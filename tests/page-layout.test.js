import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  computeFitPageZoom,
  computeFitZoom,
  computeOutputScale,
  computePageColumns,
  currentPageFromPositions,
  resolveDualPageMode,
} from "../src/page-layout.js";

describe("computeOutputScale", () => {
  it("keeps the display ratio when the canvas fits the budget", () => {
    expect(computeOutputScale(800, 1000, 2)).toBe(2);
  });

  it("lowers the scale so the backing store stays within the budget", () => {
    // a letter page at 4x zoom: 2448 x 3168 CSS px on a 3x display
    const scale = computeOutputScale(2448, 3168, 3);
    expect(scale).toBeLessThan(3);
    expect(scale).toBeGreaterThan(1);
    expect(2448 * scale * (3168 * scale)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
  });

  it("falls back to 1 for a missing or invalid display ratio", () => {
    expect(computeOutputScale(800, 1000, 0)).toBe(1);
    expect(computeOutputScale(800, 1000, undefined)).toBe(1);
  });

  it("returns the display ratio for an empty canvas size", () => {
    expect(computeOutputScale(0, 0, 2)).toBe(2);
  });
});

describe("computePageColumns", () => {
  it("always keeps a dual-page pair, even when it must overflow", () => {
    expect(computePageColumns(300, 400, 16, true)).toBe(2);
  });

  it("adds gallery columns only when their page and gap fit", () => {
    expect(computePageColumns(1000, 300, 16, true)).toBe(3);
    expect(computePageColumns(931, 300, 16, true)).toBe(2);
  });

  it("keeps single-page mode to one column", () => {
    expect(computePageColumns(2000, 100, 16, false)).toBe(1);
  });

  it("does not create unused columns beyond the document page count", () => {
    expect(computePageColumns(2000, 100, 16, true, 3)).toBe(3);
  });
});

describe("computeFitZoom", () => {
  it("fits one page across the available width", () => {
    expect(computeFitZoom(800, 400, 16, false)).toBe(2);
  });

  it("fits a dual-page row including its gap", () => {
    expect(computeFitZoom(816, 400, 16, true)).toBe(1);
  });

  it("falls back to 1 for unavailable dimensions", () => {
    expect(computeFitZoom(0, 400, 16, true)).toBe(1);
  });
});

describe("resolveDualPageMode", () => {
  it("defaults mobile and tablet widths to vertical scrolling", () => {
    expect(resolveDualPageMode(390, 8)).toBe(false);
    expect(resolveDualPageMode(1200, 8)).toBe(false);
  });

  it("defaults wide desktop windows to side-by-side pages", () => {
    expect(resolveDualPageMode(1201, 8)).toBe(true);
  });

  it("respects an explicit layout choice", () => {
    expect(resolveDualPageMode(390, 8, "dual")).toBe(true);
    expect(resolveDualPageMode(1600, 8, "single")).toBe(false);
  });

  it("keeps a one-page document in vertical mode", () => {
    expect(resolveDualPageMode(1600, 1, "dual")).toBe(false);
  });
});

describe("computeFitPageZoom", () => {
  it("uses the width fit when the page is wider than it is tall", () => {
    // width fit = 800/400 = 2; height fit = 1200/300 = 4 -> width wins
    expect(computeFitPageZoom(800, 1200, 400, 300, 16, false)).toBe(2);
  });

  it("uses the height fit when the page is taller than the viewport", () => {
    // width fit = 800/400 = 2; height fit = 600/600 = 1 -> height wins
    expect(computeFitPageZoom(800, 600, 400, 600, 16, false)).toBe(1);
  });

  it("falls back to the width fit when height is unavailable", () => {
    expect(computeFitPageZoom(800, 0, 400, 600, 16, false)).toBe(2);
  });
});

describe("currentPageFromPositions", () => {
  const positions = [
    { pageNumber: 1, top: -50, bottom: 150 },
    { pageNumber: 2, top: 150, bottom: 400 },
    { pageNumber: 3, top: 400, bottom: 650 },
  ];

  it("returns the page straddling the reference line", () => {
    expect(currentPageFromPositions(positions, 0)).toBe(1);
    expect(currentPageFromPositions(positions, 300)).toBe(2);
    expect(currentPageFromPositions(positions, 500)).toBe(3);
  });

  it("picks the nearest page centre when a gap straddles the line", () => {
    const gapped = [
      { pageNumber: 1, top: -300, bottom: -100 },
      { pageNumber: 2, top: 20, bottom: 180 },
    ];
    expect(currentPageFromPositions(gapped, 0)).toBe(2);
  });

  it("returns null when there are no pages", () => {
    expect(currentPageFromPositions([], 0)).toBe(null);
  });
});
