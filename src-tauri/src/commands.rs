use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::io::Read as _;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// File extensions the app can open (lowercase, no dot).
pub const SUPPORTED_EXTENSIONS: &[&str] = &["pdf", "docx"];

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

/// Display name for the recent list. Prefers a name supplied by the caller
/// (Android resolves the real one from the content provider); otherwise the
/// last path segment, or a generic title when a `content://` URI has none.
fn display_name(app: &tauri::AppHandle, file_path: &FilePath, given: Option<String>) -> String {
    if let Some(name) = given.filter(|n| !n.trim().is_empty()) {
        return name;
    }
    app.path()
        .file_name(&file_path.to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Document".to_string())
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

/// Android content:// grants (file picker, "open with", share sheet) usually
/// expire when the app restarts, so a recent entry pointing at the URI would
/// fail to reopen. Keep a private copy of such documents and record that path.
fn documents_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("documents");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create documents dir: {e}"))?;
    Ok(dir)
}

fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Stores `bytes` under a name derived from the document's name and size (so
/// opening the same file again reuses one copy) and returns its path.
fn store_private_copy(
    app: &tauri::AppHandle,
    name: &str,
    bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    let ext = if bytes.starts_with(b"%PDF") { "pdf" } else { "docx" };
    let key = fnv1a(&[name.as_bytes(), &(bytes.len() as u64).to_le_bytes()]);
    let path = documents_dir(app)?.join(format!("{key:016x}.{ext}"));
    if fs::metadata(&path).map(|m| m.len() != bytes.len() as u64).unwrap_or(true) {
        fs::write(&path, bytes).map_err(|e| format!("Failed to keep a copy of the file: {e}"))?;
    }
    Ok(path)
}

/// Deletes private copies that no recent entry points at any more.
pub fn prune_private_copies(app: &tauri::AppHandle, entries: &[RecentEntry]) {
    let Ok(dir) = documents_dir(app) else { return };
    let Ok(read) = fs::read_dir(&dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        let keep = entries
            .iter()
            .any(|e| Path::new(&e.path) == path.as_path());
        if !keep {
            let _ = fs::remove_file(path);
        }
    }
}

/// Reads a document's bytes, records it in the recent-files list, and
/// returns the bytes as an IPC response. Shared by both
/// `open_document_file` (native dialog) and `open_document_path`
/// (drag-drop / sidebar reopen / launch path). The frontend decides from
/// the bytes whether it is a PDF or a Word file.
fn open_filepath_and_record(
    app: &tauri::AppHandle,
    file_path: FilePath,
    name: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let existing = recent_files::load(app);
    // Reopening a recent entry passes only its stored path (for content://
    // documents that is the private copy, whose file name is a hash). Keep the
    // name the entry already has instead of replacing it with that file name.
    let name = match name.filter(|n| !n.trim().is_empty()) {
        Some(given) => given,
        None => existing
            .iter()
            .find(|e| e.path == file_path.to_string())
            .map(|e| e.name.clone())
            .unwrap_or_else(|| display_name(app, &file_path, None)),
    };
    let bytes = read_bytes(app, &file_path)?;
    let is_plain_path = file_path.as_path().is_some();
    let path_str = if is_plain_path {
        file_path.to_string()
    } else {
        // Falls back to the URI itself if the copy cannot be written.
        match store_private_copy(app, &name, &bytes) {
            Ok(copy) => copy.to_string_lossy().into_owned(),
            Err(_) => file_path.to_string(),
        }
    };

    let entries = existing;
    let entries = recent_files::upsert_and_trim(
        entries,
        &path_str,
        &name,
        recent_files::now_millis(),
        recent_files::RECENT_CAP,
    );
    // A private copy remembers where the document really came from, so
    // "Overwrite original" can target it instead of the copy.
    let entries = if is_plain_path {
        entries
    } else {
        recent_files::set_origin(entries, &path_str, &file_path.to_string())
    };
    recent_files::save(app, &entries)?;
    remember_current(app, &path_str, &entries);
    prune_private_copies(app, &entries);

    Ok(tauri::ipc::Response::new(bytes))
}

/// What "Overwrite original" writes to for the document on screen.
#[derive(Default)]
pub struct CurrentDocument(Mutex<Option<CurrentTarget>>);

struct CurrentTarget {
    /// The user's original file (a path, or a content:// URI).
    target: String,
    /// Our private copy to keep in step, when the target is a content:// URI.
    private_copy: Option<String>,
}

fn remember_current(app: &tauri::AppHandle, path_str: &str, entries: &[RecentEntry]) {
    let origin = entries
        .iter()
        .find(|e| e.path == path_str)
        .and_then(|e| e.origin.clone());
    let current = match origin {
        Some(origin) => CurrentTarget { target: origin, private_copy: Some(path_str.to_string()) },
        None => CurrentTarget { target: path_str.to_string(), private_copy: None },
    };
    if let Ok(mut slot) = app.state::<CurrentDocument>().0.lock() {
        *slot = Some(current);
    }
}

fn request_bytes(request: tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("Expected raw bytes".to_string()),
    }
}

fn header_text(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    // The frontend percent-encodes values so non-ASCII file names survive.
    let mut out = Vec::new();
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() { "document-annotated.pdf".to_string() } else { cleaned }
}

/// Desktop "Save as copy": asks where to save, then writes the bytes there.
#[tauri::command]
pub async fn save_pdf_copy(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let name = safe_file_name(&header_text(&request, "x-file-name").unwrap_or_default());
    let bytes = request_bytes(request)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF document", &["pdf"])
        .set_file_name(name)
        .blocking_save_file();
    let Some(file_path) = picked else {
        return Err("cancelled".to_string());
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("Could not use that location: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Android "Save as copy" step 1: stage the bytes in the app cache. The
/// Kotlin bridge then copies the staged file into the public Downloads folder.
#[tauri::command]
pub async fn stage_file(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let name = safe_file_name(&header_text(&request, "x-file-name").unwrap_or_default());
    let bytes = request_bytes(request)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {e}"))?
        .join("staged");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    let path = dir.join(name);
    fs::write(&path, bytes).map_err(|e| format!("Failed to stage file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// "Overwrite original": writes the bytes over the file the document was
/// opened from. Fails with "not-writable" when the system only granted read
/// access (typical for Android content:// URIs); the frontend then falls back
/// to saving a copy.
#[tauri::command]
pub async fn overwrite_current(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let bytes = request_bytes(request)?;
    let (target, private_copy) = {
        let state = app.state::<CurrentDocument>();
        let guard = state.0.lock().map_err(|_| "state".to_string())?;
        let current = guard.as_ref().ok_or_else(|| "no-document".to_string())?;
        (current.target.clone(), current.private_copy.clone())
    };

    let file_path: FilePath = target.parse().expect("FilePath parsing is infallible");
    if let Some(path) = file_path.as_path() {
        fs::write(path, &bytes).map_err(|_| "not-writable".to_string())?;
    } else {
        use std::io::Write as _;
        let mut file = app
            .fs()
            .open(
                file_path.clone(),
                OpenOptions::new().write(true).truncate(true).clone(),
            )
            .map_err(|_| "not-writable".to_string())?;
        file.write_all(&bytes).map_err(|_| "not-writable".to_string())?;
    }
    // Keep our private copy (what the recent list reopens) in step.
    if let Some(copy) = private_copy {
        let _ = fs::write(copy, &bytes);
    }
    Ok(())
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
        Some(path) => open_filepath_and_record(&app, path, None),
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_document_path(
    app: tauri::AppHandle,
    path: String,
    name: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let file_path: FilePath = path.parse().expect("FilePath parsing is infallible");
    open_filepath_and_record(&app, file_path, name)
}

/// Returns the document path passed on the command line, if any — this is
/// how Windows launches the app for "Open with" / file-association
/// double-click.
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| is_supported_document(arg))
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
    prune_private_copies(&app, &entries);
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
    fn rejects_other_files() {
        assert!(!is_supported_document("old.doc"));
        assert!(!is_supported_document("archive.docx.zip"));
        assert!(!is_supported_document("docx"));
        assert!(!is_supported_document("--flag"));
        assert!(!is_supported_document(""));
    }
}
