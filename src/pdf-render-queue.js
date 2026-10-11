// Replacing the window discards queued work. Running jobs keep their concurrency
// slot until cancellation settles, including across zoom and document changes.
export class PdfRenderQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.active = new Map();
    this.pending = new Map();
  }

  replace(jobs) {
    const previous = this.pending;
    this.pending = new Map();
    const promises = [];
    for (const { key, run } of jobs) {
      let entry = this.active.get(key) ?? previous.get(key);
      if (!entry) {
        let resolve;
        let reject;
        const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        entry = { run, promise, resolve, reject };
      }
      if (!this.active.has(key)) this.pending.set(key, entry);
      previous.delete(key);
      promises.push(entry.promise);
    }
    for (const entry of previous.values()) entry.resolve();
    this.pump();
    return Promise.all(promises);
  }

  clear() {
    for (const entry of this.pending.values()) entry.resolve();
    this.pending.clear();
  }

  pump() {
    while (this.active.size < this.concurrency && this.pending.size) {
      const [key, entry] = this.pending.entries().next().value;
      this.pending.delete(key);
      this.active.set(key, entry);
      Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
        this.active.delete(key);
        this.pump();
      });
    }
  }
}
