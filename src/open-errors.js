// What a failed open does to the UI. Kept free of DOM/Tauri calls so it can
// be unit tested; main.js passes in the real effects.
//
// A failed open never touches the recent-files list: the entry may be pinned,
// its content:// grant may only have expired, or a USB/network path may be
// offline for now. The user can still remove it from the sidebar by hand.
// It also leaves a document that is already on screen alone; only when
// nothing is showing does it fall back to the empty state, so the viewer is
// never stranded blank.
export function reportOpenFailure(err, { documentShowing, setStatus, showEmptyState }) {
  if (err === "cancelled") return; // the user closed the file picker
  setStatus(formatOpenError(err));
  if (!documentShowing) showEmptyState();
}

const UNAVAILABLE_PATTERN =
  /permission denial|requires that you obtain access|no such file|not found|os error (2|3)|cannot find|failed to open file|failed to read file/i;

export const UNAVAILABLE_MESSAGE =
  "This file is no longer available (moved, deleted or access expired). Open it again with the open button, or remove it from the recent list.";

export function formatOpenError(err) {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (UNAVAILABLE_PATTERN.test(message)) return `Error: ${UNAVAILABLE_MESSAGE}`;
  return `Error: ${message || "Could not open the document."}`;
}
