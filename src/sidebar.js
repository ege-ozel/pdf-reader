import { groupByPinned, recentLimitNote } from "./recent-list.js";
import { emit, on } from "./app-events.js";
import { documentKindFromName } from "./document-kind.js";
import { getBackStack } from "./back-stack.js";

const { invoke } = window.__TAURI__.core;

let pinnedContainer = null;
let recentContainer = null;
let activePath = null;

export function initSidebar() {
  pinnedContainer = document.getElementById("sidebar-pinned");
  recentContainer = document.getElementById("sidebar-recent");

  refresh();
  on("file-opened", (detail) => refresh(detail?.path ?? null));

  initDrawer();
}

function initDrawer() {
  const appShell = document.getElementById("app-shell");
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const backdrop = document.getElementById("sidebar-backdrop");

  const backStack = getBackStack();

  const setOpen = (open) => {
    const wasOpen = appShell.classList.contains("sidebar-open");
    if (open === wasOpen) return;
    appShell.classList.toggle("sidebar-open", open);
    toggleBtn.setAttribute("aria-expanded", String(open));

    // The open drawer is a back-stack layer (see back-stack.js), so the
    // Android back button/gesture closes it first instead of leaving the
    // app; closing it any other way drops its history entry again. When Back
    // itself closes it, the stack has already removed the layer, so this
    // release is a no-op.
    if (open) backStack.push("sidebar", () => setOpen(false));
    else backStack.release("sidebar");
  };

  toggleBtn.addEventListener("click", () => {
    setOpen(!appShell.classList.contains("sidebar-open"));
  });
  backdrop.addEventListener("click", () => setOpen(false));
  // picking a file should get the drawer out of the way on narrow screens
  on("open-requested", () => setOpen(false));

  initSwipeToClose(document.getElementById("sidebar"), setOpen);
}

// Lets a touch user drag the open drawer closed instead of only tapping the
// backdrop or toggle button. Tracks the raw finger position during the drag
// so the drawer follows the finger, then either commits to closed or snaps
// back based on how far/fast the swipe went. A real-world swipe is usually
// a quick, short flick rather than a slow drag past a distance threshold,
// so a fast flick commits to closed even if it didn't travel very far.
function initSwipeToClose(sidebar, setOpen) {
  const CLOSE_DISTANCE_RATIO = 0.3; // fraction of drawer width that counts as "closed" on its own
  const FLICK_VELOCITY = 0.5; // px/ms leftward that counts as a deliberate flick
  const FLICK_MIN_DISTANCE = 24; // ignore tiny jitters when checking velocity
  let startX = null;
  let startTime = 0;
  let currentDeltaX = 0;
  let lastMoveX = 0;
  let lastMoveTime = 0;
  let velocity = 0; // px/ms, negative = leftward
  let dragging = false;

  sidebar.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startTime = event.timeStamp;
      lastMoveX = startX;
      lastMoveTime = startTime;
      currentDeltaX = 0;
      velocity = 0;
      dragging = true;
      sidebar.style.transition = "none";
    },
    { passive: true }
  );

  sidebar.addEventListener(
    "touchmove",
    (event) => {
      if (!dragging || startX === null) return;
      const touchX = event.touches[0].clientX;
      const dt = event.timeStamp - lastMoveTime;
      if (dt > 0) velocity = (touchX - lastMoveX) / dt;
      lastMoveX = touchX;
      lastMoveTime = event.timeStamp;

      currentDeltaX = Math.min(0, touchX - startX); // only allow dragging leftward (closing)
      sidebar.style.transform = `translateX(${currentDeltaX}px)`;
    },
    { passive: true }
  );

  const endSwipe = () => {
    if (!dragging) return;
    dragging = false;
    sidebar.style.transition = "";
    sidebar.style.transform = "";
    const closeDistance = -sidebar.getBoundingClientRect().width * CLOSE_DISTANCE_RATIO;
    const wasFlicked = currentDeltaX < -FLICK_MIN_DISTANCE && velocity < -FLICK_VELOCITY;
    if (currentDeltaX < closeDistance || wasFlicked) {
      setOpen(false);
    }
    startX = null;
    currentDeltaX = 0;
  };

  sidebar.addEventListener("touchend", endSwipe);
  sidebar.addEventListener("touchcancel", endSwipe);
}

async function refresh(openedPath) {
  const entries = await invoke("get_recent_files");
  const { pinned, recent } = groupByPinned(entries);
  if (openedPath !== undefined) activePath = openedPath ?? entries[0]?.path ?? null;
  render(pinnedContainer, pinned);
  render(recentContainer, recent);
  const note = recentLimitNote(recent.length);
  const noteEl = document.getElementById("sidebar-recent-note");
  noteEl.textContent = note ?? "";
  noteEl.hidden = note === null;
}

function render(container, entries) {
  container.innerHTML = "";
  for (const entry of entries) {
    container.appendChild(renderRow(entry));
  }
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "sidebar-row";
  row.classList.toggle("active", entry.path === activePath);
  row.setAttribute("aria-current", entry.path === activePath ? "true" : "false");

  const kind = documentKindFromName(entry.name);
  if (kind === "pdf" || kind === "docx") {
    const badge = document.createElement("span");
    badge.className = `sidebar-row-kind sidebar-row-kind-${kind}`;
    badge.textContent = kind === "docx" ? "DOCX" : "PDF";
    badge.setAttribute("aria-hidden", "true");
    badge.addEventListener("click", () => {
      emit("open-requested", { path: entry.path });
    });
    row.appendChild(badge);
  }

  const label = document.createElement("span");
  label.className = "sidebar-row-label";
  label.textContent = entry.name;
  label.title = entry.path;
  label.addEventListener("click", () => {
    emit("open-requested", { path: entry.path });
  });
  row.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "sidebar-row-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "sidebar-action-btn sidebar-copy-btn";
  copyBtn.title = "Copy filename";
  copyBtn.setAttribute("aria-label", `Copy filename ${entry.name}`);
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>`;
  copyBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await copyText(entry.name);
      copyBtn.classList.add("copied");
      copyBtn.title = "Filename copied";
      copyBtn.setAttribute("aria-label", `Copied filename ${entry.name}`);
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.title = "Copy filename";
        copyBtn.setAttribute("aria-label", `Copy filename ${entry.name}`);
      }, 1200);
    } catch {
      copyBtn.title = "Could not copy filename";
    }
  });
  actions.appendChild(copyBtn);

  const pinBtn = document.createElement("button");
  pinBtn.className = "sidebar-action-btn sidebar-pin-btn";
  pinBtn.innerHTML = entry.pinned
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></svg>`;
  pinBtn.title = entry.pinned ? "Unstar" : "Star";
  pinBtn.setAttribute("aria-label", `${entry.pinned ? "Unstar" : "Star"} ${entry.name}`);
  pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await invoke("toggle_pin", { path: entry.path });
    await refresh();
  });
  actions.appendChild(pinBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "sidebar-action-btn sidebar-remove-btn";
  removeBtn.title = "Remove from list";
  removeBtn.setAttribute("aria-label", `Remove ${entry.name} from the file list`);
  removeBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>`;
  removeBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!(await confirmRemove(entry.name))) return;
    await invoke("remove_recent_entry", { path: entry.path });
    await refresh();
  });
  actions.appendChild(removeBtn);
  row.appendChild(actions);

  return row;
}

// Native dialog (tauri-plugin-dialog) rather than window.confirm, which the
// Android WebView doesn't reliably show.
async function confirmRemove(name) {
  const message = `Remove "${name}" from the list?\nThe file itself is not deleted.`;
  const ask = window.__TAURI__.dialog?.ask;
  if (!ask) return window.confirm(message);
  return ask(message, {
    title: "Remove from list",
    kind: "warning",
    okLabel: "Remove",
    cancelLabel: "Cancel",
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed");
}
