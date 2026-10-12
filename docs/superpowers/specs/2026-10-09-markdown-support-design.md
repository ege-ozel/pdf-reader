# Markdown (.md) Support — Design

## Goal

Let the app open Markdown files read-only, on desktop (Windows) and Android,
alongside PDFs and Word documents, without changing how those behave.

## Decisions

- **Renderer:** [markdown-it](https://github.com/markdown-it/markdown-it)
  (MIT), pinned to an exact released version at implementation time and
  vendored into `src/vendor/markdown-it/` as a classic `<script>` tag, the same
  way PDF.js and docx-preview are vendored (there is no bundler).
- **Raw HTML is off.** markdown-it is created with `html: false`, so `<script>`,
  `<iframe>`, event-handler attributes and other raw HTML in the source are
  escaped and shown as text. This is the main safety measure, so no separate
  HTML sanitizer is vendored. Links with unsafe schemes (`javascript:`,
  `vbscript:`, `data:` except images) are rejected by markdown-it's default
  link validator and must stay that way.
- **Separate viewer.** Markdown renders into its own `#markdown-container`
  with native scrolling, next to the PDF and Word viewers. Only one viewer is
  visible and loaded at a time; switching documents releases the other one.
- **Type detection.** Markdown has no file signature, so detection cannot be
  purely by bytes like PDF and ZIP are. Rules, in order:
  1. `%PDF-` → PDF, ZIP header → Word (unchanged).
  2. Otherwise, if the file name ends in `.md` or `.markdown`, and the bytes
     decode as UTF-8 with no NUL bytes → Markdown.
  3. Otherwise, the existing fall-through to PDF.js, which reports its own
     error.
  Android `content://` URIs carry a display name through the SAF metadata
  (`PathResolver::file_name`), so the name is available for both the picker and
  "Open with" launches. The IPC must pass the name to the frontend with the
  bytes; see "Open decisions".
- **Entry points** accept `.md` and `.markdown`: the file picker filter,
  drag-and-drop, the command-line / "Open with" launch, the Windows file
  association in `tauri.conf.json`, and the Android intent filter for
  `text/markdown`.
- **Rendering details:**
  - Headings, paragraphs, emphasis, lists, task lists (as plain checkboxes,
    read-only), blockquotes, tables, horizontal rules, inline and fenced code
    blocks. Fenced code is shown in a monospace block with no syntax
    highlighting in v1.
  - Typography follows the app theme tokens (light and dark) and uses a
    reading-width column (about 75 characters, capped by the viewport).
  - Leading YAML front matter (`---` … `---`) is shown as a small monospace
    block at the top rather than as a horizontal rule and paragraph.
- **Zoom:** a CSS font-size scale, driven by the same toolbar controls as the
  Word viewer (+/−/fit, Ctrl/⌘ + wheel, Ctrl/⌘ + `+`/`-`/`0`, and two-finger
  pinch on touch screens). Fit means "reading width", not page width.
- **Toolbar:** the page-layout (side-by-side) button and its menu options are
  hidden for Markdown, as they are for Word.
- **Links never navigate the app window.** Links to `#anchors` inside the
  document scroll to the heading with that generated id. External `http(s)`
  links are inert in v1, matching the Word viewer. Opening them in the system
  browser is a follow-up that needs the opener plugin and its own review.
- **Images:** no remote fetching. Images with `http(s)` sources render as their
  alt text, so opening a file never makes network requests. Relative images
  (`![x](./pic.png)`) also render as alt text in v1, because Android `content://`
  files have no sibling files to read. Data-URL images are allowed.
- **Sidebar** rows get a small `MD` badge derived from the file name.

## Non-goals (v1)

- Editing, saving, or a source/preview toggle.
- Syntax highlighting in code blocks.
- Relative image loading and remote images.
- Rendering raw HTML, math (LaTeX), Mermaid diagrams, or footnote popovers.
- Search within the document (a later pass can share it with the PDF and Word
  viewers).
- Printing and export.

## Known limitations

- Rendering follows CommonMark plus the GFM extensions markdown-it enables.
  Other dialects (for example, Obsidian-style callouts or wikilinks) show as
  plain text.
- Very large files (several MB) render in one pass on the main thread. Measure
  before adding a size limit; see "Verification".

## Open decisions

- **IPC shape.** Today `open_document_file` and `open_document_path` return
  only bytes, and the frontend sniffs them. Markdown needs the file name. Two
  options:
  1. Return a small JSON header with `{ name, bytes }` alongside the bytes.
  2. Add a second command that returns the name for the last-opened path.
  Option 1 is preferred: one call, no race between two commands.
- **Highlighting.** Deferred. If wanted later, a subset build of highlight.js
  for the most common languages keeps the size bounded.

## Verification

- Unit tests (`tests/`):
  - Type detection: `.md` and `.markdown` names, ZIP and PDF bytes still win,
    NUL bytes and invalid UTF-8 are rejected, and a `.md` name with binary
    bytes falls through.
  - Rendering: `<script>` and `onerror=` attributes are escaped in the output;
    `javascript:` links are not rendered as links; heading ids are generated
    and stable; front matter is extracted.
- Manual checks on Windows and Android (the README checklist):
  - Open a `.md` file from the picker, drag-and-drop, "Open with", and the
    sidebar; switch between PDF, Word and Markdown.
  - Confirm no network request is made for a document with remote images
    (browser devtools or the Android logcat network trace).
  - Zoom with each input method; check the light and dark themes.
  - Open a 5 MB and a 20 MB Markdown file and record the time to first paint
    before deciding on a size limit.
