// Immersive full-screen reading mode.
//
// The toolbar turns into an auto-hiding overlay (CSS: body.is-fullscreen),
// revealed by a tap on touch devices or by mouse movement on desktop, so every
// control stays reachable without leaving full screen. Escape and the toolbar's
// own full-screen button (which flips to an "exit" icon) leave the mode. A slim
// page bar is pinned to the bottom, Acrobat-style, for page number + turning.
//
// On the desktop the OS window is also taken full-screen via the Tauri window
// API when it is available; everything degrades gracefully to the CSS-only
// immersive layout when it is not (e.g. the Android WebView).

const CONTROLS_HIDE_DELAY = 2600; // ms of stillness before desktop controls hide

let active = false;
let hideTimer = null;
let changeCallback = null;
let pageBar = null;
let onPrev = null;
let onNext = null;

const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

function tauriWindow() {
  try {
    return window.__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

async function setNativeFullscreen(on) {
  // Android: also hide the system status bar so only the text is left.
  try {
    window.AndroidIntent?.setReadingMode?.(on);
  } catch {
    // bridge unavailable; the CSS layout alone still works
  }
  const win = tauriWindow();
  if (!win?.setFullscreen) return;
  try {
    await win.setFullscreen(on);
  } catch {
    // Window control unavailable (e.g. mobile) — the CSS immersive layout
    // still applies, so there is nothing to recover from here.
  }
}

function scheduleHide() {
  clearTimeout(hideTimer);
  if (isTouch()) return; // touch reveals/hides by tap, not by a timer
  hideTimer = setTimeout(() => {
    if (active) document.body.classList.remove("controls-visible");
  }, CONTROLS_HIDE_DELAY);
}

function showControls() {
  if (!active) return;
  document.body.classList.add("controls-visible");
  scheduleHide();
}

function hideControls() {
  clearTimeout(hideTimer);
  document.body.classList.remove("controls-visible");
}

function toggleControls() {
  if (document.body.classList.contains("controls-visible")) hideControls();
  else showControls();
}

function buildPageBar() {
  const bar = document.createElement("div");
  bar.id = "fs-page-bar";
  bar.innerHTML = `
    <button type="button" data-fs-prev title="Previous page" aria-label="Previous page">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
    </button>
    <span data-fs-label>1 / 1</span>
    <button type="button" data-fs-next title="Next page" aria-label="Next page">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
    </button>`;
  bar.querySelector("[data-fs-prev]").addEventListener("click", () => onPrev?.());
  bar.querySelector("[data-fs-next]").addEventListener("click", () => onNext?.());
  document.body.appendChild(bar);
  return bar;
}

export function updateFullscreenPage(current, total) {
  if (!pageBar) return;
  pageBar.querySelector("[data-fs-label]").textContent = `${current} / ${total}`;
  pageBar.querySelector("[data-fs-prev]").disabled = current <= 1;
  pageBar.querySelector("[data-fs-next]").disabled = current >= total;
}

export function isFullscreen() {
  return active;
}

export function enterFullscreen() {
  if (active) return;
  active = true;
  document.body.classList.add("is-fullscreen");
  setNativeFullscreen(true);
  // Let the layout settle at its new size, then recompute the fit.
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  showControls();
  changeCallback?.(true);
}

export function exitFullscreen() {
  if (!active) return;
  active = false;
  clearTimeout(hideTimer);
  document.body.classList.remove("is-fullscreen", "controls-visible");
  setNativeFullscreen(false);
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  changeCallback?.(false);
}

export function toggleFullscreen() {
  if (active) exitFullscreen();
  else enterFullscreen();
}

// `viewerEl` is the scroll/pan surface; a tap on it toggles controls on touch.
// `onChange(active)` lets the caller sync the toolbar button state.
export function initFullscreen({ viewerEl, onChange, onPrevPage, onNextPage }) {
  changeCallback = onChange ?? null;
  onPrev = onPrevPage ?? null;
  onNext = onNextPage ?? null;
  pageBar = buildPageBar();

  // Desktop: any mouse movement reveals the controls and resets the hide timer.
  window.addEventListener("mousemove", () => {
    if (active && !isTouch()) showControls();
  });

  // Touch: a tap on the page toggles the control overlay.
  viewerEl?.addEventListener("click", () => {
    if (active && isTouch()) toggleControls();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active) {
      event.preventDefault();
      exitFullscreen();
    }
  });
}
