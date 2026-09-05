# Changelog

## Unreleased

- **A link opens an example.** `#example=mounting-plate`, `#example=potted-plant` or
  `#example=biergarten-sign` on the app's URL creates a document from that example and opens
  it, like a share link does.

## v0.4.2 — 2026-09-05

The open document is in the address bar and the tab.

- **The URL hash is the open document.** `#<id>` while a document is open, none at the start
  window, and a history entry per move: Back and Forward walk between documents and the start
  window, and a reload or a bookmark lands on the document instead of the launcher. Share links
  keep their `#s=` form and still take precedence.
- **The tab title names the model.** `<name> · Vibe3D` while a document is open, `Vibe3D` at the
  start window.

## v0.4.1 — 2026-09-05

A reopened document no longer waits for the kernel.

- **A reopened document shows its mesh at once.** The last successful compile's OFF bytes are
  kept with the document in IndexedDB under the key that made them (source, defines and
  components). Opening the app or switching documents shows that mesh without starting the
  kernel; the first edit compiles as before. The bytes stay out of the project file, like the
  thumbnail. A turn's result is now keyed with the document's components too, so a turn on a
  document with an attached mesh no longer compiles a second time.

## v0.4.0 — 2026-09-03

The harness review: defects fixed, the loop made cheaper and observable, an eval runner, BOSL2,
and the viewport tools that were missing. Ten of ten bake-off parts commit on the first run of
`pnpm eval` against gemini-3.7-flash at high thinking, with no repairs.

### Fixed in the harness

- **An edit that missed was relabelled as applied.** The source re-attached after a failed
  `openscad-edit` or `openscad-part` block was headed "with your edits applied" although the
  diagnostic had just said it did not. The compile event now marks an edit miss, and the
  window says "the current source" for it.
- **The worked example broke the PART rule.** The system prompt demands every top-level call
  inside `// ---- PART N ----` markers, then showed a bare `plate();`. The example carries the
  markers (and a colour).
- **Warnings from a successful compile went nowhere.** "Ignoring unknown variable" and "may
  not be a valid 2-manifold" were stored and never shown — to the model, which now gets them
  before the report, or to you, who now see them under the viewport in amber.
- **Every look re-sent every earlier look's picture.** A six-look turn sent up to 21 renders.
  Only the newest render of a turn rides; earlier rounds keep their report.
- **A model could oscillate for ever.** A source the turn already compiled is now a loop: a
  repeat of one that compiled confirms it, a repeat of one that failed fails the turn.
- **A reply cut off after its code block closed was thrown away.** Only trailing prose was
  lost; the source is whole and is compiled.
- **The first send after boot could get no render**, when it outran the catalogue fetch that
  says whether the model reads images. The turn now waits for the catalogue.

### Improved in the harness

- **`pnpm eval`**: the turn controller against a real model and the real kernel, under Node,
  over the ten parts of design.md §5's bake-off. `OPENROUTER_API_KEY=… pnpm eval`, with
  `EVAL_MODEL`, `EVAL_THINKING` and `EVAL_ONLY` to narrow it. Writes a table and the full
  transcripts to `eval/results/`.
- A 429, a 5xx or a dropped connection before the stream opens is retried once.
- `max_tokens` is set to the model's own output ceiling from the catalogue, so a provider
  default cannot cut a long part short.
- Anthropic models get a prompt-cache breakpoint on the system prompt.
- A compile that runs out its 60 seconds is fed back once as a diagnostic — lower `$fn`, no
  minkowski over many objects — before a second timeout fails the turn.
- An edit whose only miss is indentation still applies.
- The status line shows what the running turn has cost so far.
- **Two more checks the app grades**: the share of each part's surface that overhangs past
  45° off the bed, and whether the model fits the printer's build volume. The bed is a
  setting (default 256 × 256 × 256, the Bambu A1/P1S/X1C); the viewport's plate outline
  follows it.

### Added

- **BOSL2** ships with the kernel: `include <BOSL2/std.scad>` gives rounded and chamfered
  primitives, anchors, threads, gears and screw holes. Loaded only for a source that names
  it; a `bosl2` skill lists the calls; the prompt points the model at it for fillets,
  threads and gears. The library is fetched from GitHub at a pinned commit by
  `scripts/fetch-bosl2.mjs` on install and before build, test and dev — not vendored.
- **Share**: a link with the source in its hash. Opening it makes a new document.
- **Export a selected part alone**: with a part selected, the export buttons say so and
  write only that part — STL and OBJ from the mesh, 3MF cut down to that object.
- **CUT and MEASURE** in the viewport: a section along X, Y or Z with a slider, and a
  two-click distance with its axis deltas.
- **The error line** is marked in the editor when a compile fails.
- **Diff** in the menu bar: what the current version changed against the one it was made
  from.
- **Thumbnails** on the start window, rendered at each compile.

## v0.3.3 — 2026-09-01

- **A sharing image**: links to the app now unfurl with a screenshot of the potted Monstera
  session, via Open Graph and Twitter card meta tags.

## v0.3.2 — 2026-08-31

- **CI is green again**: the three e2e tests that still assumed the old thinking-off default
  were caught up with v0.3.1's default of high.

## v0.3.1 — 2026-08-31

- **Thinking defaults to high**: a model with no stored thinking level now thinks at high
  instead of not at all. Choosing off in the menubar still sticks, per model, and a model
  without reasoning ignores the knob on the wire.

## v0.3.0 — 2026-08-31

The phone, the divider and the local model host.

- **A mobile view**: below 720px the app is one column — the model above, the chat below, the
  export row on the model's bottom edge, the menubar scrolling sideways. The editor pane is
  desktop-only; the source is untouched and waiting when the document is opened on a wide
  screen again.
- **The code pane slides away**: a chevron on the divider collapses the editor pane and brings
  it back, animated, without fighting the resize grip.
- **Keyless custom endpoints**: an empty API key is allowed when the base URL is not
  OpenRouter's own, and then no `Authorization` header is sent at all — so a local host such as
  Ollama or LM Studio works without inventing a key. (The deployed build's CSP still allows
  only OpenRouter; local hosts are for builds you serve yourself.)
- **The footer version is `git describe`**: the tag itself on a clean release,
  `v0.2.0-3-gabc1234[-dirty]` past it, linking to the release or the commit accordingly.
- **The tagline** is "Prompt a parametric 3D model - with your own tokens.", and Live moved to
  <https://spoerri.dev/Vibe3D/>.

## v0.2.0 — 2026-08-31

Milestones 5–7 of [`docs/design.md`](docs/design.md): parts and imported meshes, draw mode and
model-requested views, colour everywhere and per-part inspection — plus fonts, skills and a
third example.

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

- **Exporting a big coloured model no longer freezes the tab**: the 3MF painting pass replaced
  triangle tags one `String.replace` at a time over the whole model XML — quadratic, 46 seconds
  for the sign's 58k triangles, on the main thread. One pass now, 0.2 s, byte-identical output.
- The Biergarten example's mounting-hole cutters carry the plate's colour, so the bore walls no
  longer export in an unset colour.
- **Help** explains Bambu Studio's "invalid config, load geometry data only" dialog: its
  greeting for every 3MF it did not write itself — click OK, the parts and colours all load.
- The start page ends with the version — `v0.2.0` on a release, `v0.2.0+hash` linking to the
  commit otherwise — and a link to the repository.
- A standing notice in the chat when no API access is configured yet: connect OpenRouter or
  paste a key in settings.
- The start window no longer wears the last document's menubar: version picker, name badge,
  Rename and Delete belong to a document on screen.
- The tagline is "Prompt a 3D model (with your own tokens)."

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
