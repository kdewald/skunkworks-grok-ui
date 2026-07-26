//! Workspace filesystem Tauri commands.
use tauri::State;

use crate::commands::AppState;
use crate::workspace_fs::{
    git_status_local, git_status_remote, list_local, list_remote, read_local, read_remote,
    resolve_workspace_root, write_local, write_remote, WorkspaceFileContent, WorkspaceGitStatus,
    WorkspaceListing,
};

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

/// Write a text file in the project workspace (local or SSH).
#[tauri::command]
pub fn write_workspace_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
    chat_id: Option<String>,
) -> Result<(), String> {
    let data = state.data.lock().clone();
    let (project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;

    if !remote {
        return write_local(std::path::Path::new(&root), &path, &content);
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
    write_remote(host, &root, &path, &content)
}

/// Absolute local workspace root (for file:// URIs / LSP). Fails for SSH remotes.
#[tauri::command]
pub fn get_workspace_abs_root(
    state: State<'_, AppState>,
    project_id: String,
    chat_id: Option<String>,
) -> Result<String, String> {
    let data = state.data.lock().clone();
    let (_project, root, remote) =
        resolve_workspace_root(&data, &project_id, chat_id.as_deref())?;
    if remote {
        return Err("LSP is only available for local workspaces".into());
    }
    let path = std::path::PathBuf::from(&root);
    if !path.is_absolute() {
        return Err(format!("workspace root is not absolute: {root}"));
    }
    Ok(root)
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

