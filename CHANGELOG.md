# Changelog

## Unreleased

- **A third example**, "A Biergarten sign": a plate with a raised gold frame and Liberation
  Serif lettering, a beer mug at each end, hanging holes — every feature in its own colour, the
  way the colour rules ask for.
- **Colour**: the model is asked to colour every feature a second filament would print —
  lettering, ornaments, trim — apart from its base, and each part apart from the others; the
  measured report lists each part's colours by surface share and flags lettering left in its
  base's colour. 3MF exports carry the colours as materials (per triangle) and, for Bambu
  Studio and PrusaSlicer, as painting — each colour region assigned a filament slot, largest
  region first, in both slicers' dialects; STL exports carry them per facet in the
  VisCAM/SolidView attribute word, which MeshLab reads and slicers ignore; OBJ exports carry
  them as materials in an MTL file downloaded alongside, which the slicers import too.
- **Skills**: reference the model loads on demand with a ```` ```skill ```` block — `fonts`
  (every face and style, sizing and cutting lettering), `views` (the view grammar: cuts,
  framing, close-ups, the best side), `parts` (PART editing, and a live listing of this
  document's parts with their colours and boxes), `diff` (reading the measured report and the
  render). Listed one line each in the system prompt; a **skill · fonts** chip marks a load.
- **Fonts**: `text()` renders. The Liberation family (Sans, Serif, Mono; Regular, Bold,
  Italic, Bold Italic — SIL OFL) ships with the kernel and is loaded on the first part that
  uses text; a font name outside the family falls back to the nearest face instead of
  rendering nothing. The prompt tells the model which faces exist.
- **Inspection per part**: the measured report lists every solid with its box and volume in
  PART order, and names a closed void — a pocket cut entirely inside a part — instead of
  counting it as a part. The app grades the mechanical checks itself (rests on Z=0, solids
  against PART sections, voids, watertight, genus) and hands the model the verdicts, so its
  own questions go to the request. Each round of a turn is measured against the round before
  it. A part moved whole is recognised (`moved_mm`) and put back before the diff, so the
  render shows what changed in shape rather than the move; and when the change is small the
  render gains a second pane, a close-up of the largest changed piece seen from the side it
  sits on. The report lists every changed piece (`changed_pieces`) with the side it is best
  seen from, and the model can ask for any of them — ```` ```view {"closeup": N} ```` — or
  for `"view": "auto"`, where the app picks the side a box is best seen from.
- **Draw mode**: **DRAW** in the viewport turns the view into a sketchpad; **ATTACH** puts the
  marked-up view (red strokes) into the next message, headed so the model reads the strokes as
  annotations of where a change goes.
- **Thinking**: a setting, and `/think off|low|medium|high`. Off — the default — is one model
  call per message with no verification round. Any other level sets OpenRouter's
  `reasoning.effort` and lets the model look at what it built, ask for views and cuts, and
  correct itself until it is satisfied.
- **Model-requested views**: with thinking on, a reply may be a ```` ```view ```` block naming a
  view (iso, iso_back, front, back, left, right, top, bottom), an optional section cut and an
  optional box to frame; the app renders it and hands it back as an inspection.
- **A status line** under the transcript says what the turn is doing — `look 2 · measuring the
  part`, `repair 1 of 2 · compiling`, `look 3 · rendering front view, cut at z = 12 mm` — with a
  spinner, as has the HUD's `compiling…` tag — so a long chain of looks reads as progress.
  Click it to see the model's output so far, raw: reasoning and code included.
  Nothing interrupts a turn but **Stop**. The viewport shows each version that compiles as the
  turn goes (tagged **candidate** until it commits), and the transcript only follows the newest
  message while you are at the bottom of it — scrolling up to re-read stays put.
- **PART sections**: the source wraps each part in `// ---- PART N ----` … `// ---- PART N END ----`,
  one top-level call each, so viewport part N is source PART N; a reply may replace one with a
  ```` ```openscad-part N ```` block (one past the last adds a part, an empty body deletes one).
  The same block takes a **module name** — ```` ```openscad-part lid ```` — and replaces that whole
  `module lid(...) { … }`, found by parsing (braceless one-liners too); an unknown name appends.
  After a compile the chat notes a section with no call, a call outside the sections, or a module
  nothing calls. The examples carry markers.
- **Construction geometry**: a `// ---- CONSTRUCTION ----` section of `%`-prefixed statements
  — reference shapes the part must fit — compiled on its own kernel and drawn as a translucent
  blue ghost in the viewport and in the model's looks. The `%` keeps it out of every export
  (verified on the pinned kernel); the checks flag a construction statement that forgot it.
  Replace it with ```` ```openscad-part construction ````.
- Repairs are per candidate: every source that compiles gets two of its own.
- Deleting the open document goes back to the start window instead of silently opening a
  neighbour.
- The thinking level is remembered **per model**: switching models no longer carries the last
  model's level along (a model without reasoning wants none). The reasoning and raw-output boxes
  under the transcript are taller, and the reasoning box scrolls, following the newest thought
  until you scroll up.
- The live reasoning is rendered as markdown — a thinking model titles its steps in bold — and is
  no longer shown twice: OpenRouter carries Gemini's thought in both `reasoning` and
  `reasoning_details`, and the reader added both.
- **copy** in the chat's footer puts a debug report on the clipboard: settings, the source and
  the whole transcript raw — replies verbatim, stderr, inspection reports — with no key and no
  images. Paste it into an issue.

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
