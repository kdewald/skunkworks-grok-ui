mod acp;
mod commands;
mod store;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new().expect("failed to open local store");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::connect_agent,
            commands::set_grok_path,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::set_active_project,
            commands::list_chats,
            commands::create_chat,
            commands::get_chat,
            commands::save_chat_document,
            commands::rename_chat,
            commands::delete_chat,
            commands::set_active_chat,
            commands::ensure_chat_session,
            commands::send_message,
            commands::cancel_prompt,
            commands::respond_permission,
            commands::apply_session_update,
            commands::set_turn_collapsed,
            commands::set_block_collapsed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
