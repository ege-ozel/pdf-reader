// Desktop end-to-end tests against the real app.
//
//   npm run test:e2e              build a debug app, then run tests/e2e
//   npm run test:e2e -- --no-build   reuse the last debug build
//
// Needs tauri-driver (`cargo install tauri-driver --locked`) plus the native
// WebDriver: WebKitWebDriver on Linux (webkit2gtk-driver package), or
// msedgedriver matching the installed Edge/WebView2 on Windows. On Linux
// without a display, Xvfb is started. The build output goes to
// release/logs/e2e-build.log.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "release", "logs");
const isWindows = process.platform === "win32";
const binary = join(ROOT, "src-tauri", "target", "debug", isWindows ? "pdf-reader.exe" : "pdf-reader");
const children = [];

function fail(message) {
  console.error(`FAILED e2e: ${message}`);
  cleanup();
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: ROOT, shell: isWindows, ...options });
    child.on("error", (err) => fail(`${command}: ${err.message}`));
    child.on("close", (code) => resolveRun(code));
  });
}

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolveWait();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) rejectWait(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function findTauriDriver() {
  const name = isWindows ? "tauri-driver.exe" : "tauri-driver";
  const cargoBin = join(homedir(), ".cargo", "bin", name);
  return existsSync(cargoBin) ? cargoBin : name;
}

// The app keeps its recent-files list in the user config dir. Tests start
// from an empty list, so the real list is moved aside and put back after.
function isolateRecentFiles(env) {
  if (isWindows) {
    const file = join(process.env.APPDATA ?? "", "com.d.pdf-reader", "recent_files.json");
    const backup = `${file}.e2e-backup`;
    if (existsSync(file)) renameSync(file, backup);
    return () => {
      rmSync(file, { force: true });
      if (existsSync(backup)) renameSync(backup, file);
    };
  }
  const configHome = mkdtempSync(join(tmpdir(), "pdf-reader-e2e-config-"));
  env.XDG_CONFIG_HOME = configHome;
  return () => rmSync(configHome, { recursive: true, force: true });
}

let restoreRecentFiles = () => {};
function cleanup() {
  for (const child of children.reverse()) child.kill();
  try {
    restoreRecentFiles();
  } catch (err) {
    console.error(`could not restore the recent-files list: ${err.message}`);
  }
  restoreRecentFiles = () => {};
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

if (!process.argv.includes("--no-build")) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, "e2e-build.log");
  console.log("- building debug app");
  const log = createWriteStream(logPath);
  const code = await new Promise((resolveBuild) => {
    const child = spawn("npx", ["tauri", "build", "--debug", "--no-bundle"], { cwd: ROOT, shell: isWindows });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on("error", (err) => fail(`tauri build: ${err.message}`));
    child.on("close", resolveBuild);
  });
  if (code !== 0) fail(`debug build exited with code ${code}; see ${logPath}`);
}
if (!existsSync(binary)) fail(`no app binary at ${binary}; run without --no-build`);

const env = { ...process.env, E2E_APP_BINARY: binary };
restoreRecentFiles = isolateRecentFiles(env);

if (process.platform === "linux" && !env.DISPLAY) {
  const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
  xvfb.on("error", (err) => fail(`Xvfb: ${err.message} (install xvfb, or set DISPLAY)`));
  children.push(xvfb);
  env.DISPLAY = ":99";
  // The app aborts if GTK cannot reach the display, so wait for the socket.
  const socket = "/tmp/.X11-unix/X99";
  const deadline = Date.now() + 10000;
  while (!existsSync(socket)) {
    if (Date.now() > deadline) fail("Xvfb did not start on :99");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

const driver = spawn(findTauriDriver(), [], { env, stdio: ["ignore", "ignore", "pipe"] });
let driverErrors = "";
driver.stderr.on("data", (chunk) => (driverErrors = (driverErrors + chunk).slice(-4000)));
driver.on("error", (err) => fail(`tauri-driver: ${err.message} (cargo install tauri-driver --locked)`));
children.push(driver);
try {
  await waitForPort(4444);
} catch (err) {
  fail(`tauri-driver did not start: ${err.message}\n${driverErrors}`);
}

console.log("- running end-to-end tests");
const code = await run("npx", ["vitest", "run", "--config", "tests/e2e/vitest.config.mjs"], {
  env,
  stdio: "inherit",
});
cleanup();
if (code !== 0) {
  if (driverErrors.trim()) console.error(`\ntauri-driver stderr (tail):\n${driverErrors}`);
  process.exit(code);
}
console.log("OK e2e");
