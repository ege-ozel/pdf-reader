// End-to-end tests: drive the real desktop app (built binary, real IPC, real
// file reads) through tauri-driver. Run with `npm run test:e2e`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { AppSession } from "./webdriver.mjs";
import { createFixtures, DOCX_TEXT, PDF_PAGE_COUNT } from "./fixtures.mjs";

const APP = process.env.E2E_APP_BINARY;
if (!APP) throw new Error("E2E_APP_BINARY is not set; run `npm run test:e2e`");

let fixtures;
let app;

async function launch(...args) {
  app = await AppSession.start(APP, args);
  await app.waitFor(() => app.run("return document.readyState === 'complete' && !!window.__TAURI__;"), {
    what: "the app window to load",
  });
  return app;
}

async function waitForPdf(pages = PDF_PAGE_COUNT) {
  await app.waitFor(() => app.visible("#viewer-container"), { what: "the PDF viewer" });
  await app.waitFor(() => app.run("return document.querySelectorAll('#pdf-pages canvas').length > 0;"), {
    what: "a rendered PDF page canvas",
  });
  const label = await app.waitFor(
    async () => {
      const text = (await app.text("#page-nav-label"))?.trim();
      return text === `1 / ${pages}` ? text : null;
    },
    { what: `page label 1 / ${pages}` },
  );
  // The toolbar switches to PDF controls once the first render finishes.
  await app.waitFor(() => app.visible("#page-nav"), { what: "the PDF page controls" });
  return label;
}

async function statusText() {
  return ((await app.text("#status")) ?? "").trim();
}

async function recentNames(container = "#sidebar-recent") {
  return app.run(
    "return [...document.querySelectorAll(arguments[0] + ' .sidebar-row-label')].map((el) => el.textContent);",
    container,
  );
}

beforeAll(async () => {
  fixtures = await createFixtures();
});

afterEach(async () => {
  await app?.stop();
  app = null;
});

afterAll(() => {
  if (fixtures) rmSync(fixtures.dir, { recursive: true, force: true });
});

describe("desktop app end to end", () => {
  it("starts on the empty state with no document", async () => {
    await launch();
    expect(await app.visible("#empty-state")).toBe(true);
    expect(await app.visible("#viewer-container")).toBe(false);
    expect(await app.visible("#docx-container")).toBe(false);
    expect(await recentNames()).toEqual([]);
    expect(await statusText()).toBe("");
  });

  it("opens a PDF passed on the command line (Open with / double-click)", async () => {
    await launch(fixtures.files.pdf);
    await waitForPdf();
    expect(await app.visible("#empty-state")).toBe(false);
    expect(await app.visible("#page-nav")).toBe(true);
    expect(await statusText()).toBe("");
    // The PDF's text layer carries the real page text.
    const text = await app.waitFor(
      () => app.run("return document.querySelector('#pdf-pages .text-layer')?.textContent || null;"),
      { what: "the PDF text layer" },
    );
    expect(text).toContain("End-to-end page 1");
    expect(await recentNames()).toEqual(["sample.pdf"]);
  });

  it("navigates pages and zooms a PDF", async () => {
    await launch(fixtures.files.pdf);
    await waitForPdf();

    await app.click("#page-next-btn");
    await app.waitFor(async () => (await app.text("#page-nav-label"))?.trim() === `2 / ${PDF_PAGE_COUNT}`, {
      what: "page 2",
    });
    await app.click("#page-prev-btn");
    await app.waitFor(async () => (await app.text("#page-nav-label"))?.trim() === `1 / ${PDF_PAGE_COUNT}`, {
      what: "back to page 1",
    });

    const pageWidth = () =>
      app.run("return document.querySelector('#pdf-pages .pdf-page-slot')?.getBoundingClientRect().width ?? 0;");
    const before = await pageWidth();
    await app.click("#zoom-in-btn");
    await app.waitFor(async () => (await pageWidth()) > before * 1.05, { what: "the page to grow on zoom in" });
    await app.click("#zoom-out-btn");
    await app.waitFor(async () => (await pageWidth()) < before * 1.05, { what: "the page to shrink on zoom out" });
  });

  it("opens a Word document passed on the command line", async () => {
    await launch(fixtures.files.docx);
    await app.waitFor(() => app.visible("#docx-container"), { what: "the Word viewer" });
    await app.waitFor(async () => (await app.text("#docx-pages"))?.includes(DOCX_TEXT), {
      what: "the Word document text",
    });
    // PDF-only controls are hidden for Word documents.
    expect(await app.visible("#page-nav")).toBe(false);
    expect(await app.visible("#page-layout-seg")).toBe(false);
    expect(await app.visible("#zoom-in-btn")).toBe(true);
    expect(await statusText()).toBe("");
  });

  it("lists opened documents in the sidebar and reopens them from there", async () => {
    await launch();
    const names = await app.waitFor(async () => {
      const list = await recentNames();
      return list.length >= 2 ? list : null;
    }, { what: "recent files in the sidebar" });
    expect(names).toEqual(expect.arrayContaining(["sample.pdf", "sample.docx"]));

    await app.run(
      `const label = [...document.querySelectorAll('#sidebar-recent .sidebar-row-label')]
         .find((el) => el.textContent === 'sample.pdf');
       label.click();`,
    );
    await waitForPdf();

    await app.run(
      `const label = [...document.querySelectorAll('#sidebar-recent .sidebar-row-label')]
         .find((el) => el.textContent === 'sample.docx');
       label.click();`,
    );
    await app.waitFor(async () => (await app.text("#docx-pages"))?.includes(DOCX_TEXT), {
      what: "switching from PDF to Word",
    });
    expect(await app.visible("#viewer-container")).toBe(false);
  });

  it("pins a document and keeps the pin after a restart", async () => {
    await launch();
    await app.waitFor(async () => (await recentNames()).includes("sample.pdf"), { what: "sample.pdf in the list" });
    await app.run(
      `const row = [...document.querySelectorAll('#sidebar-recent .sidebar-row')]
         .find((el) => el.querySelector('.sidebar-row-label').textContent === 'sample.pdf');
       row.querySelector('.sidebar-pin-btn').click();`,
    );
    await app.waitFor(async () => (await recentNames("#sidebar-pinned")).includes("sample.pdf"), {
      what: "sample.pdf under pinned",
    });
    await app.stop();

    await launch();
    await app.waitFor(async () => (await recentNames("#sidebar-pinned")).includes("sample.pdf"), {
      what: "the pin to survive a restart",
    });
    expect(await recentNames()).not.toContain("sample.pdf");
  });

  it("shows an error and the empty state for a corrupt PDF", async () => {
    await launch(fixtures.files.corrupt);
    await app.waitFor(async () => (await statusText()).startsWith("Error"), { what: "an error message" });
    expect(await app.visible("#empty-state")).toBe(true);
  });

  it("rejects a legacy .doc with a clear message", async () => {
    await launch(fixtures.files.legacyDoc);
    await app.waitFor(async () => (await statusText()).includes(".docx"), { what: "the legacy .doc message" });
    expect(await app.visible("#docx-container")).toBe(false);
  });

  it("reports a missing file and drops it from the list", async () => {
    await launch(fixtures.files.missing);
    await app.waitFor(async () => (await statusText()).startsWith("Error"), { what: "a missing-file error" });
    expect(await recentNames()).not.toContain("does-not-exist.pdf");
  });

  it("ignores an external-open request with nothing pending", async () => {
    await launch(fixtures.files.pdf);
    await waitForPdf();
    // What Android sends after "Open with"; with nothing handed over it must
    // leave the open document alone.
    await app.runAsync("await window.__TAURI__.event.emit('external-open', null); return true;");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await app.visible("#viewer-container")).toBe(true);
    expect(await statusText()).toBe("");
  });
});
