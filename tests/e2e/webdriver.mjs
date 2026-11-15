// Minimal W3C WebDriver client for tauri-driver (no extra dependencies).

const DRIVER_URL = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";

async function request(method, path, body) {
  const response = await fetch(`${DRIVER_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json.value?.message ?? JSON.stringify(json);
    throw new Error(`WebDriver ${method} ${path} failed: ${detail}`);
  }
  return json.value;
}

export class AppSession {
  static async start(application, args = []) {
    const value = await request("POST", "/session", {
      capabilities: {
        alwaysMatch: { "tauri:options": { application, args } },
      },
    });
    return new AppSession(value.sessionId);
  }

  constructor(id) {
    this.id = id;
  }

  // Runs `script` (a function body) in the app's webview and returns its value.
  async run(script, ...args) {
    return request("POST", `/session/${this.id}/execute/sync`, { script, args });
  }

  // Runs an async function body; it must resolve to the value to return.
  async runAsync(script, ...args) {
    const wrapped = `const done = arguments[arguments.length - 1];
      (async () => { ${script} })(...arguments).then(done, (e) => done({ __error: String(e) }));`;
    const value = await request("POST", `/session/${this.id}/execute/async`, {
      script: wrapped,
      args,
    });
    if (value && value.__error) throw new Error(value.__error);
    return value;
  }

  async click(selector) {
    const found = await this.run(
      "const el = document.querySelector(arguments[0]); if (!el) return false; el.click(); return true;",
      selector,
    );
    if (!found) throw new Error(`no element matches ${selector}`);
  }

  async text(selector) {
    return this.run("return document.querySelector(arguments[0])?.textContent ?? null;", selector);
  }

  async visible(selector) {
    return this.run(
      `const el = document.querySelector(arguments[0]);
       if (!el || el.closest("[hidden]")) return false;
       const r = el.getBoundingClientRect();
       return r.width > 0 && r.height > 0;`,
      selector,
    );
  }

  // Polls `check` until it returns a truthy value, then returns that value.
  async waitFor(check, { timeout = 20000, interval = 150, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await check();
        if (last) return last;
      } catch (err) {
        last = err;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`timed out waiting for ${what} (last: ${last})`);
  }

  async stop() {
    await request("DELETE", `/session/${this.id}`).catch(() => {});
  }
}
