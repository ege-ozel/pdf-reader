import {
  renderPdf,
  closePdf,
  setStatusCallback,
  setPageMode,
  isSinglePageMode,
  zoomByStep,
  resetZoom,
  fitPage,
  goToPage,
  goToAdjacentPage,
  setScrollMode,
  getScrollMode,
  setPageChangeHook,
  getPageCount,
  getCurrentPage,
} from "./viewer.js";
import { renderDocx, closeDocx, zoomDocxByStep, resetDocxZoom } from "./docx-viewer.js";
import {
  initFullscreen,
  toggleFullscreen,
  isFullscreen,
  updateFullscreenPage,
} from "./fullscreen.js";
import { detectDocumentKind, pickDroppedPath, LEGACY_DOC_MESSAGE } from "./document-kind.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const pageLayoutSeg = document.getElementById("page-layout-seg");
const layoutOptions = [...document.querySelectorAll("[data-page-layout]")];
const toolbarMenuWrap = document.getElementById("toolbar-menu-wrap");
const toolbarMenuBtn = document.getElementById("toolbar-menu-btn");
const toolbarMenu = document.getElementById("toolbar-menu");
const scrollModeOptions = [...document.querySelectorAll("[data-scroll-mode]")];
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomResetBtn = document.getElementById("zoom-reset-btn");
const fitPageBtn = document.getElementById("fit-page-btn");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const menuZoomInBtn = document.getElementById("menu-zoom-in-btn");
const menuZoomOutBtn = document.getElementById("menu-zoom-out-btn");
const menuZoomResetBtn = document.getElementById("menu-zoom-reset-btn");
const pageNav = document.getElementById("page-nav");
const pageNavBtn = document.getElementById("page-nav-btn");
const pageNavLabel = document.getElementById("page-nav-label");
const pageNavPopover = document.getElementById("page-nav-popover");
const pageNavInput = document.getElementById("page-nav-input");
const pageNavTotal = document.getElementById("page-nav-total");
const pagePrevBtn = document.getElementById("page-prev-btn");
const pageNextBtn = document.getElementById("page-next-btn");
const status = document.getElementById("status");
const loadingIndicator = document.getElementById("loading-indicator");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");
const docxContainer = document.getElementById("docx-container");

// "pdf" | "docx" | null — which viewer currently shows a document.
let activeKind = null;
// Bumped on every open, so a slow render that finishes after a newer open
// started can tell it was superseded and leave the UI alone.
let openSequence = 0;

function setStatus(message) {
  status.textContent = message;
  status.classList.toggle("status-error", message.startsWith("Error"));
}

setStatusCallback(setStatus);

function showViewer(kind) {
  emptyState.hidden = true;
  viewerContainer.hidden = kind !== "pdf";
  docxContainer.hidden = kind !== "docx";
  // The immersive bottom page bar is only meaningful for PDFs.
  document.body.classList.toggle("pdf-active", kind === "pdf");
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
  docxContainer.hidden = true;
  document.body.classList.remove("pdf-active");
  activeKind = null;
  syncToolbarForKind(null);
  closeDocx();
  closePdf().catch(() => {
    // best-effort release; nothing is shown either way
  });
}

function syncLayoutSegment() {
  const single = isSinglePageMode();
  for (const option of layoutOptions) {
    const active = option.dataset.pageLayout === (single ? "single" : "dual");
    option.setAttribute("aria-pressed", String(active));
  }
}

function syncScrollModeOptions() {
  const mode = getScrollMode();
  for (const option of scrollModeOptions) {
    const selected = option.dataset.scrollMode === mode;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  }
}

// Page layout, scroll mode and page navigation only apply to PDFs; zoom and
// full screen apply to both viewers.
function syncToolbarForKind(kind) {
  const isPdf = kind === "pdf";
  pageLayoutSeg.hidden = !isPdf;
  pageNav.hidden = !isPdf;
  fitPageBtn.hidden = !isPdf;
  for (const option of scrollModeOptions) option.disabled = !isPdf;
  zoomInBtn.hidden = kind === null;
  zoomOutBtn.hidden = kind === null;
  zoomResetBtn.hidden = kind === null;
  fullscreenBtn.hidden = kind === null;
  toolbarMenuWrap.hidden = kind === null;
  if (isPdf) {
    syncLayoutSegment();
    syncScrollModeOptions();
  }
}

function closeToolbarMenu() {
  toolbarMenu.hidden = true;
  toolbarMenuBtn.setAttribute("aria-expanded", "false");
}

function closePageNav() {
  pageNavPopover.hidden = true;
  pageNavBtn.setAttribute("aria-expanded", "false");
}

function openPageNav() {
  pageNavPopover.hidden = false;
  pageNavBtn.setAttribute("aria-expanded", "true");
  const current = getCurrentPage() ?? 1;
  pageNavInput.value = String(current);
  pageNavInput.max = String(getPageCount());
  pageNavInput.focus();
  pageNavInput.select();
}

// Keeps the top-bar pill, the popover input and the full-screen page bar in
// step with whatever page the viewer reports as current.
function updatePageIndicator(current, total) {
  pageNavLabel.textContent = `${current} / ${total}`;
  pageNavTotal.textContent = `/ ${total}`;
  if (pageNavPopover.hidden) pageNavInput.value = String(current);
  pagePrevBtn.disabled = current <= 1;
  pageNextBtn.disabled = current >= total;
  updateFullscreenPage(current, total);
}

// Renders a file's bytes in the viewer that matches its contents (not its
// name — Android content:// URIs have none). Returns false when a newer open
// superseded this one mid-render, or when a legacy .doc was rejected (the
// error is already in the status bar); the caller must then leave the UI alone.
async function showDocument(bytes) {
  // Keep the bridge's Uint8Array backing buffer; copying a large local PDF here
  // needlessly doubles peak input memory before PDF.js even starts parsing it.
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Unrecognized bytes go to PDF.js, which reports its own precise error.
  const kind = detectDocumentKind(data) ?? "pdf";
  // A rejected legacy .doc touches nothing: the open document (or an open
  // still in progress) and the toolbar stay as they are.
  if (kind === "doc") {
    setStatus(`Error: ${LEGACY_DOC_MESSAGE}`);
    return false;
  }
  const sequence = ++openSequence;
  activeKind = null;
  try {
    if (kind === "docx") {
      await closePdf();
      if (sequence !== openSequence) return false;
      showViewer("docx");
      await renderDocx(data);
    } else {
      closeDocx();
      showViewer("pdf");
      await renderPdf(data);
    }
  } catch (err) {
    if (sequence !== openSequence) return false;
    throw err;
  }
  if (sequence !== openSequence) return false;
  activeKind = kind;
  syncToolbarForKind(kind);
  return true;
}

async function openViaBytesResult(invokePromise) {
  setStatus("");
  loadingIndicator.hidden = false;
  try {
    const bytes = await invokePromise;
    if (await showDocument(bytes)) emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    setStatus(`Error: ${err}`);
    showEmptyState();
  } finally {
    loadingIndicator.hidden = true;
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_document_file"));
}

async function handleOpenRequested({ path }) {
  setStatus("");
  loadingIndicator.hidden = false;
  let bytes;
  try {
    bytes = await invoke("open_document_path", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    loadingIndicator.hidden = true;
    try {
      await invoke("remove_recent_entry", { path });
    } catch {
      // best-effort cleanup; the read already failed, nothing more to do
    }
    emit("file-opened", null); // refresh sidebar to drop the dead entry
    return;
  }
  try {
    if (await showDocument(bytes)) emit("file-opened", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    showEmptyState(); // don't strand the UI on a blank viewer pane
  } finally {
    loadingIndicator.hidden = true;
  }
}

function zoomActiveByStep(direction) {
  if (activeKind === "docx") zoomDocxByStep(direction);
  else zoomByStep(direction);
}

function resetActiveZoom() {
  if (activeKind === "docx") resetDocxZoom();
  else resetZoom();
}

function syncFullscreenButton(on) {
  fullscreenBtn.setAttribute("aria-pressed", String(on));
  fullscreenBtn.title = on ? "Exit full screen" : "Full screen";
  fullscreenBtn.setAttribute("aria-label", on ? "Exit full screen" : "Enter full screen");
}

function commitPageJump() {
  const value = Number.parseInt(pageNavInput.value, 10);
  if (Number.isFinite(value)) goToPage(value);
  closePageNav();
}

openBtn.addEventListener("click", handleOpenClick);

for (const option of layoutOptions) {
  option.addEventListener("click", () => {
    setPageMode(option.dataset.pageLayout);
    syncLayoutSegment();
  });
}

toolbarMenuBtn.addEventListener("click", () => {
  const opening = toolbarMenu.hidden;
  toolbarMenu.hidden = !opening;
  toolbarMenuBtn.setAttribute("aria-expanded", String(opening));
});
for (const option of scrollModeOptions) {
  option.addEventListener("click", () => {
    setScrollMode(option.dataset.scrollMode);
    syncScrollModeOptions();
    closeToolbarMenu();
  });
}
menuZoomInBtn.addEventListener("click", () => zoomActiveByStep(1));
menuZoomOutBtn.addEventListener("click", () => zoomActiveByStep(-1));
menuZoomResetBtn.addEventListener("click", () => resetActiveZoom());

document.addEventListener("pointerdown", (event) => {
  if (!toolbarMenu.hidden && !toolbarMenuWrap.contains(event.target)) closeToolbarMenu();
  if (!pageNavPopover.hidden && !pageNav.contains(event.target)) closePageNav();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeToolbarMenu();
    closePageNav();
  }
});

zoomInBtn.addEventListener("click", () => zoomActiveByStep(1));
zoomOutBtn.addEventListener("click", () => zoomActiveByStep(-1));
zoomResetBtn.addEventListener("click", () => resetActiveZoom());
fitPageBtn.addEventListener("click", () => fitPage());
fullscreenBtn.addEventListener("click", () => toggleFullscreen());

pageNavBtn.addEventListener("click", () => {
  if (pageNavPopover.hidden) openPageNav();
  else closePageNav();
});
pagePrevBtn.addEventListener("click", () => goToAdjacentPage(-1));
pageNextBtn.addEventListener("click", () => goToAdjacentPage(1));
pageNavInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitPageJump();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation(); // close the popover without exiting full screen
    closePageNav();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomActiveByStep(1);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomActiveByStep(-1);
    } else if (event.key === "0") {
      event.preventDefault();
      resetActiveZoom();
    }
    return;
  }
  // Arrow / page keys turn pages when paging through one page at a time, and
  // while immersive (Acrobat-style), but never while typing a page number.
  if (activeKind !== "pdf" || event.target === pageNavInput) return;
  if (getScrollMode() !== "paged" && !isFullscreen()) return;
  if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    goToAdjacentPage(1);
  } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    goToAdjacentPage(-1);
  }
});

let layoutSyncTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(layoutSyncTimer);
  layoutSyncTimer = setTimeout(() => {
    if (activeKind === "pdf") syncLayoutSegment();
  }, 220);
});
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

setPageChangeHook(updatePageIndicator);
initFullscreen({
  viewerEl: viewerContainer,
  onChange: syncFullscreenButton,
  onPrevPage: () => goToAdjacentPage(-1),
  onNextPage: () => goToAdjacentPage(1),
});

initSidebar();
initEmptyState();
showEmptyState();

invoke("get_launch_path").then((path) => {
  if (path) handleOpenRequested({ path });
});

getCurrentWebview().onDragDropEvent((event) => {
  const type = event.payload.type;
  if (type === "over") {
    document.body.classList.add("drag-active");
  } else if (type === "drop") {
    document.body.classList.remove("drag-active");
    const dropped = pickDroppedPath(event.payload.paths || []);
    if (dropped.error) {
      setStatus(dropped.error);
      return;
    }
    handleOpenRequested({ path: dropped.path });
  } else {
    document.body.classList.remove("drag-active");
  }
}).catch(() => {
  setStatus("Drag-and-drop unavailable.");
});
