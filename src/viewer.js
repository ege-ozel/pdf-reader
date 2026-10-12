import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { computeZoom } from "./zoom.js";
import { autoscrollSpeed, AUTOSCROLL_DEAD_ZONE } from "./autoscroll.js";
import {
  computeFitZoom as fitZoomForPages,
  computeFitPageZoom as fitPageZoomForPage,
  computePageColumns,
  resolveDualPageMode,
} from "./page-layout.js";
import { layoutPages, pagesInWindow, pageAtY, rasterSize } from "./pdf-page-window.js";
import { PdfRenderQueue } from "./pdf-render-queue.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
// JPEG 2000 / JBIG2 / color-profile decoders; without them scanned PDFs render blank.
const WASM_URL = new URL("./vendor/pdfjs/wasm/", import.meta.url).href;
// CMaps for CJK/CID-keyed fonts, base-14 standard font data, and the default
// CMYK ICC profile — all optional external asset sets PDF.js fetches on demand.
// Without them, non-embedded fonts and some CMYK colors render wrong or blank.
const CMAP_URL = new URL("./vendor/pdfjs/cmaps/", import.meta.url).href;
const STANDARD_FONT_URL = new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href;
const ICC_URL = new URL("./vendor/pdfjs/iccs/", import.meta.url).href;

const container = document.getElementById("viewer-container");
const pagesWrapper = document.getElementById("pdf-pages");

const MAX_ZOOM = 4.0;
const MIN_SINGLE_PAGE_ZOOM = 0.25;
const MIN_DUAL_PAGE_ZOOM = 0.1;
const DESKTOP_PAGE_GAP = 16;
const MOBILE_PAGE_GAP = 12;
const RESIZE_SETTLE_DELAY = 150;
const ZOOM_RERENDER_DELAY = 120;
// Momentum scrolling after a touch pan: velocity decays exponentially.
const FLING_TIME_CONSTANT = 325; // ms; larger = longer glide
const FLING_MIN_SPEED = 0.02; // px/ms below which the glide stops
const FLING_MAX_SPEED = 6; // px/ms cap so a flick can't launch the page
const FLING_STALE_MS = 80; // finger paused longer than this before lift = no glide
const MOBILE_RENDERING = window.matchMedia("(pointer: coarse)").matches;
const CANVAS_PIXEL_BUDGET = (MOBILE_RENDERING ? 32 : 96) * 1024 * 1024 / 4;
const MAX_PAGE_PIXELS = (MOBILE_RENDERING ? 4 : 8) * 1024 * 1024;
const renderQueue = new PdfRenderQueue(MOBILE_RENDERING ? 1 : 2);
// Minimum horizontal travel (px) of a one-finger swipe that flips the page in
// paged mode when the page can't pan sideways (it already fits the width).
const PAGE_SWIPE_THRESHOLD = 50;

let pdfDoc = null;
let pdfLoadingTask = null;
// Bumped by every closePdf(); a renderPdf that sees it change was superseded.
let loadToken = 0;
let pages = [];
let pageModePreference = null;
// "continuous" = free pan/momentum scroll; "paged" = a whole page fits the
// viewport (minimum zoom) and navigation moves one page at a time.
let scrollMode = "continuous";
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let renderedZoom = 1;
let renderedContentWidth = 0;
let renderedContentHeight = 0;
let renderGeneration = 0;
let statusCallback = null;
let zoomDebounceTimer = null;
let resizeDebounceTimer = null;
let pageRows = [];
const mountedPages = new Set();
let viewportFrame = 0;
let layoutFrame = 0;
let canvasPixelLimit = MAX_PAGE_PIXELS;
let pendingZoomAnchor = null;
let fitZoom = 1;
let gesture = null;
let flingFrame = 0;
let panVelocity = null; // { vx, vy, time } from the latest touchmove, px/ms
let pageRenderedHook = null;
let pageUnloadedHook = null;
let documentChangeHook = null;
let pageChangeHook = null;
let lastReportedPage = null;
let panEnabled = true;
// Middle-click autoscroll: { originX, originY, x, y, held, dragged, frame }.
let autoscroll = null;
let autoscrollMarker = null;

function isDualPageMode() {
  return resolveDualPageMode(window.innerWidth, pdfDoc?.numPages ?? 0, pageModePreference);
}

// Whole-page fit zoom for the page currently at the top of the viewport.
// Cheap enough to call from minimumZoom(); falls back to the single-page
// floor before a document is laid out.
function currentFitPageZoom() {
  if (!pdfDoc || pages.length === 0) return MIN_SINGLE_PAGE_ZOOM;
  const current = currentPageNumber() ?? 1;
  const page = pages[current - 1] ?? pages[0];
  const { top, bottom } = containerInsets();
  const availableHeight = Math.max(0, container.clientHeight - top - bottom);
  const zoom = fitPageZoomForPage(
    container.clientWidth,
    availableHeight,
    page.width,
    page.height,
    getPageGap(),
    isDualPageMode(),
  );
  return Math.min(MAX_ZOOM, Math.max(MIN_SINGLE_PAGE_ZOOM, zoom));
}

function minimumZoom() {
  if (scrollMode === "paged") return currentFitPageZoom();
  return isDualPageMode() ? MIN_DUAL_PAGE_ZOOM : MIN_SINGLE_PAGE_ZOOM;
}

function getPageGap() {
  return window.matchMedia("(max-width: 640px)").matches ? MOBILE_PAGE_GAP : DESKTOP_PAGE_GAP;
}

function reportError(message) {
  if (statusCallback) statusCallback(message);
}

function cancelPageRender(page) {
  page.renderToken += 1;
  if (page.renderTask) {
    page.renderTask.cancel();
    page.renderTask = null;
  }
  if (page.textLayer) {
    page.textLayer.cancel();
    page.textLayer = null;
  }
}

function cancelAllPageRenders() {
  renderQueue.clear();
  for (const page of mountedPages) unloadPage(page);
}

function contentSize() {
  const scale = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  return {
    width: renderedContentWidth * scale,
    height: renderedContentHeight * scale,
  };
}

function containerInsets() {
  const containerStyle = getComputedStyle(container);
  return {
    top: Number.parseFloat(containerStyle.paddingTop) || 0,
    bottom: Number.parseFloat(containerStyle.paddingBottom) || 0,
  };
}

function clampPan() {
  const { width, height } = contentSize();
  const viewportWidth = container.clientWidth;
  const viewportHeight = container.clientHeight;
  const { top: topInset, bottom: bottomInset } = containerInsets();
  const usableHeight = Math.max(0, viewportHeight - topInset - bottomInset);
  panX = width <= viewportWidth
    ? (viewportWidth - width) / 2
    : Math.min(0, Math.max(viewportWidth - width, panX));
  panY = height <= usableHeight
    ? (usableHeight - height) / 2
    : Math.min(0, Math.max(usableHeight - height, panY));
}

function stopFling() {
  cancelAnimationFrame(flingFrame);
  flingFrame = 0;
}

function startFling(vx, vy) {
  stopFling();
  let lastTime = performance.now();
  const step = (now) => {
    const dt = Math.min(now - lastTime, 50);
    lastTime = now;
    const decay = Math.exp(-dt / FLING_TIME_CONSTANT);
    vx *= decay;
    vy *= decay;
    const beforeX = panX;
    const beforeY = panY;
    panX += vx * dt;
    panY += vy * dt;
    updateView();
    // Hitting an edge kills the velocity on that axis (clampPan moved us back).
    if (panX !== beforeX + vx * dt) vx = 0;
    if (panY !== beforeY + vy * dt) vy = 0;
    if (Math.hypot(vx, vy) < FLING_MIN_SPEED) {
      flingFrame = 0;
      return;
    }
    flingFrame = requestAnimationFrame(step);
  };
  flingFrame = requestAnimationFrame(step);
}

function applyTransform() {
  const scale = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  pagesWrapper.style.transformOrigin = "0 0";
  pagesWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function updateView({ rerender = false, anchor = null } = {}) {
  clampPan();
  applyTransform();
  reportCurrentPage();
  scheduleViewportRender();
  if (rerender) {
    if (anchor) pendingZoomAnchor = anchor;
    scheduleRerender();
  }
}

// Page number currently at the top of the viewport, computed from the cached
// page layout offsets (no per-frame DOM reads). Returns null when nothing is
// open or laid out yet.
function currentPageNumber() {
  if (!pdfDoc || pages.length === 0 || renderedZoom <= 0) return null;
  const scale = zoomLevel / renderedZoom;
  const base = pagesWrapper.offsetTop + panY;
  const referenceY = containerInsets().top + 1;
  return pageAtY(pageRows, (referenceY - base) / scale);
}

function reportCurrentPage() {
  if (!pageChangeHook) return;
  const current = currentPageNumber();
  if (current == null || current === lastReportedPage) return;
  lastReportedPage = current;
  pageChangeHook(current, pdfDoc?.numPages ?? 0);
}

function scheduleRerender(delay = ZOOM_RERENDER_DELAY) {
  clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    rerenderPages({ anchor: pendingZoomAnchor }).catch((err) => {
      reportError(`Could not render PDF: ${err.message || err}`);
    });
  }, delay);
}

function containerRelativePoint(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function captureAnchor(point) {
  const containerRect = container.getBoundingClientRect();
  const clientPoint = {
    x: point.x + containerRect.left,
    y: point.y + containerRect.top,
  };
  const contentPoint = {
    x: (point.x - panX) / zoomLevel,
    y: (point.y - pagesWrapper.offsetTop - panY) / zoomLevel,
  };
  let nearestPage = null;
  let nearestDistance = Infinity;

  for (const page of mountedPages) {
    if (!page.slot) continue;
    const rect = page.slot.getBoundingClientRect();
    if (clientPoint.x >= rect.left && clientPoint.x <= rect.right &&
      clientPoint.y >= rect.top && clientPoint.y <= rect.bottom) {
      return {
        pageNumber: page.pageNumber,
        xRatio: rect.width ? (clientPoint.x - rect.left) / rect.width : 0.5,
        yRatio: rect.height ? (clientPoint.y - rect.top) / rect.height : 0.5,
        point,
        contentPoint,
      };
    }

    const dx = clientPoint.x - (rect.left + rect.width / 2);
    const dy = clientPoint.y - (rect.top + rect.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = {
        pageNumber: page.pageNumber,
        xRatio: 0.5,
        yRatio: 0.5,
        point,
        contentPoint,
      };
    }
  }
  return nearestPage || { pageNumber: null, point, contentPoint };
}

function restoreAnchor(anchor, targetZoom) {
  if (anchor?.pageNumber) {
    const page = pages[anchor.pageNumber - 1];
    if (page?.layoutTop != null) {
      const scale = zoomLevel / targetZoom;
      const originTop = pagesWrapper.offsetTop;
      const contentX = page.layoutLeft + page.width * targetZoom * anchor.xRatio;
      const contentY = originTop + page.layoutTop + page.height * targetZoom * anchor.yRatio;
      panX = anchor.point.x - contentX * scale;
      panY = anchor.point.y - contentY * scale;
      return;
    }
  }
  if (anchor?.point) {
    panX = anchor.point.x - anchor.contentPoint.x * zoomLevel;
    panY = anchor.point.y - pagesWrapper.offsetTop - anchor.contentPoint.y * zoomLevel;
  }
}

function zoomAt(anchor, newZoom) {
  stopFling();
  const capturedAnchor = captureAnchor(anchor);
  const clampedZoom = Math.min(MAX_ZOOM, Math.max(minimumZoom(), newZoom));
  const contentX = (anchor.x - panX) / zoomLevel;
  const contentY = (anchor.y - pagesWrapper.offsetTop - panY) / zoomLevel;
  zoomLevel = clampedZoom;
  panX = anchor.x - contentX * zoomLevel;
  panY = anchor.y - pagesWrapper.offsetTop - contentY * zoomLevel;
  updateView({ rerender: true, anchor: capturedAnchor });
}

export function togglePageMode() {
  return setPageMode(isDualPageMode() ? "single" : "dual");
}

export function setPageMode(mode) {
  if (mode !== "single" && mode !== "dual") return isSinglePageMode();
  const anchor = pdfDoc ? captureAnchor({
    x: container.clientWidth / 2,
    y: container.clientHeight / 2,
  }) : null;
  const nextIsDual = mode === "dual";
  pageModePreference = nextIsDual ? "dual" : "single";
  if (pdfDoc) {
    computeFitZoom().then((nextFitZoom) => {
      zoomLevel = Math.max(minimumZoom(), zoomLevel);
      if (nextIsDual && zoomLevel > nextFitZoom) zoomLevel = nextFitZoom;
      fitZoom = nextFitZoom;
      rerenderPages({ anchor }).catch((err) => {
        reportError(`Could not render PDF: ${err.message || err}`);
      });
    }).catch((err) => {
      reportError(`Could not calculate page layout: ${err.message || err}`);
    });
  }
  return !nextIsDual;
}

export function isSinglePageMode() {
  return !isDualPageMode();
}

export function zoomByStep(direction) {
  if (!pdfDoc) return;
  const step = 0.2;
  const factor = direction > 0 ? 1 + step : 1 / (1 + step);
  zoomAt(
    { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    zoomLevel * factor
  );
}

export async function resetZoom() {
  if (!pdfDoc) return;
  const anchor = captureAnchor({
    x: container.clientWidth / 2,
    y: container.clientHeight / 2,
  });
  fitZoom = await computeFitZoom();
  zoomLevel = fitZoom;
  panX = 0;
  panY = 0;
  pendingZoomAnchor = anchor;
  updateView({ rerender: true });
}

export function setStatusCallback(fn) {
  statusCallback = fn;
}

export function setPageRenderedHook(fn) {
  pageRenderedHook = fn;
}

export function setPageUnloadedHook(fn) {
  pageUnloadedHook = fn;
}

export function setDocumentChangeHook(fn) {
  documentChangeHook = fn;
}

export function setPageChangeHook(fn) {
  pageChangeHook = fn;
}

export function getPageCount() {
  return pdfDoc?.numPages ?? 0;
}

export function getCurrentPage() {
  return currentPageNumber();
}

// Scrolls page `pageNumber` to the top of the viewport. Used by the page
// navigation control; also the primary navigation in paged scroll mode.
export function goToPage(pageNumber) {
  if (!pdfDoc || pages.length === 0) return;
  const clamped = Math.min(pages.length, Math.max(1, Math.round(pageNumber)));
  const page = pages[clamped - 1];
  if (page?.layoutTop == null) return;
  stopFling();
  const scale = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  panY = containerInsets().top - pagesWrapper.offsetTop - page.layoutTop * scale;
  updateView();
}

// Zoom so the whole current page fits the viewport (both dimensions), unlike
// resetZoom() which fits width only. Also the minimum zoom baseline in paged
// mode. Keeps the current focal point via the anchor.
export async function fitPage() {
  if (!pdfDoc || pages.length === 0) return;
  const anchor = captureAnchor({
    x: container.clientWidth / 2,
    y: container.clientHeight / 2,
  });
  const current = currentPageNumber() ?? 1;
  const page = pages[current - 1] ?? pages[0];
  const { top: topInset, bottom: bottomInset } = containerInsets();
  const availableHeight = Math.max(0, container.clientHeight - topInset - bottomInset);
  const zoom = fitPageZoomForPage(
    container.clientWidth,
    availableHeight,
    page.width,
    page.height,
    getPageGap(),
    isDualPageMode(),
  );
  zoomLevel = Math.min(MAX_ZOOM, Math.max(minimumZoom(), zoom));
  pendingZoomAnchor = anchor;
  updateView({ rerender: true });
}

export function getScrollMode() {
  return scrollMode;
}

// Switches between continuous and paged scrolling. Entering paged mode fits
// the current page whole and snaps it to the top; the minimum zoom then holds
// a page in view until the reader zooms in.
export function setScrollMode(mode) {
  if (mode !== "continuous" && mode !== "paged") return scrollMode;
  scrollMode = mode;
  pagesWrapper.classList.toggle("paged-mode", mode === "paged");
  if (!pdfDoc || pages.length === 0) return scrollMode;
  if (mode === "paged") {
    const current = currentPageNumber() ?? 1;
    zoomLevel = currentFitPageZoom();
    rerenderPages()
      .then(() => goToPage(current))
      .catch((err) => reportError(`Could not render PDF: ${err.message || err}`));
  }
  return scrollMode;
}

export function goToAdjacentPage(direction) {
  const current = currentPageNumber() ?? 1;
  const step = isDualPageMode() ? 2 : 1;
  goToPage(current + (direction > 0 ? step : -step));
}

export function setPanEnabled(enabled) {
  panEnabled = enabled;
  if (!enabled) stopFling();
}

export function getOpenPdf() {
  return pdfDoc ? { doc: pdfDoc, numPages: pdfDoc.numPages } : null;
}

function computeColumns(targetZoom) {
  const widestPage = pages.reduce((width, page) => Math.max(width, page.width), 0);
  const columns = computePageColumns(
    container.clientWidth,
    widestPage * targetZoom,
    getPageGap(),
    isDualPageMode(),
    pages.length
  );
  return columns;
}

async function computeFitZoom() {
  if (!pdfDoc || pages.length === 0) return 1;
  const widestPage = pages.reduce((width, page) => Math.max(width, page.width), 0);
  const zoom = fitZoomForPages(
    container.clientWidth,
    widestPage,
    getPageGap(),
    isDualPageMode()
  );
  return Math.min(MAX_ZOOM, Math.max(minimumZoom(), zoom));
}

async function loadPageMetadata(doc) {
  // Reserve estimated geometry without fetching every page. Mixed-size pages
  // are corrected when visited, keeping the reader's focal point stable.
  const firstPage = await doc.getPage(1);
  const viewport = firstPage.getViewport({ scale: 1 });
  firstPage.cleanup();
  return Array.from({ length: doc.numPages }, (_, index) => ({
    pageNumber: index + 1,
    proxy: null,
    width: viewport.width,
    height: viewport.height,
    slot: null,
    canvas: null,
    renderTask: null,
    renderToken: 0,
    rendering: false,
    failedGeneration: null,
  }));
}

function makePageSlot(page, targetZoom, animate) {
  const slot = document.createElement("div");
  slot.className = animate ? "pdf-page-slot pdf-page-enter" : "pdf-page-slot";
  slot.dataset.pageNumber = String(page.pageNumber);
  slot.style.width = `${page.width * targetZoom}px`;
  slot.style.height = `${page.height * targetZoom}px`;
  slot.style.left = `${page.layoutLeft}px`;
  slot.style.top = `${page.layoutTop}px`;
  page.slot = slot;
  page.canvas = null;
  return slot;
}

function scheduleViewportRender() {
  if (!pdfDoc || viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    renderNearViewport(renderGeneration).catch((err) => {
      reportError(`Could not render PDF: ${err.message || err}`);
    });
  });
}

function scheduleMetadataLayout() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    if (!pdfDoc) return;
    const anchor = captureAnchor({ x: container.clientWidth / 2, y: container.clientHeight / 2 });
    updatePageLayout(renderedZoom);
    for (const page of mountedPages) {
      page.slot.style.left = `${page.layoutLeft}px`;
      page.slot.style.top = `${page.layoutTop}px`;
    }
    restoreAnchor(anchor, renderedZoom);
    updateView();
  });
}

function unloadPage(page) {
  cancelPageRender(page);
  // PDF.js keeps a rendered page's decoded images and operator list on its
  // cached page proxy until cleanup(), so without this every page ever viewed
  // stays in memory (a scanned page with a high-res mask holds ~128 MB).
  // A cancelled render still in flight is cleaned up once it settles.
  page.proxy?.cleanup();
  // A running render owns its proxy until its promise settles.
  if (!page.rendering) page.proxy = null;
  if (page.canvas) {
    page.canvas.width = 0;
    page.canvas.height = 0;
  }
  page.slot?.remove();
  page.slot = null;
  page.canvas = null;
  mountedPages.delete(page);
  pageUnloadedHook?.(page.pageNumber);
}

// Transparent, selectable text over the canvas so long-press (touch) and
// drag (mouse) can select and copy PDF text. Failure here must never break
// the page itself, so errors are swallowed.
async function mountTextLayer(page, pageProxy, viewport, zoom, generation, token) {
  const layer = document.createElement("div");
  layer.className = "text-layer";
  layer.style.setProperty("--total-scale-factor", String(zoom));
  layer.style.setProperty("--scale-round-x", "1px");
  layer.style.setProperty("--scale-round-y", "1px");
  let textLayer = null;
  try {
    textLayer = new pdfjsLib.TextLayer({
      textContentSource: pageProxy.streamTextContent(),
      container: layer,
      viewport,
    });
    page.textLayer = textLayer;
    await textLayer.render();
  } catch {
    return;
  } finally {
    if (textLayer && page.textLayer === textLayer) page.textLayer = null;
  }
  if (generation === renderGeneration && token === page.renderToken && page.slot) {
    page.slot.append(layer);
  }
}

async function renderPage(page, generation) {
  if (generation !== renderGeneration || !page.slot || page.canvas || page.rendering) return;
  page.rendering = true;
  const token = ++page.renderToken;
  const doc = pdfDoc;
  const targetZoom = renderedZoom;
  let pageProxy = null;
  let canvas = null;
  try {
    pageProxy = await doc.getPage(page.pageNumber);
    page.proxy = pageProxy;
    if (generation !== renderGeneration || token !== page.renderToken) return;
    const size = pageProxy.getViewport({ scale: 1 });
    if (page.width !== size.width || page.height !== size.height) {
      page.width = size.width;
      page.height = size.height;
      page.slot.style.width = `${size.width * targetZoom}px`;
      page.slot.style.height = `${size.height * targetZoom}px`;
      scheduleMetadataLayout();
    }
    const viewport = pageProxy.getViewport({ scale: targetZoom });
    const raster = rasterSize(viewport.width, viewport.height,
      window.devicePixelRatio || 1, canvasPixelLimit);
    const outputScale = raster.scale;
    canvas = document.createElement("canvas");
    canvas.width = raster.width;
    canvas.height = raster.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.className = "pdf-page";
    page.canvas = canvas;
    page.slot.replaceChildren(canvas);

    const context = canvas.getContext("2d");
    if (!context) {
      page.canvas = null;
      page.slot.replaceChildren();
      throw new Error(`Could not create a canvas context for page ${page.pageNumber}`);
    }

    const task = pageProxy.render({
      canvasContext: context,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    page.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        canvas.width = 0;
        canvas.height = 0;
        if (page.canvas === canvas) {
          page.canvas = null;
          page.slot?.replaceChildren();
        }
        throw err;
      }
    } finally {
      if (page.renderTask === task) page.renderTask = null;
      if (generation !== renderGeneration || token !== page.renderToken) {
        if (page.canvas === canvas) {
          canvas.width = 0;
          canvas.height = 0;
          page.canvas = null;
          page.slot?.replaceChildren();
        }
      }
    }

    if (generation === renderGeneration && token === page.renderToken && page.canvas === canvas) {
      await mountTextLayer(page, pageProxy, viewport, targetZoom, generation, token);
    }

    if (generation === renderGeneration && token === page.renderToken && page.canvas === canvas) {
      pageRenderedHook?.({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        slot: page.slot,
        viewport,
        pageProxy,
        renderedZoom: targetZoom,
      });
    }
  } catch (err) {
    if (generation === renderGeneration && token === page.renderToken) {
      page.failedGeneration = generation;
      throw err;
    }
  } finally {
    page.rendering = false;
    if (generation !== renderGeneration || token !== page.renderToken || !page.canvas) {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      pageProxy?.cleanup();
      if (page.proxy === pageProxy) page.proxy = null;
    }
    // A cancelled job may now have a new slot after a zoom or fast return.
    // Retry only that case; failed pages must not loop continuously.
    if (pdfDoc === doc && page.slot && !page.canvas && page.failedGeneration !== renderGeneration) {
      scheduleViewportRender();
    }
  }
}

async function renderNearViewport(generation) {
  if (!pdfDoc || generation !== renderGeneration) return;
  const scale = zoomLevel / renderedZoom;
  const top = (-pagesWrapper.offsetTop - panY) / scale;
  const height = container.clientHeight / scale;
  const left = -panX / scale;
  const width = container.clientWidth / scale;
  const nearby = pagesInWindow(pageRows, {
    top: top - height * 0.5, bottom: top + height * 1.5,
    left: left - width * 0.5, right: left + width * 1.5,
  }, renderedZoom);
  const wanted = new Set(nearby);
  for (const page of mountedPages) if (!wanted.has(page)) unloadPage(page);
  const nextLimit = Math.min(MAX_PAGE_PIXELS,
    Math.floor(CANVAS_PIXEL_BUDGET / Math.max(nearby.length, 1)));
  canvasPixelLimit = nextLimit;
  for (const page of nearby) {
    // If more pages fit now (e.g. while pinching out), shrink older rasters too.
    if (page.canvas && page.canvas.width * page.canvas.height > nextLimit) unloadPage(page);
    if (!page.slot) {
      pagesWrapper.appendChild(makePageSlot(page, renderedZoom, false));
      mountedPages.add(page);
    }
  }
  const center = top + height / 2;
  nearby.sort((a, b) => Math.abs((a.layoutTop + a.layoutBottom) / 2 - center) -
    Math.abs((b.layoutTop + b.layoutBottom) / 2 - center));
  await renderQueue.replace(nearby.filter((page) => !page.canvas &&
    page.failedGeneration !== generation).map((page) => ({
    key: page,
    run: () => renderPage(page, generation),
  })));
}

function updatePageLayout(targetZoom) {
  const layout = layoutPages(pages, computeColumns(targetZoom), targetZoom, getPageGap());
  pageRows = layout.rows;
  renderedContentWidth = layout.width;
  renderedContentHeight = layout.height;
  pagesWrapper.style.width = `${layout.width}px`;
  pagesWrapper.style.height = `${layout.height}px`;
}

async function rerenderPages({ animate = false, anchor = null } = {}) {
  if (!pdfDoc) {
    cancelAllPageRenders();
    pagesWrapper.replaceChildren();
    renderedContentWidth = 0;
    renderedContentHeight = 0;
    applyTransform();
    return;
  }

  const generation = ++renderGeneration;
  cancelAllPageRenders();
  const targetZoom = zoomLevel;
  pagesWrapper.classList.toggle("single-page-mode", !isDualPageMode());
  pagesWrapper.classList.toggle("dual-page-mode", isDualPageMode());
  pagesWrapper.replaceChildren();
  updatePageLayout(targetZoom);
  renderedZoom = targetZoom;
  if (anchor) restoreAnchor(anchor, targetZoom);
  clampPan();
  applyTransform();
  lastReportedPage = null;
  reportCurrentPage();
  await renderNearViewport(generation);
  if (animate) for (const page of mountedPages) page.slot?.classList.add("pdf-page-enter");
  if (generation !== renderGeneration) return;
  pendingZoomAnchor = null;
}

// Releases the open PDF (page renders, observer, pending timers, the PDF.js
// document) and clears the page area. Safe to call when nothing is open.
export async function closePdf() {
  stopFling();
  stopAutoscroll();
  loadToken += 1;
  clearTimeout(zoomDebounceTimer);
  clearTimeout(resizeDebounceTimer);
  cancelAnimationFrame(viewportFrame);
  cancelAnimationFrame(layoutFrame);
  viewportFrame = 0;
  layoutFrame = 0;
  cancelAllPageRenders();
  pagesWrapper.replaceChildren();
  const previousLoadingTask = pdfLoadingTask;
  pdfLoadingTask = null;
  pdfDoc = null;
  documentChangeHook?.("closed");
  lastReportedPage = null;
  pages = [];
  pageRows = [];
  gesture = null;
  pendingZoomAnchor = null;
  renderedContentWidth = 0;
  renderedContentHeight = 0;
  renderGeneration += 1;
  if (previousLoadingTask) {
    await previousLoadingTask.destroy();
  }
}

// Drops a load that a later closePdf() superseded. Only the task this load
// created is released, and only if nobody else took it over already.
async function releaseSupersededLoad(loadingTask) {
  if (!loadingTask || pdfLoadingTask !== loadingTask) return;
  pdfLoadingTask = null;
  pdfDoc = null;
  try {
    await loadingTask.destroy();
  } catch (destroyError) {
    reportError(`Could not release the superseded PDF load: ${destroyError.message || destroyError}`);
  }
}

export async function renderPdf(bytes) {
  // closePdf() bumps loadToken before its first await, so the token is read
  // right after that bump: any later closePdf() (a newer open, PDF or Word)
  // marks this load as superseded, even while this one is still closing.
  const closing = closePdf();
  const token = loadToken;
  await closing;
  if (token !== loadToken) return;
  pageModePreference = null;
  let loadingTask = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: bytes,
      wasmUrl: WASM_URL,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_URL,
      iccUrl: ICC_URL,
    });
    pdfLoadingTask = loadingTask;
    const loadedDoc = await loadingTask.promise;
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    pdfDoc = loadedDoc;
  } catch (err) {
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    const failedLoadingTask = pdfLoadingTask;
    pdfLoadingTask = null;
    pdfDoc = null;
    if (failedLoadingTask) {
      try {
        await failedLoadingTask.destroy();
      } catch (destroyError) {
        reportError(`Could not release the failed PDF load: ${destroyError.message || destroyError}`);
      }
    }
    throw `Could not open PDF: ${err.message || err}`;
  }

  try {
    const loadedPages = await loadPageMetadata(pdfDoc);
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    pages = loadedPages;
    fitZoom = await computeFitZoom();
    zoomLevel = fitZoom;
    panX = 0;
    panY = 0;
    await rerenderPages({ animate: true });
    if (token === loadToken) documentChangeHook?.("opened");
  } catch (err) {
    if (token !== loadToken) {
      // closePdf() already cleared this load; the state now belongs to the
      // newer open, so leave it alone.
      await releaseSupersededLoad(loadingTask);
      return;
    }
    cancelAllPageRenders();
    renderGeneration += 1;
    const failedLoadingTask = pdfLoadingTask;
    pdfLoadingTask = null;
    pdfDoc = null;
    pages = [];
    pagesWrapper.replaceChildren();
    if (failedLoadingTask) {
      try {
        await failedLoadingTask.destroy();
      } catch (destroyError) {
        reportError(`Could not release the failed PDF: ${destroyError.message || destroyError}`);
      }
    }
    throw `Could not open PDF: ${err.message || err}`;
  }
}

function zoomByWheel(event) {
  const anchor = containerRelativePoint(event.clientX, event.clientY);
  zoomAt(anchor, computeZoom(zoomLevel, event.deltaY, { min: minimumZoom(), max: MAX_ZOOM }));
}

container.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (!pdfDoc) return;
    stopFling();
    stopAutoscroll();
    if (event.ctrlKey || event.metaKey) {
      zoomByWheel(event);
    } else {
      panX -= event.deltaX;
      panY -= event.deltaY;
      updateView();
    }
  },
  { passive: false }
);

// Desktop middle-click autoscroll, like the browser's native one (which the
// Word view gets for free): the page moves towards the cursor at a speed set
// by its distance from where the middle button went down. A click without
// moving keeps it running until the next click; press-drag-release stops on
// release.
function startAutoscroll(event) {
  stopFling();
  autoscroll = {
    originX: event.clientX,
    originY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    held: true,
    dragged: false,
    frame: 0,
  };
  autoscrollMarker ??= Object.assign(document.createElement("div"), { className: "autoscroll-marker" });
  autoscrollMarker.style.left = `${event.clientX}px`;
  autoscrollMarker.style.top = `${event.clientY}px`;
  document.body.append(autoscrollMarker);
  container.classList.add("autoscrolling");

  let lastTime = performance.now();
  const step = (now) => {
    const dt = Math.min(now - lastTime, 50);
    lastTime = now;
    const vx = autoscrollSpeed(autoscroll.x - autoscroll.originX);
    const vy = autoscrollSpeed(autoscroll.y - autoscroll.originY);
    if (vx || vy) {
      panX -= vx * dt;
      panY -= vy * dt;
      updateView();
    }
    autoscroll.frame = requestAnimationFrame(step);
  };
  autoscroll.frame = requestAnimationFrame(step);
}

function stopAutoscroll() {
  if (!autoscroll) return;
  cancelAnimationFrame(autoscroll.frame);
  autoscroll = null;
  autoscrollMarker?.remove();
  container.classList.remove("autoscrolling");
}

// Capture on window: a click anywhere ends a running autoscroll and does
// nothing else (it never reaches the toolbar or the start listener below).
window.addEventListener("mousedown", (event) => {
  if (!autoscroll) return;
  event.preventDefault();
  event.stopPropagation();
  stopAutoscroll();
}, true);

container.addEventListener("mousedown", (event) => {
  if (event.button !== 1 || !pdfDoc) return;
  event.preventDefault(); // no native autoscroll / paste
  startAutoscroll(event);
}, true);

window.addEventListener("mousemove", (event) => {
  if (!autoscroll) return;
  autoscroll.x = event.clientX;
  autoscroll.y = event.clientY;
  if (autoscroll.held && (
    Math.abs(event.clientX - autoscroll.originX) > AUTOSCROLL_DEAD_ZONE ||
    Math.abs(event.clientY - autoscroll.originY) > AUTOSCROLL_DEAD_ZONE
  )) {
    autoscroll.dragged = true;
  }
});

window.addEventListener("mouseup", (event) => {
  if (!autoscroll || event.button !== 1) return;
  if (autoscroll.dragged) stopAutoscroll();
  else autoscroll.held = false;
});

window.addEventListener("keydown", (event) => {
  if (autoscroll && event.key === "Escape") stopAutoscroll();
});
window.addEventListener("blur", stopAutoscroll);

function touchPoint(touch) {
  return containerRelativePoint(touch.clientX, touch.clientY);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function beginGesture(touches) {
  if (touches.length === 1) {
    gesture = panEnabled
      ? { kind: "pan", start: touchPoint(touches[0]), startPanX: panX, startPanY: panY }
      : { kind: "idle" };
  } else if (touches.length === 2) {
    const first = touchPoint(touches[0]);
    const second = touchPoint(touches[1]);
    gesture = {
      kind: "pinch",
      startMid: midpoint(first, second),
      startDistance: distance(first, second),
      startZoom: zoomLevel,
      startPanX: panX,
      startPanY: panY,
    };
  } else {
    gesture = null;
  }
}

container.addEventListener("touchstart", (event) => {
  if (!pdfDoc) return;
  stopFling(); // a touch catches the gliding page, like native scrolling
  stopAutoscroll();
  panVelocity = null;
  beginGesture(event.touches);
}, { passive: true });

container.addEventListener("touchmove", (event) => {
  if (!gesture || !pdfDoc) return;
  event.preventDefault();

  if (gesture.kind === "pan" && event.touches.length === 1) {
    const point = touchPoint(event.touches[0]);
    gesture.lastPoint = point;
    const prevX = panX;
    const prevY = panY;
    panX = gesture.startPanX + point.x - gesture.start.x;
    panY = gesture.startPanY + point.y - gesture.start.y;
    updateView();
    const now = performance.now();
    if (panVelocity && now > panVelocity.time) {
      const dt = now - panVelocity.time;
      // light smoothing so one jittery sample doesn't decide the fling
      panVelocity = {
        vx: 0.4 * panVelocity.vx + 0.6 * ((panX - prevX) / dt),
        vy: 0.4 * panVelocity.vy + 0.6 * ((panY - prevY) / dt),
        time: now,
      };
    } else if (!panVelocity) {
      panVelocity = { vx: 0, vy: 0, time: now };
    }
  } else if (gesture.kind === "pinch" && event.touches.length === 2) {
    const first = touchPoint(event.touches[0]);
    const second = touchPoint(event.touches[1]);
    const mid = midpoint(first, second);
    pendingZoomAnchor = captureAnchor(mid);
    const scale = distance(first, second) / gesture.startDistance;
    const newZoom = Math.min(MAX_ZOOM, Math.max(minimumZoom(), gesture.startZoom * scale));
    const contentX = (gesture.startMid.x - gesture.startPanX) / gesture.startZoom;
    const contentY = (gesture.startMid.y - pagesWrapper.offsetTop - gesture.startPanY) / gesture.startZoom;
    zoomLevel = newZoom;
    panX = mid.x - contentX * zoomLevel;
    panY = mid.y - pagesWrapper.offsetTop - contentY * zoomLevel;
    updateView();
  } else if (gesture.kind !== "idle") {
    beginGesture(event.touches);
  }
}, { passive: false });

function commitZoom() {
  clearTimeout(zoomDebounceTimer);
  rerenderPages({ anchor: pendingZoomAnchor }).catch((err) => {
    reportError(`Could not render PDF: ${err.message || err}`);
  });
}

// A one-finger swipe that flipped the page in paged mode: horizontal, past the
// threshold, and only when the page is already as wide as the viewport (so the
// swipe wasn't meant to pan sideways).
function pagedSwipeDirection(panGesture) {
  if (scrollMode !== "paged" || panGesture?.kind !== "pan" || !panGesture.lastPoint) return 0;
  const dx = panGesture.lastPoint.x - panGesture.start.x;
  const dy = panGesture.lastPoint.y - panGesture.start.y;
  if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) < PAGE_SWIPE_THRESHOLD) return 0;
  if (contentSize().width > container.clientWidth + 1) return 0;
  return dx < 0 ? 1 : -1;
}

container.addEventListener("touchend", (event) => {
  const wasZooming = gesture?.kind === "pinch";
  const wasPanning = gesture?.kind === "pan";
  const swipeDirection = pagedSwipeDirection(gesture);
  if (event.touches.length === 0) {
    gesture = null;
    if (swipeDirection) {
      panVelocity = null;
      goToAdjacentPage(swipeDirection);
      return;
    }
    if (wasPanning && panVelocity && performance.now() - panVelocity.time < FLING_STALE_MS) {
      const speed = Math.hypot(panVelocity.vx, panVelocity.vy);
      if (speed > FLING_MIN_SPEED) {
        const k = Math.min(1, FLING_MAX_SPEED / speed);
        startFling(panVelocity.vx * k, panVelocity.vy * k);
      }
    }
    panVelocity = null;
  } else {
    beginGesture(event.touches);
  }
  if (wasZooming) commitZoom();
});

container.addEventListener("touchcancel", () => {
  panVelocity = null;
  const wasZooming = gesture?.kind === "pinch";
  gesture = null;
  if (wasZooming) commitZoom();
});

window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(async () => {
    if (!pdfDoc) return;
    const anchor = captureAnchor({
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    });
    try {
      const nextFitZoom = await computeFitZoom();
      if (Math.abs(zoomLevel - fitZoom) < 0.001) zoomLevel = nextFitZoom;
      fitZoom = nextFitZoom;
      await rerenderPages({ anchor });
    } catch (err) {
      reportError(`Could not update PDF layout: ${err.message || err}`);
    }
  }, RESIZE_SETTLE_DELAY);
});
