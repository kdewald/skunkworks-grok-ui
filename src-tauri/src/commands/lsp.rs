//! Language-server hub Tauri commands.
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::lsp::{rel_to_uri, LspServerStatus};
use crate::workspace_fs::resolve_workspace_root;

#[tauri::command]
pub fn lsp_status(state: State<'_, AppState>) -> Vec<LspServerStatus> {
    state.lsp.status_all()
}

#[tauri::command]
pub async fn lsp_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    project_id: String,
    chat_id: Option<String>,
) -> Result<LspServerStatus, String> {
    let data = state.data.lock().clone();
    let (_project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;
    if remote {
        return Err("LSP is only available for local workspaces".into());
    }
    let root = std::path::PathBuf::from(root);
    state.lsp.ensure(app, &server_id, root).await
}

#[tauri::command]
pub async fn lsp_stop(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<(), String> {
    state.lsp.stop(&server_id).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, AppState>,
    server_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    state.lsp.request(&server_id, &method, params).await
}

#[tauri::command]
pub async fn lsp_notify(
    state: State<'_, AppState>,
    server_id: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    state.lsp.notify(&server_id, &method, params).await
}

/// Build a file:// URI for a workspace-relative path (local only).
#[tauri::command]
pub fn lsp_file_uri(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    chat_id: Option<String>,
) -> Result<String, String> {
    let data = state.data.lock().clone();
    let (_project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;
    if remote {
        return Err("LSP URIs only for local workspaces".into());
    }
    Ok(rel_to_uri(std::path::Path::new(&root), &path))
}
