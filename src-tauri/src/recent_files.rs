use serde::{Deserialize, Serialize};

pub const RECENT_CAP: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
    pub pinned: bool,
    /// For documents we keep a private copy of (Android content:// grants),
    /// the URI the user originally opened. "Overwrite original" targets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

pub fn upsert_and_trim(
    entries: Vec<RecentEntry>,
    path: &str,
    name: &str,
    opened_at: u64,
    cap: usize,
) -> Vec<RecentEntry> {
    // Capture the existing entry's pinned state if it exists, otherwise default to false
    let existing_pinned = entries.iter()
        .find(|e| e.path == path)
        .map(|e| e.pinned)
        .unwrap_or(false);

    let existing_origin = entries
        .iter()
        .find(|e| e.path == path)
        .and_then(|e| e.origin.clone());

    let mut without_target: Vec<RecentEntry> =
        entries.into_iter().filter(|e| e.path != path).collect();

    without_target.push(RecentEntry {
        path: path.to_string(),
        name: name.to_string(),
        opened_at,
        pinned: existing_pinned,
        origin: existing_origin,
    });

    let (mut pinned, mut unpinned): (Vec<_>, Vec<_>) =
        without_target.into_iter().partition(|e| e.pinned);

    unpinned.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    unpinned.truncate(cap);
    pinned.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));

    // Entries are re-sorted by timestamp at the end, so pinned and unpinned
    // entries are interleaved by most-recent-first. Grouping for display
    // (pinned vs. unpinned) happens in the frontend (Task 4's groupByPinned).
    let mut result: Vec<RecentEntry> = Vec::new();
    result.extend(unpinned);
    result.extend(pinned);
    result.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    result
}

pub fn toggle_pin(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    entries
        .into_iter()
        .map(|mut e| {
            if e.path == path {
                e.pinned = !e.pinned;
            }
            e
        })
        .collect()
}

/// Remembers the original URI behind a private copy.
pub fn set_origin(entries: Vec<RecentEntry>, path: &str, origin: &str) -> Vec<RecentEntry> {
    entries
        .into_iter()
        .map(|mut e| {
            if e.path == path {
                e.origin = Some(origin.to_string());
            }
            e
        })
        .collect()
}

pub fn remove_entry(entries: Vec<RecentEntry>, path: &str) -> Vec<RecentEntry> {
    entries.into_iter().filter(|e| e.path != path).collect()
}

use std::fs;
use tauri::Manager;

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app config dir: {e}"))?;
    Ok(dir.join("recent_files.json"))
}

pub fn load(app: &tauri::AppHandle) -> Vec<RecentEntry> {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_entries(&contents)
}

pub fn parse_entries(contents: &str) -> Vec<RecentEntry> {
    serde_json::from_str(contents).unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, entries: &[RecentEntry]) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Failed to serialize recent files: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write recent files: {e}"))
}

pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, opened_at: u64, pinned: bool) -> RecentEntry {
        RecentEntry {
            origin: None,
            path: path.to_string(),
            name: path.to_string(),
            opened_at,
            pinned,
        }
    }

    #[test]
    fn upsert_adds_new_entry_to_front() {
        let entries = vec![entry("a.pdf", 100, false)];
        let result = upsert_and_trim(entries, "b.pdf", "b.pdf", 200, 20);
        assert_eq!(result[0].path, "b.pdf");
        assert_eq!(result[1].path, "a.pdf");
    }

    #[test]
    fn upsert_bumps_existing_entry_to_front_and_updates_timestamp() {
        let entries = vec![entry("a.pdf", 100, false), entry("b.pdf", 50, false)];
        let result = upsert_and_trim(entries, "b.pdf", "b.pdf", 999, 20);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, "b.pdf");
        assert_eq!(result[0].opened_at, 999);
        assert_eq!(result[1].path, "a.pdf");
    }

    #[test]
    fn upsert_trims_non_pinned_entries_to_cap() {
        let mut entries = Vec::new();
        for i in 0..5 {
            entries.push(entry(&format!("f{i}.pdf"), i as u64, false));
        }
        let result = upsert_and_trim(entries, "new.pdf", "new.pdf", 999, 3);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].path, "new.pdf");
    }

    #[test]
    fn upsert_does_not_count_pinned_entries_against_cap() {
        let mut entries = vec![entry("pinned1.pdf", 1, true), entry("pinned2.pdf", 2, true)];
        for i in 0..5 {
            entries.push(entry(&format!("f{i}.pdf"), 10 + i as u64, false));
        }
        let result = upsert_and_trim(entries, "new.pdf", "new.pdf", 999, 3);
        let pinned_count = result.iter().filter(|e| e.pinned).count();
        let non_pinned_count = result.iter().filter(|e| !e.pinned).count();
        assert_eq!(pinned_count, 2);
        assert_eq!(non_pinned_count, 3);
    }

    #[test]
    fn toggle_pin_flips_pinned_flag() {
        let entries = vec![entry("a.pdf", 1, false)];
        let result = toggle_pin(entries, "a.pdf");
        assert!(result[0].pinned);
        let result = toggle_pin(result, "a.pdf");
        assert!(!result[0].pinned);
    }

    #[test]
    fn toggle_pin_on_unknown_path_is_a_noop() {
        let entries = vec![entry("a.pdf", 1, false)];
        let result = toggle_pin(entries.clone(), "missing.pdf");
        assert_eq!(result, entries);
    }

    #[test]
    fn remove_entry_filters_out_matching_path() {
        let entries = vec![entry("a.pdf", 1, false), entry("b.pdf", 2, false)];
        let result = remove_entry(entries, "a.pdf");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "b.pdf");
    }

    #[test]
    fn upsert_preserves_pinned_flag_on_existing_entry() {
        let entries = vec![entry("a.pdf", 100, true)];
        let result = upsert_and_trim(entries, "a.pdf", "a.pdf", 200, 20);
        assert_eq!(result[0].path, "a.pdf");
        assert_eq!(result[0].opened_at, 200);
        assert!(result[0].pinned);
    }

    #[test]
    fn parse_entries_round_trips_valid_json() {
        let entries = vec![entry("a.pdf", 100, false), entry("b.pdf", 200, true)];
        let json = serde_json::to_string(&entries).unwrap();
        let result = parse_entries(&json);
        assert_eq!(result, entries);
    }

    #[test]
    fn parse_entries_returns_empty_on_garbage_input() {
        let result = parse_entries("not valid json {{{");
        assert!(result.is_empty());
    }
}
