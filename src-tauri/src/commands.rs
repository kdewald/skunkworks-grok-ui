//! Tauri commands bridging the frontend to ACP + local store.
//!
//! Supports multiple environments (local + SSH hosts). Each environment can
//! hold its own `grok agent stdio` connection; chat transcripts stay local.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::acp::{
    ensure_remote_scratch_dir, list_ssh_config_hosts, probe_ssh_host, resolve_remote_project_path,
    AcpConnection, AgentSpawnTarget,
};
use crate::store::{
    ensure_scratch_root, local_env_display_name, migrate_app_data, new_id, now,
    project_name_from_path, remote_scratch_display_path, remove_scratch_chat_dir,
    resolve_local_session_cwd, scratch_project_id_for_env, AppData, ChatDocument, ChatMeta,
    Environment, FileAttachment, IntermediateBlock, PlanEntry, Project, Store, Turn,
    LOCAL_ENV_ID, SCRATCH_PROJECT_ID,
};

pub struct AppState {
    pub store: Store,
    pub data: Mutex<AppData>,
    /// ACP connections keyed by environment id.
    pub agents: Mutex<HashMap<String, Arc<AcpConnection>>>,
    pub grok_path: Mutex<Option<String>>,
    /// Serialize chat read-modify-write so concurrent stream chunks don't clobber each other.
    pub chat_write: Arc<Mutex<()>>,
    /// ACP session IDs already loaded per environment (agent process).
    pub loaded_sessions: Mutex<HashMap<String, HashSet<String>>>,
    /// Sessions currently replaying history via session/load — ignore stream applies.
    pub replaying_sessions: Mutex<HashSet<String>>,
    /// Sessions that were recreated locally (old ACP id gone); next prompt should rehydrate context.
    pub needs_history_seed: Mutex<HashSet<String>>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let store = Store::open()?;
        let mut data = store.load_index().unwrap_or_default();
        migrate_app_data(&mut data);
        // Always ensure the built-in scratch workspace for local env.
        ensure_scratch_in_index(&store, &mut data, LOCAL_ENV_ID).map_err(anyhow::Error::msg)?;
        let _ = store.save_index(&data);
        Ok(Self {
            store,
            data: Mutex::new(data),
            agents: Mutex::new(HashMap::new()),
            grok_path: Mutex::new(None),
            chat_write: Arc::new(Mutex::new(())),
            loaded_sessions: Mutex::new(HashMap::new()),
            replaying_sessions: Mutex::new(HashSet::new()),
            needs_history_seed: Mutex::new(HashSet::new()),
        })
    }
}

fn ensure_scratch_in_index(
    store: &Store,
    data: &mut AppData,
    environment_id: &str,
) -> Result<(), String> {
    let env_id = if environment_id.is_empty() {
        LOCAL_ENV_ID
    } else {
        environment_id
    };
    let scratch_id = scratch_project_id_for_env(env_id);
    let is_local = env_id == LOCAL_ENV_ID;

    let path_str = if is_local {
        let path = ensure_scratch_root().map_err(|e| e.to_string())?;
        path.to_string_lossy().to_string()
    } else {
        remote_scratch_display_path(None)
    };

    let name = if is_local {
        "Scratch".to_string()
    } else {
        let env_name = data
            .environments
            .iter()
            .find(|e| e.id == env_id)
            .map(|e| e.name.clone())
            .unwrap_or_else(|| env_id.to_string());
        format!("Scratch · {env_name}")
    };

    if let Some(existing) = data.projects.iter_mut().find(|p| p.id == scratch_id) {
        existing.is_scratch = true;
        existing.name = name;
        existing.path = path_str;
        existing.environment_id = env_id.to_string();
        existing.updated_at = now();
    } else {
        let ts = now();
        data.projects.push(Project {
            id: scratch_id.clone(),
            name,
            path: path_str,
            created_at: ts,
            updated_at: ts,
            is_scratch: true,
            environment_id: env_id.to_string(),
        });
    }

    // Local scratch stays first among projects when active env is local.
    if is_local {
        if let Some(idx) = data.projects.iter().position(|p| p.id == SCRATCH_PROJECT_ID) {
            if idx != 0 {
                let p = data.projects.remove(idx);
                data.projects.insert(0, p);
            }
        }
    }

    if data.active_project_id.is_none() {
        data.active_project_id = Some(scratch_id);
    }

    store.save_index(data).map_err(|e| e.to_string())
}

fn env_from_data(data: &AppData, environment_id: &str) -> Result<Environment, String> {
    data.environments
        .iter()
        .find(|e| e.id == environment_id)
        .cloned()
        .ok_or_else(|| format!("unknown environment: {environment_id}"))
}

fn agent_for_env(state: &AppState, environment_id: &str) -> Result<Arc<AcpConnection>, String> {
    state
        .agents
        .lock()
        .get(environment_id)
        .cloned()
        .ok_or_else(|| {
            format!(
                "agent not connected for environment `{environment_id}` — connect first"
            )
        })
}

fn clear_loaded_for_env(state: &AppState, environment_id: &str) {
    state.loaded_sessions.lock().remove(environment_id);
}

fn mark_session_loaded(state: &AppState, environment_id: &str, session_id: String) {
    state
        .loaded_sessions
        .lock()
        .entry(environment_id.to_string())
        .or_default()
        .insert(session_id);
}

fn is_session_loaded(state: &AppState, environment_id: &str, session_id: &str) -> bool {
    state
        .loaded_sessions
        .lock()
        .get(environment_id)
        .map(|s| s.contains(session_id))
        .unwrap_or(false)
}

async fn resolve_session_cwd(
    state: &AppState,
    project: &Project,
    chat_id: &str,
) -> Result<String, String> {
    let env_id = if project.environment_id.is_empty() {
        LOCAL_ENV_ID
    } else {
        project.environment_id.as_str()
    };

    if env_id == LOCAL_ENV_ID {
        return resolve_local_session_cwd(project, chat_id).map_err(|e| e.to_string());
    }

    let env = {
        let data = state.data.lock();
        env_from_data(&data, env_id)?
    };
    let host = env
        .ssh_host
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SSH environment missing host".to_string())?;

    if project.is_scratch || project.id.starts_with("scratch:") {
        return ensure_remote_scratch_dir(host, chat_id)
            .await
            .map_err(|e| e.to_string());
    }

    Ok(project.path.clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSessionResult {
    pub chat: ChatDocument,
    /// loaded | created | already_active | recreated
    pub status: String,
    pub message: String,
}

fn json_str<'a>(update: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    update
        .get(camel)
        .or_else(|| update.get(snake))
        .and_then(|v| v.as_str())
}

fn json_val<'a>(update: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    update.get(camel).or_else(|| update.get(snake))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub data: AppData,
    pub data_dir: String,
    pub agent_connected: bool,
    pub connected_environments: Vec<String>,
    pub active_environment_id: String,
    pub ssh_hosts: Vec<String>,
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, AppState>) -> Result<BootstrapResponse, String> {
    let data = state.data.lock().clone();
    let connected: Vec<String> = state.agents.lock().keys().cloned().collect();
    let active = data
        .active_environment_id
        .clone()
        .unwrap_or_else(|| LOCAL_ENV_ID.to_string());
    let agent_connected = connected.iter().any(|id| id == &active);
    Ok(BootstrapResponse {
        data,
        data_dir: state.store.data_dir().display().to_string(),
        agent_connected,
        connected_environments: connected,
        active_environment_id: active,
        ssh_hosts: list_ssh_config_hosts(),
    })
}

#[tauri::command]
pub fn list_ssh_hosts() -> Result<Vec<String>, String> {
    Ok(list_ssh_config_hosts())
}

#[tauri::command]
pub async fn probe_environment(
    state: State<'_, AppState>,
    environment_id: String,
) -> Result<Value, String> {
    let env = {
        let data = state.data.lock();
        env_from_data(&data, &environment_id)?
    };
    if env.is_local() {
        return Ok(json!({
            "environmentId": LOCAL_ENV_ID,
            "ok": true,
            "kind": "local",
        }));
    }
    let host = env
        .ssh_host
        .ok_or_else(|| "SSH environment missing host".to_string())?;
    probe_ssh_host(&host, env.remote_grok_path.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_ssh_environment(
    state: State<'_, AppState>,
    host: String,
    name: Option<String>,
    remote_grok_path: Option<String>,
) -> Result<Environment, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("SSH host is required".into());
    }
    if host.contains(' ') || host.contains('*') {
        return Err("invalid SSH host alias".into());
    }

    // Probe before saving so we fail fast.
    let probe = probe_ssh_host(&host, remote_grok_path.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let discovered_grok = probe
        .get("grokPath")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let remote_path = remote_grok_path
        .filter(|s| !s.trim().is_empty())
        .or(discovered_grok);

    let mut env = Environment::ssh(&host, name, remote_path);
    env.name = if env.name == host {
        // Prefer a friendly name when host is an alias
        host.clone()
    } else {
        env.name
    };

    {
        let mut data = state.data.lock();
        if let Some(existing) = data.environments.iter_mut().find(|e| e.id == env.id) {
            existing.name = env.name.clone();
            existing.remote_grok_path = env.remote_grok_path.clone();
            existing.updated_at = now();
            env = existing.clone();
        } else {
            data.environments.push(env.clone());
        }
        ensure_scratch_in_index(&state.store, &mut data, &env.id)?;
        state.store.save_index(&data).map_err(|e| e.to_string())?;
    }

    Ok(env)
}

#[tauri::command]
pub fn remove_environment(
    state: State<'_, AppState>,
    environment_id: String,
) -> Result<(), String> {
    if environment_id == LOCAL_ENV_ID {
        return Err("Cannot remove the local environment".into());
    }

    // Drop live agent
    {
        let mut agents = state.agents.lock();
        agents.remove(&environment_id);
    }
    clear_loaded_for_env(&state, &environment_id);

    let mut data = state.data.lock();
    if !data.environments.iter().any(|e| e.id == environment_id) {
        return Err("environment not found".into());
    }

    let project_ids: Vec<String> = data
        .projects
        .iter()
        .filter(|p| p.environment_id == environment_id)
        .map(|p| p.id.clone())
        .collect();
    let chat_ids: Vec<String> = data
        .chats
        .iter()
        .filter(|c| project_ids.iter().any(|pid| pid == &c.project_id))
        .map(|c| c.id.clone())
        .collect();

    data.environments.retain(|e| e.id != environment_id);
    data.projects
        .retain(|p| p.environment_id != environment_id);
    data.chats
        .retain(|c| !chat_ids.iter().any(|id| id == &c.id));

    if data.active_environment_id.as_deref() == Some(&environment_id) {
        data.active_environment_id = Some(LOCAL_ENV_ID.to_string());
    }
    if data
        .active_project_id
        .as_ref()
        .is_some_and(|id| project_ids.contains(id))
    {
        data.active_project_id = Some(SCRATCH_PROJECT_ID.to_string());
    }
    if data
        .active_chat_id
        .as_ref()
        .is_some_and(|id| chat_ids.contains(id))
    {
        data.active_chat_id = None;
    }

    state.store.save_index(&data).map_err(|e| e.to_string())?;
    for id in chat_ids {
        let _ = state.store.delete_chat_file(&id);
    }
    Ok(())
}

#[tauri::command]
pub fn set_active_environment(
    state: State<'_, AppState>,
    environment_id: String,
) -> Result<AppData, String> {
    let mut data = state.data.lock();
    if !data.environments.iter().any(|e| e.id == environment_id) {
        return Err(format!("unknown environment: {environment_id}"));
    }
    ensure_scratch_in_index(&state.store, &mut data, &environment_id)?;
    data.active_environment_id = Some(environment_id.clone());

    // Prefer an existing project on this env (scratch if none selected).
    let scratch_id = scratch_project_id_for_env(&environment_id);
    let current_ok = data.active_project_id.as_ref().is_some_and(|pid| {
        data.projects
            .iter()
            .any(|p| &p.id == pid && p.environment_id == environment_id)
    });
    if !current_ok {
        data.active_project_id = Some(scratch_id);
        data.active_chat_id = None;
    }

    state.store.save_index(&data).map_err(|e| e.to_string())?;
    Ok(data.clone())
}

#[tauri::command]
pub async fn connect_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    environment_id: Option<String>,
) -> Result<Value, String> {
    let env_id = environment_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            state
                .data
                .lock()
                .active_environment_id
                .clone()
                .unwrap_or_else(|| LOCAL_ENV_ID.to_string())
        });

    let env = {
        let mut data = state.data.lock();
        migrate_app_data(&mut data);
        ensure_scratch_in_index(&state.store, &mut data, &env_id)?;
        env_from_data(&data, &env_id)?
    };

    // Drop existing connection for this environment
    {
        let mut agents = state.agents.lock();
        agents.remove(&env_id);
    }
    clear_loaded_for_env(&state, &env_id);

    let target = if env.is_local() {
        AgentSpawnTarget::Local {
            grok_path: state.grok_path.lock().clone(),
        }
    } else {
        let host = env
            .ssh_host
            .clone()
            .ok_or_else(|| "SSH environment missing host".to_string())?;
        AgentSpawnTarget::Ssh {
            host,
            remote_grok_path: env.remote_grok_path.clone(),
        }
    };

    let label = if env.is_local() {
        local_env_display_name()
    } else {
        env.name.clone()
    };

    let conn = AcpConnection::spawn(app.clone(), env_id.clone(), target)
        .await
        .map_err(|e| e.to_string())?;

    let init = conn.initialize().await.map_err(|e| {
        format!("initialize on {label} failed: {e}")
    })?;
    let auth = conn.authenticate_from_init(&init).await.map_err(|e| {
        format!(
            "authenticate on {label} failed: {e}"
        )
    })?;

    state.agents.lock().insert(env_id.clone(), conn);

    // Remember active environment
    {
        let mut data = state.data.lock();
        data.active_environment_id = Some(env_id.clone());
        let _ = state.store.save_index(&data);
    }

    let message = if env.is_local() {
        "Connected to local Grok agent".into()
    } else {
        format!("Connected to Grok on {}", env.name)
    };

    let _ = app.emit(
        "agent-status",
        json!({
            "connected": true,
            "message": message,
            "agentInfo": init,
            "auth": auth,
            "environmentId": env_id,
        }),
    );

    Ok(json!({
        "initialize": init,
        "auth": auth,
        "environmentId": env_id,
        "message": message,
    }))
}

#[tauri::command]
pub fn disconnect_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    environment_id: Option<String>,
) -> Result<(), String> {
    let env_id = environment_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            state
                .data
                .lock()
                .active_environment_id
                .clone()
                .unwrap_or_else(|| LOCAL_ENV_ID.to_string())
        });

    state.agents.lock().remove(&env_id);
    clear_loaded_for_env(&state, &env_id);

    let _ = app.emit(
        "agent-status",
        json!({
            "connected": false,
            "message": format!("Disconnected ({env_id})"),
            "environmentId": env_id,
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn set_grok_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    *state.grok_path.lock() = if path.trim().is_empty() {
        None
    } else {
        Some(path)
    };
    Ok(())
}

#[tauri::command]
pub fn list_projects(
    state: State<'_, AppState>,
    environment_id: Option<String>,
) -> Result<Vec<Project>, String> {
    let data = state.data.lock();
    let projects = match environment_id {
        Some(env) if !env.is_empty() => data
            .projects
            .iter()
            .filter(|p| p.environment_id == env)
            .cloned()
            .collect(),
        _ => data.projects.clone(),
    };
    Ok(projects)
}

#[tauri::command]
pub async fn add_project(
    state: State<'_, AppState>,
    path: String,
    environment_id: Option<String>,
) -> Result<Project, String> {
    let env_id = environment_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            state
                .data
                .lock()
                .active_environment_id
                .clone()
                .unwrap_or_else(|| LOCAL_ENV_ID.to_string())
        });

    let env = {
        let data = state.data.lock();
        env_from_data(&data, &env_id)?
    };

    let path = if env.is_local() {
        std::fs::canonicalize(&path)
            .map_err(|e| format!("invalid path: {e}"))?
            .to_string_lossy()
            .to_string()
    } else {
        let host = env
            .ssh_host
            .as_deref()
            .ok_or_else(|| "SSH environment missing host".to_string())?;
        resolve_remote_project_path(host, &path)
            .await
            .map_err(|e| e.to_string())?
    };

    let mut data = state.data.lock();
    if let Some(existing) = data
        .projects
        .iter()
        .find(|p| p.path == path && p.environment_id == env_id)
    {
        return Ok(existing.clone());
    }

    let project = Project {
        id: new_id(),
        name: project_name_from_path(&path),
        path,
        created_at: now(),
        updated_at: now(),
        is_scratch: false,
        environment_id: env_id,
    };
    data.projects.push(project.clone());
    data.active_project_id = Some(project.id.clone());
    data.active_environment_id = Some(project.environment_id.clone());
    state.store.save_index(&data).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    if project_id == SCRATCH_PROJECT_ID || project_id.starts_with("scratch:") {
        return Err("Scratch workspace can't be removed".into());
    }

    let mut data = state.data.lock();
    if data
        .projects
        .iter()
        .any(|p| p.id == project_id && p.is_scratch)
    {
        return Err("Scratch workspace can't be removed".into());
    }

    let env_id = data
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.environment_id.clone())
        .unwrap_or_else(|| LOCAL_ENV_ID.to_string());

    let chat_ids: Vec<String> = data
        .chats
        .iter()
        .filter(|c| c.project_id == project_id)
        .map(|c| c.id.clone())
        .collect();

    data.projects.retain(|p| p.id != project_id);
    data.chats.retain(|c| c.project_id != project_id);
    if data.active_project_id.as_deref() == Some(&project_id) {
        data.active_project_id = Some(scratch_project_id_for_env(&env_id));
    }
    if let Some(active) = data.active_chat_id.clone() {
        if chat_ids.contains(&active) {
            data.active_chat_id = data
                .chats
                .iter()
                .find(|c| data.active_project_id.as_deref() == Some(&c.project_id))
                .map(|c| c.id.clone());
        }
    }
    state.store.save_index(&data).map_err(|e| e.to_string())?;
    for id in chat_ids {
        let _ = state.store.delete_chat_file(&id);
    }
    Ok(())
}

#[tauri::command]
pub fn set_active_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<(), String> {
    let mut data = state.data.lock();
    if let Some(ref pid) = project_id {
        if let Some(p) = data.projects.iter().find(|p| &p.id == pid) {
            data.active_environment_id = Some(p.environment_id.clone());
        }
    }
    data.active_project_id = project_id;
    state.store.save_index(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chats(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ChatMeta>, String> {
    let data = state.data.lock();
    Ok(data
        .chats
        .iter()
        .filter(|c| c.project_id == project_id)
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn create_chat(
    state: State<'_, AppState>,
    project_id: Option<String>,
    title: Option<String>,
) -> Result<ChatDocument, String> {
    let project_id = project_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            state
                .data
                .lock()
                .active_project_id
                .clone()
                .unwrap_or_else(|| SCRATCH_PROJECT_ID.to_string())
        });

    let project = {
        let mut data = state.data.lock();
        let env_id = data
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.environment_id.clone())
            .unwrap_or_else(|| LOCAL_ENV_ID.to_string());
        ensure_scratch_in_index(&state.store, &mut data, &env_id)?;
        data.projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "project not found".to_string())?
            .clone()
    };
    let project_id = project.id.clone();
    let env_id = project.environment_id.clone();

    let chat_id = new_id();
    let session_cwd = resolve_session_cwd(&state, &project, &chat_id).await?;

    let agent = agent_for_env(&state, &env_id)?;

    let result = agent
        .session_new(&session_cwd)
        .await
        .map_err(|e| e.to_string())?;
    let acp_session_id = result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .ok_or_else(|| format!("session/new missing sessionId: {result}"))?
        .to_string();
    mark_session_loaded(&state, &env_id, acp_session_id.clone());

    let ts = now();
    let title = title.unwrap_or_else(|| "New chat".to_string());

    let doc = ChatDocument {
        id: chat_id.clone(),
        project_id: project_id.clone(),
        title: title.clone(),
        acp_session_id: Some(acp_session_id),
        turns: vec![],
        created_at: ts,
        updated_at: ts,
    };
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;

    let meta = ChatMeta {
        id: chat_id,
        project_id,
        title,
        acp_session_id: doc.acp_session_id.clone(),
        preview: None,
        created_at: ts,
        updated_at: ts,
    };

    {
        let mut data = state.data.lock();
        data.chats.insert(0, meta);
        data.active_chat_id = Some(doc.id.clone());
        data.active_project_id = Some(doc.project_id.clone());
        data.active_environment_id = Some(env_id);
        state.store.save_index(&data).map_err(|e| e.to_string())?;
    }

    Ok(doc)
}

#[tauri::command]
pub fn get_chat(state: State<'_, AppState>, chat_id: String) -> Result<ChatDocument, String> {
    state.store.load_chat(&chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_chat_document(
    state: State<'_, AppState>,
    chat: ChatDocument,
) -> Result<(), String> {
    let mut updated = chat;
    updated.updated_at = now();
    state.store.save_chat(&updated).map_err(|e| e.to_string())?;

    let mut data = state.data.lock();
    if let Some(meta) = data.chats.iter_mut().find(|c| c.id == updated.id) {
        meta.title = updated.title.clone();
        meta.acp_session_id = updated.acp_session_id.clone();
        meta.updated_at = updated.updated_at;
        meta.preview = updated.turns.last().map(|t| {
            let preview = if !t.assistant_message.is_empty() {
                t.assistant_message.clone()
            } else {
                t.user_message.clone()
            };
            preview.chars().take(120).collect()
        });
    }
    data.chats.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    state.store.save_index(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat(
    state: State<'_, AppState>,
    chat_id: String,
    title: String,
) -> Result<(), String> {
    let mut doc = state.store.load_chat(&chat_id).map_err(|e| e.to_string())?;
    doc.title = title.clone();
    doc.updated_at = now();
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;

    let mut data = state.data.lock();
    if let Some(meta) = data.chats.iter_mut().find(|c| c.id == chat_id) {
        meta.title = title;
        meta.updated_at = doc.updated_at;
    }
    state.store.save_index(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, chat_id: String) -> Result<(), String> {
    let project_id = {
        let data = state.data.lock();
        data.chats
            .iter()
            .find(|c| c.id == chat_id)
            .map(|c| c.project_id.clone())
    };

    let mut data = state.data.lock();
    data.chats.retain(|c| c.id != chat_id);
    if data.active_chat_id.as_deref() == Some(&chat_id) {
        data.active_chat_id = data.chats.first().map(|c| c.id.clone());
    }
    state.store.save_index(&data).map_err(|e| e.to_string())?;
    state
        .store
        .delete_chat_file(&chat_id)
        .map_err(|e| e.to_string())?;

    // Local scratch only — remote dirs left for the user / agent.
    if project_id.as_deref() == Some(SCRATCH_PROJECT_ID) {
        remove_scratch_chat_dir(&chat_id);
    }
    Ok(())
}

#[tauri::command]
pub fn set_active_chat(
    state: State<'_, AppState>,
    chat_id: Option<String>,
) -> Result<(), String> {
    let mut data = state.data.lock();
    data.active_chat_id = chat_id;
    state.store.save_index(&data).map_err(|e| e.to_string())
}

/// Load or recreate the ACP session for a chat so prompts don't hit "unknown session id".
#[tauri::command]
pub async fn ensure_chat_session(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> Result<EnsureSessionResult, String> {
    ensure_session_inner(&app, &state, &chat_id).await
}

async fn ensure_session_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    chat_id: &str,
) -> Result<EnsureSessionResult, String> {
    let mut doc = state
        .store
        .load_chat(chat_id)
        .map_err(|e| e.to_string())?;

    let project = {
        let data = state.data.lock();
        data.projects
            .iter()
            .find(|p| p.id == doc.project_id)
            .cloned()
            .ok_or_else(|| "project not found".to_string())?
    };
    let env_id = if project.environment_id.is_empty() {
        LOCAL_ENV_ID.to_string()
    } else {
        project.environment_id.clone()
    };

    let session_cwd = resolve_session_cwd(state, &project, chat_id).await?;
    let agent = agent_for_env(state, &env_id)?;

    // Already live in this agent process
    if let Some(sid) = doc.acp_session_id.clone() {
        if is_session_loaded(state, &env_id, &sid) {
            return Ok(EnsureSessionResult {
                chat: doc,
                status: "already_active".into(),
                message: "Session already loaded in this agent process".into(),
            });
        }
    }

    // Try session/load for persisted Grok sessions
    if let Some(sid) = doc.acp_session_id.clone() {
        state.replaying_sessions.lock().insert(sid.clone());
        let _ = app.emit(
            "agent-log",
            json!({
                "level": "info",
                "message": format!(
                    "Loading ACP session {sid} for chat {chat_id} (cwd={session_cwd}, env={env_id})"
                ),
                "environmentId": env_id,
            }),
        );

        let load_result = agent.session_load(&sid, &session_cwd).await;
        state.replaying_sessions.lock().remove(&sid);

        match load_result {
            Ok(_) => {
                mark_session_loaded(state, &env_id, sid);
                state.needs_history_seed.lock().remove(chat_id);
                let _ = app.emit(
                    "session-ready",
                    json!({ "chatId": chat_id, "status": "loaded", "cwd": session_cwd, "environmentId": env_id }),
                );
                return Ok(EnsureSessionResult {
                    chat: doc,
                    status: "loaded".into(),
                    message: "Restored ACP session from disk".into(),
                });
            }
            Err(err) => {
                let msg = err.to_string();
                let _ = app.emit(
                    "agent-log",
                    json!({
                        "level": "warn",
                        "message": format!("session/load failed for {sid}: {msg}; creating new session"),
                        "environmentId": env_id,
                    }),
                );
            }
        }
    }

    // Create a fresh ACP session (no prior id, or load failed)
    let result = agent
        .session_new(&session_cwd)
        .await
        .map_err(|e| e.to_string())?;
    let new_sid = result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "session/new missing sessionId".to_string())?
        .to_string();

    let had_history = !doc.turns.is_empty();
    let status = if doc.acp_session_id.is_some() {
        "recreated"
    } else {
        "created"
    };

    doc.acp_session_id = Some(new_sid.clone());
    doc.updated_at = now();
    {
        let _guard = state.chat_write.lock();
        state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    }
    sync_meta(state, &doc)?;

    mark_session_loaded(state, &env_id, new_sid);
    if had_history {
        state.needs_history_seed.lock().insert(chat_id.to_string());
    }

    let _ = app.emit(
        "session-ready",
        json!({ "chatId": chat_id, "status": status, "environmentId": env_id }),
    );

    Ok(EnsureSessionResult {
        chat: doc,
        status: status.into(),
        message: if had_history {
            "ACP session was gone; created a new one. Prior turns will be rehydrated on the next message.".into()
        } else {
            "Created new ACP session".into()
        },
    })
}

fn build_history_seed(doc: &ChatDocument, new_message: &str) -> String {
    let mut parts = Vec::new();
    parts.push(
        "The previous agent session could not be restored, so this is a fresh ACP session \
with the same project folder. Below is the conversation so far from the local transcript. \
Continue naturally from that context.\n"
            .to_string(),
    );
    for (i, turn) in doc.turns.iter().enumerate() {
        if i + 1 == doc.turns.len()
            && turn.status == "streaming"
            && turn.user_message == new_message
            && turn.assistant_message.is_empty()
        {
            continue;
        }
        parts.push(format!("User:\n{}\n", turn.user_message));
        if !turn.assistant_message.trim().is_empty() {
            parts.push(format!("Assistant:\n{}\n", turn.assistant_message));
        }
    }
    parts.push(format!(
        "---\nUser's new message (respond to this):\n{}",
        new_message
    ));
    parts.join("\n")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    /// "image" | "text"
    pub kind: String,
    /// Base64-encoded bytes (no data: prefix). For text, UTF-8 file bytes.
    pub data: String,
    pub mime_type: String,
    pub name: Option<String>,
    /// Optional data URL for image previews.
    pub data_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageArgs {
    pub chat_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
    /// Legacy field — merged into attachments as images.
    #[serde(default)]
    pub images: Vec<AttachmentPayload>,
}

const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024; // 8 MiB per file
const MAX_ATTACHMENTS: usize = 8;

fn ext_for_mime(mime: &str, kind: &str, name: &str) -> String {
    if let Some(ext) = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
    {
        return ext.to_lowercase();
    }
    match (kind, mime) {
        ("image", "image/jpeg" | "image/jpg") => "jpg".into(),
        ("image", "image/webp") => "webp".into(),
        ("image", "image/gif") => "gif".into(),
        ("image", _) => "png".into(),
        (_, "application/json") => "json".into(),
        (_, "text/markdown") => "md".into(),
        (_, "text/html") => "html".into(),
        (_, "text/csv") => "csv".into(),
        _ => "txt".into(),
    }
}

fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))
}

fn save_attachment(
    data_dir: &std::path::Path,
    chat_id: &str,
    att: &AttachmentPayload,
) -> Result<FileAttachment, String> {
    let kind = if att.kind == "text" { "text" } else { "image" };
    let id = new_id();
    let name = att.name.clone().unwrap_or_else(|| {
        if kind == "image" {
            "image.png".into()
        } else {
            "file.txt".into()
        }
    });
    let mime = if att.mime_type.is_empty() {
        if kind == "image" {
            "image/png".into()
        } else {
            "text/plain".into()
        }
    } else {
        att.mime_type.clone()
    };
    let ext = ext_for_mime(&mime, kind, &name);
    let rel = format!("attachments/{chat_id}/{id}.{ext}");
    let abs = data_dir.join(&rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes = decode_b64(&att.data)?;
    if bytes.is_empty() {
        return Err(format!("empty attachment: {name}"));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{name} is too large ({} MB). Max is {} MB.",
            bytes.len() / (1024 * 1024),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    if kind == "image" && bytes.len() < 32 {
        return Err(format!("{name}: image data too small"));
    }
    if kind == "text" {
        std::str::from_utf8(&bytes).map_err(|_| {
            format!("{name} is not valid UTF-8 text and can't be embedded in the prompt")
        })?;
    }

    std::fs::write(&abs, &bytes).map_err(|e| e.to_string())?;

    let data_url = if kind == "image" {
        att.data_url.clone().or_else(|| {
            if att.data.len() < 4_000_000 {
                Some(format!("data:{mime};base64,{}", att.data))
            } else {
                None
            }
        })
    } else {
        None
    };

    Ok(FileAttachment {
        id,
        name,
        kind: kind.into(),
        mime_type: mime,
        path: rel,
        data_url,
        size: bytes.len() as u64,
    })
}

fn build_prompt_blocks(
    data_dir: &std::path::Path,
    text: &str,
    attachments: &[FileAttachment],
) -> Result<Vec<Value>, String> {
    use base64::Engine;
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    } else if !attachments.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": "Please review the attached file(s)."
        }));
    }
    for att in attachments {
        let abs = data_dir.join(&att.path);
        let bytes = std::fs::read(&abs)
            .map_err(|e| format!("read attachment {}: {e}", abs.display()))?;
        if att.kind == "text" {
            let content = String::from_utf8_lossy(&bytes).to_string();
            blocks.push(json!({
                "type": "resource",
                "resource": {
                    "uri": format!("attachment:///{}", att.name),
                    "mimeType": att.mime_type,
                    "text": content,
                }
            }));
        } else {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            blocks.push(json!({
                "type": "image",
                "mimeType": att.mime_type,
                "data": b64,
            }));
        }
    }
    Ok(blocks)
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendMessageArgs,
) -> Result<ChatDocument, String> {
    let text = args.text.trim().to_string();
    let mut payloads = args.attachments;
    for img in args.images {
        let mut p = img;
        if p.kind.is_empty() {
            p.kind = "image".into();
        }
        payloads.push(p);
    }
    if text.is_empty() && payloads.is_empty() {
        return Err("empty message".into());
    }
    if payloads.len() > MAX_ATTACHMENTS {
        return Err(format!("too many attachments (max {MAX_ATTACHMENTS})"));
    }

    let ensured = ensure_session_inner(&app, &state, &args.chat_id).await?;
    let mut doc = ensured.chat;

    let env_id = {
        let data = state.data.lock();
        data.projects
            .iter()
            .find(|p| p.id == doc.project_id)
            .map(|p| {
                if p.environment_id.is_empty() {
                    LOCAL_ENV_ID.to_string()
                } else {
                    p.environment_id.clone()
                }
            })
            .unwrap_or_else(|| LOCAL_ENV_ID.to_string())
    };

    let agent = agent_for_env(&state, &env_id)?;

    let acp_session_id = doc
        .acp_session_id
        .clone()
        .ok_or_else(|| "no ACP session after ensure".to_string())?;

    let data_dir = state.store.data_dir().to_path_buf();
    let mut attachments = Vec::new();
    for p in &payloads {
        attachments.push(save_attachment(&data_dir, &doc.id, p)?);
    }

    if doc.turns.is_empty() && doc.title == "New chat" {
        let seed = if !text.is_empty() {
            text.clone()
        } else if let Some(a) = attachments.first() {
            format!("Attached {}", a.name)
        } else {
            "New chat".into()
        };
        doc.title = seed.chars().take(48).collect::<String>();
        if seed.chars().count() > 48 {
            doc.title.push('…');
        }
    }

    let turn = Turn {
        id: new_id(),
        user_message: text.clone(),
        intermediate: vec![],
        assistant_message: String::new(),
        status: "streaming".into(),
        intermediate_collapsed: false,
        attachments: attachments.clone(),
        created_at: now(),
    };
    let turn_id = turn.id.clone();
    doc.turns.push(turn);
    doc.updated_at = now();
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    sync_meta(&state, &doc)?;

    let mut prompt_text = text.clone();
    if state.needs_history_seed.lock().remove(&args.chat_id) {
        prompt_text = build_history_seed(&doc, &text);
    }

    let prompt_blocks = build_prompt_blocks(&data_dir, &prompt_text, &attachments)?;

    let _ = app.emit(
        "chat-updated",
        json!({ "chatId": doc.id, "turnId": turn_id }),
    );

    let agent2 = agent.clone();
    let session_id = acp_session_id.clone();
    let chat_id = doc.id.clone();
    let store_path = data_dir;
    let turn_id2 = turn_id.clone();
    let app2 = app.clone();
    let chat_write = Arc::clone(&state.chat_write);
    let blocks = prompt_blocks;

    tokio::spawn(async move {
        let result = agent2.session_prompt_blocks(&session_id, blocks).await;

        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        {
            let _guard = chat_write.lock();
            let chat_file = store_path.join("chats").join(format!("{chat_id}.json"));
            if let Ok(raw) = std::fs::read_to_string(&chat_file) {
                if let Ok(mut chat) = serde_json::from_str::<ChatDocument>(&raw) {
                    if let Some(t) = chat.turns.iter_mut().find(|t| t.id == turn_id2) {
                        match &result {
                            Ok(_) => {
                                t.status = "complete".into();
                                t.intermediate_collapsed = true;
                            }
                            Err(err) => {
                                t.status = "error".into();
                                // Always surface the reason (don't hide it when
                                // the turn already streamed partial assistant text).
                                let note = format!("\n\n---\n**Turn failed:** {err}");
                                if t.assistant_message.is_empty() {
                                    t.assistant_message = format!("**Turn failed:** {err}");
                                } else if !t.assistant_message.contains("**Turn failed:**") {
                                    t.assistant_message.push_str(&note);
                                }
                            }
                        }
                    }
                    chat.updated_at = now();
                    let _ = std::fs::write(
                        &chat_file,
                        serde_json::to_string_pretty(&chat).unwrap_or_default(),
                    );
                }
            }
        }

        let _ = app2.emit(
            "prompt-finished",
            json!({
                "chatId": chat_id,
                "turnId": turn_id2,
                "ok": result.is_ok(),
                "error": result.as_ref().err().map(|e| e.to_string()),
            }),
        );
    });

    Ok(doc)
}

fn sync_meta(state: &AppState, doc: &ChatDocument) -> Result<(), String> {
    let mut data = state.data.lock();
    if let Some(meta) = data.chats.iter_mut().find(|c| c.id == doc.id) {
        meta.title = doc.title.clone();
        meta.acp_session_id = doc.acp_session_id.clone();
        meta.updated_at = doc.updated_at;
        meta.preview = doc
            .turns
            .last()
            .map(|t| t.user_message.chars().take(120).collect::<String>());
    }
    data.chats.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    state.store.save_index(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_prompt(
    state: State<'_, AppState>,
    chat_id: String,
) -> Result<(), String> {
    let doc = state
        .store
        .load_chat(&chat_id)
        .map_err(|e| e.to_string())?;
    let sid = doc
        .acp_session_id
        .ok_or_else(|| "no ACP session".to_string())?;

    let env_id = {
        let data = state.data.lock();
        data.projects
            .iter()
            .find(|p| p.id == doc.project_id)
            .map(|p| {
                if p.environment_id.is_empty() {
                    LOCAL_ENV_ID.to_string()
                } else {
                    p.environment_id.clone()
                }
            })
            .unwrap_or_else(|| LOCAL_ENV_ID.to_string())
    };

    let agent = agent_for_env(&state, &env_id)?;
    agent.session_cancel(&sid).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn respond_permission(
    state: State<'_, AppState>,
    request_id: Value,
    option_id: Option<String>,
    cancelled: bool,
) -> Result<(), String> {
    // Find whichever agent is waiting on this permission id.
    let agent = {
        let agents = state.agents.lock();
        agents
            .values()
            .find(|a| a.has_pending_permission(&request_id))
            .cloned()
            .or_else(|| agents.values().next().cloned())
            .ok_or_else(|| "agent not connected".to_string())?
    };
    agent
        .respond_permission(request_id, option_id, cancelled)
        .await
        .map_err(|e| e.to_string())
}

/// Apply a streamed session/update into the local chat document.
#[tauri::command]
pub fn apply_session_update(
    state: State<'_, AppState>,
    chat_id: String,
    update: Value,
) -> Result<ChatDocument, String> {
    {
        let doc_peek = state.store.load_chat(&chat_id).ok();
        if let Some(doc) = doc_peek {
            if let Some(sid) = doc.acp_session_id.as_ref() {
                if state.replaying_sessions.lock().contains(sid) {
                    return Ok(doc);
                }
            }
        }
    }

    let _guard = state.chat_write.lock();
    let mut doc = state
        .store
        .load_chat(&chat_id)
        .map_err(|e| e.to_string())?;

    let Some(turn) = doc.turns.last_mut() else {
        return Ok(doc);
    };

    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|s| s.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            if turn.status == "cancelled" {
                // keep whatever we have
            } else if let Some(text) = update
                .pointer("/content/text")
                .and_then(|t| t.as_str())
            {
                turn.assistant_message.push_str(text);
            } else if let Some(text) = update.get("content").and_then(|c| {
                if c.is_string() {
                    c.as_str()
                } else {
                    c.get("text").and_then(|t| t.as_str())
                }
            }) {
                turn.assistant_message.push_str(text);
            }
        }
        "agent_thought_chunk" => {
            let text = update
                .pointer("/content/text")
                .or_else(|| update.get("content").and_then(|c| c.get("text")))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if text.is_empty() {
                // nothing
            } else if let Some(IntermediateBlock::Thought { text: existing, .. }) =
                turn.intermediate.iter_mut().rev().find(|b| {
                    matches!(b, IntermediateBlock::Thought { .. })
                })
            {
                existing.push_str(text);
            } else {
                turn.intermediate.push(IntermediateBlock::Thought {
                    id: new_id(),
                    text: text.to_string(),
                    collapsed: false,
                });
            }
        }
        "tool_call" => {
            let tool_call_id = json_str(&update, "toolCallId", "tool_call_id")
                .unwrap_or("")
                .to_string();
            let title = update
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("Tool")
                .to_string();
            let tool_kind = update
                .get("kind")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let status = update
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("pending")
                .to_string();
            let raw_input = json_val(&update, "rawInput", "raw_input").cloned();
            let content = update.get("content").cloned();
            let raw_output = json_val(&update, "rawOutput", "raw_output").cloned();

            if !tool_call_id.is_empty() {
                if let Some(IntermediateBlock::Tool {
                    title: existing_title,
                    kind: existing_kind,
                    status: existing_status,
                    raw_input: existing_input,
                    content: existing_content,
                    raw_output: existing_output,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == &tool_call_id,
                    _ => false,
                }) {
                    if title.len() > existing_title.len() || existing_title == "Tool" {
                        *existing_title = title;
                    }
                    if tool_kind.is_some() {
                        *existing_kind = tool_kind;
                    }
                    *existing_status = status;
                    if raw_input.is_some() {
                        *existing_input = raw_input;
                    }
                    if content.is_some() {
                        *existing_content = content;
                    }
                    if raw_output.is_some() {
                        *existing_output = raw_output;
                    }
                } else {
                    turn.intermediate.push(IntermediateBlock::Tool {
                        id: new_id(),
                        tool_call_id,
                        title,
                        kind: tool_kind,
                        status,
                        raw_input,
                        content,
                        raw_output,
                        collapsed: false,
                    });
                }
            } else {
                turn.intermediate.push(IntermediateBlock::Tool {
                    id: new_id(),
                    tool_call_id,
                    title,
                    kind: tool_kind,
                    status,
                    raw_input,
                    content,
                    raw_output,
                    collapsed: false,
                });
            }
        }
        "tool_call_update" => {
            let tool_call_id = json_str(&update, "toolCallId", "tool_call_id").unwrap_or("");
            if let Some(IntermediateBlock::Tool {
                status,
                content,
                raw_output,
                raw_input,
                title,
                kind,
                ..
            }) = turn.intermediate.iter_mut().find(|b| match b {
                IntermediateBlock::Tool { tool_call_id: id, .. } => id == tool_call_id,
                _ => false,
            }) {
                if let Some(s) = update.get("status").and_then(|s| s.as_str()) {
                    *status = s.to_string();
                }
                if let Some(c) = update.get("content") {
                    *content = Some(c.clone());
                }
                if let Some(o) = json_val(&update, "rawOutput", "raw_output") {
                    *raw_output = Some(o.clone());
                }
                if let Some(i) = json_val(&update, "rawInput", "raw_input") {
                    *raw_input = Some(i.clone());
                }
                if let Some(t) = update.get("title").and_then(|s| s.as_str()) {
                    if t.len() >= title.len() {
                        *title = t.to_string();
                    }
                }
                if let Some(k) = update.get("kind").and_then(|s| s.as_str()) {
                    *kind = Some(k.to_string());
                }
            }
        }
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(|e| e.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|e| PlanEntry {
                            content: e
                                .get("content")
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .to_string(),
                            priority: e
                                .get("priority")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string()),
                            status: e
                                .get("status")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(IntermediateBlock::Plan {
                entries: existing, ..
            }) = turn.intermediate.iter_mut().rev().find(|b| {
                matches!(b, IntermediateBlock::Plan { .. })
            }) {
                *existing = entries;
            } else {
                turn.intermediate.push(IntermediateBlock::Plan {
                    id: new_id(),
                    entries,
                    collapsed: false,
                });
            }
        }
        "user_message_chunk" => {}
        _ => {}
    }

    doc.updated_at = now();
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    Ok(doc)
}

#[tauri::command]
pub fn set_turn_collapsed(
    state: State<'_, AppState>,
    chat_id: String,
    turn_id: String,
    collapsed: bool,
) -> Result<ChatDocument, String> {
    let _guard = state.chat_write.lock();
    let mut doc = state
        .store
        .load_chat(&chat_id)
        .map_err(|e| e.to_string())?;
    if let Some(t) = doc.turns.iter_mut().find(|t| t.id == turn_id) {
        t.intermediate_collapsed = collapsed;
    }
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    Ok(doc)
}

#[tauri::command]
pub fn set_block_collapsed(
    state: State<'_, AppState>,
    chat_id: String,
    turn_id: String,
    block_id: String,
    collapsed: bool,
) -> Result<ChatDocument, String> {
    let _guard = state.chat_write.lock();
    let mut doc = state
        .store
        .load_chat(&chat_id)
        .map_err(|e| e.to_string())?;
    if let Some(t) = doc.turns.iter_mut().find(|t| t.id == turn_id) {
        for b in &mut t.intermediate {
            match b {
                IntermediateBlock::Thought { id, collapsed: c, .. }
                | IntermediateBlock::Tool { id, collapsed: c, .. }
                | IntermediateBlock::Plan { id, collapsed: c, .. }
                    if id == &block_id =>
                {
                    *c = collapsed;
                }
                _ => {}
            }
        }
    }
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    Ok(doc)
}
