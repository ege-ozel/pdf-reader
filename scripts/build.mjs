// One-command release builds with quiet output.
//
//   npm run build:desktop            Windows NSIS installer
//   npm run build:android            arm64 release APK
//   npm run build:android -- --install   ...and install it on the connected phone
//
// The full tool output goes to release/logs/<target>.log; the console only
// gets one line per step, the artifact path, and the log tail on failure.
// Artifacts are copied to release/ with a readable name.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = join(ROOT, "release");
const LOG_DIR = join(RELEASE_DIR, "logs");
const TAIL_LINES = 40;

const target = process.argv[2];
const install = process.argv.includes("--install");
if (target !== "desktop" && target !== "android") {
  console.error("usage: node scripts/build.mjs <desktop|android> [--install]");
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).version;
mkdirSync(LOG_DIR, { recursive: true });
const logPath = join(LOG_DIR, `${target}.log`);
const log = createWriteStream(logPath);
const started = Date.now();
// Recent output kept in memory: the log stream may not be flushed when we fail.
let recent = "";

function record(chunk) {
  log.write(chunk);
  recent = (recent + chunk).slice(-20000);
}

function fail(message) {
  log.end();
  console.error(recent.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n"));
  console.error(`\nFAILED ${target}: ${message}\nfull log: ${logPath}`);
  process.exit(1);
}

// Runs a command with its output going to the log only.
function run(label, command, args, env = process.env) {
  console.log(`- ${label}`);
  record(`\n$ ${command} ${args.join(" ")}\n`);
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: ROOT, env, shell: process.platform === "win32" });
    child.stdout.on("data", (chunk) => record(chunk.toString()));
    child.stderr.on("data", (chunk) => record(chunk.toString()));
    child.on("error", (err) => fail(`${label}: ${err.message}`));
    child.on("close", (code) => (code === 0 ? resolveRun() : fail(`${label} exited with code ${code}`)));
  });
}

// Newest file under dir (recursive) whose name matches and that was written
// by this build.
function newestArtifact(dir, pattern) {
  let best = null;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (pattern.test(entry.name)) {
        const { mtimeMs } = statSync(p);
        if (mtimeMs >= started - 1000 && (!best || mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs };
      }
    }
  };
  walk(dir);
  return best?.path ?? null;
}

function publish(source, name) {
  const dest = join(RELEASE_DIR, name);
  copyFileSync(source, dest);
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
  return `${dest} (${mb} MB)`;
}

function androidEnv() {
  const env = { ...process.env };
  if (!env.NDK_HOME && env.ANDROID_HOME) {
    const ndkRoot = join(env.ANDROID_HOME, "ndk");
    const versions = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort() : [];
    if (versions.length) env.NDK_HOME = join(ndkRoot, versions.at(-1));
  }
  if (!env.ANDROID_HOME) fail("ANDROID_HOME is not set");
  if (!env.NDK_HOME) fail("NDK_HOME is not set and no NDK was found under ANDROID_HOME/ndk");
  return env;
}

await run("tests", "npm", ["test"]);

let artifact;
if (target === "desktop") {
  await run("tauri build (nsis)", "npx", ["tauri", "build", "--bundles", "nsis"]);
  const exe = newestArtifact(join(ROOT, "src-tauri", "target", "release", "bundle", "nsis"), /-setup\.exe$/);
  if (!exe) fail("build finished but no setup .exe was produced");
  artifact = publish(exe, `PDF-Reader-${version}-windows-x64-setup.exe`);
} else {
  const env = androidEnv();
  // The generated Android project is git-ignored; MainActivity (file-open
  // intents, immersive mode) lives in src-tauri/android-overrides.
  const activityDir = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "java", "com", "d", "pdf_reader");
  if (existsSync(activityDir)) {
    copyFileSync(join(ROOT, "src-tauri", "android-overrides", "MainActivity.kt"), join(activityDir, "MainActivity.kt"));
  }
  await run("tauri android build (arm64 apk)", "npx", ["tauri", "android", "build", "--apk", "--target", "aarch64"], env);
  const apk = newestArtifact(join(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk"), /release\.apk$/);
  if (!apk) fail("build finished but no release .apk was produced");
  artifact = publish(apk, `PDF-Reader-${version}-android-arm64.apk`);
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`OK ${target} ${version} in ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s -> ${artifact}`);

if (install && target === "android") {
  const devices = spawnSync("adb", ["devices"], { encoding: "utf8" }).stdout ?? "";
  if (!/\tdevice\b/.test(devices)) {
    console.log("install skipped: no device in `adb devices`");
  } else {
    const apkPath = artifact.replace(/ \([\d.]+ MB\)$/, "");
    await run("adb install", "adb", ["install", "-r", `"${apkPath}"`]);
    console.log("installed on device");
  }
}
log.end();
