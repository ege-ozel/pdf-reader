// Local browser fixture: no Tauri/Rust build, no files written to disk.
// node scripts/pdf-performance-preview.mjs [--baseline=<git-revision>]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src");
const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice(11);
const baselineSource = baseline ? execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`,
  "show", `${baseline}:src/viewer.js`], { cwd: root, encoding: "utf8" }) : null;
const fixtures = new Map();
async function fixture(mixed) {
  if (fixtures.has(mixed)) return fixtures.get(mixed);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= 1000; number += 1) {
    const page = doc.addPage(mixed && number % 2 === 0 ? [900, 600] : [600, 800]);
    page.drawText(`Performance fixture - page ${number} / 1000`, { x: 35, y: page.getHeight() - 60, size: 20, font });
    for (let line = 0; line < 30; line += 1) {
      page.drawText(`Line ${line + 1}: long-document rendering, navigation and resource cleanup.`,
        { x: 35, y: page.getHeight() - 100 - line * 14, size: 11, font });
    }
    page.drawRectangle({ x: 35, y: 25, width: page.getWidth() - 70, height: 35,
      color: rgb(0.1, (number % 10) / 12, 0.6) });
  }
  const bytes = await doc.save();
  fixtures.set(mixed, bytes);
  return bytes;
}

const port = Number(process.env.PDF_PERFORMANCE_PORT || 4173);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>PDF performance fixture</title>
<link rel="stylesheet" href="/src/styles.css"><style>
body{display:block;margin:0;font:14px system-ui}header{height:90px;background:#eee;color:#111;padding:8px}
button,input{font:inherit;padding:4px;margin:2px}#viewer-container{height:calc(100vh - 110px)}#metrics{white-space:pre-wrap}
</style></head><body><header>
<button id="open">Open 1000 pages</button><button id="mixed">Open mixed sizes</button>
<label>Page <input id="page" type="number" value="900" min="1" max="1000" style="width:70px"></label>
<button id="jump">Jump</button><button id="zoom-in">Zoom in</button><button id="zoom-out">Zoom out</button>
<button id="fit">Reset zoom</button><button id="dual">Dual</button><button id="single">Single</button>
<button id="paged">Paged</button><button id="continuous">Continuous</button><button id="close">Close</button>
<output id="metrics">Ready</output><output id="error"></output></header>
<div id="viewer-container"><div id="pdf-pages"></div></div>
<script type="module">
import * as viewer from '${baseline ? "/src/baseline-viewer.js" : "/src/viewer.js"}';
const metrics = document.getElementById('metrics');
let state = 'Ready', opening = 0;
viewer.setStatusCallback(message => document.getElementById('error').textContent = message);
async function open(mixed) {
  state = 'Loading'; globalThis.__pdfPageRequests = 0;
  const bytes = new Uint8Array(await (await fetch('/fixture.pdf?mixed=' + mixed)).arrayBuffer());
  const start = performance.now();
  await viewer.renderPdf(bytes);
  opening = performance.now() - start; state = 'Opened';
}
document.getElementById('open').onclick = () => open(false).catch(error => { state = String(error); });
document.getElementById('mixed').onclick = () => open(true).catch(error => { state = String(error); });
document.getElementById('jump').onclick = () => viewer.goToPage(Number(document.getElementById('page').value));
document.getElementById('zoom-in').onclick = () => viewer.zoomByStep(1);
document.getElementById('zoom-out').onclick = () => viewer.zoomByStep(-1);
document.getElementById('fit').onclick = () => viewer.resetZoom();
document.getElementById('dual').onclick = () => viewer.setPageMode('dual');
document.getElementById('single').onclick = () => viewer.setPageMode('single');
document.getElementById('paged').onclick = () => viewer.setScrollMode('paged');
document.getElementById('continuous').onclick = () => viewer.setScrollMode('continuous');
document.getElementById('close').onclick = async () => { await viewer.closePdf(); state = 'Closed'; };
setInterval(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const bytes = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
  metrics.textContent = state + ' | page ' + viewer.getCurrentPage() + '/' + viewer.getPageCount() +
    ' | slots ' + document.querySelectorAll('.pdf-page-slot').length + ' | canvases ' + canvases.length +
    ' | canvas MiB ' + (bytes / 1024 / 1024).toFixed(2) + ' | page requests ' +
    (globalThis.__pdfPageRequests || 0) + ' | open ms ' + opening.toFixed(0);
}, 100);
</script></body></html>`;

const mimeTypes = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".pdf": "application/pdf" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let body;
    let type;
    if (url.pathname === "/") { body = html; type = "text/html"; }
    else if (url.pathname === "/fixture.pdf") { body = await fixture(url.searchParams.get("mixed") === "true"); type = "application/pdf"; }
    else if (url.pathname.startsWith("/src/")) {
      const path = resolve(source, decodeURIComponent(url.pathname.slice(5)));
      if (!path.startsWith(source + sep)) throw new Error("Invalid asset path");
      if (url.pathname === "/src/baseline-viewer.js" && baselineSource) {
        body = baselineSource.replace('= "./vendor/pdfjs/pdf.worker.mjs";',
          '= new URL("./vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;');
      }
      else body = await readFile(path);
      if (url.pathname === "/src/vendor/pdfjs/pdf.mjs") {
        body = body.toString().replace("getPage(pageNumber) {",
          "getPage(pageNumber) { globalThis.__pdfPageRequests = (globalThis.__pdfPageRequests || 0) + 1;");
      }
      type = mimeTypes[url.pathname.slice(url.pathname.lastIndexOf("."))] ?? "application/octet-stream";
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
  } catch (error) { res.writeHead(500).end(String(error)); }
});
server.listen(port, "127.0.0.1", () => console.log(`PDF fixture: http://127.0.0.1:${port} ${baseline ? `(baseline ${baseline})` : "(working tree)"}`));
