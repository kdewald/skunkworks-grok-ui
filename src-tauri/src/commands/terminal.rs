//! Terminal PTY Tauri commands.
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::terminal::TerminalInfo;

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

