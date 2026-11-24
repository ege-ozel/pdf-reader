import { describe, it, expect, vi, beforeEach } from "vitest";

// src/save-service.js is the platform save layer (dialogs, Rust commands);
// it is mocked here so the flow is tested without Tauri.
vi.mock("../src/save-service.js", () => ({
  saveAnnotatedCopy: vi.fn(),
  overwriteOriginal: vi.fn(),
}));

import { saveAnnotatedCopy, overwriteOriginal } from "../src/save-service.js";
import { saveAnnotations, suggestAnnotatedName, pickDisplayName } from "../src/annotation-save.js";
import { createAnnotationStore } from "../src/annotations.js";

const ink = (page = 1) => ({ type: "ink", page, color: "#000000", width: 2, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] });

function setup() {
  const store = createAnnotationStore();
  const exported = new Uint8Array([9, 9, 9]);
  const exportAnnotatedPdf = vi.fn(async () => exported);
  const deps = {
    store,
    getBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getPages: vi.fn(async () => [{ toPdf: (x, y) => [x, y] }]),
    displayName: "Report.final.pdf",
    setStatus: vi.fn(),
    loadExporter: async () => ({ exportAnnotatedPdf }),
  };
  return { store, deps, exported, exportAnnotatedPdf };
}

beforeEach(() => {
  saveAnnotatedCopy.mockReset();
  overwriteOriginal.mockReset();
});

describe("suggestAnnotatedName", () => {
  it("replaces the extension with -annotated.pdf", () => {
    expect(suggestAnnotatedName("Report.final.pdf")).toBe("Report.final-annotated.pdf");
    expect(suggestAnnotatedName("notes")).toBe("notes-annotated.pdf");
  });

  it("strips directories and falls back to document", () => {
    expect(suggestAnnotatedName("C:\\docs\\Önemli belge.PDF")).toBe("Önemli belge-annotated.pdf");
    expect(suggestAnnotatedName("/home/u/a.pdf")).toBe("a-annotated.pdf");
    expect(suggestAnnotatedName("")).toBe("document-annotated.pdf");
    expect(suggestAnnotatedName(null)).toBe("document-annotated.pdf");
  });
});

describe("pickDisplayName", () => {
  const recent = [
    { path: "content://x/document/42", name: "Scan.pdf" },
    { path: "C:\\b.pdf", name: "b.pdf" },
  ];

  it("prefers the name the open flow was given", () => {
    expect(pickDisplayName({ name: "Given.pdf", path: "content://x/1", recentEntries: recent })).toBe("Given.pdf");
  });

  it("uses the recent entry for the path, else the path's file name", () => {
    expect(pickDisplayName({ path: "content://x/document/42", recentEntries: recent })).toBe("Scan.pdf");
    expect(pickDisplayName({ path: "D:\\docs\\c.pdf", recentEntries: recent })).toBe("c.pdf");
  });

  it("never uses an opaque content:// segment as a name", () => {
    expect(pickDisplayName({ path: "content://x/document/7", recentEntries: [] })).toBe("");
  });

  it("uses the newest recent entry for a dialog open (no path)", () => {
    expect(pickDisplayName({ recentEntries: recent })).toBe("Scan.pdf");
    expect(pickDisplayName({})).toBe("");
  });
});

describe("saveAnnotations", () => {
  it("exports the marks and saves a copy under the suggested name", async () => {
    const { store, deps, exported, exportAnnotatedPdf } = setup();
    store.add(ink(2));
    saveAnnotatedCopy.mockResolvedValue({ ok: true });

    const result = await saveAnnotations("copy", deps);

    expect(result.ok).toBe(true);
    expect(deps.getPages).toHaveBeenCalledWith([2]);
    expect(exportAnnotatedPdf).toHaveBeenCalledWith(expect.objectContaining({
      bytes: new Uint8Array([1, 2, 3]),
      marks: store.all(),
    }));
    expect(saveAnnotatedCopy).toHaveBeenCalledWith(exported, "Report.final-annotated.pdf");
    expect(overwriteOriginal).not.toHaveBeenCalled();
    expect(store.isDirty()).toBe(false);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Saved a copy with your marks");
  });

  it("overwrites the original and shows the service's message", async () => {
    const { store, deps, exported } = setup();
    store.add(ink());
    overwriteOriginal.mockResolvedValue({ ok: true, message: "Saved to Report.pdf" });

    await saveAnnotations("overwrite", deps);

    expect(overwriteOriginal).toHaveBeenCalledWith(exported, "Report.final-annotated.pdf");
    expect(saveAnnotatedCopy).not.toHaveBeenCalled();
    expect(store.isDirty()).toBe(false);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Saved to Report.pdf");
  });

  it("keeps the marks unsaved and reports an Error when the service fails", async () => {
    const { store, deps } = setup();
    store.add(ink());
    overwriteOriginal.mockResolvedValue({ ok: false, message: "The file is read-only" });

    const result = await saveAnnotations("overwrite", deps);

    expect(result.ok).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(store.all()).toHaveLength(1);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Error: The file is read-only");
  });

  it("does not double the Error prefix", async () => {
    const { store, deps } = setup();
    store.add(ink());
    saveAnnotatedCopy.mockResolvedValue({ ok: false, message: "Error: disk full" });
    await saveAnnotations("copy", deps);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Error: disk full");
  });

  it("clears the status and keeps the marks when the user cancels", async () => {
    const { store, deps } = setup();
    store.add(ink());
    saveAnnotatedCopy.mockResolvedValue({ ok: false, cancelled: true });

    const result = await saveAnnotations("copy", deps);

    expect(result.cancelled).toBe(true);
    expect(store.isDirty()).toBe(true);
    expect(deps.setStatus).toHaveBeenLastCalledWith("");
  });

  it("reports an export failure as an Error and keeps the marks", async () => {
    const { store, deps } = setup();
    store.add(ink());
    deps.loadExporter = async () => ({
      exportAnnotatedPdf: async () => { throw new Error("Could not read the PDF to save annotations: encrypted"); },
    });

    const result = await saveAnnotations("copy", deps);

    expect(result.ok).toBe(false);
    expect(saveAnnotatedCopy).not.toHaveBeenCalled();
    expect(store.isDirty()).toBe(true);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Error: Could not read the PDF to save annotations: encrypted");
  });

  it("stays dirty when a mark was added while the save was running", async () => {
    const { store, deps } = setup();
    store.add(ink());
    saveAnnotatedCopy.mockImplementation(async () => {
      store.add(ink()); // drawn while the save dialog was open
      return { ok: true };
    });

    await saveAnnotations("copy", deps);

    expect(store.isDirty()).toBe(true);
  });

  it("does nothing but say so when there are no marks", async () => {
    const { deps } = setup();
    const result = await saveAnnotations("copy", deps);
    expect(result.ok).toBe(false);
    expect(saveAnnotatedCopy).not.toHaveBeenCalled();
    expect(deps.getBytes).not.toHaveBeenCalled();
  });
});
