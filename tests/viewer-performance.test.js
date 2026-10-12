import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }));
vi.mock("../src/vendor/pdfjs/pdf.mjs", () => pdfjs);

// Small DOM fixture for the viewer's transform-driven layout. Canvas allocation
// and PDF worker resources are counted by the fakes below, not drawn in Node.
class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.dataset = {};
    this.listeners = new Map();
    this.classList = { add() {}, toggle() {} };
    this.width = 0;
    this.height = 0;
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  get offsetTop() { return this.id === "pdf-pages" ? 24 : parseFloat(this.style.top) || 0; }
  get offsetLeft() { return parseFloat(this.style.left) || 0; }
  get offsetWidth() { return parseFloat(this.style.width) || this.clientWidth; }
  get offsetHeight() { return parseFloat(this.style.height) || this.clientHeight; }
  getBoundingClientRect() {
    if (this.id === "viewer-container") return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
    const wrapper = this.parent;
    const match = wrapper?.style.transform?.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
    const [x, y, scale] = match ? match.slice(1).map(Number) : [0, 0, 1];
    const left = x + this.offsetLeft * scale;
    const top = (wrapper?.offsetTop || 0) + y + this.offsetTop * scale;
    return { left, top, right: left + this.offsetWidth * scale, bottom: top + this.offsetHeight * scale,
      width: this.offsetWidth * scale, height: this.offsetHeight * scale };
  }
  getContext() { return {}; }
}

function fakeDocument(count, { mixed = false, render = () => ({ promise: Promise.resolve(), cancel: vi.fn() }) } = {}) {
  const proxies = new Map();
  const doc = {
    numPages: count,
    getPage: vi.fn(async number => {
      if (!proxies.has(number)) {
        const width = mixed && number % 2 === 0 ? 900 : 600;
        const height = mixed && number % 2 === 0 ? 1200 : 800;
        proxies.set(number, {
          getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }),
          cleanup: vi.fn(),
          render: vi.fn(render),
        });
      }
      return proxies.get(number);
    }),
  };
  return { doc, proxies, task: { promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) } };
}

let viewer;
let wrapper;
let container;
const advance = async () => { await vi.advanceTimersByTimeAsync(250); };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  container = Object.assign(new Element(), { id: "viewer-container", clientWidth: 1000, clientHeight: 800 });
  wrapper = Object.assign(new Element(), { id: "pdf-pages" });
  container.append(wrapper);
  vi.stubGlobal("document", {
    getElementById: id => id === "viewer-container" ? container : wrapper,
    createElement: tag => new Element(tag),
    body: new Element(),
  });
  vi.stubGlobal("window", {
    innerWidth: 1000, devicePixelRatio: 3,
    matchMedia: () => ({ matches: false }), addEventListener() {},
  });
  vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "24px", paddingBottom: "64px" }));
  vi.stubGlobal("requestAnimationFrame", callback => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  viewer = await import("../src/viewer.js");
});

afterEach(async () => {
  await viewer.closePdf();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("long PDF viewer lifecycle", () => {
  it("opens 10,000 pages without eagerly requesting or mounting them, and jumps to page 9000", async () => {
    const pdf = fakeDocument(10000);
    pdfjs.getDocument.mockReturnValueOnce(pdf.task);
    await viewer.renderPdf(new Uint8Array([1]));
    await advance();
    expect(pdf.doc.getPage.mock.calls.length).toBeLessThan(5);
    expect(wrapper.children.length).toBeLessThan(5);
    expect(viewer.getPageCount()).toBe(10000);
    viewer.goToPage(9000);
    await advance();
    expect(viewer.getCurrentPage()).toBe(9000);
    expect(pdf.doc.getPage).toHaveBeenCalledWith(9000);
    expect(wrapper.children.length).toBeLessThan(6);
    expect(wrapper.children.some(slot => slot.dataset.pageNumber === "1")).toBe(false);
    expect(pdf.proxies.get(1).cleanup).toHaveBeenCalled();
    const bytes = wrapper.children.reduce((sum, slot) => sum + slot.children.reduce((n, canvas) => n + canvas.width * canvas.height * 4, 0), 0);
    expect(bytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  });

  it("cleans zoomed-out pages and annotation references on zoom, unload and close", async () => {
    const pdf = fakeDocument(1000);
    pdfjs.getDocument.mockReturnValueOnce(pdf.task);
    const liveAnnotations = new Set();
    viewer.setPageRenderedHook(({ pageNumber }) => liveAnnotations.add(pageNumber));
    viewer.setPageUnloadedHook(pageNumber => liveAnnotations.delete(pageNumber));
    await viewer.renderPdf(new Uint8Array([1]));
    const oldCanvas = wrapper.children[0].children[0];
    viewer.zoomByStep(1);
    await advance();
    expect(oldCanvas.width).toBe(0);
    expect(oldCanvas.height).toBe(0);
    expect(pdf.proxies.get(1).cleanup.mock.calls.length).toBeGreaterThan(1);
    viewer.goToPage(800);
    await advance();
    expect(liveAnnotations.has(1)).toBe(false);
    expect(liveAnnotations.has(800)).toBe(true);
    const canvases = wrapper.children.flatMap(slot => slot.children);
    await viewer.closePdf();
    expect(liveAnnotations.size).toBe(0);
    expect(wrapper.children).toHaveLength(0);
    expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(pdf.task.destroy).toHaveBeenCalledOnce();
    expect(viewer.getCurrentPage()).toBe(null);
  });

  it("corrects mixed page dimensions without rendering the entire document", async () => {
    const pdf = fakeDocument(1000, { mixed: true });
    pdfjs.getDocument.mockReturnValueOnce(pdf.task);
    await viewer.renderPdf(new Uint8Array([1]));
    viewer.goToPage(500);
    await advance();
    expect(viewer.getCurrentPage()).toBe(500);
    const page = wrapper.children.find(slot => slot.dataset.pageNumber === "500");
    expect(parseFloat(page.style.width)).toBeCloseTo(1500);
    expect(parseFloat(page.style.height)).toBeCloseTo(2000);
    expect(pdf.doc.getPage.mock.calls.length).toBeLessThan(12);
    expect(wrapper.children.length).toBeLessThan(6);
  });

  it("destroys a superseded opening without requesting pages from the replacement document", async () => {
    let finishFirst;
    const first = fakeDocument(1000);
    first.doc.getPage.mockImplementation(() => new Promise(resolve => { finishFirst = resolve; }));
    const second = fakeDocument(10000);
    pdfjs.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const opening = viewer.renderPdf(new Uint8Array([1]));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(finishFirst).toBeTypeOf("function");
    await viewer.renderPdf(new Uint8Array([2]));
    finishFirst({ getViewport: () => ({ width: 600, height: 800 }), cleanup() {} });
    await opening;
    expect(first.task.destroy).toHaveBeenCalledOnce();
    expect(viewer.getPageCount()).toBe(10000);
    expect(first.doc.getPage).toHaveBeenCalledTimes(1);
    expect(second.doc.getPage.mock.calls.length).toBeLessThan(5);
  });

  it("keeps rendering bounded while fast navigation and zoom cancel slow jobs", async () => {
    container.clientWidth = 1600;
    container.clientHeight = 1200;
    window.innerWidth = 1600;
    let active = 0;
    let peak = 0;
    const pdf = fakeDocument(10000, { render: () => {
      active += 1;
      peak = Math.max(peak, active);
      let resolve;
      let reject;
      let settled = false;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      const finish = (cancelled = false) => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (cancelled) reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
        else resolve();
      };
      const timer = setTimeout(finish, 200);
      return { promise, cancel: () => { clearTimeout(timer); setTimeout(() => finish(true), 100); } };
    } });
    pdfjs.getDocument.mockReturnValueOnce(pdf.task);
    const opening = viewer.renderPdf(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(20);
    for (const page of [500, 9000, 10, 7000]) {
      viewer.goToPage(page);
      viewer.zoomByStep(1);
      await vi.advanceTimersByTimeAsync(130);
    }
    await vi.advanceTimersByTimeAsync(2000);
    await opening;
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
    expect(wrapper.children.length).toBeLessThan(12);
    expect(pdf.doc.getPage.mock.calls.length).toBeLessThan(40);
    expect(wrapper.children.some(slot => slot.children.length > 0)).toBe(true);
  });
});
