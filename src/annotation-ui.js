// Mark-up UI for PDFs: the "Mark up" toggle, the floating tool bar (tools,
// colour, undo/redo, save menu), the highlight-from-selection glue, the small
// dialogs (note text, unsaved marks, overwrite) and the wiring of the
// annotation store + SVG layer controller into the viewer's page hooks.
//
// With no tool selected the viewer behaves exactly as without mark-up: the
// annotation surfaces let every press through and one finger pans.
import { createAnnotationStore } from "./annotations.js";
import { createAnnotationLayerController } from "./annotation-layer.js";
import { clientRectsToPageRects } from "./selection-rects.js";
import { saveAnnotations } from "./annotation-save.js";
import { createUnsavedGuard } from "./unsaved-guard.js";
import {
  setPageRenderedHook,
  setPageUnloadedHook,
  setDocumentChangeHook,
  setPanEnabled,
  getOriginalPdfBytes,
  getPageConverters,
} from "./viewer.js";

const COARSE_POINTER = window.matchMedia("(pointer: coarse)").matches;
// How long a text selection must stay unchanged (with no finger or button
// down) before it becomes a highlight. Longer on touch, so the selection
// handles can still be dragged after the long-press that started it.
const SELECTION_SETTLE_MS = COARSE_POINTER ? 700 : 200;

export function initAnnotationUi({ setStatus, backStack, getDisplayName }) {
  const toggleBtn = document.getElementById("markup-btn");
  const bar = document.getElementById("markup-bar");
  const toolButtons = [...bar.querySelectorAll("[data-tool]")];
  const colorBtn = document.getElementById("markup-color-btn");
  const colorMenu = document.getElementById("markup-color-menu");
  const swatches = [...colorMenu.querySelectorAll("[data-color]")];
  const undoBtn = document.getElementById("markup-undo-btn");
  const redoBtn = document.getElementById("markup-redo-btn");
  const saveBtn = document.getElementById("markup-save-btn");
  const saveMenu = document.getElementById("markup-save-menu");
  const pagesEl = document.getElementById("pdf-pages");

  const store = createAnnotationStore();
  const controller = createAnnotationLayerController({
    store,
    onStatus: setStatus,
    editNoteText: ({ text }) => openNoteEditor(text),
  });
  let saving = false;
  let selectionTimer = 0;
  let dialogEl = null; // open dialog's backdrop, if any
  let dialogResolve = null;

  setPageRenderedHook((info) => controller.handlePageRendered(info));
  setPageUnloadedHook((pageNumber) => controller.handlePageUnloaded(pageNumber));
  // A new or closed document starts with no marks and the bar closed. The
  // unsaved-marks question was already asked before the open/close began.
  setDocumentChangeHook(() => {
    closeDialog();
    store.clear();
    closeBar();
  });

  // ---------- tools, colour, undo/redo ----------

  function selectTool(tool) {
    controller.setTool(tool);
    for (const button of toolButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
    }
    // One finger belongs to the tool (a stroke must not pan); two fingers
    // still pinch-zoom because the viewer's pinch does not depend on this.
    setPanEnabled(tool === null);
    if (tool !== "highlight") clearTimeout(selectionTimer);
  }

  function selectColor(hex) {
    controller.setColor(hex);
    colorBtn.style.setProperty("--markup-color", hex);
    for (const swatch of swatches) {
      swatch.setAttribute("aria-pressed", String(swatch.dataset.color === hex));
    }
  }

  function sync() {
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    saveBtn.disabled = saving || store.all().length === 0;
    saveBtn.classList.toggle("has-unsaved", hasUnsavedMarks());
  }

  // Marks someone could lose. Marks erased after a save are not counted: the
  // saved file already has whatever they wanted to keep.
  function hasUnsavedMarks() {
    return store.isDirty() && store.all().length > 0;
  }

  // ---------- bar and its menus ----------

  function openBar() {
    if (!bar.hidden) return;
    bar.hidden = false;
    toggleBtn.setAttribute("aria-pressed", "true");
    sync();
    // Android Back closes the bar before it closes the document.
    backStack.push("markup-bar", closeBar);
  }

  function closeBar() {
    closeMenus();
    selectTool(null);
    if (bar.hidden) return;
    bar.hidden = true;
    toggleBtn.setAttribute("aria-pressed", "false");
    backStack.release("markup-bar");
  }

  function openMenu(menu, button) {
    closeMenus();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    backStack.push("markup-menu", closeMenus);
  }

  function closeMenus() {
    colorMenu.hidden = true;
    saveMenu.hidden = true;
    colorBtn.setAttribute("aria-expanded", "false");
    saveBtn.setAttribute("aria-expanded", "false");
    backStack.release("markup-menu");
  }

  toggleBtn.addEventListener("click", () => (bar.hidden ? openBar() : closeBar()));
  for (const button of toolButtons) {
    button.addEventListener("click", () => {
      closeMenus();
      selectTool(controller.getTool() === button.dataset.tool ? null : button.dataset.tool);
    });
  }
  colorBtn.addEventListener("click", () => {
    if (colorMenu.hidden) openMenu(colorMenu, colorBtn);
    else closeMenus();
  });
  for (const swatch of swatches) {
    swatch.addEventListener("click", () => {
      selectColor(swatch.dataset.color);
      closeMenus();
    });
  }
  undoBtn.addEventListener("click", () => store.undo());
  redoBtn.addEventListener("click", () => store.redo());
  saveBtn.addEventListener("click", () => {
    if (saveMenu.hidden) openMenu(saveMenu, saveBtn);
    else closeMenus();
  });
  for (const item of saveMenu.querySelectorAll("[data-save-mode]")) {
    item.addEventListener("click", () => {
      closeMenus();
      if (item.dataset.saveMode === "overwrite") confirmAndOverwrite();
      else save("copy");
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!colorMenu.hidden || !saveMenu.hidden) {
      if (!bar.contains(event.target)) closeMenus();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (bar.hidden || dialogEl) return;
    if (event.key === "Escape" && (!colorMenu.hidden || !saveMenu.hidden)) {
      closeMenus();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
    } else if (key === "y") {
      event.preventDefault();
      store.redo();
    }
  });

  // In reading mode a tap on the page toggles the controls (fullscreen.js).
  // A tap that places a note or erases is not meant for that.
  pagesEl.addEventListener("click", (event) => {
    if (controller.getTool() && controller.getTool() !== "highlight" &&
      event.target.closest?.(".annot-surface")) {
      event.stopPropagation();
    }
  }, true);

  store.subscribe(sync);
  selectColor(swatches[0]?.dataset.color ?? controller.getColor());
  sync();

  // ---------- highlight: text selection -> marks ----------

  const pressedPointers = new Set();

  function scheduleSelectionCommit() {
    clearTimeout(selectionTimer);
    if (controller.getTool() !== "highlight") return;
    selectionTimer = setTimeout(commitSelection, SELECTION_SETTLE_MS);
  }

  document.addEventListener("selectionchange", scheduleSelectionCommit);
  document.addEventListener("pointerdown", (event) => {
    pressedPointers.add(event.pointerId);
    if (controller.getTool() === "highlight") reportPageWithoutText(event.target);
  }, true);
  const release = (event) => {
    if (!pressedPointers.delete(event.pointerId)) return;
    if (pressedPointers.size === 0) scheduleSelectionCommit();
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", () => pressedPointers.clear());

  function reportPageWithoutText(target) {
    const slot = target?.closest?.(".pdf-page-slot");
    if (!slot || !pagesEl.contains(slot)) return;
    // Only judge pages that finished rendering (the text layer is mounted
    // before the rendered hook fires); a page still loading may get text.
    if (!controller.pageInfo(Number(slot.dataset.pageNumber))) return;
    const layer = slot.querySelector(".text-layer");
    if (!layer || layer.textContent.trim() === "") {
      setStatus("No selectable text on this page");
    }
  }

  function commitSelection() {
    if (controller.getTool() !== "highlight" || pressedPointers.size > 0) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const layers = [...pagesEl.querySelectorAll(".text-layer")]
      .filter((layer) => range.intersectsNode(layer));
    if (layers.length === 0) return;

    const pages = [];
    const clientRects = [];
    for (const layer of layers) {
      const slot = layer.closest(".pdf-page-slot");
      const pageNumber = Number(slot?.dataset.pageNumber);
      const info = controller.pageInfo(pageNumber);
      if (!info) continue;
      pages.push({ pageNumber, box: slot.getBoundingClientRect(), width: info.width, height: info.height });
      clientRects.push(...selectedTextRects(layer, range));
    }
    const byPage = clientRectsToPageRects(clientRects, pages);
    const color = controller.getColor();
    for (const [page, rects] of byPage) {
      if (rects.length > 0) store.add({ type: "highlight", page, color, rects });
    }
    selection.removeAllRanges();
  }

  // Boxes of the selected glyphs only: one sub-range per selected text node.
  // range.getClientRects() would also return whole element boxes (a fully
  // selected text layer is the size of the page).
  function selectedTextRects(layer, range) {
    const rects = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      const part = document.createRange();
      part.selectNodeContents(node);
      if (node === range.startContainer) part.setStart(node, range.startOffset);
      if (node === range.endContainer) part.setEnd(node, range.endOffset);
      for (const r of part.getClientRects()) {
        rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
    }
    return rects;
  }

  // ---------- saving ----------

  async function save(mode) {
    if (saving) return { ok: false, message: "A save is already running" };
    saving = true;
    sync();
    try {
      return await saveAnnotations(mode, {
        store,
        getBytes: getOriginalPdfBytes,
        getPages: getPageConverters,
        displayName: getDisplayName(),
        setStatus,
        renderNoteImage,
      });
    } finally {
      saving = false;
      sync();
    }
  }

  async function confirmAndOverwrite() {
    const { choice } = await openDialog({
      title: "Overwrite the original file?",
      message: "The file you opened is replaced by a version with your marks. This cannot be undone.",
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "overwrite", label: "Overwrite", kind: "danger" },
      ],
    });
    if (choice === "overwrite") await save("overwrite");
  }

  const confirmLeave = createUnsavedGuard({
    isDirty: hasUnsavedMarks,
    ask: async () => (await openDialog({
      title: "Unsaved marks",
      message: "Your marks on this PDF are not saved yet.",
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "discard", label: "Discard", kind: "danger" },
        { id: "save", label: "Save copy", kind: "primary" },
      ],
    })).choice,
    save: () => save("copy"),
  });

  // Reloading the page (or a webview that honours it) would drop the marks.
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedMarks()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // ---------- dialogs ----------

  // A small modal: optional textarea plus buttons. Resolves to
  // { choice, text }; Back, Escape and a tap outside resolve to "cancel".
  function openDialog({ title, message = "", text = null, buttons }) {
    closeDialog();
    const backdrop = document.createElement("div");
    backdrop.className = "markup-dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "markup-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    dialog.append(heading);
    if (message) {
      const p = document.createElement("p");
      p.textContent = message;
      dialog.append(p);
    }
    let textarea = null;
    if (text !== null) {
      textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.placeholder = "Note";
      textarea.value = text;
      dialog.append(textarea);
    }
    const actions = document.createElement("div");
    actions.className = "markup-dialog-actions";
    for (const { id, label, kind } of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (kind) button.classList.add(`markup-dialog-${kind}`);
      button.addEventListener("click", () => closeDialog(id));
      actions.append(button);
    }
    dialog.append(actions);
    backdrop.append(dialog);
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) closeDialog("cancel");
    });
    dialog.addEventListener("keydown", (event) => {
      // Escape must not also leave full screen or close a menu underneath.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog("cancel");
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && textarea) {
        event.preventDefault();
        closeDialog(buttons[buttons.length - 1].id);
      }
    });
    document.body.append(backdrop);
    dialogEl = backdrop;
    backStack.push("markup-dialog", () => closeDialog("cancel"));
    (textarea ?? actions.lastElementChild)?.focus();
    return new Promise((resolve) => {
      dialogResolve = (choice) => resolve({ choice, text: textarea?.value ?? null });
    });
  }

  function closeDialog(choice = "cancel") {
    if (!dialogEl) return;
    const resolve = dialogResolve;
    dialogEl.remove();
    dialogEl = null;
    dialogResolve = null;
    backStack.release("markup-dialog");
    resolve?.(choice);
  }

  async function openNoteEditor(text) {
    const result = await openDialog({
      title: text ? "Note" : "Add a note",
      text,
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "save", label: "Save", kind: "primary" },
      ],
    });
    return result.choice === "save" ? result.text : null;
  }

  return {
    // Shows the Mark up button for PDFs only; anything else closes the bar.
    syncForKind(kind) {
      toggleBtn.hidden = kind !== "pdf";
      if (kind !== "pdf") closeBar();
    },
    // Resolves true when it is fine to replace or close the open document.
    confirmLeave,
    hasUnsavedMarks,
  };
}

// Draws a note's text to a PNG so the saved PDF shows it in any script
// (Turkish letters, emoji) without embedding a font. Size is in page units.
const NOTE_FONT = '14px system-ui, "Segoe UI", sans-serif';
const NOTE_LINE_HEIGHT = 18;
const NOTE_PADDING = 6;
const NOTE_MAX_TEXT_WIDTH = 220;

function wrapNoteText(context, text) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (line && context.measureText(next).width > NOTE_MAX_TEXT_WIDTH) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function renderNoteImage(note) {
  const scale = 2;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = NOTE_FONT;
  const lines = wrapNoteText(probe, note.text);
  const textWidth = Math.max(40, ...lines.map((line) => probe.measureText(line).width));
  const width = Math.ceil(Math.min(textWidth, NOTE_MAX_TEXT_WIDTH) + NOTE_PADDING * 2);
  const height = Math.ceil(lines.length * NOTE_LINE_HEIGHT + NOTE_PADDING * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.fillStyle = "#fffbe6";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = note.color;
  context.lineWidth = 2;
  context.strokeRect(1, 1, width - 2, height - 2);
  context.fillStyle = "#201d1a";
  context.font = NOTE_FONT;
  context.textBaseline = "top";
  lines.forEach((line, i) => context.fillText(line, NOTE_PADDING, NOTE_PADDING + i * NOTE_LINE_HEIGHT));
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw the note for saving");
  return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
}
