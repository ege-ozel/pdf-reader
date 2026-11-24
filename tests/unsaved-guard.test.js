import { describe, it, expect, vi } from "vitest";
import { createUnsavedGuard } from "../src/unsaved-guard.js";

function setup({ dirty = true, choice = "cancel", saveResult = { ok: true } } = {}) {
  const ask = vi.fn(async () => choice);
  const save = vi.fn(async () => saveResult);
  const confirmLeave = createUnsavedGuard({ isDirty: () => dirty, ask, save });
  return { confirmLeave, ask, save };
}

describe("unsaved marks guard", () => {
  it("lets the caller go ahead without asking when nothing is unsaved", async () => {
    const { confirmLeave, ask } = setup({ dirty: false });
    expect(await confirmLeave()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("goes ahead on Discard", async () => {
    const { confirmLeave, save } = setup({ choice: "discard" });
    expect(await confirmLeave()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("stays on Cancel", async () => {
    const { confirmLeave, save } = setup({ choice: "cancel" });
    expect(await confirmLeave()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("goes ahead after a successful Save", async () => {
    const { confirmLeave, save } = setup({ choice: "save", saveResult: { ok: true } });
    expect(await confirmLeave()).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("stays when the save failed or was cancelled", async () => {
    expect(await setup({ choice: "save", saveResult: { ok: false, message: "x" } }).confirmLeave()).toBe(false);
    expect(await setup({ choice: "save", saveResult: { ok: false, cancelled: true } }).confirmLeave()).toBe(false);
  });

  it("shares one question between calls made while it is open", async () => {
    let answer;
    const ask = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const confirmLeave = createUnsavedGuard({ isDirty: () => true, ask, save: vi.fn() });
    const first = confirmLeave();
    const second = confirmLeave();
    answer("discard");
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    // a later attempt asks again
    const third = confirmLeave();
    answer("cancel");
    expect(await third).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
