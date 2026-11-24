// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod recent_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::CurrentDocument::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_document_file,
            commands::open_document_path,
            commands::get_launch_path,
            commands::get_recent_files,
            commands::toggle_pin,
            commands::remove_recent_entry,
            commands::save_pdf_copy,
            commands::stage_file,
            commands::overwrite_current,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
