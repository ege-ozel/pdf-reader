# PDF Reader

A lightweight PDF and Word (.docx) reader for Windows and Android, built with
Tauri 2, vendored PDF.js and vendored docx-preview. There is no frontend
bundler — `src/` is plain HTML/CSS/JS served as-is, and `src/vendor/`
contains the pre-built library files copied in directly (`pdfjs/`, and
`docx-preview/` with its JSZip dependency).

See `docs/superpowers/specs/` for the design and task breakdown.

## Development

```
npm install
npm run tauri dev
```

## Tests

- `npm test` — frontend unit tests (zoom, page layout, document-type detection) via Vitest.
- `cargo test` (from `src-tauri/`) — Rust unit tests for file reading.

## PDF viewer

Opening a PDF reads the first page size immediately and fetches other page
metadata only when needed. Lightweight layout records reserve stable document
positions; only pages in the visible window and a small nearby buffer get DOM
slots and canvases. Distant page proxies and canvas pixel buffers are released
on navigation. Render concurrency and total canvas memory are capped, and a
scanned page's canvas resolution is limited at large zoom levels. Documents
with mixed page sizes refine nearby layout positions as they are visited.
Single-page mode uses one column; dual-page mode uses two columns at normal
zoom and adds gallery columns when more pages fit at lower zoom levels.
Desktop and mobile page spacing is 16px and 12px, respectively.

## Word viewer

`.docx` files are rendered by docx-preview into `#docx-container`, a
natively scrolling pane separate from the PDF viewer. Files are routed by
their first bytes, not their extension (Android `content://` URIs have
none); legacy `.doc` files are rejected with a message. Pages open at 100%,
shrunk to fit narrow screens; zoom uses CSS `zoom`. Links inside a document
never navigate the app; bookmark links scroll within it. Embedded HTML
(altChunk) content is not rendered, because docx-preview would place it in an
unsandboxed iframe with the app's origin. Layout is an approximation of
Word's — complex text boxes, SmartArt and missing fonts may differ.

Known limitations:

- No Content Security Policy is configured yet (`csp: null`). docx-preview
  pastes document values into CSS unescaped, so a crafted `.docx` can make the
  app request remote URLs (e.g. a tracking image) and restyle the app UI while
  it is open. It cannot run script. The proposed fix is
  `"csp": "img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:"`
  with `"dangerousDisableAssetCspModification": true` in
  `src-tauri/tauri.conf.json`; it needs a smoke test of both viewers.
- Password-protected (encrypted) `.docx` files are stored in the same
  container format as legacy `.doc`, so they get the legacy `.doc` message.

To update the vendored Word libraries:

    npm install --save-exact docx-preview@<version> jszip@<version>
    cp node_modules/jszip/dist/jszip.min.js src/vendor/docx-preview/
    cp node_modules/docx-preview/dist/docx-preview.min.js src/vendor/docx-preview/

## Manual viewer checks

### Mobile

- [ ] Touch scroll/pan, pinch zoom, and toolbar zoom in/out
- [ ] Single-page and dual-page modes; verify the dual-page pair fits
- [ ] 2-page, 3–5-page, 10+-page, and long documents
- [ ] Slow and fast scrolling while pages load and unload
- [ ] Rotate the device and resize the viewport in both page modes

### Laptop / desktop

- [ ] Mouse wheel and vertical trackpad scrolling
- [ ] Trackpad pinch and Ctrl/Meta+wheel zoom in/out
- [ ] Single-page, dual-page, and gallery layouts; last unpaired page
- [ ] 10+-page and long documents; verify fast-scroll rendering
- [ ] Confirm native browser zoom does not compete with viewer gestures

### Shared layout cases

- [ ] 1, 2, 3, 4, 6, 10+, and 50+ page documents
- [ ] Extreme zoom in/out, gallery layout, and consistent page gaps
- [ ] Small-content centering and large-content pan bounds with the sidebar
- [ ] Hover/tap/active document border matches the Drop Zone accent
- [ ] Android SAF filenames show the real display name, not a URI document ID

### Word documents

- [ ] Simple, table/image-heavy, header/footer, and landscape `.docx` files
- [ ] Toolbar zoom, Ctrl+wheel, Ctrl+`+`/`-`/`0`, and pinch on touch
- [ ] Phone width: page fits on open; zoomed-in left edge reachable
- [ ] Web links do nothing; table-of-contents links scroll in the document
- [ ] PDF ↔ DOCX switching; side-by-side control only shown for PDFs
- [ ] Drop `.doc` (legacy message) and unsupported files (prompt)
- [ ] Android picker lists `.docx` files and opens them
