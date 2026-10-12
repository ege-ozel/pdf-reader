import { describe, expect, it, vi } from "vitest";
import { PdfRenderQueue } from "../src/pdf-render-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe("PDF render queue", () => {
  it("limits active jobs and renders the viewport before prefetched pages", async () => {
    const queue = new PdfRenderQueue(2);
    const waits = Array.from({ length: 4 }, deferred);
    const started = [];
    const complete = queue.replace(waits.map((wait, key) => ({ key, run: () => {
      started.push(key);
      return wait.promise;
    } })));
    await flush();
    expect(started).toEqual([0, 1]);
    waits[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    waits[0].resolve();
    waits[2].resolve();
    waits[3].resolve();
    await complete;
    await flush();
    expect(queue.active.size).toBe(0);
  });

  it("drops stale queued pages without exceeding concurrency while cancellation settles", async () => {
    const queue = new PdfRenderQueue(1);
    const old = deferred();
    const stale = vi.fn();
    const fresh = vi.fn();
    const previous = queue.replace([{ key: 1, run: () => old.promise }, { key: 2, run: stale }]);
    await flush();
    queue.clear();
    const next = queue.replace([{ key: 3, run: fresh }]);
    await flush();
    expect(fresh).not.toHaveBeenCalled();
    old.resolve();
    await Promise.all([previous, next]);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("deduplicates a running page and drains the queue after a render error", async () => {
    const queue = new PdfRenderQueue(1);
    const wait = deferred();
    const run = vi.fn(() => wait.promise);
    const first = queue.replace([{ key: 1, run }]);
    const second = queue.replace([{ key: 1, run }]);
    wait.resolve();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledOnce();
    const failure = queue.replace([{ key: 2, run: () => { throw new Error("decode failed"); } }]);
    await expect(failure).rejects.toThrow("decode failed");
    await flush();
    const success = vi.fn();
    await queue.replace([{ key: 3, run: success }]);
    expect(success).toHaveBeenCalledOnce();
  });
});
