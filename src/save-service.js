// Saving a marked-up PDF. Two choices, both returning
// { ok, cancelled?, message? } and never throwing:
//
//   saveAnnotatedCopy  - a new file. Desktop: native "Save as" dialog.
//                        Android: written to the public Downloads folder.
//   overwriteOriginal  - writes over the file that was opened. If the system
//                        only allows read access to it (common on Android),
//                        a copy is saved instead and the message says so.
//
// The Rust commands take the PDF as the raw request body, with the file name
// percent-encoded in a header so non-ASCII names survive.

const { invoke } = window.__TAURI__.core;

function rawRequest(bytes, name) {
  return [bytes, { headers: { "x-file-name": encodeURIComponent(name) } }];
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err ?? "");
}

export async function saveAnnotatedCopy(bytes, suggestedName = "document-annotated.pdf") {
  try {
    const android = window.AndroidIntent?.saveToDownloads;
    if (android) {
      const staged = await invoke("stage_file", ...rawRequest(bytes, suggestedName));
      const saved = window.AndroidIntent.saveToDownloads(staged, suggestedName);
      if (!saved) return { ok: false, message: "Could not save to the Downloads folder." };
      return { ok: true, message: `Saved a copy to Downloads: ${saved}` };
    }
    const path = await invoke("save_pdf_copy", ...rawRequest(bytes, suggestedName));
    return { ok: true, message: `Saved a copy: ${path}` };
  } catch (err) {
    if (errorText(err) === "cancelled") return { ok: false, cancelled: true };
    return { ok: false, message: errorText(err) || "Could not save the file." };
  }
}

export async function overwriteOriginal(bytes, suggestedName = "document-annotated.pdf") {
  try {
    await invoke("overwrite_current", bytes);
    return { ok: true, message: "Saved over the original file." };
  } catch (err) {
    if (errorText(err) !== "not-writable") {
      return { ok: false, message: errorText(err) || "Could not save the file." };
    }
  }
  const copy = await saveAnnotatedCopy(bytes, suggestedName);
  if (copy.ok) {
    return {
      ok: true,
      message: `The original cannot be modified here, so a copy was saved instead. ${copy.message ?? ""}`.trim(),
    };
  }
  return copy;
}
