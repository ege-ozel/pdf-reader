// Keep in step with RECENT_CAP in src-tauri/src/recent_files.rs.
export const RECENT_CAP = 20;
const WARN_BEFORE_CAP = 5;

// Warning shown under the Recent list as it nears the cap: unstarred files
// beyond it are dropped automatically (and their stored copy deleted).
export function recentLimitNote(recentCount, cap = RECENT_CAP) {
  if (recentCount < cap - WARN_BEFORE_CAP) return null;
  return `Only the latest ${cap} recent files are kept. Older ones are removed automatically. Star a file to keep it.`;
}

export function groupByPinned(entries) {
  const pinned = entries
    .filter((e) => e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  const recent = entries
    .filter((e) => !e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  return { pinned, recent };
}
