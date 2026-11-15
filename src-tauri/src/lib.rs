// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod recent_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::PendingOpen::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_document_file,
            commands::open_document_path,
            commands::get_launch_path,
            commands::take_pending_open,
            commands::get_recent_files,
            commands::toggle_pin,
            commands::remove_recent_entry,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Android "Open with" (a VIEW intent) arrives as `Opened`, with
            // content:// URIs. Nothing else in the app listens for it, so
            // without this the document is silently dropped.
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            {
                if let tauri::RunEvent::Opened { urls } = event {
                    let paths: Vec<String> = urls.iter().map(|url| url.to_string()).collect();
                    commands::handle_external_open(app, &paths);
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            {
                let _ = (app, event);
            }
        });
}
