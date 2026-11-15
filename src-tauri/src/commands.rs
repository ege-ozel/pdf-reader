use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::io::Read as _;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// File extensions the app can open (lowercase, no dot).
pub const SUPPORTED_EXTENSIONS: &[&str] = &["pdf", "docx"];

/// Event sent to the window when another app hands it a document while it is
/// already running. The payload is the path or URI string.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub const EXTERNAL_OPEN_EVENT: &str = "external-open";

/// A document handed over from outside the app ("Open with") that the
/// frontend has not taken yet. It covers the cold start, where the event can
/// fire before the window is listening.
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Option<String>>);

/// The first non-blank path in an external open request.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub fn first_opened_path(paths: &[String]) -> Option<String> {
    paths.iter().find(|path| !path.trim().is_empty()).cloned()
}

/// Remembers an external open request for the frontend and tells a running
/// window to take it (see `take_pending_open`).
#[cfg_attr(
    not(any(target_os = "macos", target_os = "ios", target_os = "android")),
    allow(dead_code)
)]
pub fn handle_external_open(app: &tauri::AppHandle, paths: &[String]) {
    let Some(path) = first_opened_path(paths) else {
        return;
    };
    let pending = app.state::<PendingOpen>();
    if let Ok(mut slot) = pending.0.lock() {
        *slot = Some(path.clone());
    }
    let _ = app.emit(EXTERNAL_OPEN_EVENT, path);
}

/// True when `path` ends in one of `SUPPORTED_EXTENSIONS`, ignoring case.
pub fn is_supported_document(path: &str) -> bool {
    let lower = path.to_lowercase();
    SUPPORTED_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

fn file_name_or_path(app: &tauri::AppHandle, file_path: &FilePath) -> Result<String, String> {
    let path = file_path.to_string();
    app.path()
        .file_name(&path)
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Could not retrieve the document name from file metadata".to_string())
}

/// Reads a document's bytes — via a direct filesystem read for a regular
/// path, or via the fs plugin's Android content-resolver bridge for a
/// `content://` URI (what the native file picker returns on Android/scoped
/// storage).
fn read_bytes(app: &tauri::AppHandle, file_path: &FilePath) -> Result<Vec<u8>, String> {
    if let Some(path) = file_path.as_path() {
        return read_file_bytes(path);
    }

    let mut file = app
        .fs()
        .open(file_path.clone(), OpenOptions::new().read(true).clone())
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(bytes)
}

/// Reads a document's bytes, records it in the recent-files list, and
/// returns the bytes as an IPC response. Shared by both
/// `open_document_file` (native dialog) and `open_document_path`
/// (drag-drop / sidebar reopen / launch path). The frontend decides from
/// the bytes whether it is a PDF or a Word file.
fn open_filepath_and_record(
    app: &tauri::AppHandle,
    file_path: FilePath,
) -> Result<tauri::ipc::Response, String> {
    let path_str = file_path.to_string();
    let name = file_name_or_path(app, &file_path)?;
    let bytes = read_bytes(app, &file_path)?;

    let entries = recent_files::load(app);
    let entries = recent_files::upsert_and_trim(
        entries,
        &path_str,
        &name,
        recent_files::now_millis(),
        recent_files::RECENT_CAP,
    );
    recent_files::save(app, &entries)?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn open_document_file(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("PDF or Word document", SUPPORTED_EXTENSIONS)
        .blocking_pick_file();

    match file_path {
        Some(path) => open_filepath_and_record(&app, path),
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_document_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let file_path: FilePath = path.parse().expect("FilePath parsing is infallible");
    open_filepath_and_record(&app, file_path)
}

/// Takes the document another app handed over ("Open with") and that the
/// window has not opened yet, so each hand-over is opened exactly once.
pub fn take_pending(app: &tauri::AppHandle) -> Option<String> {
    app.state::<PendingOpen>()
        .0
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// Returns the document this launch should open, if any: a document handed
/// over by the OS and not yet taken (Android "Open with"), else the document
/// path passed on the command line (Windows "Open with" / file-association
/// double-click).
#[tauri::command]
pub fn get_launch_path(app: tauri::AppHandle) -> Option<String> {
    take_pending(&app).or_else(|| {
        std::env::args()
            .skip(1)
            .find(|arg| is_supported_document(arg))
    })
}

/// Called by the window when `EXTERNAL_OPEN_EVENT` arrives. Taking the path
/// here (rather than using the event payload) clears it, so a later page
/// reload does not open the same document again.
#[tauri::command]
pub fn take_pending_open(app: tauri::AppHandle) -> Option<String> {
    take_pending(&app)
}

#[tauri::command]
pub fn get_recent_files(app: tauri::AppHandle) -> Vec<RecentEntry> {
    recent_files::load(&app)
}

#[tauri::command]
pub fn toggle_pin(app: tauri::AppHandle, path: String) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::toggle_pin(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn remove_recent_entry(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::remove_entry(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_existing_file_bytes() {
        let mut tmp = std::env::temp_dir();
        tmp.push("pdf_reader_test_read.bin");
        let mut f = fs::File::create(&tmp).unwrap();
        f.write_all(b"%PDF-1.4 test bytes").unwrap();

        let result = read_file_bytes(&tmp).unwrap();
        assert_eq!(result, b"%PDF-1.4 test bytes");

        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn errors_on_missing_file() {
        let missing = Path::new("this_file_does_not_exist_pdf_reader.pdf");
        let result = read_file_bytes(missing);
        assert!(result.is_err());
    }

    #[test]
    fn accepts_pdf_and_docx_in_any_case() {
        assert!(is_supported_document("a.pdf"));
        assert!(is_supported_document("C:\\Docs\\Report.PDF"));
        assert!(is_supported_document("/home/me/notes.docx"));
        assert!(is_supported_document("Notes.DocX"));
    }

    #[test]
    fn picks_first_non_blank_external_path() {
        let paths = vec![
            "  ".to_string(),
            "content://media/document/1".to_string(),
            "content://media/document/2".to_string(),
        ];
        assert_eq!(
            first_opened_path(&paths).as_deref(),
            Some("content://media/document/1")
        );
        assert_eq!(first_opened_path(&[]), None);
    }

    #[test]
    fn rejects_other_files() {
        assert!(!is_supported_document("old.doc"));
        assert!(!is_supported_document("archive.docx.zip"));
        assert!(!is_supported_document("docx"));
        assert!(!is_supported_document("--flag"));
        assert!(!is_supported_document(""));
    }
}
