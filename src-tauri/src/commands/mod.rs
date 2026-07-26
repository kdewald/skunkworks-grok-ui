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

use crate::acp::{AcpConnection, AgentSpawnTarget};
use crate::ssh::{
    ensure_remote_scratch_dir, list_remote_directory, list_ssh_config_hosts, probe_ssh_host,
    resolve_remote_project_path, RemoteDirListing,
};
use crate::store::{
    ensure_scratch_root, local_env_display_name, migrate_app_data, new_id, now,
    project_name_from_path, remote_scratch_display_path, remove_scratch_chat_dir,
    resolve_local_session_cwd, scratch_project_id_for_env, AppData, ChatDocument, ChatMeta,
    Environment, FileAttachment, IntermediateBlock, Project, Store, Turn,
    LOCAL_ENV_ID, SCRATCH_PROJECT_ID,
};
use crate::terminal::TerminalManager;
use crate::lsp::LspHub;

use crate::chat::session::{build_history_seed, is_unknown_session_error};
use crate::chat::transcript::{
    apply_one_update, is_stream_chunk_kind, promote_subagent_tools_in_doc,
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
    pub loaded_sessions: Arc<Mutex<HashMap<String, HashSet<String>>>>,
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
    /// Backend authority for in-flight prompts: chat_id → turn_id.
    /// Rejects concurrent send_message for the same chat until the prompt future settles.
    pub inflight_prompts: Arc<Mutex<HashMap<String, String>>>,
    /// Environments currently mid-connect (single-flight).
    pub connecting_envs: Mutex<HashSet<String>>,
    /// Chats currently mid ensure_session (single-flight).
    pub ensuring_chats: Mutex<HashSet<String>>,
    /// Interactive project terminals (local PTY / SSH).
    pub terminals: TerminalManager,
    /// Local language servers (stdio LSP).
    pub lsp: Arc<LspHub>,
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
            loaded_sessions: Arc::new(Mutex::new(HashMap::new())),
            replaying_sessions: Mutex::new(HashSet::new()),
            needs_history_seed: Mutex::new(HashSet::new()),
            cancelling_sessions: Arc::new(Mutex::new(HashSet::new())),
            live_chats: Arc::new(Mutex::new(HashMap::new())),
            last_disk_save: Mutex::new(HashMap::new()),
            inflight_prompts: Arc::new(Mutex::new(HashMap::new())),
            connecting_envs: Mutex::new(HashSet::new()),
            ensuring_chats: Mutex::new(HashSet::new()),
            terminals: TerminalManager::default(),
            lsp: Arc::new(LspHub::new()),
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

fn unmark_session_loaded(state: &AppState, environment_id: &str, session_id: &str) {
    if let Some(set) = state.loaded_sessions.lock().get_mut(environment_id) {
        set.remove(session_id);
    }
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
        // Inflight check + cache eviction + index mutation under one write lock
        // so a late apply cannot resurrect a ghost between steps.
        let _guard = state.chat_write.lock();
        if state.inflight_prompts.lock().contains_key(chat_id) {
            return Err(
                "chat has an in-flight prompt; cancel it before deleting".into(),
            );
        }

        state.live_chats.lock().remove(chat_id);
        state.last_disk_save.lock().remove(chat_id);
        state.needs_history_seed.lock().remove(chat_id);
        state.inflight_prompts.lock().remove(chat_id);

        let mut data = state.data.lock();
        let project_id = data
            .chats
            .iter()
            .find(|c| c.id == chat_id)
            .map(|c| c.project_id.clone());
        data.chats.retain(|c| c.id != chat_id);
        if data.active_chat_id.as_deref() == Some(chat_id) {
            data.active_chat_id = None;
        }
        state.store.save_index(&data).map_err(|e| e.to_string())?;
        let _ = state.store.delete_chat_file(chat_id);
        project_id
    };

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
pub async fn remove_environment(
    state: State<'_, AppState>,
    environment_id: String,
) -> Result<(), String> {
    if environment_id == LOCAL_ENV_ID {
        return Err("Cannot remove the local environment".into());
    }

    let (project_ids, chat_ids) = {
        let data = state.data.lock();
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
        (project_ids, chat_ids)
    };

    // Refuse *before* killing the agent so a failed remove leaves the connection.
    for id in &chat_ids {
        if state.inflight_prompts.lock().contains_key(id) {
            return Err(format!(
                "environment has an in-flight prompt in chat {id}; cancel first"
            ));
        }
    }

    // Drop live agent with explicit shutdown (kill child + fail pending).
    let old = { state.agents.lock().remove(&environment_id) };
    if let Some(conn) = old {
        conn.shutdown(&format!("Environment {environment_id} removed"))
            .await;
    }
    clear_loaded_for_env(&state, &environment_id);

    for id in &chat_ids {
        purge_chat(&state, id)?;
    }

    let mut data = state.data.lock();
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

    // Single-flight: concurrent connectAgent calls (bootstrap + selectChat) share one spawn.
    let claimed = {
        let mut connecting = state.connecting_envs.lock();
        if connecting.contains(&env_id) {
            false
        } else {
            connecting.insert(env_id.clone());
            true
        }
    };

    if !claimed {
        // Wait briefly for the in-progress connect to finish, then return current state.
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if !state.connecting_envs.lock().contains(&env_id) {
                break;
            }
        }
        if state.agents.lock().contains_key(&env_id) {
            return Ok(json!({
                "environmentId": env_id,
                "message": "Already connecting/connected",
                "alreadyConnected": true,
            }));
        }
        // Other attempt failed — claim and try ourselves.
        let mut connecting = state.connecting_envs.lock();
        if connecting.contains(&env_id) {
            return Err("connect already in progress".into());
        }
        connecting.insert(env_id.clone());
    }

    let connect_result = connect_agent_inner(&app, &state, &env_id).await;
    state.connecting_envs.lock().remove(&env_id);
    connect_result
}

async fn connect_agent_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    env_id: &str,
) -> Result<Value, String> {
    // Already connected and alive — no second process. Stale (dead) entries
    // are replaced below so EOF disconnects can recover.
    {
        let agents = state.agents.lock();
        if let Some(conn) = agents.get(env_id) {
            if conn.is_alive() {
                return Ok(json!({
                    "environmentId": env_id,
                    "message": "Already connected",
                    "alreadyConnected": true,
                }));
            }
        }
    }

    let env = {
        let mut data = state.data.lock();
        migrate_app_data(&mut data);
        ensure_scratch_in_index(&state.store, &mut data, env_id)?;
        env_from_data(&data, env_id)?
    };

    // Drop existing connection for this environment — fail + kill so the child
    // and reader task do not leak across reconnect.
    let old = { state.agents.lock().remove(env_id) };
    if let Some(old) = old {
        old.shutdown(&format!("Agent for {env_id} was replaced (reconnect)"))
            .await;
    }
    clear_loaded_for_env(state, env_id);

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

    let conn = AcpConnection::spawn(app.clone(), env_id.to_string(), target)
        .await
        .map_err(|e| e.to_string())?;

    let init = match conn.initialize().await {
        Ok(v) => v,
        Err(e) => {
            conn.shutdown(&format!("initialize failed: {e}")).await;
            return Err(format!("initialize on {label} failed: {e}"));
        }
    };
    let auth = match conn.authenticate_from_init(&init).await {
        Ok(v) => v,
        Err(e) => {
            conn.shutdown(&format!("authenticate failed: {e}")).await;
            return Err(format!("authenticate on {label} failed: {e}"));
        }
    };

    state.agents.lock().insert(env_id.to_string(), conn);

    // Remember active environment
    {
        let mut data = state.data.lock();
        data.active_environment_id = Some(env_id.to_string());
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
pub async fn disconnect_agent(
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

    // Fail in-flight prompts and kill the child before dropping the connection.
    // Take Arc out of the map before awaiting so we never hold a parking_lot guard.
    let old = { state.agents.lock().remove(&env_id) };
    if let Some(conn) = old {
        conn.shutdown(&format!("Disconnected agent ({env_id})"))
            .await;
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

    let chat_ids: Vec<String> = {
        let data = state.data.lock();
        if data
            .projects
            .iter()
            .any(|p| p.id == project_id && p.is_scratch)
        {
            return Err("Scratch workspace can't be removed".into());
        }
        data.chats
            .iter()
            .filter(|c| c.project_id == project_id)
            .map(|c| c.id.clone())
            .collect()
    };

    // Refuse if any chat in the project still has an in-flight prompt.
    {
        let inflight = state.inflight_prompts.lock();
        for id in &chat_ids {
            if inflight.contains_key(id) {
                return Err(format!(
                    "project has an in-flight prompt in chat {id}; cancel first"
                ));
            }
        }
    }

    for id in &chat_ids {
        purge_chat(&state, id)?;
    }

    let mut data = state.data.lock();
    let env_id = data
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.environment_id.clone())
        .unwrap_or_else(|| LOCAL_ENV_ID.to_string());

    data.projects.retain(|p| p.id != project_id);
    // purge_chat already removed chats; belt-and-suspenders.
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
    let _guard = state.chat_write.lock();
    let mut doc = load_chat_doc(&state, &chat_id)?;
    doc.title = title.clone();
    doc.updated_at = now();
    put_chat_doc(&state, doc.clone(), true)?;
    drop(_guard);

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
    // Single-flight per chat: selectChat background ensure + send_message must
    // not both session/new and race-patch different ACP ids.
    let claimed = {
        let mut set = state.ensuring_chats.lock();
        if set.contains(chat_id) {
            false
        } else {
            set.insert(chat_id.to_string());
            true
        }
    };
    if !claimed {
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if !state.ensuring_chats.lock().contains(chat_id) {
                break;
            }
        }
        // Peer finished — return current live state.
        let doc = load_chat_doc(state, chat_id)?;
        return Ok(EnsureSessionResult {
            chat: doc,
            status: "already_active".into(),
            message: "Session ensure already in progress; using current document".into(),
        });
    }

    let result = ensure_session_work(app, state, chat_id).await;
    state.ensuring_chats.lock().remove(chat_id);
    result
}

async fn ensure_session_work(
    app: &AppHandle,
    state: &State<'_, AppState>,
    chat_id: &str,
) -> Result<EnsureSessionResult, String> {
    // Prefer the live document so we never clobber an in-flight turn/stream
    // with a lagging on-disk snapshot (that caused user messages to vanish).
    let doc = load_chat_doc(state, chat_id)?;

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

    // Already live in this agent process — re-read live so we never return a
    // pre-await clone that would clobber a concurrent send's turn.
    if let Some(sid) = doc.acp_session_id.clone() {
        if is_session_loaded(state, &env_id, &sid) {
            let live = load_chat_doc(state, chat_id).unwrap_or(doc);
            return Ok(EnsureSessionResult {
                chat: live,
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
                // Always return the *current* live doc, not the pre-await clone.
                let live = load_chat_doc(state, chat_id).unwrap_or(doc);
                return Ok(EnsureSessionResult {
                    chat: live,
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
    let had_history = !doc.turns.is_empty();
    let status = if doc.acp_session_id.is_some() {
        "recreated"
    } else {
        "created"
    };
    let old_sid = doc.acp_session_id.clone();

    let result = agent
        .session_new(&session_cwd)
        .await
        .map_err(|e| e.to_string())?;
    let new_sid = result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "session/new missing sessionId".to_string())?
        .to_string();

    // Re-load under the write lock and ONLY patch session id — never write back
    // the pre-await clone (stream applies may have advanced live_chats).
    let doc = patch_chat_session_id(state, chat_id, &env_id, old_sid.as_deref(), &new_sid)?;

    if had_history {
        state.needs_history_seed.lock().insert(chat_id.to_string());
    }

    let _ = app.emit(
        "session-ready",
        json!({
            "chatId": chat_id,
            "status": status,
            "environmentId": env_id,
            "sessionId": new_sid,
        }),
    );
    let _ = app.emit(
        "chat-updated",
        json!({ "chatId": chat_id, "sessionId": new_sid, "sessionRecreated": true }),
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

/// Patch only `acp_session_id` on the current live (or disk) doc under lock.
/// Compare-and-swap on `old_sid`: if another ensure/send already moved the
/// session, leave the document alone (caller may discard the orphaned new sid).
fn patch_chat_session_id(
    state: &AppState,
    chat_id: &str,
    env_id: &str,
    old_sid: Option<&str>,
    new_sid: &str,
) -> Result<ChatDocument, String> {
    let _guard = state.chat_write.lock();
    let mut doc = state
        .live_chats
        .lock()
        .get(chat_id)
        .cloned()
        .or_else(|| state.store.load_chat(chat_id).ok())
        .ok_or_else(|| format!("chat `{chat_id}` not found while patching session"))?;

    // CAS: if we expected a specific old id and the doc moved past it, abort.
    if let Some(expected_old) = old_sid {
        match doc.acp_session_id.as_deref() {
            Some(current) if current != expected_old => {
                // Another path already installed a different session.
                return Ok(doc);
            }
            _ => {}
        }
    }

    if let Some(old) = old_sid {
        unmark_session_loaded(state, env_id, old);
        state.cancelling_sessions.lock().remove(old);
    }
    doc.acp_session_id = Some(new_sid.to_string());
    doc.updated_at = now();
    state
        .live_chats
        .lock()
        .insert(chat_id.to_string(), doc.clone());
    state
        .store
        .save_chat(&doc)
        .map_err(|e| e.to_string())?;
    state
        .last_disk_save
        .lock()
        .insert(chat_id.to_string(), Instant::now());
    drop(_guard);

    mark_session_loaded(state, env_id, new_sid.to_string());
    sync_meta(state, &doc)?;
    Ok(doc)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Result of rolling a chat back to (and including) a turn for edit/resubmit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackToTurnResult {
    pub chat: ChatDocument,
    /// Original user text from the removed turn (for the editor).
    pub draft_text: String,
    /// Attachments re-encoded for a subsequent `send_message`.
    pub attachments: Vec<AttachmentPayload>,
    /// How many turns were dropped (including the edited one).
    pub removed_count: usize,
}

fn attachment_to_payload(
    data_dir: &std::path::Path,
    att: &FileAttachment,
) -> Result<AttachmentPayload, String> {
    use base64::Engine;
    let abs = data_dir.join(&att.path);
    let bytes = std::fs::read(&abs).map_err(|e| {
        format!(
            "could not re-read attachment `{}` ({}): {e}",
            att.name, att.path
        )
    })?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AttachmentPayload {
        kind: att.kind.clone(),
        data,
        mime_type: att.mime_type.clone(),
        name: Some(att.name.clone()),
        data_url: att.data_url.clone(),
    })
}

/// Truncate the chat at `turn_id` (remove that turn and everything after) and
/// invalidate the ACP session so the next send rehydrates from the shortened
/// transcript. Used for "edit previous message" / rollback.
#[tauri::command]
pub async fn rollback_to_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    turn_id: String,
) -> Result<RollbackToTurnResult, String> {
    // Best-effort cancel if a turn is still streaming.
    {
        let doc = load_chat_doc(&state, &chat_id)?;
        let streaming = doc
            .turns
            .iter()
            .any(|t| t.status == "streaming" || t.status == "cancelling");
        if streaming {
            let _ = cancel_prompt(app.clone(), state.clone(), chat_id.clone()).await;
            // Wait for the backend prompt registry to release — the finalizer
            // only clears after the agent settles (+150ms). A fixed 80ms sleep
            // made edit-resend race "chat already has an in-flight prompt".
            for _ in 0..100 {
                if !state.inflight_prompts.lock().contains_key(&chat_id) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            // Force-clear a stuck claim only if the live doc no longer has that turn.
            {
                let mut map = state.inflight_prompts.lock();
                if let Some(tid) = map.get(&chat_id).cloned() {
                    let still_there = load_chat_doc(&state, &chat_id)
                        .map(|d| d.turns.iter().any(|t| t.id == tid && t.status == "streaming"))
                        .unwrap_or(false);
                    if !still_there {
                        map.remove(&chat_id);
                    }
                }
            }
        }
    }

    let data_dir = state.store.data_dir().to_path_buf();

    let (doc, draft_text, attachments, removed_count, old_sid, env_id) = {
        let _guard = state.chat_write.lock();
        let mut doc = load_chat_doc(&state, &chat_id)?;
        let idx = doc
            .turns
            .iter()
            .position(|t| t.id == turn_id)
            .ok_or_else(|| format!("turn `{turn_id}` not found in chat"))?;

        let removed = doc.turns.split_off(idx);
        let target = removed
            .first()
            .ok_or_else(|| "nothing to roll back".to_string())?;
        let draft_text = target.user_message.clone();
        let mut attachments = Vec::new();
        for att in &target.attachments {
            match attachment_to_payload(&data_dir, att) {
                Ok(p) => attachments.push(p),
                Err(e) => {
                    let _ = app.emit(
                        "agent-log",
                        json!({
                            "level": "warn",
                            "message": format!("rollback: {e}"),
                        }),
                    );
                }
            }
        }
        let removed_count = removed.len();

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
        // Drop ACP session so the agent does not keep the rolled-back turns.
        let old_sid = doc.acp_session_id.take();
        if let Some(ref sid) = old_sid {
            unmark_session_loaded(&state, &env_id, sid);
            state.cancelling_sessions.lock().remove(sid);
        }
        // Next send creates a fresh session; rehydrate only if prior turns remain.
        if doc.turns.is_empty() {
            state.needs_history_seed.lock().remove(&chat_id);
        } else {
            state.needs_history_seed.lock().insert(chat_id.clone());
        }

        doc.updated_at = now();
        put_chat_doc(&state, doc.clone(), true)?;
        sync_meta(&state, &doc)?;
        (doc, draft_text, attachments, removed_count, old_sid, env_id)
    };

    // Outside the write lock — cancel may await the agent.
    if let Some(sid) = old_sid {
        if let Ok(agent) = agent_for_env(&state, &env_id) {
            let _ = agent.session_cancel(&sid).await;
        }
    }

    let _ = app.emit(
        "chat-updated",
        json!({ "chatId": doc.id, "rolledBack": true, "removedCount": removed_count }),
    );

    Ok(RollbackToTurnResult {
        chat: doc,
        draft_text,
        attachments,
        removed_count,
    })
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

    // Backend authority: one prompt per chat until the previous future settles.
    // Frontend queue is UX only — this prevents double-dispatch corruption.
    {
        let inflight = state.inflight_prompts.lock();
        if let Some(turn_id) = inflight.get(&args.chat_id) {
            return Err(format!(
                "chat already has an in-flight prompt (turn {turn_id}); wait or cancel"
            ));
        }
    }

    let ensured = ensure_session_inner(&app, &state, &args.chat_id).await?;

    let data_dir = state.store.data_dir().to_path_buf();
    let mut attachments = Vec::new();
    for p in &payloads {
        attachments.push(save_attachment(&data_dir, &args.chat_id, p)?);
    }

    // Append turn + claim inflight under the write lock so concurrent sends
    // cannot load/append/save racing copies of the same document.
    let (doc, turn_id, acp_session_id, env_id, agent) = {
        let _guard = state.chat_write.lock();
        if state.inflight_prompts.lock().contains_key(&args.chat_id) {
            return Err("chat already has an in-flight prompt; wait or cancel".into());
        }

        let mut doc = load_chat_doc(&state, &args.chat_id)?;
        if let Some(sid) = ensured.chat.acp_session_id.clone() {
            doc.acp_session_id = Some(sid);
        }

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

        // Do not start a new prompt while this session is still in the cancel gate.
        if state.cancelling_sessions.lock().contains(&acp_session_id) {
            return Err(
                "session is still settling after cancel; try again in a moment".into(),
            );
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
        // Claim *after* put+sync so a sync_meta I/O failure cannot leave a
        // permanent inflight lock with no prompt future to release it.
        sync_meta(&state, &doc)?;
        state
            .inflight_prompts
            .lock()
            .insert(args.chat_id.clone(), turn_id.clone());
        (doc, turn_id, acp_session_id, env_id, agent)
    };

    let mut prompt_text = text.clone();
    if state.needs_history_seed.lock().remove(&args.chat_id) {
        prompt_text = build_history_seed(&doc, &text);
    }

    let prompt_blocks = match build_prompt_blocks(&data_dir, &prompt_text, &attachments) {
        Ok(b) => b,
        Err(e) => {
            // Release claim so the chat is not permanently locked.
            let mut map = state.inflight_prompts.lock();
            if map.get(&args.chat_id).map(|t| t == &turn_id).unwrap_or(false) {
                map.remove(&args.chat_id);
            }
            return Err(e);
        }
    };

    let _ = app.emit(
        "chat-updated",
        json!({ "chatId": doc.id, "turnId": turn_id }),
    );

    let project_for_cwd = {
        let data = state.data.lock();
        data.projects
            .iter()
            .find(|p| p.id == doc.project_id)
            .cloned()
    };
    let project_for_cwd = match project_for_cwd {
        Some(p) => p,
        None => {
            let mut map = state.inflight_prompts.lock();
            if map.get(&args.chat_id).map(|t| t == &turn_id).unwrap_or(false) {
                map.remove(&args.chat_id);
            }
            return Err("project not found".into());
        }
    };
    let session_cwd = match resolve_session_cwd(&state, &project_for_cwd, &doc.id).await {
        Ok(c) => c,
        Err(e) => {
            let mut map = state.inflight_prompts.lock();
            if map.get(&args.chat_id).map(|t| t == &turn_id).unwrap_or(false) {
                map.remove(&args.chat_id);
            }
            return Err(e);
        }
    };

    let agent2 = agent.clone();
    let session_id_initial = acp_session_id.clone();
    let chat_id = doc.id.clone();
    let turn_id2 = turn_id.clone();
    let user_text = text.clone();
    let app2 = app.clone();
    let chat_write = Arc::clone(&state.chat_write);
    let blocks_initial = prompt_blocks;
    let live_chats = Arc::clone(&state.live_chats);
    let cancelling = Arc::clone(&state.cancelling_sessions);
    let loaded_sessions = Arc::clone(&state.loaded_sessions);
    let inflight_prompts = Arc::clone(&state.inflight_prompts);
    let store = state.store.clone();
    let data_dir2 = data_dir.clone();
    let attachments2 = attachments.clone();
    let env_id2 = env_id.clone();
    // Clone index path machinery via store for meta sync after recreate.
    tokio::spawn(async move {
        let mut session_id = session_id_initial.clone();
        let mut blocks = blocks_initial;
        let mut result = agent2.session_prompt_blocks(&session_id, blocks.clone()).await;

        // Stale session after agent restart: recreate once, re-seed history, retry.
        if let Err(err) = &result {
            let msg = err.to_string();
            if is_unknown_session_error(&msg) {
                let _ = app2.emit(
                    "agent-log",
                    json!({
                        "level": "warn",
                        "message": format!(
                            "session/prompt unknown session {session_id}; recreating and retrying"
                        ),
                        "environmentId": env_id2,
                    }),
                );
                match agent2.session_new(&session_cwd).await {
                    Ok(new_res) => {
                        if let Some(new_sid) = new_res
                            .get("sessionId")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                        {
                            // Patch live under write lock — only session id, keep stream state.
                            let patched = {
                                let _guard = chat_write.lock();
                                let mut chat = live_chats
                                    .lock()
                                    .get(&chat_id)
                                    .cloned()
                                    .or_else(|| store.load_chat(&chat_id).ok());
                                if let Some(ref mut chat) = chat {
                                    let old = chat.acp_session_id.clone();
                                    if let Some(ref o) = old {
                                        if let Some(set) =
                                            loaded_sessions.lock().get_mut(&env_id2)
                                        {
                                            set.remove(o);
                                        }
                                        cancelling.lock().remove(o);
                                    }
                                    chat.acp_session_id = Some(new_sid.clone());
                                    chat.updated_at = now();
                                    let _ = store.save_chat(chat);
                                    live_chats.lock().insert(chat_id.clone(), chat.clone());
                                    // Bookkeeping for ensure_session later.
                                    loaded_sessions
                                        .lock()
                                        .entry(env_id2.clone())
                                        .or_default()
                                        .insert(new_sid.clone());
                                    // Best-effort index meta so frontend session maps stay correct.
                                    if let Ok(mut data) = store.load_index() {
                                        if let Some(meta) =
                                            data.chats.iter_mut().find(|c| c.id == chat_id)
                                        {
                                            meta.acp_session_id = Some(new_sid.clone());
                                            meta.updated_at = chat.updated_at;
                                        }
                                        let _ = store.save_index(&data);
                                    }
                                    Some(chat.clone())
                                } else {
                                    None
                                }
                            };
                            let _ = app2.emit(
                                "chat-updated",
                                json!({
                                    "chatId": chat_id,
                                    "sessionId": new_sid,
                                    "sessionRecreated": true,
                                }),
                            );
                            // Rebuild prompt with full transcript seed for the empty session.
                            let seed_doc = patched.or_else(|| store.load_chat(&chat_id).ok());
                            if let Some(seed_doc) = seed_doc {
                                let seeded = build_history_seed(&seed_doc, &user_text);
                                if let Ok(seeded_blocks) =
                                    build_prompt_blocks(&data_dir2, &seeded, &attachments2)
                                {
                                    blocks = seeded_blocks;
                                }
                            }
                            session_id = new_sid;
                            result = agent2.session_prompt_blocks(&session_id, blocks).await;
                        }
                    }
                    Err(e) => {
                        let _ = app2.emit(
                            "agent-log",
                            json!({
                                "level": "error",
                                "message": format!("session/new after unknown session failed: {e}"),
                                "environmentId": env_id2,
                            }),
                        );
                    }
                }
            }
        }

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
                    // Never overwrite a user-cancelled status with complete/error
                    // from a late or racing prompt result.
                    let already_cancelled = t.status == "cancelled" || t.status == "cancelling";
                    match &result {
                        Ok(val) => {
                            let reason = val
                                .get("stopReason")
                                .or_else(|| val.get("stop_reason"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("end_turn");
                            stop_reason = Some(if already_cancelled {
                                "cancelled".to_string()
                            } else {
                                reason.to_string()
                            });
                            if already_cancelled || reason == "cancelled" {
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
                                // Leave running children as-is. Late subagent_finished /
                                // task_completed / tool terminal updates still apply after
                                // parent complete (see apply_one_update late-allow list).
                            }
                            t.intermediate_collapsed = true;
                        }
                        Err(err) => {
                            let msg = err.to_string();
                            let looks_cancelled = already_cancelled
                                || msg.to_lowercase().contains("cancel")
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
                                    if let IntermediateBlock::Subagent { status, .. } = b {
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
        // Release the send slot only for *this* turn (a newer claim would differ).
        {
            let mut map = inflight_prompts.lock();
            if map.get(&chat_id).map(|t| t == &turn_id2).unwrap_or(false) {
                map.remove(&chat_id);
            }
        }

        // Give the frontend a bit more time to apply trailing stream events
        // before UI treats the turn as fully sealed (late chunks still accepted
        // on complete for agent_message_chunk / child results).
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

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
    // Prefer live doc so we cancel the real session id / turn after mid-turn recreate.
    let doc = load_chat_doc(&state, &chat_id)?;
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

    // Which turn are we killing? Prefer live streaming turn.
    let cancelled_turn_id = doc
        .turns
        .iter()
        .rev()
        .find(|t| t.status == "streaming" || t.status == "cancelling")
        .map(|t| t.id.clone());

    // Stop racing a natural finish: if nothing is in the prompt registry,
    // do NOT insert cancelling_sessions (finalizer already ran — a gate here
    // would poison the session for ~30s with no finalizer to clear it).
    let had_inflight = state.inflight_prompts.lock().contains_key(&chat_id);
    if !had_inflight {
        // Best-effort cancel notify; never poison the gate.
        if let Ok(agent) = agent_for_env(&state, &env_id) {
            let _ = agent.session_cancel(&sid).await;
        }
        // Still paint cancelled if UI shows streaming (stale).
        if cancelled_turn_id.is_some() {
            let _guard = state.chat_write.lock();
            if let Ok(mut chat) = load_chat_doc(&state, &chat_id) {
                for t in chat.turns.iter_mut() {
                    if Some(&t.id) == cancelled_turn_id.as_ref()
                        || t.status == "streaming"
                        || t.status == "cancelling"
                    {
                        t.status = "cancelled".into();
                        t.intermediate_collapsed = true;
                    }
                }
                let _ = put_chat_doc(&state, chat, true);
            }
        }
        let _ = app.emit(
            "cancel-started",
            json!({
                "chatId": chat_id,
                "sessionId": sid,
                "turnId": cancelled_turn_id,
            }),
        );
        return Ok(());
    }

    // Mark live cancelled immediately so get_chat / ensure never re-report streaming.
    {
        let _guard = state.chat_write.lock();
        let mut live = state
            .live_chats
            .lock()
            .get(&chat_id)
            .cloned()
            .or_else(|| state.store.load_chat(&chat_id).ok());
        if let Some(ref mut chat) = live {
            let target = cancelled_turn_id.as_ref();
            for t in chat.turns.iter_mut() {
                let match_turn = if let Some(id) = target {
                    &t.id == id
                } else {
                    t.status == "streaming" || t.status == "cancelling"
                };
                if !match_turn {
                    continue;
                }
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
            }
            chat.updated_at = now();
            state
                .live_chats
                .lock()
                .insert(chat_id.clone(), chat.clone());
            // Best-effort disk; do not block agent cancel on a fat write.
            let _ = state.store.save_chat(chat);
        }
    }

    // Re-read live sid in case unknown-session retry swapped it mid-cancel.
    let live_sid = load_chat_doc(&state, &chat_id)
        .ok()
        .and_then(|d| d.acp_session_id)
        .unwrap_or_else(|| sid.clone());
    state.cancelling_sessions.lock().insert(live_sid.clone());
    if live_sid != sid {
        state.cancelling_sessions.lock().insert(sid.clone());
    }

    let agent = agent_for_env(&state, &env_id)?;
    agent
        .session_cancel(&live_sid)
        .await
        .map_err(|e| e.to_string())?;

    // Background re-assert cancelled on disk if a concurrent apply rewrote the file.
    let chat_write = Arc::clone(&state.chat_write);
    let live_chats = Arc::clone(&state.live_chats);
    let store = state.store.clone();
    let chat_id_bg = chat_id.clone();
    let app_bg = app.clone();
    let sid_bg = live_sid.clone();
    let sid_old = sid.clone();
    let turn_id_bg = cancelled_turn_id.clone();
    let cancelling = Arc::clone(&state.cancelling_sessions);
    tokio::spawn(async move {
        let mut saved = false;
        for attempt in 0..20 {
            if let Some(_guard) = chat_write.try_lock() {
                let mut chat = live_chats
                    .lock()
                    .get(&chat_id_bg)
                    .cloned()
                    .or_else(|| store.load_chat(&chat_id_bg).ok());
                if let Some(ref mut chat) = chat {
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
                        let _ = store.save_chat(chat);
                        live_chats
                            .lock()
                            .insert(chat_id_bg.clone(), chat.clone());
                        saved = true;
                    } else {
                        // Already cancelled on live — still flush disk.
                        let _ = store.save_chat(chat);
                        saved = true;
                    }
                }
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = attempt;
        }

        if saved {
            let _ = app_bg.emit("chat-updated", json!({ "chatId": chat_id_bg }));
        }

        // Safety net if the finalizer never runs (agent hang / kill path).
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        cancelling.lock().remove(&sid_bg);
        cancelling.lock().remove(&sid_old);
    });

    let _ = app.emit(
        "cancel-started",
        json!({
            "chatId": chat_id,
            "sessionId": live_sid,
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

/// Apply one or more streamed session/updates under a single write lock.
/// Batching is critical: per-token IPC + lock + full-doc clone was starving the UI
/// long after the agent had finished streaming.
fn apply_updates_inner(
    state: &AppState,
    chat_id: &str,
    updates: &[Value],
    expected_session_id: Option<&str>,
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
            // Reject batches from an invalidated session (post-rollback recreate).
            if let Some(expected) = expected_session_id {
                match doc.acp_session_id.as_deref() {
                    Some(current) if current == expected => {}
                    Some(_) => {
                        return Err(format!(
                            "session id mismatch for chat {chat_id}: batch={expected}, doc={}",
                            doc.acp_session_id.as_deref().unwrap_or("none")
                        ));
                    }
                    None => {
                        return Err(format!(
                            "session id mismatch for chat {chat_id}: batch={expected}, doc=none"
                        ));
                    }
                }
            }
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
    // Re-check session after lock (rollback may have recreated mid-flight).
    if let Some(expected) = expected_session_id {
        if doc.acp_session_id.as_deref() != Some(expected) {
            return Err(format!(
                "session id mismatch for chat {chat_id} after lock"
            ));
        }
    }
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
    session_id: String,
) -> Result<ChatDocument, String> {
    apply_updates_inner(
        &state,
        &chat_id,
        std::slice::from_ref(&update),
        Some(session_id.as_str()),
    )
}

/// Apply many session/updates in one lock + one IPC response (streaming fast-path).
#[tauri::command]
pub fn apply_session_updates(
    state: State<'_, AppState>,
    chat_id: String,
    updates: Vec<Value>,
    session_id: String,
) -> Result<ChatDocument, String> {
    apply_updates_inner(&state, &chat_id, &updates, Some(session_id.as_str()))
}

#[tauri::command]
pub fn set_turn_collapsed(
    state: State<'_, AppState>,
    chat_id: String,
    turn_id: String,
    collapsed: bool,
) -> Result<ChatDocument, String> {
    let _guard = state.chat_write.lock();
    let mut doc = load_chat_doc(&state, &chat_id)?;
    if let Some(t) = doc.turns.iter_mut().find(|t| t.id == turn_id) {
        t.intermediate_collapsed = collapsed;
    }
    put_chat_doc(&state, doc.clone(), true)?;
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
    let mut doc = load_chat_doc(&state, &chat_id)?;
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
    put_chat_doc(&state, doc.clone(), true)?;
    Ok(doc)
}

// ── Project terminal ────────────────────────────────────────────────────────

pub mod lsp;
pub mod terminal;
pub mod workspace;

pub use lsp::*;
pub use terminal::*;
pub use workspace::*;
