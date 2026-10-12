import { describe, expect, it } from "vitest";
import { layoutPages, pagesInWindow, pageAtY, rasterSize } from "../src/pdf-page-window.js";

function pages(count) {
  return Array.from({ length: count }, (_, i) => ({ pageNumber: i + 1, width: 600, height: 800 }));
}

describe("PDF page window", () => {
  it("finds only nearby pages in a 10,000-page document, including a distant jump", () => {
    const input = pages(10000);
    const { rows, height } = layoutPages(input, 1, 1, 16);
    expect(height).toBe(10000 * 816 - 16);
    const top = input[8999].layoutTop;
    expect(pageAtY(rows, top + 1)).toBe(9000);
    expect(pagesInWindow(rows, { top, bottom: top + 800 }, 1).map(p => p.pageNumber)).toEqual([9000]);
  });

  it("reserves mixed-size gallery rows and the unpaired last page correctly", () => {
    const input = pages(5);
    input[1].width = 900;
    input[1].height = 1200;
    const { rows, width, height } = layoutPages(input, 2, 0.5, 12);
    expect(width).toBe(762);
    expect(height).toBe(1424);
    expect(input[2].layoutTop).toBe(612);
    expect(input[4].layoutTop).toBe(1024);
    expect(pageAtY(rows, 450)).toBe(2);
    expect(pagesInWindow(rows, { top: 0, bottom: 300, left: 500, right: 700 }, 0.5)
      .map(p => p.pageNumber)).toEqual([2]);
  });

  it("tracks the first page in a row and the nearest centre in a gap", () => {
    const { rows } = layoutPages(pages(6), 2, 1, 16);
    expect(pageAtY(rows, -10)).toBe(1);
    expect(pageAtY(rows, 817)).toBe(3);
    expect(pageAtY(rows, 805)).toBe(1);
    expect(pageAtY(rows, 811)).toBe(3);
    expect(pageAtY(rows, 1e6)).toBe(5);
    expect(pageAtY([], 1)).toBe(null);
    const touching = layoutPages(pages(2), 1, 1, 0).rows;
    expect(pageAtY(touching, 800)).toBe(2);
  });
});

describe("canvas memory limits", () => {
  it("caps high-DPI zoomed pages by both area and maximum dimension", () => {
    const large = rasterSize(2400, 3200, 3, 4 * 1024 * 1024);
    expect(large.width * large.height * 4).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(large.scale).toBeLessThan(1);
    const tall = rasterSize(1, 100000, 3, 4 * 1024 * 1024);
    expect(tall.height).toBe(8192);
  });

  it("retains native sharpness for small canvases and bounds a whole viewport window", () => {
    expect(rasterSize(300, 400, 2, 4 * 1024 * 1024)).toEqual({ width: 600, height: 800, scale: 2 });
    const totalBudget = 32 * 1024 * 1024 / 4;
    const count = 30;
    const raster = rasterSize(600, 800, 3, Math.floor(totalBudget / count));
    expect(count * raster.width * raster.height * 4).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
