import { describe, it, expect } from "vitest";
import { clientRectsToPageRects } from "../src/selection-rects.js";

// A page of 600x800 page units shown at 2x, its slot at client (100, 50).
const page1 = { pageNumber: 1, box: { left: 100, top: 50, width: 1200, height: 1600 }, width: 600, height: 800 };
// Page 2 directly below it.
const page2 = { pageNumber: 2, box: { left: 100, top: 1670, width: 1200, height: 1600 }, width: 600, height: 800 };

const rect = (left, top, width, height) => ({ left, top, width, height });

describe("clientRectsToPageRects", () => {
  it("converts client pixels to page units using the slot's on-screen box", () => {
    const out = clientRectsToPageRects([rect(300, 250, 200, 40)], [page1]);
    expect(out.get(1)).toEqual([{ x: 100, y: 100, w: 100, h: 20 }]);
  });

  it("merges the word fragments of one line into a single band", () => {
    const words = [rect(300, 250, 100, 40), rect(410, 250, 120, 40), rect(540, 252, 80, 38)];
    const out = clientRectsToPageRects(words, [page1]);
    expect(out.get(1)).toHaveLength(1);
    const [band] = out.get(1);
    expect(band.x).toBeCloseTo(100);
    expect(band.w).toBeCloseTo(160);
  });

  it("keeps separate lines separate", () => {
    const lines = [rect(300, 250, 400, 40), rect(300, 300, 300, 40)];
    expect(clientRectsToPageRects(lines, [page1]).get(1)).toHaveLength(2);
  });

  it("assigns rects to the page containing their centre (selection across pages)", () => {
    const out = clientRectsToPageRects(
      [rect(300, 1500, 200, 40), rect(300, 1700, 200, 40)],
      [page1, page2],
    );
    expect(out.get(1)).toEqual([{ x: 100, y: 725, w: 100, h: 20 }]);
    expect(out.get(2)).toEqual([{ x: 100, y: 15, w: 100, h: 20 }]);
  });

  it("drops empty rects and rects outside every page, and clips to the page", () => {
    const out = clientRectsToPageRects(
      [rect(300, 250, 0, 40), rect(5000, 5000, 10, 10), rect(1250, 250, 100, 40)],
      [page1],
    );
    // only the third survives, clipped at the page's right edge (x = 600)
    expect(out.get(1)).toEqual([{ x: 575, y: 100, w: 25, h: 20 }]);
  });

  it("returns an empty map when nothing was selected on a page", () => {
    expect(clientRectsToPageRects([], [page1]).size).toBe(0);
  });
});
