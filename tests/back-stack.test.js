import { describe, it, expect, vi } from "vitest";
import { createBackStack } from "../src/back-stack.js";

// Minimal session history: pushState is synchronous, go() is asynchronous
// (queued until flush()), and every traversal fires popstate like a browser.
function fakeHistory() {
  const entries = [null];
  let index = 0;
  const queued = [];
  let onPop = () => {};
  const history = {
    get state() {
      return entries[index];
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push(state);
      index = entries.length - 1;
    },
    go(delta) {
      queued.push(delta);
    },
  };
  const traverse = (delta) => {
    const target = Math.max(0, Math.min(entries.length - 1, index + delta));
    if (target === index) return false;
    index = target;
    onPop();
    return true;
  };
  return {
    history,
    setOnPop: (fn) => (onPop = fn),
    flush() {
      while (queued.length) traverse(queued.shift());
    },
    // The Android back button: WebView.goBack() when there is history to go
    // back to, otherwise the app exits.
    pressBack() {
      return traverse(-1) ? "handled" : "exit";
    },
    get length() {
      return entries.length;
    },
    get index() {
      return index;
    },
  };
}

function setup() {
  const fake = fakeHistory();
  const stack = createBackStack({ history: fake.history });
  fake.setOnPop(() => stack.handlePopState());
  return { fake, stack };
}

describe("back-stack", () => {
  it("pushes one history entry per layer and ignores duplicate pushes", () => {
    const { fake, stack } = setup();
    stack.push("document", () => {});
    stack.push("document", () => {});
    stack.push("menu", () => {});
    expect(stack.ids()).toEqual(["document", "menu"]);
    expect(fake.index).toBe(2);
  });

  it("Back closes the top layer only, then the next one, then exits", () => {
    const { fake, stack } = setup();
    const closeDoc = vi.fn();
    const closeFs = vi.fn();
    stack.push("document", closeDoc);
    stack.push("fullscreen", closeFs);

    expect(fake.pressBack()).toBe("handled");
    expect(closeFs).toHaveBeenCalledTimes(1);
    expect(closeDoc).not.toHaveBeenCalled();
    expect(stack.ids()).toEqual(["document"]);

    expect(fake.pressBack()).toBe("handled");
    expect(closeDoc).toHaveBeenCalledTimes(1);
    expect(stack.ids()).toEqual([]);

    expect(fake.pressBack()).toBe("exit");
  });

  it("a close callback that releases its own layer does not step history again", () => {
    const { fake, stack } = setup();
    stack.push("document", () => {});
    stack.push("menu", () => stack.release("menu"));
    fake.pressBack();
    fake.flush();
    expect(stack.ids()).toEqual(["document"]);
    expect(fake.index).toBe(1);
  });

  it("releasing a layer another way removes its history entry", () => {
    const { fake, stack } = setup();
    const closeDoc = vi.fn();
    stack.push("document", closeDoc);
    stack.push("popover", () => {});
    stack.release("popover");
    fake.flush();
    expect(fake.index).toBe(1);

    // the next Back goes to the document, not to a stale popover entry
    fake.pressBack();
    expect(closeDoc).toHaveBeenCalledTimes(1);
    expect(fake.pressBack()).toBe("exit");
  });

  it("releasing a layer from the middle keeps Back closing the top layer", () => {
    const { fake, stack } = setup();
    const closeDoc = vi.fn();
    const closeMenu = vi.fn();
    stack.push("document", closeDoc);
    stack.push("sidebar", () => {});
    stack.push("menu", closeMenu);
    stack.release("sidebar");
    fake.flush();
    expect(fake.index).toBe(2);

    fake.pressBack();
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(closeDoc).not.toHaveBeenCalled();
    fake.pressBack();
    expect(closeDoc).toHaveBeenCalledTimes(1);
  });

  it("release of an unknown layer is a no-op", () => {
    const { fake, stack } = setup();
    stack.release("menu");
    fake.flush();
    expect(fake.index).toBe(0);
    expect(fake.length).toBe(1);
  });

  it("a push while our own traversal is in flight waits for it to land", () => {
    const { fake, stack } = setup();
    const closeFs = vi.fn();
    stack.push("document", () => {});
    stack.push("menu", () => {});
    stack.release("menu"); // queues go(-1)
    stack.push("fullscreen", closeFs); // before the traversal lands
    fake.flush();
    expect(closeFs).not.toHaveBeenCalled();
    expect(stack.ids()).toEqual(["document", "fullscreen"]);
    expect(fake.index).toBe(2);

    fake.pressBack();
    expect(closeFs).toHaveBeenCalledTimes(1);
  });

  it("several releases in a row settle history at the right depth", () => {
    const { fake, stack } = setup();
    stack.push("document", () => {});
    stack.push("sidebar", () => {});
    stack.push("menu", () => {});
    stack.release("menu");
    stack.release("sidebar");
    fake.flush();
    expect(fake.index).toBe(1);
    expect(stack.ids()).toEqual(["document"]);
  });

  it("a stale pending traversal does not block later pushes forever", () => {
    let t = 0;
    const fake = fakeHistory();
    const stack = createBackStack({ history: fake.history, now: () => t });
    fake.setOnPop(() => stack.handlePopState());
    stack.push("menu", () => {});
    stack.release("menu"); // go(-1) queued but never delivered
    t = 5000;
    stack.push("document", () => {});
    expect(fake.index).toBe(1);
  });

  it("keeps going when a close callback throws", () => {
    const { fake, stack } = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    stack.push("menu", () => {
      throw new Error("boom");
    });
    fake.pressBack();
    expect(stack.ids()).toEqual([]);
    spy.mockRestore();
  });
});
