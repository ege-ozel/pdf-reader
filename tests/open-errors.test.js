import { describe, it, expect, vi } from "vitest";
import { reportOpenFailure, formatOpenError } from "../src/open-errors.js";

function effects(documentShowing) {
  return { documentShowing, setStatus: vi.fn(), showEmptyState: vi.fn() };
}

describe("reportOpenFailure", () => {
  it("keeps a document that is already on screen", () => {
    const fx = effects(true);
    reportOpenFailure("Something odd", fx);
    expect(fx.setStatus).toHaveBeenCalledWith("Error: Something odd");
    expect(fx.showEmptyState).not.toHaveBeenCalled();
  });

  it("falls back to the empty state when nothing was showing", () => {
    const fx = effects(false);
    reportOpenFailure("Corrupt header", fx);
    expect(fx.setStatus).toHaveBeenCalledWith("Error: Corrupt header");
    expect(fx.showEmptyState).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the file picker was cancelled", () => {
    const fx = effects(false);
    reportOpenFailure("cancelled", fx);
    expect(fx.setStatus).not.toHaveBeenCalled();
    expect(fx.showEmptyState).not.toHaveBeenCalled();
  });

  it("only reports through the given effects (no recent-list removal hook)", () => {
    const fx = effects(false);
    const extra = vi.fn();
    reportOpenFailure("offline", { ...fx, removeRecent: extra });
    expect(extra).not.toHaveBeenCalled();
  });
});

describe("formatOpenError", () => {
  it("formats strings, Errors and empty values", () => {
    expect(formatOpenError("boom")).toBe("Error: boom");
    expect(formatOpenError(new Error("bad pdf"))).toBe("Error: bad pdf");
    expect(formatOpenError(undefined)).toBe("Error: Could not open the document.");
  });
});

describe("unavailable files", () => {
  it("replaces raw provider errors with a readable message", () => {
    const raw = "Failed to open file: Permission Denial: reading content://x requires that you obtain access using ACTION_OPEN_DOCUMENT";
    expect(formatOpenError(raw)).toMatch(/no longer available/);
    expect(formatOpenError("Failed to read file: No such file or directory (os error 2)")).toMatch(/no longer available/);
  });
});
