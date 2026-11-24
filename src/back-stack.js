// Back-button stack for dismissable UI layers (popover, menu, full screen,
// sidebar drawer, the open document).
//
// Tauri's Android shell maps the hardware/gesture back button to
// WebView.goBack(), which only does something in-page while there is
// same-document history; otherwise the app exits. So every open layer owns
// one history entry, tagged with its depth ({ backDepth: n }), and the stack
// keeps "history depth === number of open layers" true:
//
//  - push(id, close): a layer was shown; adds an entry for it.
//  - release(id): a layer was closed some other way (button, Escape, tap
//    outside); drops it and steps history back over its now-stale entry.
//  - popstate (Back): closes layers until the stack matches the new depth.
//
// Entries are anonymous tokens: which layer Back closes is decided by this
// stack (always the top), not by which entry was popped, so releasing a
// layer from the middle of the stack stays consistent too.
//
// Our own history.go() is asynchronous; while it is in flight, the next
// popstate is ours and only re-syncs history instead of closing layers, and
// pushes wait for it to land so they cannot be undone by it.

const PENDING_TIMEOUT_MS = 1000;

export function createBackStack({ history, now = () => Date.now() }) {
  const layers = []; // [{ id, close }], bottom -> top
  let pendingSince = null;

  const isPending = () => pendingSince !== null && now() - pendingSince < PENDING_TIMEOUT_MS;

  const historyDepth = () => {
    const depth = history.state?.backDepth;
    return Number.isInteger(depth) && depth > 0 ? depth : 0;
  };

  // Makes the history depth equal the number of open layers.
  function sync() {
    if (isPending()) return;
    pendingSince = null;
    let depth = historyDepth();
    if (depth > layers.length) {
      pendingSince = now();
      history.go(layers.length - depth);
      return;
    }
    while (depth < layers.length) {
      depth += 1;
      history.pushState({ backDepth: depth }, "");
    }
  }

  function push(id, close) {
    if (layers.some((layer) => layer.id === id)) return;
    layers.push({ id, close });
    sync();
  }

  function release(id) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index === -1) return;
    layers.splice(index, 1);
    sync();
  }

  function handlePopState() {
    if (isPending()) {
      // The traversal we started in sync() landed.
      pendingSince = null;
      sync();
      return;
    }
    pendingSince = null;
    const depth = historyDepth();
    // Remove each layer before calling its close callback, so the callback's
    // own release(id) is a no-op instead of a second history step.
    while (layers.length > depth) {
      const layer = layers.pop();
      try {
        layer.close();
      } catch (err) {
        console.error(err);
      }
    }
    sync();
  }

  return {
    push,
    release,
    handlePopState,
    has: (id) => layers.some((layer) => layer.id === id),
    ids: () => layers.map((layer) => layer.id),
  };
}

let shared = null;

// The app-wide stack bound to the real window history.
export function getBackStack() {
  if (!shared) {
    shared = createBackStack({ history: window.history });
    window.addEventListener("popstate", () => shared.handlePopState());
  }
  return shared;
}
