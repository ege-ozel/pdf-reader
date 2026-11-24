// Saving marks: export them into the PDF with pdf-lib, then hand the bytes to
// the save service ("save as copy" or "overwrite original"). Everything
// platform-specific is injected, so this flow is testable without a DOM.
//
// The save service (src/save-service.js) and the exporter (pdf-lib, large)
// are imported lazily, on the first save: a problem in either then only
// breaks saving, never opening or reading documents.

const DEFAULT_MESSAGES = {
  copy: "Saved a copy with your marks",
  overwrite: "Saved your marks into the original file",
};

// "Report.final.pdf" -> "Report.final-annotated.pdf". Directories (and
// Windows separators) are stripped; an empty name falls back to "document".
export function suggestAnnotatedName(displayName) {
  const base = String(displayName ?? "").split(/[\\/]/).pop().trim();
  const stem = base.replace(/\.[^.]*$/, "").trim();
  return `${stem || "document"}-annotated.pdf`;
}

// Best display name for the open document: the name the open flow was given
// (Android content:// URIs carry one), else the recent-list entry for that
// path, else the newest recent entry (a dialog open has just been recorded,
// and recent entries come newest first), else the path's last segment.
export function pickDisplayName({ name = null, path = null, recentEntries = [] } = {}) {
  if (name) return name;
  if (path) {
    const match = recentEntries.find((entry) => entry.path === path);
    if (match?.name) return match.name;
    const segment = decodeURIComponentSafe(String(path).split(/[\\/]/).pop() ?? "");
    // A content:// URI's last segment is an opaque id, not a file name.
    if (segment && !String(path).includes("://")) return segment;
    return "";
  }
  return recentEntries[0]?.name ?? "";
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function errorText(message) {
  const text = String(message || "Could not save the file");
  return text.startsWith("Error") ? text : `Error: ${text}`;
}

// mode: "copy" | "overwrite". Resolves to the service's result shape
// { ok, cancelled?, message? }; never throws. Marks are kept on any failure.
// The store is only marked saved when nothing changed while saving (a mark
// added during the file picker is not in the written file).
export async function saveAnnotations(mode, {
  store,
  getBytes,
  getPages,
  displayName = "",
  setStatus = () => {},
  renderNoteImage = undefined,
  loadExporter = () => import("./pdf-export.js"),
  loadService = () => import("./save-service.js"),
}) {
  const marks = store.all();
  if (marks.length === 0) {
    setStatus("No marks to save yet");
    return { ok: false, message: "No marks to save yet" };
  }
  let changedDuringSave = false;
  const unsubscribe = store.subscribe(() => { changedDuringSave = true; });
  setStatus("Saving…");
  try {
    const [{ exportAnnotatedPdf }, service] = await Promise.all([loadExporter(), loadService()]);
    const bytes = await getBytes();
    const pages = await getPages(marks.map((m) => m.page));
    const out = await exportAnnotatedPdf({ bytes, marks, pages, renderNoteImage });
    // The name also goes to overwriteOriginal, for its fallback to saving a
    // copy when the original is not writable (Android content:// URIs).
    const suggestedName = suggestAnnotatedName(displayName);
    const result = mode === "overwrite"
      ? await service.overwriteOriginal(out, suggestedName)
      : await service.saveAnnotatedCopy(out, suggestedName);
    if (result?.ok) {
      if (!changedDuringSave) store.markSaved();
      setStatus(result.message || DEFAULT_MESSAGES[mode] || DEFAULT_MESSAGES.copy);
      return result;
    }
    if (result?.cancelled) {
      setStatus("");
      return result;
    }
    setStatus(errorText(result?.message));
    return { ok: false, ...result };
  } catch (err) {
    const message = errorText(err?.message || err);
    setStatus(message);
    return { ok: false, message };
  } finally {
    unsubscribe();
  }
}
