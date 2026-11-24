// Turns a text selection's on-screen boxes into highlight rects in page units.
// Pure (no DOM): the caller collects the client rects (one per selected text
// fragment) and each page slot's on-screen box, already including the
// viewer's pan/zoom transform, so the result does not depend on zoom.
import { clientToPage, mergeLineRects } from "./page-geometry.js";

// clientRects: [{ left, top, width, height }] in client (screen) pixels.
// pages: [{ pageNumber, box: { left, top, width, height }, width, height }]
//   where box is the page slot's client rect and width/height its page units.
// Returns Map<pageNumber, rects[]> with rects as { x, y, w, h } page units,
// clipped to the page and merged per line. A rect belongs to the page that
// contains its centre (a selection may run across pages).
export function clientRectsToPageRects(clientRects, pages) {
  const byPage = new Map();
  for (const r of clientRects) {
    if (!(r.width > 0 && r.height > 0)) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const page = pages.find(({ box }) =>
      cx >= box.left && cx <= box.left + box.width && cy >= box.top && cy <= box.top + box.height);
    if (!page) continue;
    const a = clientToPage(r.left, r.top, page.box, page.width, page.height);
    const b = clientToPage(r.left + r.width, r.top + r.height, page.box, page.width, page.height);
    const x0 = Math.max(0, Math.min(a.x, b.x));
    const y0 = Math.max(0, Math.min(a.y, b.y));
    const x1 = Math.min(page.width, Math.max(a.x, b.x));
    const y1 = Math.min(page.height, Math.max(a.y, b.y));
    if (x1 <= x0 || y1 <= y0) continue;
    if (!byPage.has(page.pageNumber)) byPage.set(page.pageNumber, []);
    byPage.get(page.pageNumber).push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  for (const [pageNumber, rects] of byPage) {
    // Words are often separate text spans with a small gap between them;
    // bridging gaps up to half a line height gives one band per line instead
    // of a row of separate boxes.
    const heights = rects.map((r) => r.h).sort((p, q) => p - q);
    const tolerance = Math.max(2, heights[Math.floor(heights.length / 2)] / 2);
    byPage.set(pageNumber, mergeLineRects(rects, tolerance));
  }
  return byPage;
}
