//! Tauri commands bridging the frontend to ACP + local store.
//!
//! Supports multiple environments (local + SSH hosts). Each environment can
//! hold its own `grok agent stdio` connection; chat transcripts stay local.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::acp::{
    ensure_remote_scratch_dir, list_remote_directory, list_ssh_config_hosts, probe_ssh_host,
    resolve_remote_project_path, AcpConnection, AgentSpawnTarget, RemoteDirListing,
};
use crate::store::{
    ensure_scratch_root, local_env_display_name, migrate_app_data, new_id, now,
    project_name_from_path, remote_scratch_display_path, remove_scratch_chat_dir,
    resolve_local_session_cwd, scratch_project_id_for_env, AppData, ChatDocument, ChatMeta,
    Environment, FileAttachment, IntermediateBlock, PlanEntry, Project, Store, Turn,
    LOCAL_ENV_ID, SCRATCH_PROJECT_ID,
};
use crate::terminal::{TerminalInfo, TerminalManager};
use crate::workspace_fs::{
    git_status_local, git_status_remote, list_local, list_remote, read_local, read_remote,
    resolve_workspace_root, WorkspaceFileContent, WorkspaceGitStatus, WorkspaceListing,
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
    /// Sessions the user cancelled — drop further stream applies so cancel isn't blocked
    /// behind multi‑MB tool-output writes.
    pub cancelling_sessions: Arc<Mutex<HashSet<String>>>,
    /// In-memory chat docs while streaming so we don't rewrite multi‑MB JSON
    /// to disk on every token.
    pub live_chats: Arc<Mutex<HashMap<String, ChatDocument>>>,
    /// Last time each chat was flushed to disk (for debounced persistence).
    pub last_disk_save: Mutex<HashMap<String, Instant>>,
    /// Interactive project terminals (local PTY / SSH).
    pub terminals: TerminalManager,
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
            cancelling_sessions: Arc::new(Mutex::new(HashSet::new())),
            live_chats: Arc::new(Mutex::new(HashMap::new())),
            last_disk_save: Mutex::new(HashMap::new()),
            terminals: TerminalManager::default(),
        })
    }
}

/// Prefer the live (in-memory) document while a turn is streaming.
fn load_chat_doc(state: &AppState, chat_id: &str) -> Result<ChatDocument, String> {
    {
        let mut live = state.live_chats.lock();
        if let Some(doc) = live.get_mut(chat_id) {
            promote_subagent_tools_in_doc(doc);
            return Ok(doc.clone());
        }
    }
    let mut doc = state.store.load_chat(chat_id).map_err(|e| e.to_string())?;
    promote_subagent_tools_in_doc(&mut doc);
    // Keep promoted form warm so subsequent stream applies see Subagent cards.
    state.live_chats.lock().insert(chat_id.to_string(), doc.clone());
    Ok(doc)
}

/// Older transcripts stored spawn_subagent as plain Tool blocks. Lift them into
/// Subagent cards so the side rail populates for historical chats too.
fn promote_subagent_tools_in_doc(doc: &mut ChatDocument) {
    for turn in &mut doc.turns {
        // Snapshot tool indices first — we may remove some.
        let tools: Vec<(usize, IntermediateBlock)> = turn
            .intermediate
            .iter()
            .enumerate()
            .filter_map(|(i, b)| match b {
                IntermediateBlock::Tool { .. } => Some((i, b.clone())),
                _ => None,
            })
            .collect();

        let mut remove_idxs: Vec<usize> = Vec::new();
        for (idx, block) in tools {
            let IntermediateBlock::Tool {
                tool_call_id,
                title,
                status,
                raw_input,
                content,
                raw_output,
                ..
            } = block
            else {
                continue;
            };
            if looks_like_subagent_spawn(raw_input.as_ref(), &title) {
                upsert_subagent_from_spawn_tool(
                    turn,
                    &tool_call_id,
                    &title,
                    &status,
                    raw_input.as_ref(),
                    content.as_ref(),
                    raw_output.as_ref(),
                );
                remove_idxs.push(idx);
            } else if looks_like_subagent_wait(raw_input.as_ref(), &title) {
                apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
                remove_idxs.push(idx);
            }
        }
        // Remove promoted tools from the main work list (highest index first).
        remove_idxs.sort_unstable();
        remove_idxs.dedup();
        for idx in remove_idxs.into_iter().rev() {
            if idx < turn.intermediate.len() {
                if matches!(turn.intermediate[idx], IntermediateBlock::Tool { .. }) {
                    turn.intermediate.remove(idx);
                }
            }
        }
    }
}

/// Keep the live cache warm; optionally flush to disk.
fn put_chat_doc(state: &AppState, doc: ChatDocument, force_disk: bool) -> Result<(), String> {
    let id = doc.id.clone();
    state.live_chats.lock().insert(id.clone(), doc.clone());
    if force_disk {
        state.store.save_chat(&doc).map_err(|e| e.to_string())?;
        state.last_disk_save.lock().insert(id, Instant::now());
    }
    Ok(())
}

/// Persist a chat if enough time has passed, or always for non-chunk updates.
fn should_flush_disk(state: &AppState, chat_id: &str, kind: &str) -> bool {
    // High-churn stream kinds: debounce disk. Structural events flush immediately.
    let is_chunk = matches!(
        kind,
        "agent_message_chunk"
            | "agent_thought_chunk"
            | "tool_call_update" // status/content thrash during long tools
    );
    if !is_chunk {
        return true;
    }
    let mut map = state.last_disk_save.lock();
    let now = Instant::now();
    match map.get(chat_id) {
        Some(prev) if now.duration_since(*prev) < Duration::from_millis(750) => false,
        _ => {
            map.insert(chat_id.to_string(), now);
            true
        }
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

/// True when the chat never received a user/agent turn.
fn chat_has_no_turns(doc: &ChatDocument) -> bool {
    doc.turns.is_empty()
}

/// Remove a chat from the index + disk (and local scratch dir if applicable).
fn purge_chat(state: &AppState, chat_id: &str) -> Result<(), String> {
    let project_id = {
        let data = state.data.lock();
        data.chats
            .iter()
            .find(|c| c.id == chat_id)
            .map(|c| c.project_id.clone())
    };

    {
        let mut data = state.data.lock();
        data.chats.retain(|c| c.id != chat_id);
        if data.active_chat_id.as_deref() == Some(chat_id) {
            data.active_chat_id = None;
        }
        state.store.save_index(&data).map_err(|e| e.to_string())?;
    }
    let _ = state.store.delete_chat_file(chat_id);

    // Local scratch only — remote dirs left for the user / agent.
    if project_id.as_deref() == Some(SCRATCH_PROJECT_ID)
        || project_id
            .as_deref()
            .map(|p| p.starts_with("scratch:"))
            .unwrap_or(false)
    {
        remove_scratch_chat_dir(chat_id);
    }
    Ok(())
}

/// Drop a chat that never received any messages. Returns true if purged.
fn discard_empty_chat(state: &AppState, chat_id: &str) -> Result<bool, String> {
    match state.store.load_chat(chat_id) {
        Ok(doc) if chat_has_no_turns(&doc) => {
            purge_chat(state, chat_id)?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(_) => {
            // Orphan index entry / missing file — clean it up.
            purge_chat(state, chat_id)?;
            Ok(true)
        }
    }
}

/// Remove every never-used draft (no turns) from the store.
fn prune_all_empty_chats(state: &AppState) -> Result<(), String> {
    let ids: Vec<String> = {
        let data = state.data.lock();
        data.chats.iter().map(|c| c.id.clone()).collect()
    };
    let active = state.data.lock().active_chat_id.clone();
    for id in ids {
        // Keep the currently open draft so the user can still type into it.
        if active.as_deref() == Some(&id) {
            continue;
        }
        let _ = discard_empty_chat(state, &id);
    }
    Ok(())
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, AppState>) -> Result<BootstrapResponse, String> {
    // Drop abandoned empty drafts so they never accumulate in the sidebar.
    let _ = prune_all_empty_chats(&state);

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

    // Drop existing connection for this environment — fail any in-flight
    // session/prompt first so turns don't stay "streaming" after reconnect.
    {
        let mut agents = state.agents.lock();
        if let Some(old) = agents.remove(&env_id) {
            old.fail_all_pending(&format!(
                "Agent for {env_id} was replaced (reconnect)"
            ));
        }
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

    // Fail in-flight prompts before dropping the connection.
    if let Some(conn) = state.agents.lock().remove(&env_id) {
        conn.fail_all_pending(&format!("Disconnected agent ({env_id})"));
    }
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

/// List (or search) directories on an SSH environment for the remote folder browser.
#[tauri::command]
pub async fn list_remote_dir(
    state: State<'_, AppState>,
    environment_id: String,
    path: Option<String>,
    query: Option<String>,
) -> Result<RemoteDirListing, String> {
    let env = {
        let data = state.data.lock();
        env_from_data(&data, &environment_id)?
    };
    if env.is_local() {
        return Err("list_remote_dir is only for SSH environments".into());
    }
    let host = env
        .ssh_host
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SSH environment missing host".to_string())?;
    list_remote_directory(host, path.as_deref(), query.as_deref())
        .await
        .map_err(|e| e.to_string())
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

    // Reuse an unused draft in this project instead of stacking empty chats.
    let prev_active = state.data.lock().active_chat_id.clone();
    if let Some(ref aid) = prev_active {
        if let Ok(doc) = state.store.load_chat(aid) {
            if doc.project_id == project_id && chat_has_no_turns(&doc) {
                let mut data = state.data.lock();
                data.active_chat_id = Some(doc.id.clone());
                data.active_project_id = Some(doc.project_id.clone());
                data.active_environment_id = Some(env_id);
                state.store.save_index(&data).map_err(|e| e.to_string())?;
                return Ok(doc);
            }
        }
    }

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
    // Draft is written so the session has a stable id/cwd; it is purged if the
    // user leaves without sending any messages (see set_active_chat / prune).
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

    // Leaving an unused draft behind when starting a new one.
    if let Some(prev) = prev_active {
        if prev != doc.id {
            let _ = discard_empty_chat(&state, &prev);
        }
    }

    Ok(doc)
}

#[tauri::command]
pub fn get_chat(state: State<'_, AppState>, chat_id: String) -> Result<ChatDocument, String> {
    load_chat_doc(&state, &chat_id)
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
    purge_chat(&state, &chat_id)?;
    // If we deleted the active chat, point at another remaining chat.
    let mut data = state.data.lock();
    if data.active_chat_id.is_none() {
        data.active_chat_id = data.chats.first().map(|c| c.id.clone());
        state.store.save_index(&data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Switch active chat. If the previous chat had no messages, it is discarded
/// (not kept as a permanent "New chat" entry). Returns the discarded id, if any.
/// Also keeps `active_project_id` (and env when known) aligned with the chat so
/// cold start / bootstrap restore the correct sidebar + files tree.
#[tauri::command]
pub fn set_active_chat(
    state: State<'_, AppState>,
    chat_id: Option<String>,
) -> Result<Option<String>, String> {
    let prev = {
        let mut data = state.data.lock();
        let prev = data.active_chat_id.clone();
        data.active_chat_id = chat_id.clone();
        if let Some(ref id) = chat_id {
            let project_id = data
                .chats
                .iter()
                .find(|c| c.id == *id)
                .map(|c| c.project_id.clone());
            if let Some(project_id) = project_id {
                data.active_project_id = Some(project_id.clone());
                let env_id = data
                    .projects
                    .iter()
                    .find(|p| p.id == project_id)
                    .map(|p| p.environment_id.clone())
                    .filter(|e| !e.is_empty());
                if let Some(env_id) = env_id {
                    data.active_environment_id = Some(env_id);
                }
            }
        }
        state.store.save_index(&data).map_err(|e| e.to_string())?;
        prev
    };

    let mut discarded = None;
    if let Some(prev_id) = prev {
        if chat_id.as_ref() != Some(&prev_id) && discard_empty_chat(&state, &prev_id)? {
            discarded = Some(prev_id);
        }
    }
    Ok(discarded)
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
    put_chat_doc(&state, doc.clone(), true)?;
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
    let turn_id2 = turn_id.clone();
    let app2 = app.clone();
    let chat_write = Arc::clone(&state.chat_write);
    let blocks = prompt_blocks;
    let live_chats = Arc::clone(&state.live_chats);
    let cancelling = Arc::clone(&state.cancelling_sessions);
    let store = state.store.clone();
    tokio::spawn(async move {
        let result = agent2.session_prompt_blocks(&session_id, blocks).await;

        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut finished_ok = result.is_ok();
        let mut finished_error: Option<String> = result.as_ref().err().map(|e| e.to_string());
        let mut stop_reason: Option<String> = None;

        {
            let _guard = chat_write.lock();
            // Prefer live (streamed) document over disk — disk may lag by design.
            let mut chat = live_chats
                .lock()
                .get(&chat_id)
                .cloned()
                .or_else(|| store.load_chat(&chat_id).ok());
            if let Some(ref mut chat) = chat {
                if let Some(t) = chat.turns.iter_mut().find(|t| t.id == turn_id2) {
                    match &result {
                        Ok(val) => {
                            let reason = val
                                .get("stopReason")
                                .or_else(|| val.get("stop_reason"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("end_turn");
                            stop_reason = Some(reason.to_string());
                            if reason == "cancelled" {
                                t.status = "cancelled".to_string();
                                for b in t.intermediate.iter_mut() {
                                    if let IntermediateBlock::Tool { status, .. } = b {
                                        if status == "pending"
                                            || status == "in_progress"
                                            || status == "running"
                                        {
                                            *status = "cancelled".to_string();
                                        }
                                    }
                                }
                            } else {
                                t.status = "complete".to_string();
                            }
                            t.intermediate_collapsed = true;
                        }
                        Err(err) => {
                            let msg = err.to_string();
                            let looks_cancelled = msg.to_lowercase().contains("cancel")
                                || msg.to_lowercase().contains("disconnected")
                                || msg.to_lowercase().contains("exited");
                            if looks_cancelled {
                                t.status = "cancelled".to_string();
                                finished_ok = true;
                                finished_error = None;
                                stop_reason = Some("cancelled".to_string());
                                for b in t.intermediate.iter_mut() {
                                    if let IntermediateBlock::Tool { status, .. } = b {
                                        if status == "pending"
                                            || status == "in_progress"
                                            || status == "running"
                                        {
                                            *status = "cancelled".to_string();
                                        }
                                    }
                                }
                            } else {
                                t.status = "error".to_string();
                                let note = format!("\n\n---\n**Turn failed:** {err}");
                                if t.assistant_message.is_empty() {
                                    t.assistant_message = format!("**Turn failed:** {err}");
                                } else if !t.assistant_message.contains("**Turn failed:**") {
                                    t.assistant_message.push_str(&note);
                                }
                            }
                            t.intermediate_collapsed = true;
                        }
                    }
                }
                chat.updated_at = now();
                let _ = store.save_chat(chat);
                live_chats.lock().insert(chat_id.clone(), chat.clone());
            }
        }

        cancelling.lock().remove(&session_id);

        let _ = app2.emit(
            "prompt-finished",
            json!({
                "chatId": chat_id,
                "turnId": turn_id2,
                "ok": finished_ok,
                "error": finished_error,
                "stopReason": stop_reason,
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
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> Result<(), String> {
    // IMPORTANT: do not take chat_write before talking to the agent.
    // During long tool runs (esp. shell), apply_session_update holds that lock
    // while rewriting multi‑MB chat JSON, which used to make Stop hang forever.
    let doc = state
        .store
        .load_chat(&chat_id)
        .map_err(|e| e.to_string())?;
    let sid = doc
        .acp_session_id
        .clone()
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

    // Drop further stream applies for this session so cancel isn't starved.
    state.cancelling_sessions.lock().insert(sid.clone());

    let agent = agent_for_env(&state, &env_id)?;
    // session_cancel also rejects pending permissions (required by ACP).
    agent
        .session_cancel(&sid)
        .await
        .map_err(|e| e.to_string())?;

    // Which turn are we killing? Used so late events don't clobber a new turn.
    let cancelled_turn_id = doc
        .turns
        .iter()
        .rev()
        .find(|t| t.status == "streaming" || t.status == "cancelling")
        .map(|t| t.id.clone());

    // Persist cancelled on disk without blocking Stop on a fat write.
    // Frontend already unlocked optimistically; this keeps disk/UI consistent.
    let chat_write = Arc::clone(&state.chat_write);
    let store_path = state.store.data_dir().to_path_buf();
    let chat_id_bg = chat_id.clone();
    let app_bg = app.clone();
    let sid_bg = sid.clone();
    let turn_id_bg = cancelled_turn_id.clone();
    let cancelling = Arc::clone(&state.cancelling_sessions);
    tokio::spawn(async move {
        let mut saved = false;
        for attempt in 0..40 {
            if let Some(_guard) = chat_write.try_lock() {
                let chat_file = store_path
                    .join("chats")
                    .join(format!("{chat_id_bg}.json"));
                if let Ok(raw) = std::fs::read_to_string(&chat_file) {
                    if let Ok(mut chat) = serde_json::from_str::<ChatDocument>(&raw) {
                        let target = turn_id_bg.as_ref();
                        if let Some(t) = chat.turns.iter_mut().rev().find(|t| {
                            if let Some(id) = target {
                                &t.id == id
                            } else {
                                t.status == "streaming" || t.status == "cancelling"
                            }
                        }) {
                            t.status = "cancelled".into();
                            t.intermediate_collapsed = true;
                            for b in t.intermediate.iter_mut() {
                                if let IntermediateBlock::Tool { status, .. } = b {
                                    if status == "pending"
                                        || status == "in_progress"
                                        || status == "running"
                                    {
                                        *status = "cancelled".into();
                                    }
                                }
                            }
                            chat.updated_at = now();
                            let _ = std::fs::write(
                                &chat_file,
                                serde_json::to_string_pretty(&chat).unwrap_or_default(),
                            );
                            saved = true;
                        }
                    }
                }
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if attempt == 39 {
                let _guard = chat_write.lock();
                let chat_file = store_path
                    .join("chats")
                    .join(format!("{chat_id_bg}.json"));
                if let Ok(raw) = std::fs::read_to_string(&chat_file) {
                    if let Ok(mut chat) = serde_json::from_str::<ChatDocument>(&raw) {
                        let target = turn_id_bg.as_ref();
                        if let Some(t) = chat.turns.iter_mut().rev().find(|t| {
                            if let Some(id) = target {
                                &t.id == id
                            } else {
                                t.status == "streaming" || t.status == "cancelling"
                            }
                        }) {
                            t.status = "cancelled".into();
                            t.intermediate_collapsed = true;
                            for b in t.intermediate.iter_mut() {
                                if let IntermediateBlock::Tool { status, .. } = b {
                                    if status == "pending"
                                        || status == "in_progress"
                                        || status == "running"
                                    {
                                        *status = "cancelled".into();
                                    }
                                }
                            }
                            chat.updated_at = now();
                            let _ = std::fs::write(
                                &chat_file,
                                serde_json::to_string_pretty(&chat).unwrap_or_default(),
                            );
                            saved = true;
                        }
                    }
                }
            }
        }

        if saved {
            let _ = app_bg.emit("chat-updated", json!({ "chatId": chat_id_bg }));
        }

        // Keep dropping stream applies briefly, then clear the gate.
        // (Do NOT emit a synthetic prompt-finished here — it races a new turn
        // the user may have already started after Stop.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        cancelling.lock().remove(&sid_bg);
    });

    let _ = app.emit(
        "cancel-started",
        json!({
            "chatId": chat_id,
            "sessionId": sid,
            "turnId": cancelled_turn_id,
        }),
    );
    Ok(())
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

/// High-churn stream kinds that can debounce disk writes.
fn is_stream_chunk_kind(kind: &str) -> bool {
    matches!(
        kind,
        "agent_message_chunk" | "agent_thought_chunk" | "tool_call_update"
    )
}

/// Apply a single session/update into the chat's last turn.
/// Returns the update kind when the event was considered (for flush decisions).
fn apply_one_update(doc: &mut ChatDocument, update: &Value) -> Option<String> {
    let Some(turn) = doc.turns.last_mut() else {
        return None;
    };
    // Already stopped — don't append more content to a dead turn.
    if turn.status == "cancelled" || turn.status == "cancelling" {
        return None;
    }

    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    // While subagents are running, Grok fans their thought/message chunks into the
    // parent session *without* messageIds — that produced the interleaved garbage UI.
    // Park parent text/thoughts only when no subagent is open; child reports arrive
    // cleanly on `subagent_finished.output`.
    let open_subagents = count_open_subagents(turn);

    match kind.as_str() {
        "agent_message_chunk" => {
            if turn.status == "cancelled" {
                // keep whatever we have
            } else if open_subagents > 0 {
                // Drop interleaved child fan-in; final text comes on subagent_finished.
            } else {
                let text = extract_chunk_text(&update);
                if !text.is_empty() {
                    let message_id = update
                        .get("messageId")
                        .or_else(|| update.get("message_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    append_agent_message(turn, message_id, &text);
                }
            }
        }
        "agent_thought_chunk" => {
            if open_subagents > 0 {
                // Same: child thoughts fan into parent mid-subagent — ignore.
            } else {
                let text = extract_chunk_text(&update);
                if text.is_empty() {
                    // nothing
                } else {
                    let append_to_last = matches!(
                        turn.intermediate.last(),
                        Some(IntermediateBlock::Thought { .. })
                    );
                    if append_to_last {
                        if let Some(IntermediateBlock::Thought { text: existing, .. }) =
                            turn.intermediate.last_mut()
                        {
                            existing.push_str(&text);
                        }
                    } else {
                        turn.intermediate.push(IntermediateBlock::Thought {
                            id: new_id(),
                            text: text.to_string(),
                            collapsed: true,
                        });
                    }
                }
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

            // Grok emits spawn_subagent as a normal tool_call with variant "Task"
            // (not a dedicated sessionUpdate). Park it on the Subagent rail.
            if looks_like_subagent_spawn(raw_input.as_ref(), &title) {
                upsert_subagent_from_spawn_tool(
                    turn,
                    &tool_call_id,
                    &title,
                    &status,
                    raw_input.as_ref(),
                    content.as_ref(),
                    raw_output.as_ref(),
                );
            } else if looks_like_subagent_wait(raw_input.as_ref(), &title) {
                // Wait tool: don't clutter the main work list; fold outputs into cards.
                apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
            } else if !tool_call_id.is_empty() {
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
                        collapsed: true,
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
                    collapsed: true,
                });
            }
        }
        "tool_call_update" => {
            let tool_call_id = json_str(&update, "toolCallId", "tool_call_id").unwrap_or("");
            let title = update
                .get("title")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let raw_input = json_val(&update, "rawInput", "raw_input").cloned();
            let content = update.get("content").cloned();
            let raw_output = json_val(&update, "rawOutput", "raw_output").cloned();

            // Prefer matching a Subagent card created from a Task spawn.
            let mut handled_as_subagent = false;
            if !tool_call_id.is_empty() {
                if turn.intermediate.iter().any(|b| match b {
                    IntermediateBlock::Subagent {
                        tool_call_id: Some(id),
                        ..
                    } => id == tool_call_id,
                    _ => false,
                }) {
                    upsert_subagent_from_spawn_tool(
                        turn,
                        tool_call_id,
                        &title,
                        status.as_deref().unwrap_or("running"),
                        raw_input.as_ref(),
                        content.as_ref(),
                        raw_output.as_ref(),
                    );
                    handled_as_subagent = true;
                }
            }
            if !handled_as_subagent
                && looks_like_subagent_wait(raw_input.as_ref(), &title)
            {
                apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
                handled_as_subagent = true;
            }
            // Also fold wait results even when title/input arrive only on update.
            if !handled_as_subagent && (raw_output.is_some() || content.is_some()) {
                if raw_output
                    .as_ref()
                    .map(|v| v.get("MultiResult").is_some())
                    .unwrap_or(false)
                {
                    apply_subagent_wait_output(turn, content.as_ref(), raw_output.as_ref());
                    handled_as_subagent = true;
                }
            }

            if !handled_as_subagent {
                if let Some(IntermediateBlock::Tool {
                    status: st,
                    content: c,
                    raw_output: ro,
                    raw_input: ri,
                    title: t,
                    kind,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == tool_call_id,
                    _ => false,
                }) {
                    if let Some(s) = status {
                        *st = s;
                    }
                    if let Some(cv) = content {
                        *c = Some(cv);
                    }
                    if let Some(o) = raw_output {
                        *ro = Some(o);
                    }
                    if let Some(i) = raw_input {
                        *ri = Some(i);
                    }
                    if !title.is_empty() && title.len() >= t.len() {
                        *t = title;
                    }
                    if let Some(k) = update.get("kind").and_then(|s| s.as_str()) {
                        *kind = Some(k.to_string());
                    }
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
                    collapsed: true,
                });
            }
        }
        "user_message_chunk" => {}
        "subagent_spawned" => {
            let subagent_id = update
                .get("subagent_id")
                .or_else(|| update.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if subagent_id.is_empty() {
                // nothing
            } else if !turn.intermediate.iter().any(|b| match b {
                IntermediateBlock::Subagent { subagent_id: id, .. } => id == &subagent_id,
                _ => false,
            }) {
                let description = update
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Subagent")
                    .to_string();
                let model = update
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let subagent_type = update
                    .get("subagent_type")
                    .or_else(|| update.get("subagentType"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id,
                    tool_call_id: None,
                    description,
                    status: "running".into(),
                    model,
                    subagent_type,
                    output: String::new(),
                    collapsed: true,
                });
            }
        }
        "subagent_finished" => {
            let subagent_id = update
                .get("subagent_id")
                .or_else(|| update.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed")
                .to_string();
            let output = update
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(IntermediateBlock::Subagent {
                status: st,
                output: out,
                collapsed,
                ..
            }) = turn.intermediate.iter_mut().find(|b| match b {
                IntermediateBlock::Subagent { subagent_id: id, .. } => id == subagent_id,
                _ => false,
            }) {
                *st = status;
                if !output.is_empty() {
                    *out = output;
                }
                // Keep collapsed by default; user can expand the full report.
                *collapsed = true;
            } else if !subagent_id.is_empty() {
                // Finished without a spawn event (resume / missed spawn).
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id: subagent_id.to_string(),
                    tool_call_id: None,
                    description: "Subagent".into(),
                    status,
                    model: None,
                    subagent_type: None,
                    output,
                    collapsed: true,
                });
            }
        }
        "task_backgrounded" => {
            let task_id = update
                .get("task_id")
                .or_else(|| update.get("taskId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_call_id = update
                .get("tool_call_id")
                .or_else(|| update.get("toolCallId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let description = update
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("Background task")
                .to_string();
            let command = update
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Prefer updating matching tool status if we know the toolCallId.
            if let Some(ref tcid) = tool_call_id {
                if let Some(IntermediateBlock::Tool { status, title, .. }) =
                    turn.intermediate.iter_mut().find(|b| match b {
                        IntermediateBlock::Tool { tool_call_id: id, .. } => id == tcid,
                        _ => false,
                    })
                {
                    *status = "in_progress".into();
                    if !description.is_empty() && title.len() < description.len() {
                        *title = format!("[bg] {description}");
                    }
                }
            }
            if !task_id.is_empty()
                && !turn.intermediate.iter().any(|b| match b {
                    IntermediateBlock::Task { task_id: id, .. } => id == &task_id,
                    _ => false,
                })
            {
                turn.intermediate.push(IntermediateBlock::Task {
                    id: new_id(),
                    task_id,
                    tool_call_id,
                    description,
                    command,
                    status: "running".into(),
                    output: String::new(),
                    collapsed: true,
                });
            }
        }
        "task_completed" => {
            let snap = update.get("task_snapshot").cloned().unwrap_or(Value::Null);
            let task_id = snap
                .get("task_id")
                .or_else(|| snap.get("taskId"))
                .or_else(|| update.get("task_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let output = snap
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let exit_failed = snap
                .get("exit_code")
                .and_then(|v| v.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false)
                || snap
                    .get("explicitly_killed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            let status = if exit_failed {
                "failed".to_string()
            } else {
                "completed".to_string()
            };
            let linked_tool = {
                let mut linked = None;
                if let Some(IntermediateBlock::Task {
                    status: st,
                    output: out,
                    tool_call_id,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Task { task_id: id, .. } => id == task_id,
                    _ => false,
                }) {
                    *st = status.clone();
                    if !output.is_empty() {
                        *out = output.clone();
                    }
                    linked = tool_call_id.clone();
                }
                linked
            };
            if let Some(tcid) = linked_tool {
                if let Some(IntermediateBlock::Tool {
                    status: ts,
                    content,
                    raw_output,
                    ..
                }) = turn.intermediate.iter_mut().find(|b| match b {
                    IntermediateBlock::Tool { tool_call_id: id, .. } => id == &tcid,
                    _ => false,
                }) {
                    *ts = status;
                    if !output.is_empty() {
                        *content = Some(json!([{
                            "type": "content",
                            "content": { "type": "text", "text": output }
                        }]));
                        *raw_output = Some(json!({ "output": output }));
                    }
                }
            }
        }
        "turn_completed" => {
            // Belt-and-suspenders if session/prompt response is delayed.
            let reason = update
                .get("stop_reason")
                .or_else(|| update.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn");
            if turn.status == "streaming" {
                if reason == "cancelled" {
                    turn.status = "cancelled".into();
                } else {
                    turn.status = "complete".into();
                }
                turn.intermediate_collapsed = true;
            }
        }
        _ => {}
    }

    Some(kind)
}

/// Apply one or more streamed session/updates under a single write lock.
/// Batching is critical: per-token IPC + lock + full-doc clone was starving the UI
/// long after the agent had finished streaming.
fn apply_updates_inner(
    state: &AppState,
    chat_id: &str,
    updates: &[Value],
) -> Result<ChatDocument, String> {
    {
        // Prefer live cache for session id checks (disk may be stale mid-stream).
        let doc_peek = state
            .live_chats
            .lock()
            .get(chat_id)
            .cloned()
            .or_else(|| state.store.load_chat(chat_id).ok());
        if let Some(doc) = doc_peek {
            if let Some(sid) = doc.acp_session_id.as_ref() {
                if state.replaying_sessions.lock().contains(sid) {
                    return Ok(doc);
                }
                // User hit Stop — ignore further tool output so we don't thrash the
                // write lock (and so cancel_prompt / UI stay responsive).
                if state.cancelling_sessions.lock().contains(sid) {
                    return Ok(doc);
                }
            }
        }
    }

    let _guard = state.chat_write.lock();
    let mut doc = load_chat_doc(state, chat_id)?;
    if updates.is_empty() {
        return Ok(doc);
    }

    let mut force_disk = false;
    let mut saw_chunk = false;
    for update in updates {
        if let Some(kind) = apply_one_update(&mut doc, update) {
            if is_stream_chunk_kind(&kind) {
                saw_chunk = true;
            } else {
                force_disk = true;
            }
        }
    }

    doc.updated_at = now();
    // Always keep the live cache warm; only hit disk for structural updates or
    // every ~750ms for pure text chunks (huge win during streaming).
    let flush =
        force_disk || (saw_chunk && should_flush_disk(state, chat_id, "agent_message_chunk"));
    put_chat_doc(state, doc.clone(), flush)?;
    Ok(doc)
}

/// Apply a streamed session/update into the local chat document.
#[tauri::command]
pub fn apply_session_update(
    state: State<'_, AppState>,
    chat_id: String,
    update: Value,
) -> Result<ChatDocument, String> {
    apply_updates_inner(&state, &chat_id, std::slice::from_ref(&update))
}

/// Apply many session/updates in one lock + one IPC response (streaming fast-path).
#[tauri::command]
pub fn apply_session_updates(
    state: State<'_, AppState>,
    chat_id: String,
    updates: Vec<Value>,
) -> Result<ChatDocument, String> {
    apply_updates_inner(&state, &chat_id, &updates)
}

/// Text from an ACP content chunk update (`agent_message_chunk` / `agent_thought_chunk`).
fn extract_chunk_text(update: &Value) -> String {
    if let Some(text) = update.pointer("/content/text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    if let Some(content) = update.get("content") {
        if let Some(text) = content.as_str() {
            return text.to_string();
        }
        if let Some(text) = content.get("text").and_then(|t| t.as_str()) {
            return text.to_string();
        }
    }
    if let Some(text) = update.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    String::new()
}


/// Grok's spawn_subagent ACP surface: tool_call with variant Task / spawn_subagent.
fn looks_like_subagent_spawn(raw_input: Option<&Value>, title: &str) -> bool {
    if title.eq_ignore_ascii_case("spawn_subagent") || title.contains("spawn_subagent") {
        // Avoid treating a Grep for the string "spawn_subagent" as a spawn.
        if let Some(v) = raw_input {
            let variant = v
                .get("variant")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if variant.eq_ignore_ascii_case("Grep") || variant.eq_ignore_ascii_case("ReadFile") {
                return false;
            }
        }
    }
    let Some(v) = raw_input else {
        return title.eq_ignore_ascii_case("spawn_subagent");
    };
    let variant = v
        .get("variant")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        variant.as_str(),
        "task" | "spawn_subagent" | "spawnsubagent" | "subagent"
    ) {
        // Task variant is spawn; TaskOutput is the waiter.
        return v.get("prompt").is_some()
            || v.get("subagent_type").is_some()
            || v.get("subagentType").is_some()
            || v.get("description").is_some();
    }
    if v.get("subagent_type").is_some() || v.get("subagentType").is_some() {
        return v.get("prompt").is_some() || v.get("description").is_some();
    }
    // Heuristic: prompt + description + capability_mode is the spawn shape.
    v.get("prompt").is_some()
        && v.get("description").is_some()
        && (v.get("capability_mode").is_some()
            || v.get("capabilityMode").is_some()
            || v.get("isolation").is_some())
}

fn looks_like_subagent_wait(raw_input: Option<&Value>, title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    if t.contains("get_command_or_subagent_output")
        || t.contains("wait_commands_or_subagents")
        || t == "taskoutput"
    {
        return true;
    }
    let Some(v) = raw_input else {
        return false;
    };
    let variant = v
        .get("variant")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(variant.as_str(), "taskoutput" | "task_output" | "await_task") {
        return true;
    }
    v.get("task_ids").is_some() || v.get("taskIds").is_some()
}

fn value_text_blob(v: Option<&Value>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(s) = v.get("text").and_then(|t| t.as_str()) {
        return s.to_string();
    }
    if let Some(s) = v.pointer("/content/text").and_then(|t| t.as_str()) {
        return s.to_string();
    }
    // ACP content array: [{type, content:{text}}]
    if let Some(arr) = v.as_array() {
        let mut out = String::new();
        for item in arr {
            if let Some(t) = item
                .pointer("/content/text")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("text").and_then(|x| x.as_str()))
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    v.to_string()
}

fn parse_spawned_subagent_id(blob: &str) -> Option<String> {
    for line in blob.lines() {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("subagent_id:")
            .or_else(|| line.strip_prefix("subagentId:"))
            .or_else(|| line.strip_prefix("task_id:"))
            .or_else(|| line.strip_prefix("taskId:"))
        {
            let id = rest.trim().trim_matches('`').trim().to_string();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn map_tool_status_to_subagent(status: &str) -> String {
    match status {
        "completed" | "complete" | "success" => "running".into(), // spawn tool done ⇒ child still runs
        "failed" | "error" => "failed".into(),
        "cancelled" | "canceled" => "cancelled".into(),
        "pending" => "pending".into(),
        _ => "running".into(),
    }
}

fn upsert_subagent_from_spawn_tool(
    turn: &mut Turn,
    tool_call_id: &str,
    title: &str,
    status: &str,
    raw_input: Option<&Value>,
    content: Option<&Value>,
    raw_output: Option<&Value>,
) {
    let description = raw_input
        .and_then(|v| v.get("description").and_then(|d| d.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or(title)
        .to_string();
    let subagent_type = raw_input
        .and_then(|v| {
            v.get("subagent_type")
                .or_else(|| v.get("subagentType"))
                .and_then(|x| x.as_str())
        })
        .map(|s| s.to_string());
    let model = raw_input
        .and_then(|v| v.get("model").and_then(|x| x.as_str()))
        .map(|s| s.to_string());

    let blob = {
        let mut s = value_text_blob(raw_output);
        if s.is_empty() {
            s = value_text_blob(content);
        }
        s
    };
    let parsed_id = parse_spawned_subagent_id(&blob);
    let provisional_id = if !tool_call_id.is_empty() {
        tool_call_id.to_string()
    } else {
        description.clone()
    };
    let mut sub_status = map_tool_status_to_subagent(status);
    // If spawn failed, mark failed; if we already have final-looking output without "started", keep running.
    if status == "failed" || status == "error" {
        sub_status = "failed".into();
    }

    // Find existing by tool_call_id, real id, or description.
    let existing = turn.intermediate.iter_mut().find(|b| match b {
        IntermediateBlock::Subagent {
            tool_call_id: Some(tid),
            ..
        } if !tool_call_id.is_empty() && tid == tool_call_id => true,
        IntermediateBlock::Subagent { subagent_id, .. }
            if parsed_id.as_ref().map(|p| p == subagent_id).unwrap_or(false)
                || subagent_id == &provisional_id =>
        {
            true
        }
        IntermediateBlock::Subagent {
            description: d,
            status: st,
            output,
            ..
        } if d == &description
            && (st == "running" || st == "pending" || st == "in_progress")
            && output.is_empty() =>
        {
            true
        }
        _ => false,
    });

    if let Some(IntermediateBlock::Subagent {
        subagent_id,
        tool_call_id: tid,
        description: d,
        status: st,
        model: m,
        subagent_type: ty,
        ..
    }) = existing
    {
        if let Some(pid) = parsed_id {
            *subagent_id = pid;
        }
        if !tool_call_id.is_empty() {
            *tid = Some(tool_call_id.to_string());
        }
        if !description.is_empty() {
            *d = description;
        }
        *st = sub_status;
        if model.is_some() {
            *m = model;
        }
        if subagent_type.is_some() {
            *ty = subagent_type;
        }
    } else {
        turn.intermediate.push(IntermediateBlock::Subagent {
            id: new_id(),
            subagent_id: parsed_id.unwrap_or(provisional_id),
            tool_call_id: if tool_call_id.is_empty() {
                None
            } else {
                Some(tool_call_id.to_string())
            },
            description: if description.is_empty() {
                "Subagent".into()
            } else {
                description
            },
            status: sub_status,
            model,
            subagent_type,
            output: String::new(),
            collapsed: false, // open by default so the rail is visible
        });
    }
}

fn apply_subagent_wait_output(
    turn: &mut Turn,
    content: Option<&Value>,
    raw_output: Option<&Value>,
) {
    // MultiResult.results[] with command like "[subagent:explore] Desc" + output
    if let Some(results) = raw_output
        .and_then(|v| v.pointer("/MultiResult/results"))
        .and_then(|r| r.as_array())
        .or_else(|| {
            raw_output
                .and_then(|v| v.get("results"))
                .and_then(|r| r.as_array())
        })
    {
        for res in results {
            let command = res
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            let output = res
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("")
                .to_string();
            let exit_failed = res
                .get("exit_code")
                .and_then(|c| c.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false);
            let status = if exit_failed {
                "failed".to_string()
            } else {
                "completed".to_string()
            };

            // Parse "[subagent:explore] Summarize overall diff"
            let (parsed_type, parsed_desc) = parse_subagent_command_label(command);
            let task_id = res
                .get("task_id")
                .or_else(|| res.get("taskId"))
                .or_else(|| res.get("subagent_id"))
                .or_else(|| res.get("subagentId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let matched = turn.intermediate.iter_mut().find(|b| match b {
                IntermediateBlock::Subagent { subagent_id, .. }
                    if !task_id.is_empty() && subagent_id == task_id =>
                {
                    true
                }
                IntermediateBlock::Subagent { description, .. }
                    if !parsed_desc.is_empty() && description == &parsed_desc =>
                {
                    true
                }
                IntermediateBlock::Subagent {
                    description,
                    subagent_type,
                    status: st,
                    ..
                } if !parsed_desc.is_empty()
                    && description.contains(&parsed_desc)
                    && (st == "running" || st == "pending" || st == "in_progress")
                    && (parsed_type.is_empty()
                        || subagent_type.as_deref() == Some(parsed_type.as_str())) =>
                {
                    true
                }
                _ => false,
            });

            if let Some(IntermediateBlock::Subagent {
                status: st,
                output: out,
                subagent_type: ty,
                description: d,
                subagent_id,
                collapsed,
                ..
            }) = matched
            {
                *st = status;
                if !output.is_empty() {
                    *out = output;
                }
                if ty.is_none() && !parsed_type.is_empty() {
                    *ty = Some(parsed_type);
                }
                if d.is_empty() && !parsed_desc.is_empty() {
                    *d = parsed_desc;
                }
                if !task_id.is_empty() && (subagent_id.is_empty() || subagent_id.starts_with("call-"))
                {
                    *subagent_id = task_id.to_string();
                }
                *collapsed = false;
            } else if !parsed_desc.is_empty() || !task_id.is_empty() {
                turn.intermediate.push(IntermediateBlock::Subagent {
                    id: new_id(),
                    subagent_id: if task_id.is_empty() {
                        new_id()
                    } else {
                        task_id.to_string()
                    },
                    tool_call_id: None,
                    description: if parsed_desc.is_empty() {
                        "Subagent".into()
                    } else {
                        parsed_desc
                    },
                    status,
                    model: None,
                    subagent_type: if parsed_type.is_empty() {
                        None
                    } else {
                        Some(parsed_type)
                    },
                    output,
                    collapsed: false,
                });
            }
        }
        return;
    }

    // Single-result wait: whole blob is one subagent report.
    let blob = {
        let mut s = value_text_blob(raw_output);
        if s.is_empty() {
            s = value_text_blob(content);
        }
        s
    };
    if blob.is_empty() {
        return;
    }
    // Prefer the oldest running subagent without output.
    if let Some(IntermediateBlock::Subagent {
        status: st,
        output: out,
        collapsed,
        ..
    }) = turn.intermediate.iter_mut().find(|b| matches!(
        b,
        IntermediateBlock::Subagent { status, output, .. }
            if (status == "running" || status == "pending" || status == "in_progress")
                && output.is_empty()
    )) {
        *st = "completed".into();
        *out = blob;
        *collapsed = false;
    }
}

fn parse_subagent_command_label(command: &str) -> (String, String) {
    // "[subagent:explore] Summarize overall diff"
    let command = command.trim();
    if let Some(rest) = command.strip_prefix("[subagent:") {
        if let Some((ty, desc)) = rest.split_once(']') {
            return (
                ty.trim().to_string(),
                desc.trim().to_string(),
            );
        }
    }
    if let Some(rest) = command.strip_prefix("[subagent]") {
        return (String::new(), rest.trim().to_string());
    }
    (String::new(), command.to_string())
}

fn count_open_subagents(turn: &Turn) -> usize {
    turn.intermediate
        .iter()
        .filter(|b| matches!(
            b,
            IntermediateBlock::Subagent { status, .. }
                if status == "running" || status == "in_progress" || status == "pending"
        ))
        .count()
}

/// Append an agent text chunk as a timeline message block.
///
/// Grok often interleaves `agent_thought_chunk` mid-sentence. Those must NOT
/// split the parent answer into multiple bubbles. We skip trailing Thoughts
/// when finding the open message, append there, then move that message to the
/// end so the UI reads: [work/thoughts…] → [one continuous answer].
///
/// Tools / subagents / tasks / plans are hard boundaries (new message after).
fn append_agent_message(turn: &mut Turn, message_id: Option<String>, text: &str) {
    // Walk from the end: skip Thoughts only.
    let mut target_idx: Option<usize> = None;
    for (i, b) in turn.intermediate.iter().enumerate().rev() {
        match b {
            IntermediateBlock::Thought { .. } => continue,
            IntermediateBlock::Message {
                message_id: existing_id,
                ..
            } => {
                let same = match (existing_id.as_ref(), message_id.as_ref()) {
                    (Some(a), Some(b)) => a == b,
                    (None, None) => true,
                    (None, Some(_)) => true,
                    (Some(_), None) => true,
                };
                if same {
                    target_idx = Some(i);
                }
                break;
            }
            // Tool / Subagent / Task / Plan — hard boundary.
            _ => break,
        }
    }

    if let Some(i) = target_idx {
        if let IntermediateBlock::Message {
            message_id: existing_id,
            text: existing_text,
            ..
        } = &mut turn.intermediate[i]
        {
            if existing_id.is_none() {
                if let Some(id) = message_id {
                    *existing_id = Some(id);
                }
            }
            existing_text.push_str(text);
        }
        // Keep the growing answer after any intervening thoughts.
        if i + 1 != turn.intermediate.len() {
            let msg = turn.intermediate.remove(i);
            turn.intermediate.push(msg);
        }
    } else {
        turn.intermediate.push(IntermediateBlock::Message {
            id: new_id(),
            message_id,
            text: text.to_string(),
        });
    }

    rebuild_assistant_message(turn);
}

fn rebuild_assistant_message(turn: &mut Turn) {
    let parts: Vec<&str> = turn
        .intermediate
        .iter()
        .filter_map(|b| match b {
            IntermediateBlock::Message { text, .. } if !text.is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    turn.assistant_message = parts.join("\n\n");
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
                | IntermediateBlock::Subagent { id, collapsed: c, .. }
                | IntermediateBlock::Task { id, collapsed: c, .. }
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

// ── Project terminal ────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    chat_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalInfo, String> {
    let data = state.data.lock().clone();
    state.terminals.open(
        app,
        &data,
        &project_id,
        chat_id.as_deref(),
        cols.unwrap_or(120),
        rows.unwrap_or(24),
    )
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    state.terminals.write(&terminal_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminals.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    state.terminals.close(&terminal_id)
}

// ── Workspace filesystem (Files view) ───────────────────────────────────────

#[tauri::command]
pub fn list_workspace_dir(
    state: State<'_, AppState>,
    project_id: String,
    path: Option<String>,
    chat_id: Option<String>,
) -> Result<WorkspaceListing, String> {
    let data = state.data.lock().clone();
    let (project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;
    let rel = path.unwrap_or_default();

    if !remote {
        return list_local(std::path::Path::new(&root), &rel);
    }

    let env = data
        .environments
        .iter()
        .find(|e| e.id == project.environment_id)
        .ok_or_else(|| "environment not found".to_string())?;
    let host = env
        .ssh_host
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SSH host missing".to_string())?;
    list_remote(host, &root, &rel)
}

#[tauri::command]
pub fn read_workspace_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    chat_id: Option<String>,
) -> Result<WorkspaceFileContent, String> {
    let data = state.data.lock().clone();
    let (project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;

    if !remote {
        return read_local(std::path::Path::new(&root), &path);
    }

    let env = data
        .environments
        .iter()
        .find(|e| e.id == project.environment_id)
        .ok_or_else(|| "environment not found".to_string())?;
    let host = env
        .ssh_host
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SSH host missing".to_string())?;
    read_remote(host, &root, &path)
}

#[tauri::command]
pub fn git_workspace_status(
    state: State<'_, AppState>,
    project_id: String,
    chat_id: Option<String>,
) -> Result<WorkspaceGitStatus, String> {
    let data = state.data.lock().clone();
    let (project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;

    if !remote {
        return Ok(git_status_local(std::path::Path::new(&root)));
    }

    let env = data
        .environments
        .iter()
        .find(|e| e.id == project.environment_id)
        .ok_or_else(|| "environment not found".to_string())?;
    let host = env
        .ssh_host
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SSH host missing".to_string())?;
    Ok(git_status_remote(host, &root))
}
