//! Tauri commands bridging the frontend to ACP + local store.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::acp::AcpConnection;
use crate::store::{
    ensure_scratch_root, new_id, now, project_name_from_path, remove_scratch_chat_dir,
    resolve_session_cwd, AppData, ChatDocument, ChatMeta, FileAttachment, IntermediateBlock,
    PlanEntry, Project, Store, Turn, SCRATCH_PROJECT_ID,
};

pub struct AppState {
    pub store: Store,
    pub data: Mutex<AppData>,
    pub agent: Mutex<Option<Arc<AcpConnection>>>,
    pub grok_path: Mutex<Option<String>>,
    /// Serialize chat read-modify-write so concurrent stream chunks don't clobber each other.
    pub chat_write: Arc<Mutex<()>>,
    /// ACP session IDs already loaded into the current agent process.
    pub loaded_sessions: Mutex<HashSet<String>>,
    /// Sessions currently replaying history via session/load — ignore stream applies.
    pub replaying_sessions: Mutex<HashSet<String>>,
    /// Sessions that were recreated locally (old ACP id gone); next prompt should rehydrate context.
    pub needs_history_seed: Mutex<HashSet<String>>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let store = Store::open()?;
        let mut data = store.load_index().unwrap_or_default();
        // Always ensure the built-in scratch workspace exists.
        ensure_scratch_in_index(&store, &mut data).map_err(anyhow::Error::msg)?;
        Ok(Self {
            store,
            data: Mutex::new(data),
            agent: Mutex::new(None),
            grok_path: Mutex::new(None),
            chat_write: Arc::new(Mutex::new(())),
            loaded_sessions: Mutex::new(HashSet::new()),
            replaying_sessions: Mutex::new(HashSet::new()),
            needs_history_seed: Mutex::new(HashSet::new()),
        })
    }
}

fn ensure_scratch_in_index(store: &Store, data: &mut AppData) -> Result<(), String> {
    // Project path is only the scratch *root* for display; each chat gets its own subdir.
    let path = ensure_scratch_root().map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().to_string();

    if let Some(existing) = data
        .projects
        .iter_mut()
        .find(|p| p.id == SCRATCH_PROJECT_ID || p.is_scratch)
    {
        existing.id = SCRATCH_PROJECT_ID.to_string();
        existing.is_scratch = true;
        existing.name = "Scratch".into();
        existing.path = path_str;
        existing.updated_at = now();
    } else {
        let ts = now();
        data.projects.insert(
            0,
            Project {
                id: SCRATCH_PROJECT_ID.to_string(),
                name: "Scratch".into(),
                path: path_str,
                created_at: ts,
                updated_at: ts,
                is_scratch: true,
            },
        );
    }

    // Keep scratch first in the list
    if let Some(idx) = data.projects.iter().position(|p| p.id == SCRATCH_PROJECT_ID) {
        if idx != 0 {
            let p = data.projects.remove(idx);
            data.projects.insert(0, p);
        }
    }

    // Default selection: scratch if nothing active
    if data.active_project_id.is_none() {
        data.active_project_id = Some(SCRATCH_PROJECT_ID.to_string());
    }

    store.save_index(data).map_err(|e| e.to_string())
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
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, AppState>) -> Result<BootstrapResponse, String> {
    let data = state.data.lock().clone();
    let agent_connected = state.agent.lock().is_some();
    Ok(BootstrapResponse {
        data,
        data_dir: state.store.data_dir().display().to_string(),
        agent_connected,
    })
}

#[tauri::command]
pub async fn connect_agent(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // Drop existing
    {
        let mut slot = state.agent.lock();
        *slot = None;
    }
    state.loaded_sessions.lock().clear();
    state.replaying_sessions.lock().clear();
    // Keep needs_history_seed across reconnects? Clear it — new process, re-evaluate on ensure.
    state.needs_history_seed.lock().clear();

    let grok_path = state.grok_path.lock().clone();
    let conn = AcpConnection::spawn(app.clone(), grok_path)
        .await
        .map_err(|e| e.to_string())?;

    let init = conn.initialize().await.map_err(|e| e.to_string())?;
    let auth = conn
        .authenticate_cached()
        .await
        .map_err(|e| format!("authenticate: {e}"))?;

    *state.agent.lock() = Some(conn);

    let _ = app.emit(
        "agent-status",
        json!({
            "connected": true,
            "message": "Connected to Grok agent",
            "agentInfo": init,
            "auth": auth,
        }),
    );

    Ok(json!({ "initialize": init, "auth": auth }))
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
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    Ok(state.data.lock().projects.clone())
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, path: String) -> Result<Project, String> {
    let path = std::fs::canonicalize(&path)
        .map_err(|e| format!("invalid path: {e}"))?
        .to_string_lossy()
        .to_string();

    let mut data = state.data.lock();
    if let Some(existing) = data.projects.iter().find(|p| p.path == path) {
        return Ok(existing.clone());
    }

    let project = Project {
        id: new_id(),
        name: project_name_from_path(&path),
        path,
        created_at: now(),
        updated_at: now(),
        is_scratch: false,
    };
    data.projects.push(project.clone());
    data.active_project_id = Some(project.id.clone());
    state.store.save_index(&data).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
pub fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    if project_id == SCRATCH_PROJECT_ID {
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

    let chat_ids: Vec<String> = data
        .chats
        .iter()
        .filter(|c| c.project_id == project_id)
        .map(|c| c.id.clone())
        .collect();

    data.projects.retain(|p| p.id != project_id);
    data.chats.retain(|c| c.project_id != project_id);
    if data.active_project_id.as_deref() == Some(&project_id) {
        data.active_project_id = Some(SCRATCH_PROJECT_ID.to_string());
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
    // None / empty → Scratch (no-project chats)
    let project_id = project_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| SCRATCH_PROJECT_ID.to_string());

    // Refresh scratch root in case home moved / first use
    if project_id == SCRATCH_PROJECT_ID {
        let mut data = state.data.lock();
        ensure_scratch_in_index(&state.store, &mut data)?;
    }

    let project = {
        let data = state.data.lock();
        data.projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "project not found".to_string())?
            .clone()
    };
    let project_id = project.id.clone();

    // Allocate chat id first so scratch chats get an isolated cwd immediately.
    let chat_id = new_id();
    let session_cwd = resolve_session_cwd(&project, &chat_id).map_err(|e| e.to_string())?;

    let agent = state
        .agent
        .lock()
        .clone()
        .ok_or_else(|| "agent not connected — call connect_agent first".to_string())?;

    let result = agent
        .session_new(&session_cwd)
        .await
        .map_err(|e| e.to_string())?;
    let acp_session_id = result
        .get("sessionId")
        .and_then(|s| s.as_str())
        .ok_or_else(|| format!("session/new missing sessionId: {result}"))?
        .to_string();
    state
        .loaded_sessions
        .lock()
        .insert(acp_session_id.clone());

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
        meta.preview = updated
            .turns
            .last()
            .map(|t| {
                let preview = if !t.assistant_message.is_empty() {
                    t.assistant_message.clone()
                } else {
                    t.user_message.clone()
                };
                preview.chars().take(120).collect()
            });
    }
    // keep recency order
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
    // Capture project before removing meta so we can clean scratch dirs.
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
    // Scratch chats: per-chat isolated cwd under ~/.grok-ui/scratch/<chat-id>
    let session_cwd = resolve_session_cwd(&project, chat_id).map_err(|e| e.to_string())?;

    let agent = state
        .agent
        .lock()
        .clone()
        .ok_or_else(|| "agent not connected — call connect_agent first".to_string())?;

    // Already live in this agent process
    if let Some(sid) = doc.acp_session_id.clone() {
        if state.loaded_sessions.lock().contains(&sid) {
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
                "message": format!("Loading ACP session {sid} for chat {chat_id} (cwd={session_cwd})")
            }),
        );

        let load_result = agent.session_load(&sid, &session_cwd).await;
        state.replaying_sessions.lock().remove(&sid);

        match load_result {
            Ok(_) => {
                state.loaded_sessions.lock().insert(sid);
                state.needs_history_seed.lock().remove(chat_id);
                let _ = app.emit(
                    "session-ready",
                    json!({ "chatId": chat_id, "status": "loaded", "cwd": session_cwd }),
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
                        "message": format!("session/load failed for {sid}: {msg}; creating new session")
                    }),
                );
                // fall through to recreate
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

    state.loaded_sessions.lock().insert(new_sid);
    if had_history {
        state.needs_history_seed.lock().insert(chat_id.to_string());
    }

    let _ = app.emit(
        "session-ready",
        json!({ "chatId": chat_id, "status": status }),
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
        // Exclude the in-flight turn we just appended (last, empty assistant, matching text)
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
    let name = att
        .name
        .clone()
        .unwrap_or_else(|| {
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
    // Text must be valid UTF-8 (or mostly) for embedding
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
            // Prefer ACP embedded resource (agent advertises embeddedContext).
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
    // Legacy images field
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

    // Ensure the ACP session is loaded (or recreated) before prompting.
    let ensured = ensure_session_inner(&app, &state, &args.chat_id).await?;
    let mut doc = ensured.chat;

    let agent = state
        .agent
        .lock()
        .clone()
        .ok_or_else(|| "agent not connected".to_string())?;

    let acp_session_id = doc
        .acp_session_id
        .clone()
        .ok_or_else(|| "no ACP session after ensure".to_string())?;

    // Persist attachments under app data
    let data_dir = state.store.data_dir().to_path_buf();
    let mut attachments = Vec::new();
    for p in &payloads {
        attachments.push(save_attachment(&data_dir, &doc.id, p)?);
    }

    // Auto-title from first message
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
        intermediate_collapsed: false, // expand while streaming
        attachments: attachments.clone(),
        created_at: now(),
    };
    let turn_id = turn.id.clone();
    doc.turns.push(turn);
    doc.updated_at = now();
    state.store.save_chat(&doc).map_err(|e| e.to_string())?;
    sync_meta(&state, &doc)?;

    // If session was recreated, seed the agent with prior local turns once.
    let mut prompt_text = text.clone();
    if state.needs_history_seed.lock().remove(&args.chat_id) {
        prompt_text = build_history_seed(&doc, &text);
    }

    let prompt_blocks = build_prompt_blocks(&data_dir, &prompt_text, &attachments)?;

    let _ = app.emit(
        "chat-updated",
        json!({ "chatId": doc.id, "turnId": turn_id }),
    );

    // Spawn prompt in background so UI can stream via events
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

        // Brief grace period so the frontend IPC queue can drain any session/update
        // events that were emitted just before the prompt RPC returned.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        // Mark turn complete (under the same write lock as stream applies)
        {
            let _guard = chat_write.lock();
            let chat_file = store_path.join("chats").join(format!("{chat_id}.json"));
            if let Ok(raw) = std::fs::read_to_string(&chat_file) {
                if let Ok(mut chat) = serde_json::from_str::<ChatDocument>(&raw) {
                    if let Some(t) = chat.turns.iter_mut().find(|t| t.id == turn_id2) {
                        match &result {
                            Ok(_) => {
                                t.status = "complete".into();
                                t.intermediate_collapsed = true; // auto-collapse when done
                            }
                            Err(err) => {
                                t.status = "error".into();
                                if t.assistant_message.is_empty() {
                                    t.assistant_message = format!("Error: {err}");
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
        meta.preview = doc.turns.last().map(|t| {
            t.user_message.chars().take(120).collect::<String>()
        });
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
    let agent = state
        .agent
        .lock()
        .clone()
        .ok_or_else(|| "agent not connected".to_string())?;
    agent.session_cancel(&sid).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn respond_permission(
    state: State<'_, AppState>,
    request_id: u64,
    option_id: Option<String>,
    cancelled: bool,
) -> Result<(), String> {
    let agent = state
        .agent
        .lock()
        .clone()
        .ok_or_else(|| "agent not connected".to_string())?;
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
    // Skip history replay from session/load — local transcript is already the source of truth.
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

    // Ignore late chunks after the turn finished (except tool updates still useful).
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|s| s.as_str())
        .unwrap_or("");

    match kind {
        // NOTE: Do NOT gate message/thought chunks on status=="streaming".
        // session/prompt returns before the frontend IPC queue has drained, and the
        // finish handler may mark the turn complete while late chunks are still
        // in flight — dropping them truncates the answer (e.g. ends at "### Status").
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

            // Upsert by toolCallId so streaming "pending" + later rich title don't duplicate rows.
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
                    // Prefer the more descriptive title (e.g. "Read path" over "read_file")
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
