import { describe, it, expect } from "vitest";
import { groupByPinned, recentLimitNote } from "../src/recent-list.js";

function entry(path, opened_at, pinned) {
  return { path, name: path, opened_at, pinned };
}

describe("groupByPinned", () => {
  it("splits entries into pinned and recent groups", () => {
    const entries = [
      entry("a.pdf", 300, true),
      entry("b.pdf", 200, false),
      entry("c.pdf", 100, false),
    ];
    const { pinned, recent } = groupByPinned(entries);
    expect(pinned.map((e) => e.path)).toEqual(["a.pdf"]);
    expect(recent.map((e) => e.path)).toEqual(["b.pdf", "c.pdf"]);
  });

  it("orders each group most-recent-first", () => {
    const entries = [
      entry("old.pdf", 100, false),
      entry("new.pdf", 999, false),
    ];
    const { recent } = groupByPinned(entries);
    expect(recent.map((e) => e.path)).toEqual(["new.pdf", "old.pdf"]);
  });

  it("returns empty arrays for an empty input", () => {
    const { pinned, recent } = groupByPinned([]);
    expect(pinned).toEqual([]);
    expect(recent).toEqual([]);
  });
});

describe("recentLimitNote", () => {
  it("stays quiet while far from the cap", () => {
    expect(recentLimitNote(0)).toBeNull();
    expect(recentLimitNote(14)).toBeNull();
  });
  it("warns when close to or at the cap", () => {
    expect(recentLimitNote(15)).toMatch(/latest 20/);
    expect(recentLimitNote(20)).toMatch(/Star a file/);
  });
});
