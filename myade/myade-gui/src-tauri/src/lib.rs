mod characters;
mod commands;
mod companion;
mod pane;
mod pty;
mod state;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::init_app,
            commands::create_pane,
            commands::close_pane,
            commands::list_panes,
            commands::list_characters,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_read_backlog,
            commands::open_companion_window,
            commands::companion_send_message,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Best-effort: tell the stage-1 shared daemon every pane in
            // this window is gone, so none of them linger forever in
            // pane_list.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<Arc<AppState>>();
                let myade_port = *state.myade_port.lock().unwrap();
                let panes = state.panes.lock().unwrap();
                for entry in panes.values() {
                    let pane_id = entry.myade_pane_id.lock().unwrap().clone();
                    if let Some(pane_id) = pane_id {
                        pane::register_end_blocking(myade_port, &pane_id);
                    }
                }
            }
        });
}
