# Changelog

## Unreleased

- **Parts**: every top-level statement is its own part — shown together, counted in the HUD,
  and exported as separate objects in the 3MF (each with its colour). The model is told to
  lay parts out side by side on the plate and never to overlap two top-level statements.
- **Import meshes**: attach STL, OBJ, 3MF or OFF files to a document (under the sliders) and
  `import("name.stl")` them from the source. Each file is validated and measured by the kernel
  on attach; the model sees the list with bounding boxes. Files persist with the document and
  travel in the project file (schema 2, base64 — a file without any is still schema 1).
- **Export OBJ**, and `/export obj`. Exports are named after the document (`Knurled knob.3mf`),
  not `model.3mf`.
- **Partial updates**: the model may reply with ```` ```openscad-edit ```` blocks that replace
  a quoted section of the current source instead of rewriting the file. A non-matching edit is
  reported back to it like a compile error and costs a repair attempt.
- **Click a part** in the viewport to select it; the next message is headed by its number,
  bounding box and colour, so "make this taller" means that part.
- **Resizable panes**: drag the grip at the bottom corner of the editor or chat pane.
- **Help**: a manual in the app (menu bar → Help, Esc closes), the command list on hover over
  that button, and `/help` in the chat. One `COMMANDS` table feeds all three.
- Real-kernel unit tests: the pinned wasm now runs under vitest for format and import checks.

## v0.1.0 — 2026-08-31

The first tagged release: milestones 1–4 of [`docs/design.md`](docs/design.md), plus examples,
colour and the LLM-titled document. A static site — nothing runs anywhere but your browser.

### Modelling (M1)

- **Kernel**: OpenSCAD compiled to WebAssembly, the official `2026.08.30` snapshot pinned from
  `files.openscad.org` (Manifold backend, no `SharedArrayBuffer`, so it deploys to plain static
  hosting). One fresh Worker per compile; a superseded compile is terminated, which is also how
  cancellation works. The kernel loads lazily on the first compile.
- **Viewport**: three.js, Z-up world, framed perspective, orbit controls, adaptive grid and build
  plate, crease outline, a view cube, and canvases that lay out correctly on retina displays.
- **Editor**: CodeMirror 6 with an OpenSCAD syntax mode. The editor, compiler and viewport are
  wired with debounced recompiles; the HUD stays consistent when a compile fails.
- **Stats**: bounding box, volume, watertightness, part count and genus, read off the mesh.
- **Export**: native STL and 3MF straight from the kernel; the 3MF carries the `_rels/.rels`
  StartPart relationship Bambu Studio requires.

### Chat (M2)

- **Bring your own tokens**: OpenRouter, via an OAuth PKCE flow that mints an app-scoped key, or a
  pasted key. The key lives in `localStorage`, is sent to exactly one host, and a strict
  Content-Security-Policy is what keeps it there.
- **Agent loop**: streamed reasoning and reply, a deterministic turn controller with repair
  attempts on compile errors, a Stop button, and `-D` defines for a fast reduced-resolution
  preview while a slider is dragged.
- **Customizer sliders** derived from the source's own top-level parameters and annotations.
- **Rendered transcript**, a session cost meter at list price, and a metric/imperial toggle that
  also tells the model how to read you.
- **Reference images**: paste or pick up to four per message. Sent with the turn they belong to
  and never again; the model list marks which models can read an image.
- `/undo`, `/compact`, and the other slash commands.

### Documents and versions (M3)

- Documents live in IndexedDB, each with an append-only version timeline: every LLM turn, every
  **Save version** and every successful compile of your own edits is a version, and nothing is
  deleted. A version picker in the menu bar and `/undo` step through them.
- A start window listing your documents, most recently edited first, and a menu bar over the
  store: New, Open, Save version, Rename, Delete.
- The transcript persists with the document (without its images).
- **Export project** / **Import project**: one `.json` with source, versions and conversation —
  never the key.

### Change inspection (M4)

- Once a turn's source compiles, the model gets one look at the result before the turn commits:
  a measured report (bounding box, volume, parts, genus, and what was added and removed compared
  with the part on screen, via kernel diff booleans) and, for vision models, one before/after
  render, green over magenta. It answers yes/no questions about your request and may reply with
  one correction. The report and picture sit behind the **inspected** chip.

### New in this release

- **Examples** on the start window: the mounting plate and a potted plant, from
  [`src/examples`](src/examples), each a plain `.scad` file.
- **Colour**: `color()` in the source is honoured in the viewport, per face, through unions and
  differences. Uncoloured faces keep the model's yellow.
- **LLM-titled documents**: the system prompt asks the model to open the file with a one-line
  `//` title comment, and the first committed turn names the document after it. Your prompt is
  the stand-in until then; **Rename** stays final.
- An app icon — the potted plant — in the tab and on the start window.
- The **Vibe3D** brand in the menu bar goes back to the start window.
- Fixed: a document created from the start window's **New document** was dropped on open.

### Known limits

- OpenRouter is the only model host; the CSP's `connect-src` allows nothing else.
- No organic shapes or multi-user anything, and no whole assemblies from one prompt (design.md §1).
- Stop halts billing on OpenAI, Anthropic, DeepSeek and xAI, not on Google, Groq or Mistral.
- A browser may evict IndexedDB when it needs space; export what you want to keep.
