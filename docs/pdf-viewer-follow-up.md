# PDF Viewer Follow-up

## Implemented

- Opening reads only the first page dimensions. Other page proxies and their
  metadata load when a page enters the visible window; estimated positions for
  mixed-size pages are corrected while preserving the focal point.
- A binary-searched lightweight row layout reserves pan bounds without adding
  DOM slots for the whole document. A small viewport window mounts, renders,
  and retains nearby slots; navigation removes distant slots and canvases.
- The priority render queue limits concurrent work to two desktop pages and
  one mobile page. Device-specific budgets limit total canvas memory and each
  page's raster pixel count; zoom and navigation cancel stale queued work.
- PDF pages, rasters, and old document loading tasks are cleaned up on unload,
  zoom, superseding opens, and close. Existing page hooks release annotation
  and text-layer references alongside the canvas.
- Zoom continues to use an immediate CSS transform followed by a debounced
  crisp render. The page under the zoom anchor is retained when the grid
  reflows, and only nearby pages need new canvases.
- Single-page mode is always one column. Dual-page mode uses an even-gap CSS
  grid, fitting two pages at normal zoom and adding columns as zoom decreases.
  The grid never creates columns beyond the document's page count.
- The viewer centers content that fits and clamps pan for content that
  overflows. Its flex parent can shrink alongside the desktop sidebar.
- Page canvases are capped at `MAX_CANVAS_PIXELS` (16 M backing-store pixels,
  about 64 MB). `computeOutputScale` lowers the device-pixel scale only when a
  canvas would exceed the cap. Before this, a letter page at 4x zoom on a 3x
  display allocated about 280 MB per canvas, and several visible pages at once
  could exhaust memory on large or high-DPI screens.
- Android recent-file names now come from Tauri's `PathResolver::file_name`,
  which reads the SAF display-name metadata for `content://` URIs. Names are
  no longer guessed from encoded URI segments. Desktop paths continue to use
  the real path basename.
- Sidebar hover, press, and active-document borders reuse the Drop Zone
  `--accent` theme token.

## Automated verification

- `npm test`: 20 tests passed, including page-column, gap, and fit-zoom cases.
- `cargo test` (from `src-tauri/`): 12 tests passed.
- JavaScript syntax checks, changed Rust file formatting check, and
  `git diff --check` passed.

## Large-document stability: what remains

Lazy loading and page-cache release already exist: `IntersectionObserver`
renders pages near the viewport, and `unloadPage` zeroes the canvas and calls
`PDFPageProxy.cleanup()`, so nothing is cached beyond the visible buffer. The
remaining risks, in likely order of impact:

1. Canvas memory at high zoom and DPR (addressed above).
2. Whole-file copies. Rust reads the file into a `Vec`, the IPC response copies
   it into a JS `ArrayBuffer`, and PDF.js may copy it again into its worker.
   A 40 MB file can peak at roughly 120 MB before parsing starts. Not changed
   yet; measure on a device before restructuring.
3. Decoded images. Scanned pages can hold large decoded images on the PDF.js
   page proxy until cleanup. Check whether pdfjs-dist 6 exposes a
   `maxImageSize` option before relying on it.
4. Word documents are rendered in one pass with no virtualization. Very large
   `.docx` files are a separate risk; see the Word section of the README.

## Manual verification still required

The desktop touchpad and Android device checks below require physical input
devices / a mobile runtime and have not been performed in this environment.
Use the checklist in [README.md](../README.md) to verify:

- Page counts from 1 through 50+, especially fast scrolling in long PDFs.
- Single, dual, and gallery layouts, including zoom extremes and an unpaired
  final page.
- Stable gaps, anchor retention, centering, and pan boundaries with the
  sidebar visible.
- Mobile touch pan and pinch, orientation changes, and Android SAF filenames.
- Mouse wheel, trackpad pan, trackpad pinch, and the absence of browser-native
  zoom conflicts.
