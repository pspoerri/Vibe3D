# Vibe3D — design

A browser-only 3D modelling tool where an LLM writes and edits OpenSCAD source, you see the
result in 3D, and everything — state, history, API key — lives in your browser. Static site,
no backend, bring your own API key.

Status: **Milestones 1–5 shipped** — kernel, viewport, editor, export (M1); agent loop,
OpenRouter client, Customizer sliders, reference images (M2); document store, version timeline,
persisted transcript, project file, launcher (M3); change inspection — measured report, diff
booleans, before/after composite, one verification round per turn (M4, see the end of §6);
parts, imported meshes, OBJ, partial edits, click-to-select, resizable panes (M5, see the end
of §8). Plans: `docs/superpowers/plans/`.
Date: 2026-08-31. License: **GPL-3.0**.

---

## 1. What it is

A chat window, a 3D viewport, and a source editor over one OpenSCAD document.

- You describe a part. The model writes OpenSCAD. The browser compiles it and shows the mesh.
- You can edit the source directly, or drag sliders derived from the source's own parameters.
- Every change is a version you can step back to.
- A document can hold several parts, and can import meshes you already have (STL, OBJ, 3MF).
- Export STL, 3MF or OBJ for Bambu Studio; the 3MF carries each part as its own object.

Explicit non-goals: organic shapes (faces, terrain, soft curves), multi-user anything, and
whole assemblies designed from one prompt. Even frontier models reach only ~0.5 part-matching F1
on assemblies; promising that would be promising a thing that does not work. Several parts in one
document and a mesh imported into it are in (§8) — those are things a user composes, one part
at a time.

---

## 2. Decisions

Each row is a decision that was actually contested, with the evidence that settled it.

| Decision | Choice | Why |
|---|---|---|
| Modelling language | **OpenSCAD** | ~25× the public corpus of any alternative (7,141 repos vs 286 for JSCAD, keyword-matched). P3D-Bench rates it the strongest of four code formats for LLM 3D generation. Three shipping LLM+OpenSCAD products already exist. |
| Kernel | **openscad-wasm, official snapshot** | Pinned from `files.openscad.org`, not npm. See §3. |
| Renderer | **three.js (WebGL 2)** | ~134 KB gz buys orbit controls, `EdgesGeometry`, offscreen render targets, multi-view capture. |
| Editor | **CodeMirror 6** | 121 KB gz vs Monaco's 1.24 MB. Neither ships an OpenSCAD mode, so Monaco's ecosystem edge evaporates exactly where we'd need it. ~40-line `StreamLanguage` parser. |
| Export | **STL + 3MF + OBJ, all native** | The kernel emits all three. No serializer to write. STEP dropped — see §8. |
| LLM host | **OpenRouter only for v1** | Verified browser-callable. Hand-rolled client, no SDK. |
| Edit protocol | **Full rewrite, or content-anchored section edits** | Whole-file was the v0.1 rule (a diff applier is a silent-failure surface). M5 added `openscad-edit` blocks that name the lines they replace by quoting them — not by line number, which models miscount — and must match exactly once; a miss is fed back as a diagnostic on the repair budget, so the failure is loud. See §8. |
| Time travel | **Append-only linear list** | No shipping AI tool has a branching UI. `parentId` stored anyway — it is one string, and a linear list whose nodes record their parent already *is* the tree. |
| License | **GPL-3.0** | Forced, and fine — see §9. |

### Rejected

- **JSCAD** — its 3MF serializer emits `<model>` with *zero* xmlns declarations (verified by
  unzipping real output); it has no three.js adapter (`cube − sphere` returns 476 polygons: 460
  quads, 16 pentagons, **zero** triangles); and it is ~31× slower than manifold on chained
  booleans, the exact shape LLM code takes (best-of-6: 3345 ms vs 108 ms).
- **manifold-3d as the authoring kernel** — technically the best kernel in the set, but its API
  is bespoke and therefore zero-shot for every model. Fluency beats elegance when an LLM is the
  only author. Retained as a *fallback* utility for diff booleans (§6).
- **replicad / OpenCascade.js** — 22.97 MB of LGPL-2.1 wasm, no 3MF export, upstream last
  published 2023.
- **A custom DSL** — Text2CAD-Bench's ablation: swapping ordinary code for a bespoke command
  grammar raised one model's invalidity from 13.3% to 67.3%. Do not invent a language.

---

## 3. The kernel

Pin the official WebAssembly snapshot from `files.openscad.org`, **not** `openscad-wasm@0.0.4`
on npm. The npm package base64-inlines a 13.9 MB wasm into a single JS file (unstreamable, and
it will choke a bundler) and its **3MF export hard-crashes**.

Verified on `OpenSCAD-2026.08.30-WebAssembly-web.zip`:

```
openscad.js     99,853 B   (ESM glue)
openscad.wasm   10,726,590 B   → 3.1 MB gzipped, streaming-compilable
```

| Property | Value |
|---|---|
| `SharedArrayBuffer` / `pthread` refs | **0** — no COOP/COEP, GitHub Pages works |
| Backend | Manifold 3.5.2 (default; CGAL was 15–100× slower) |
| 3MF | lib3mf 2.3.2, working |
| PNG export | **Not available** — built `-DNULLGL`. All pixels come from three.js. |
| In-memory mesh API | **None.** Export a file, parse it back. |

Export matrix, executed against the pinned build on a reference part:

```
3mf      rc=0   14,225 B      binstl   rc=0   52,684 B
off      rc=0   36,702 B      csg      rc=0      730 B
```

The 3MF is spec-correct: core namespace, `unit="millimeter"`, and the `_rels/.rels` StartPart
relationship that Bambu Studio **hard-fails** without.

### Fonts (2026-08-31)

The wasm build ships no font and its fontconfig has no default config path, so `text()`
rendered nothing — past a "Can't get font" warning, silently when other geometry was in
the same top-level object (the A320 log's engraved nameplate was byte-identical to its
embossed predecessor). `src/kernel/vendor/fonts/` now carries the Liberation family
(2.1.5, SIL OFL 1.1: Sans, Serif, Mono × Regular, Bold, Italic, Bold Italic — OpenSCAD's
own default is Liberation Sans), and `fonts.ts` installs it: the twelve faces and a
`fonts.conf` listing `/fonts` are written into the instance's FS and `ENV.FONTCONFIG_FILE`
points at the config before `callMain` — the glue exports `ENV`. Installed only when the
source matches `text\w*\s*\(` (a regex; a comment that matches merely installs fonts for
nothing): fontconfig scans the directory on every kernel start, and measured under Node
that is ~25 ms for two faces and ~30 ms for twelve on a ~30 ms compile, so the whole
family ships and a text-free part pays nothing. The worker fetches the faces once, on the
first source that needs them, as Vite-hashed assets via `import.meta.glob`; a failed fetch
is retried on the next text() compile. A name the bundle lacks gets fontconfig's nearest
match rather than nothing, and the system prompt's TEXT section names the faces so the
model asks for one that is there.

### Compile path

```
FS.writeFile('/in.scad', source)
  → callMain(['/in.scad','-o','/out.off','--export-format=off'])
  → FS.readFile('/out.off')  → parse → THREE.BufferGeometry
```

OFF rather than STL: indexed (so smaller), and it carries per-face colour — `r g b` after the
indices, on exactly the faces that had a `color()` — which the viewport shows as vertex colours.

**`callMain` runs `main()` to process exit, so a module instance is single-use.** Verified:
a second `callMain` on a live instance throws. So: one fresh Worker per compile, and
`terminate()` on supersede — which also gives cancellation of an outdated compile for free.

The kernel loads lazily on first compile, keeping it off the first-paint budget.

---

## 4. Architecture

```
src/
  kernel/
    vendor/              pinned openscad.js + openscad.wasm, never edited
    protocol.ts          worker message types, incl. -D defines and files; kernelArgs (lazy-union)
    openscad.worker.ts   fresh Worker per compile; terminate() to cancel
    kernel.node.test.ts  the real wasm under vitest: OBJ, three-object 3MF, mesh import
    compile.ts           Compiler — worker lifecycle, cancel, timeout
    off.ts               OFF → Mesh
    stats.ts             bbox, volume, tri count, watertightness
    noise.ts             stripKernelNoise (display) + stderrForModel (model)
  viewer/
    Viewport.tsx         WebGLRenderer, OrbitControls, adaptive grid
    camera.ts            pure fit / grid-spacing / standard-view maths
    ViewCube.ts          orientation widget
    capture.ts           offscreen 768² orthographic before/after composite (§6)
    inspect.ts           measured report, diff booleans on the kernel, framing (§6)
    select.ts            a clicked triangle → its part, box, colour; the [Selected part …] line (§8)
  llm/
    sse.ts               SSE reader (hand-rolled, see below)
    openrouter.ts        streamChat, model catalogue, error normalisation
    auth.ts              OAuth PKCE
    images.ts            fit + toDataUrl — ≤1568 px JPEG data: URL (§9)
  chat/
    controller.ts        runTurn / runCompact — the deterministic loop (§5)
    log.ts               append-only ChatEvent[] + buildWindow (§10); reviveLog, stripImages (§7)
    fence.ts             fenced-source extraction, fence stubbing; steps over edit blocks
    edits.ts             openscad-edit blocks: parse, apply exactly once (§8)
    prompt.ts            system prompt
    commands.ts          /clear /compact /export /model /key /undo /help; COMMANDS, the one list
  help/Help.tsx          the manual — static JSX, the command table from COMMANDS
    Chat.tsx             the chat pane
  editor/
    Editor.tsx           CodeMirror 6 + StreamLanguage OpenSCAD mode
    openscad-mode.ts     the StreamLanguage tokenizer
    params.ts            Customizer annotations → sliders
    ParamsPanel.tsx      the slider strip (named to avoid a case collision with params.ts)
    ComponentsPanel.tsx  the document's mesh files; attach = one validating compile (§8)
  state/
    settings.ts          localStorage: baseUrl, model
    key.ts               localStorage: the API key, ALONE (see §7)
    documents.ts         Doc{versions, head, chat, components}, Session, the commit rules — pure data (§7)
    project.ts           the .json project file: export, import, schemaVersion (§7)
    store.ts             idb-keyval, one named database, atomic write (§7)
  export/download.ts     bytes → file download; DownloadFormat = binstl | 3mf | obj
  examples/
    index.ts             EXAMPLES for the start window + STARTER; each .scad imported ?raw
    *.scad               the mounting plate, the potted plant (colour() per part)
```

**No state library.** §2 once implied `zustand`; plain React state carried Milestone 2, and
Milestone 3's persisted version timeline gave the store something to own — without reaching for
one: `documents.ts` and `store.ts` are plain functions over `useState`, not a library.

Single route, no router — that keeps `base: './'` valid, which is what makes one build artifact
deploy unchanged to a GitHub Pages subpath, a custom domain, or anywhere else.

---

## 5. The agent loop

A **deterministic controller**. The model does not decide when to stop.

```
user turn
  → LLM returns COMPLETE source (ONE fenced code block — see §9)
  → compile
      error → resend raw stderr verbatim, capped 100 lines (head-50 + tail-50)
              MAX 2 retries, then surface to the user
      ok    → verification round (§6): measured report + composite render,
              structured questions, ONE correction allowed → compile → answer
  at most 4 LLM calls per user turn: 1 + 2 repairs + 1 verification
```

Why the controller counts rather than the model: two repair rounds capture 76–95% of achievable
self-repair gain, and later rounds *inject* new bugs. Measured, the same loop draws 7.9 turns out
of one frontier model and 1.5 out of another — model-decided stopping is unreliable in both
directions. With a user-supplied key we cannot control which model runs, so the controller must
impose the iteration budget.

**Error feedback is `stderrForModel(stderrRaw)`.** That drops only the kernel's unconditional
localization line and applies the head-50 + tail-50 cap; it never rewrites a path or a line
number, and it is a different function from the display form, which does rewrite `/in.scad`.
Do not paraphrase, do not rewrite line numbers, do
not re-attach the source — the model already has the source it just wrote, and resending it
doubles cost for zero information. Head-50 + tail-50 because the fatal message is usually last
and the root-cause include is usually first.

Make sure stderr crosses the Worker boundary. Worker error serialization strips custom `Error`
fields by default, and a reference implementation in this space shipped exactly that regression:
"the AI build loop had nothing to self-correct against."

### Never let the model measure

VLM size/boundary IoU on CAD renders is **0.07–0.09**; spatial-relation accuracy is under 30%.
Performance more than doubles when dimensions are supplied as *text* instead of read off pixels.

So images always travel with a text block: bbox in mm, part count, watertight yes/no, volume,
and requested-vs-measured for any dimension the user named. Images catch gross layout and
proportion. Numbers catch geometry. A render is never the sole evidence that an edit is correct.

### System prompt

Order matters; roughly 1,200 tokens as a cacheable prefix. Role → tool contract → never claim a
change without calling the tool → mm and Z-up, part sits on Z=0 → parameters first, then modules,
then one top-level call → printability (0.8 mm min wall, overhangs under 45°, 0.2–0.4 mm mating
clearance, one connected manifold solid) → manifold hygiene (**overlap unions; extend subtraction
cutters past both faces — coplanar faces are the #1 cause of bad renders**) → `$fn = 48` for
preview, 64–96 for threads and small holes, never above 128 → OpenSCAD's declarative-variable
gotchas (last assignment wins; you cannot accumulate in a `for`) → one worked example.

### Measured: compile failure is not the risk

A blind bake-off — 10 realistic printable parts (plate, hex bolt, fluted knob, stackable box, flange,
phone stand, honeycomb panel, pipe tee, cable clip, twisted vase) generated with no execution allowed,
then run locally:

| kernel | first-try pass | median | slowest |
|---|---|---|---|
| OpenSCAD | **10/10** | 1,381 ms | 13,179 ms |
| JSCAD | 10/10 | 92 ms | 286 ms |
| manifold-3d | 10/10 | 25 ms | 421 ms |

**30/30 compiled on the first attempt.** With a decent API reference in context, syntax is not where a
frontier model fails. Two consequences:

1. **The 2-retry compile budget stays, but it will rarely fire.** The valuable rounds are the
   verification ones, because the model reliably produces *valid code that is the wrong shape*.
2. **Geometric divergence is the real failure mode**, and it appears exactly where the prompt is
   ambiguous. On the cable clip and the twisted vase, all three implementations produced a valid solid
   with a *matching bounding box* — and volumes 1.5× apart (2850.99 vs 1950.02 mm³) and 27169 vs 31447 mm³
   respectively, from differing readings of "wall thickness" and "20-lobe wavy circle".

Only **volume** distinguished right from wrong. Bbox and triangle count did not. This is the strongest
available argument for the `measure()` channel in §6: a render would probably not have caught either
case, and the numeric report catches both.

### Measured: latency is OpenSCAD's real cost

Compile times over the same 10 parts: median 1.4 s, but 6.6 s (fluted knob), 6.1 s (flange) and
**13.2 s** (twisted vase). The same parts take 25–421 ms on manifold. This is the price paid for
fluency, and it is paid in the interaction loop.

So: no per-keystroke recompile. Debounce, cancel-on-supersede via `terminate()` (already free from the
one-worker-per-compile design), and an honest progress state. For slider drags, substitute a reduced
`$fn` during the drag and recompile at full resolution on release — the Customizer substitution path
makes this nearly free.

### Derive, don't ask

Parameters, bbox, watertightness, part count and thumbnail are all computed client-side. The
model's entire output surface is one string. Corollary and the best UX-per-line in the project:
OpenSCAD Customizer annotations (`wall = 2; // [1:0.5:5]`) parse straight into sliders, and
dragging one does an in-source substitution and recompiles with **zero LLM calls**.

### Skills (2026-08-31)

Reference the model loads when it changes what it will do next, so the system prompt stays a
short cacheable prefix while the detail grows. Four, in `src/chat/skills.ts`:

- **fonts** — generated from `FONT_FILES`, so it can never promise a face that is not
  vendored: every family and style by name, the `Family:style=Style` syntax, size and relief
  for printed lettering, emboss and engrave snippets.
- **views** — the whole view grammar (named directions, `auto`, cuts, `box`, `closeup`), or,
  with thinking off, how to turn looks on.
- **parts** — PART sections, the four ways to change one, and a live listing of this document:
  each PART's call line against the solid on screen, with its colour (name and hex, from the
  mesh's per-face colours via `partColours`) and box — so a part can be spoken of as "the red
  one", and a mismatch between sections and solids is named.
- **diff** — every field of the measured report, the checks, and how to read the green/magenta
  render and the round-against-round semantics.

Carried in-band like a view request: a reply that is only a ```` ```skill ```` block naming one
is a round — the controller records a `skill` event and continues; beside a source, an edit or
a look the block is honoured and the reply goes ahead. Bodies are not stored: `buildWindow`
re-renders every loaded skill at window time (after the history, before the source), so the
parts listing is always current, and a loaded skill outlives compaction — it is reference, not
history — and dies at `/clear`. An unknown name gets a live-only refusal that lists the skills.
Skill loads are allowed at every thinking level, including off, capped at three per turn
without a source (`MAX_SKILL_ROUNDS`). The system prompt's SKILLS section is generated from
the same list, and its TEXT and looking clauses shrank to a pointer each.

---

## 6. Change inspection

The uncomfortable finding, and the one that shapes this feature: **numbers beat pictures, and
naive pictures actively hurt.** In the only controlled ablation (CADCodeVerify, ICLR 2025) a
geometric solver feeding numbers to GPT-4 scored 0.103 point-cloud distance vs 0.127 for the best
image-based loop and 0.155 unrefined. Naive "here is a render, fix it" **dropped GPT-4's compile
rate by 20%** on hard cases.

**1. Text diff — always on, ~200 tokens, no toggle.**

```json
{ "changed_bbox_mm": {"min":[12,4,0],"max":[20,12,6]},
  "added_volume_mm3": 412.6, "removed_volume_mm3": 0,
  "model_bbox_mm": {...}, "watertight": true,
  "genus": 0, "was_genus": 0, "tri_count": 19842, "was_tri_count": 18610 }
```

**2. One default image — a single 768×768 composite.** Not a boolean render: *before* in green,
*after* in magenta, 0.5 opacity, `MultiplyBlending`, `depthWrite: false`. ~20 lines, no geometry
cost, and it distinguishes added / removed / unchanged for free. Plus a sparse crease outline
(`EdgesGeometry`, ~30° threshold) — **not** a wireframe; dense line work is where these models
fail hardest.

768 px is the ceiling worth paying for: accuracy is flat across 384/769/1155 px on exactly the
low-level geometric tasks a CAD diff depends on.

Framing — the whole answer to "the detail, its surroundings, and how it merged" — is one line:

```ts
frameBox = lerp(changeBox, modelBox, 0.25)
```

Both halves share that camera, so the changed detail and the outer geometry it fused into are in
frame together.

**3. The toggle**, for complex modifications: added-green / removed-red as separate meshes over a
grey base, plus a capped cross-section through the changed region. Auto-*suggested* when the
changed bbox exceeds 5% of model volume, or genus changed, or the source diff touched more than
one feature.

**4. Two tools, not six.**

```ts
render_view({
  view: "iso" | "front" | "top" | "right" | "iso_back" | {az, el},
  fit: "all" | "change",                                  // default "change"
  section: null | {axis: "x"|"y"|"z", at: number|"change"} // default null
})
measure()   // no arguments; returns the report above
```

Rejected arguments and why: `resolution` (accuracy is flat, so it only burns tokens), `fov`
(pick orthographic once, globally — a per-call toggle produces variance, not information),
`distance` (derived from `fit`; let the model set it and it frames empty space), `up_vector`
(world up is +Z, always), `wireframe`/`material`/`lighting`/`background` (no evidence, all add
render paths to maintain).

**5. Non-negotiable:** every image is wrapped in structured verification — 2–5 binary questions
derived from the edit intent, answered per view with reasoning, "Unclear" permitted, then
summarised into corrections. The bare "does this look right" formulation *is* the −20% regression.

**Diff booleans need no new dependency.** We already ship the kernel, so added material is
`difference() { import("new.stl"); import("old.stl"); }` on the Manifold backend already loaded.
If that proves flaky, `manifold-3d` (541 KB, Apache-2.0) is the fallback — not the default.

Known trap: if an edit also moves the part's origin, every vertex differs and the diff is 100% of
the model. We own the parametric source, so detect it there rather than trying to re-align meshes.

### Shipped 2026-08-31

Milestone 4 built points 1, 2 and 5 as written, and took a different shape on the rest. Spec:
`docs/superpowers/specs/2026-08-31-change-inspection-design.md`.

- **The controller pushes the round; the model calls no tools.** After a compile succeeds the
  controller computes the report and the composite and sends both in one `user` message wrapped
  in the structured questions (`verifyMessage`), and the model either confirms in a sentence or
  returns a corrected complete source. `render_view` / `measure` as model-invoked tools were
  not built: tool support on OpenRouter is per-model and the user picks any model; an image
  inside a tool result is the least portable part of the OpenAI-compatible surface; and §13
  records that extra views have no ablation. They wait for an A/B that shows the fixed iso
  composite is not enough.
- **One round per turn** (`MAX_VERIFY = 1`). A correction is compiled with the remaining repair
  budget and committed without a second look — §5's finding that later rounds inject bugs, taken
  at its cheapest.
- **Once a candidate has compiled, the turn commits it unless a later candidate compiles.** A
  stop during verification, a truncated correction, or one that cannot be repaired all commit
  the verified source, with a note; the user never waits out a compile and then loses it.
- **The diff is `difference() { import("keep.off"); import("cut.off"); }`** on the kernel, twice
  in parallel with the files swapped, through a `files` channel on the compile request. An
  empty difference exits 1 with "Current top level object is empty." and is read as 0 mm³; any
  other failure is `null`, never a zero. Genus and part count come from Euler's formula and a
  union-find over shared vertices in `stats.ts`.
- **The composite**: pure green and pure magenta at opacity 0.5 under `MultiplyBlending`, no
  depth test, so unchanged material is 50% grey. three requires `premultipliedAlpha: true` for
  that blend mode — without it the draw silently overwrites and the overlap reads as "before",
  which is what the first render of this milestone showed. Crease outlines are depth-tested
  against a depth-only pass of both parts, so hidden creases stay hidden. One renderer for the
  app's lifetime.
- **The vision flag gates the app's own render**, not the user's attachments (§9's rule stands
  for those). A provider that cannot read an image would fail the turn *after* a compile the
  user waited for; the numeric half of the round goes to every model regardless.
- **Not built:** point 3's viewport toggle and cross-section — the composite thumbnail in the
  transcript is the user's before/after until someone asks for a section; and source-level
  origin-move detection — the report carries `bbox_min_shift_mm` and the message says what a
  non-zero value means.
- The `inspect` event's text (the report and questions) persists with the transcript; its image
  is live for its own turn only and stripped at the store boundary, exactly like a reference
  image. Earlier turns' inspections are dropped from the window, like their stderr (§12).

### Revised 2026-08-31: the model looks until it is done

The "one round per turn" and "no model-invoked tools" bullets above are superseded.

- **`render_view` is built, in-band.** A reply that is only a ```` ```view ```` block —
  `{"view", "section", "box"}`: point 4's arguments minus `fit`, plus a box, because the model
  has the report's numbers — is rendered by `capture.ts` (orthographic, shaded, a clipping-plane
  cut with the interior as flat back faces, uncapped) and appended as an `inspect` event; then
  the loop continues. Carried like `openscad-edit`, not as a tool call: the reasons the bullet
  above gave still hold. `measure()` needs no tool — the report rides every verification message.
- **Rounds are unbounded; Stop is the cap.** `TurnInput.looks` lets the model inspect, request
  views and correct as often as it likes; nothing asks the user mid-turn — an "N looks, keep
  going?" banner was built and removed the same day, because it stopped the chat. What the user
  gets instead is the phase: `deps.onPhase` reports "look 3 · rendering front view, cut at
  z = 12 mm", "repair 1 of 2 · compiling", and the chat shows it under the transcript while the
  turn runs. `looks: false` is thinking off — one call, compile repairs only, no verification
  round: the pre-M4 shape, and the default.
- **Thinking** is one setting: off, or OpenRouter's `reasoning.effort`. The looking clause of
  the system prompt and the view hint in `verifyMessage` are appended only when it is on, so an
  off session's prefix is byte-identical to v0.1's.
- Repairs reset per candidate (`attempt = 0` after a successful compile), or a turn of several
  looks would run out of them on its third correction.
- A reply without a full source — an edit, a part block, a view request — gets the source
  re-attached on the next call. Before, only edits did; a view-only reply would have left the
  model with nothing to edit.

### Revised 2026-08-31: per-part inspection

A debug report of an A320neo build shaped this revision: six rounds spent on `parts: 3`
with four wrong guesses at which body was extra, then a "add wheels" turn whose render was
the whole airplane in green and magenta because `z_ground` had moved it 4.6 mm.

- **Voids.** `meshStats` sorts shells into solids and voids by the sign of each shell's
  volume — inward faces enclose air. `parts` counts solids only; `partLabels` gives a void
  the label of the solid whose box holds it, so click-to-select numbering never sees one.
  The report carries `per_part` (box and volume per solid, in PART order) and `voids`. The
  A320's third "part" was the stand socket, a pocket cut entirely inside the belly fairing:
  a count could not name it, and the model guessed at the pylon, the nameplate and the
  stand arm instead.
- **App-graded checks.** `meshChecks` settles what the system prompt already demands —
  rests on Z=0 per part, solids against the PART sections (naming the smallest stray piece,
  or the fused pair), voids with their holder, watertight, genus and its change — and
  `verifyMessage` lists them as "Checks the app ran", says they are settled, and asks for
  questions about the *request*, at least one that only the render can answer. Corrections
  are asked for as `openscad-edit` first: the log resent 450 lines for each of five
  one-line fixes.
- **Rounds diff against the previous round**, not the turn's start (`inspect`'s `prior`):
  the first round measures against the part on screen, every later one against the round
  before it, so a correction's render shows the correction. A fresh document's first turn
  had no diff at all for six rounds.
- **Moves are cancelled per part** (`partMoves`, `translateParts`). Each solid is paired by
  index with the previous mesh's; the candidate translations are the shifts of the two
  boxes' corners; the one most vertices land exactly on wins, staying put wins ties, and a
  winner needs more than half. The previous solid is translated by it — and snapped onto
  the new mesh's exact float32 positions, because the kernel rounds its own move
  differently and a 1e-5 mm mismatch is a sliver the boolean keeps — before the booleans
  and the render. `per_part[i].moved_mm` carries the vector; `bbox_min_shift_mm` is gone.
  This is the known trap above solved on the mesh rather than the source: `z_ground = 17`
  moved the airplane through a variable that no diff of the PART section would show.
- **Slivers** — two compiles triangulating the same face differently — have no volume but
  a box as big as the face they lie on. The change box ignores diff shells under
  0.01 mm³; the volumes still count them. Verified on the kernel: a same-source diff is
  empty, and a lifted body with a wheel added diffs to the wheel alone.
- **A close-up pane.** When the largest changed piece is under half its part's size, the
  composite gets a second pane framed on that piece (lerp 0.1 toward the change box), from
  the side of its part it sits on — a wheel under a wing is seen from below. Both panes
  share one 1536×768 sheet, so the wire and the transcript still carry one image per
  round; the legend (`legendFor`) names the panes and the side, and rides with the render
  decision rather than the prompt.
- **Close-ups on offer, and the ideal rotation as an interface.** `changedPieces` lists every
  shell of the diff (slivers excluded), largest first, each with `idealView(box, host)` — the
  octant of its part the piece sits in, as a direction and a name ("front-right, below").
  The report carries them as `changed_pieces` (at most 8); the close-up pane shows piece 1;
  `Inspection.closeups` hands the consumer every piece with a `render()` for its composite
  close-up, and the verification message offers them. The view request grew two fields:
  `"closeup": N` renders piece N from the last report, and `"view": "auto"` lets the app
  pick the side for any box — `hostOf` finds the part the box sits on, `idealView` the
  side — so the model never has to guess a rotation from coordinates. `renderComposite`
  and `renderView` take a direction override for both.
- **Not built:** fonts — the wasm kernel ships none, so `text()` renders nothing (the log's
  engraved nameplate was byte-identical to its embossed predecessor); a follow-up.

---

### Review 2026-09-02

Defects found reading the harness, all fixed: the window headed the source "with your edits
applied" after an edit that had not applied (`compile.edit` marks a miss now); the prompt's
one example broke its own PART rule; kernel warnings on a successful compile reached nobody
(they go to the model before the report and to the user under the viewport); every live
inspect event carried its image, so a six-look turn sent 21 renders (only the newest rides);
no oscillation guard (a source compiled earlier in the turn is a confirmation or a repeated
failure); a length finish discarded a closed block; the first send could outrun the
catalogue and lose its render. Added: `pnpm eval` (`eval/turns.eval.ts`, the controller with
the Node kernel for compiles and diffs, no render — the numeric half every model gets); one
retry on 429/5xx/network before the stream; `max_tokens` from the catalogue; a cache
breakpoint on the system prompt for Anthropic models; one timeout diagnostic before failing;
indentation-forgiving edits; per-turn cost in the status line; overhang share per part and a
bed-size check (the bed is a setting). BOSL2 is not vendored: `scripts/fetch-bosl2.mjs` downloads it at a pinned
commit on install and before build, test and dev, and packs the 57 library files into
`kernel/vendor/BOSL2.zip` (1 MB, gitignored); `kernel/libraries.ts` unzips that into the kernel
FS when the source includes it — ~200 ms on top of a compile under Node.

## 7. State, time travel, persistence

**Split by growth.** `localStorage`: API key plus a few settings — chosen because it reads
synchronously at boot, *not* because it is safer. IndexedDB (`idb-keyval`): everything that grows
— versions, chat, image Blobs. Never base64 in the store; a few reference photos otherwise make
the whole thing multi-megabyte and janky, re-parsed on every rehydrate.

```ts
type Version = { id, parentId, ts, label, source, compileOk }
type Doc     = { id, name, source, versions: Version[], head, chat: ChatEvent[] }
```

`versions` is append-only, oldest first, and `head` points into it. `source` is the working copy —
what the editor holds — and differs from the head only by edits not yet committed. Version ids
are `'1'`, `'2'`, … in commit order, so the next one is minted without a uuid; `parentId` is the
head at commit time, which is what makes a linear list already be the tree.

**Restore moves `head`; it does not append a copy.** This section once specified copy-on-restore
to keep the list a total order and make losing work impossible. Moving the head does both —
nothing is ever removed, and `parentId` records where a commit made from an older head came
from — and it makes `/undo` repeatable: `v3 → v2 → v1`, where copy-on-restore oscillates between
the last two states. Edits made since the head and not yet committed are kept as a version of
their own before the head moves, for the same reason.

Commit a version on (a) an LLM turn that changed the source, labelled with the prompt; (b) an
explicit **Save version**; (c) a successful compile after manual editing. Not on every keystroke,
and not on every pause either: consecutive manual edits fold into one `edit` version until
something else — a turn, a save, a restore — intervenes, so the timeline reads as changes rather
than as typing. The keystroke-level history is the editor's own. `compileOk` is true only for a
source that was actually seen to compile; false means unverified, and the picker marks it.

Restoring source does *not* delete chat: after a bad turn you want to step back and then tell the
model what was wrong, with the failure still visible in the transcript. The transcript lives on
the document and is persisted with it; reference images are stripped at that boundary (§9), so
"never base64 in the store" holds with the log in the store.

Full snapshots, no diffing — source is a few KB of text, so 200 versions ≈ 1 MB.

**Eviction is the real risk, not quota.** WebKit deletes all script-writable storage after 7 days
without interaction, and every browser evicts an origin *whole* under pressure. So
`navigator.storage.persist()` at boot (check the boolean — it is silently denied when heuristics
are unmet, and the launcher says so when it is) and a first-class export are load-bearing, not
nice-to-haves.

**Project file** — one `.json`, not a zip, since source is the only ground truth and thumbnails
regenerate on import:

```json
{ "type": "vibe3d/project", "schemaVersion": 1,
  "name": "...", "source": "...", "head": "...", "versions": [...], "chat": [...] }
```

No `settings`: nothing in a document needs the host, and it is the field a key would hide in.
Never an `apiKey` field. The type system **cannot** enforce this: structural typing makes
`{baseUrl, model, apiKey}` assignable to a `PortableSettings` parameter, and a branded key type is
assignable to any `string` field, so the `SecretSettings` split this section once specified would
have been reassuring and inert. The mechanism is physical instead — the key lives in its own
module (`state/key.ts`) and its own localStorage record, no type in the app holds both, the
project-export path never imports it, and the export serialises five named fields rather than
spreading an object, so it cannot grow one by accident. One forgotten field otherwise turns
"share my project" into "share my key".
If `schemaVersion` exceeds ours, refuse with a specific error rather than best-effort parsing.
Below ours there is no migration table: `reviveDoc` *is* the migration — a row written before
versions existed becomes one `saved` version of its source, and an unreadable version is dropped
while its neighbours survive.

---

## 8. Export

Both formats come straight out of the kernel — a second `callMain` on a fresh instance:

- **STL** — `--export-format=binstl`, universal.
- **3MF** — `--export-format=3mf`, the default. Carries units, so it sidesteps the whole
  "object too small, scale to millimetres?" failure class STL invites.

Bambu Studio opens a plain core-spec 3MF; the cost is one dismissible dialog. We deliberately do
**not** synthesise a Bambu *project* 3MF: undocumented, ~592 printer-specific config options, a
rendered plate thumbnail, and only available as AGPL-3.0 source to transcribe. Every hour there
buys the removal of one checkbox.

**STEP was dropped.** OpenSCAD is a mesh kernel, so STEP could only ever be faceted — and for
printing it buys nothing: Bambu Studio tessellates STEP on import and cannot export it, and the
same part is 198 KB as 3MF versus 8.03 MB as faceted STEP.

### Colour (2026-08-31)

Colour is a print instruction: the prompt's COLOUR section asks for a `color()` on every
feature a second filament would print — lettering, logos, inlays, trim — and on each part when
there are several. The kernel already carries it: per-face colours reach the OFF through
`union()` and `difference()` (a cut face takes the cutter's colour, so colouring the cutter
colours an engraving), and the default 3MF export writes one `<basematerials>` entry per colour
with per-triangle `pid`/`p1` references. A kernel test pins that — and Bambu Studio ignores
it: what it and PrusaSlicer show is *painting*, an attribute per triangle naming a filament
slot (`paint_color` for Bambu, `slic3rpe:mmu_segmentation` for Prusa, the same value: the
TriangleSelector serialisation of an unsplit triangle in state n — "4", "8", "0C", "1C" …).
`export/threemf.ts` rewrites the kernel's model XML with both, the colour regions ranked by
surface area so the base is filament 1 and the lettering 2; the materials stay for everything
else that reads them, and a file with fewer than two colours passes through untouched. Which
filament a region gets is the slicer's choice — the export carries regions, not RGB, which is
what a multi-material print is. STL has no colour
standard, so `export/stl.ts` writes the binary STL itself from the OFF, with each facet's
colour in the attribute word the VisCAM/SolidView way (bit 15 valid, 5 bits per channel) —
MeshLab and most viewers read it, slicers ignore the word, an uncoloured reader sees a plain
STL. OBJ is written the same way (`export/obj.ts`): a material per colour in a sidecar MTL,
faces grouped under `usemtl`, each solid an `o part_N` group — the OBJ form PrusaSlicer and
Bambu Studio import as painting; "Export OBJ" downloads both files when the mesh is coloured,
and a plain OBJ alone when it is not. The kernel's OBJ writer is no longer used. The measured
report carries each part's colours by surface share (`per_part[i].colours`,
`partColourShares`), the parts listing names parts by them ("the gold lettering"), and one
check fires when the source has `text()` but no part carries two colours — the one colour
mistake the request's own words make certain enough to name.

### Shipped 2026-08-31: parts, components, OBJ, edits, selection, panes (M5)

Everything below was verified against the pinned kernel first, under Node with `wasmBinary`
(the web glue has no file reader), and `kernel.node.test.ts` keeps those checks: a compile is
~40 ms there, so it is a far cheaper oracle than Playwright for anything the kernel decides.

- **A part is a top-level statement.** Every compile runs with `--enable=lazy-union`, so
  top-level statements are no longer unioned: the OFF concatenates them (the viewport shows
  all of them, and `partCensus` counts them), and the 3MF carries one `<object>` and one
  `<item partnumber="Part N">` per statement, in source order, with `color()` as base
  materials — which is what a slicer wants. A single-statement source produces a byte-identical
  OFF with and without the flag, the "top level object is empty" exit that §6's diff booleans
  read is unchanged, and both examples are single-statement. STL and OBJ have no object notion
  and carry everything in one mesh. The system prompt's rule is now "one top-level call per
  part, side by side on Z=0, never overlapping" — two overlapping top-level statements would
  print as two bodies, so a solid's union belongs inside a module.
- **Components** are mesh files on the document — `Doc.components: {name, bytes, min, max}[]`
  — written into the kernel FS beside `/in.scad` on every preview, turn and export compile,
  so `import("bracket.stl")` just works. Bytes stay a `Uint8Array` in IndexedDB (structured
  clone) and become base64 only in the project file, which is written as `schemaVersion: 2`
  when it has any and `1` otherwise, so a v0.1 app still opens a file without them. Attaching
  is one compile of `import("name")` on a fresh kernel: the kernel's own error is the
  validation ("STL format not recognized"), and the resulting OFF is the measurement. The
  model gets the list after the source, each with its box, and is told to place a mesh by
  numbers (§5's rule again) and treat it as a solid. STL (ASCII and binary), OBJ, 3MF and OFF
  all import; a 2 MB STL takes ~150 ms. Names are checked against `COMPONENT_NAME` at revive —
  they are written into the FS and spliced into a string literal.
- **OBJ export** is `--export-format=obj`; no groups, one mesh. `/export obj` too.
- **Partial updates.** A reply may be one or more ```` ```openscad-edit ```` blocks, each
  `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, applied in order to the source the model
  was last shown; a search matches whole lines, exact or up to trailing whitespace, and must
  match exactly once. Content anchors rather than line ranges: models miscount lines, and this
  needs no numbered listing and no re-attachment on a full rewrite. A miss or a malformed block
  is a `compile` event with `ok: false`, so it takes the same wire path and the same repair
  budget as a kernel error, and three misses end the turn as an error with nothing committed.
  After an edit reply the applied source is attached again ("with your edits applied") for the
  repair and verification rounds — the model never wrote that file whole, and stderr line
  numbers point into it. `extractSource` steps over edit blocks, or an edit's closing fence
  would open a phantom source block.
- **Click a part.** A press that travels under 5 px is a click; the raycast's `faceIndex` is a
  triangle in both geometry layouts, `partLabels` (the union-find §6 already had) names its
  part, and the part's triangles get a translucent overlay sharing the model's position
  buffer. The chat shows the selection above the composer, and the message goes out headed by
  `[Selected part 2 of 3: 40 × 40 × 20 mm, from [60, 0, 0] to [100, 40, 20], colour #ff0000]`,
  which the system prompt explains. The model finds the part in the source by box and colour —
  no source↔mesh mapping to maintain. The selection is dropped with the mesh, since a
  recompile may renumber the parts.
- **Resizable panes**: `resize: horizontal` on the editor and chat panes over a
  `auto 1fr auto` grid — the platform's own grip. The chat pane is laid out `direction: rtl`
  (its children reset to `ltr`) so the grip sits on its inner corner, where there is room to
  drag. Widths are not persisted.

### Shipped 2026-08-31: PART sections and draw mode

- **PART sections.** The system prompt has the model wrap each part — the modules only it uses
  and its ONE top-level call — in `// ---- PART N ----` / `// ---- PART N END ----`, numbered in
  order, with parameters and shared helpers above the first marker, so viewport part N (statement
  order under the lazy union) is source PART N. The `[Selected part N …]` line now names a
  section, and the selection rule became "reply with an openscad-part block for it". A
  ```` ```openscad-part N ```` block replaces the lines between the markers (`parts.ts`); N one
  past the last appends, an empty body deletes and the rest renumber. The same fence takes a
  module name — ```` ```openscad-part lid ```` — and `moduleSpan` finds `module lid(` and
  brace-matches to its end (or to the `;` of a braceless one-statement module) on
  comment-stripped lines; the body must be the whole definition, the caption above it stays, an
  unknown name appends (modules are hoisted, so placement is free). Applied after edits, on the
  same wire path and repair budget. A last open marker with no END — models do leave one — is
  read as a section running to the end of the file, reported by the checks, and closed by the
  next replacement of it; `src/chat/fixtures/ferrari-tractor.scad` is such a file, kept as the
  test bed for module replacement inside real nesting. `checkParts` runs after every successful compile — a
  section with no top-level call, a call outside every section, a module nothing calls — noted
  in the chat and appended to the verification message as "Source checks". A comment-stripping
  line scanner that counts brackets, not a parser.
- **Construction geometry.** OpenSCAD's own mechanism, the `%` background modifier: the kernel
  drops such subtrees from every export (`kernel.node.test.ts` pins this — OFF volume, 3MF
  object count, and the empty-top-level exit for a construction-only file). The convention is
  one `// ---- CONSTRUCTION ----` section of `%` statements after the parts. `constructionSource`
  is the file minus its PART sections with the `%` unmasked; App compiles it on a third kernel
  (never sharing one with the part: `compile()` cancels), and the viewport draws the mesh as a
  translucent blue ghost — not picked, not framed, not measured — as does `renderView`, so the
  model's looks show the part against what it fits. `checkParts` flags a construction statement
  without `%`, the one mistake that would print.
- **Draw mode.** A 2D canvas over the WebGL canvas: `pointer-events` only while the mode is on,
  OrbitControls disabled for the same span, strokes kept in CSS px so a resize redraws them in
  place. ATTACH renders a frame and reads it in the same task (no `preserveDrawingBuffer`),
  composites the strokes, downsizes through `images.fit`, and hands a JPEG up App → Chat, where
  it is an attachment flagged `markup`: the message is headed
  `[Attached: the viewport with my markup in red]` and the image clause tells the model what the
  red is.

---

## 9. LLM client

One `fetch` to `https://openrouter.ai/api/v1/chat/completions` plus a 22-line hand-rolled SSE
reader. No OpenAI SDK, no Vercel AI SDK — roughly 100 lines, and it avoids shipping an SDK whose
browser mode is explicitly named "dangerous". This section once specified `eventsource-parser`;
it was dropped after measurement, because that library consumes *strings*, so the one genuinely
hard trap — multi-byte UTF-8 torn across a chunk boundary — is solved by the native
`TextDecoderStream` both options must call anyway, leaving the dependency selling ~8 lines of
line-splitting in the one module that handles the user's API key. This section's own
"keeping dependencies few" ruling below already argued against its opening sentence.

Verified live: OpenRouter answers CORS preflight with `Access-Control-Allow-Origin: *` and
allow-lists `Authorization`, `HTTP-Referer` and both `X-Title` and `X-OpenRouter-Title` (preflight
verified 2026-08-31). `GET /api/v1/models` needs **no auth**, so
the model dropdown, vision filter and pricing all come from one unauthenticated request — the user
can browse models before entering a key.

**Auth: OAuth PKCE as the primary path**, paste-a-key as fallback. The user mints a revocable
per-app key instead of handing over their account key. (The app cannot set a spend cap on it —
that is a manual step in the user's OpenRouter settings.) **Correction, verified live:** PKCE
does *not* need an HTTPS callback — a `http://localhost` callback on any port is accepted, so the
flow works against `pnpm dev`. Paste-a-key stays permanently, for different reasons: offline
development, a key the user already has, a failed exchange, and a non-secure origin such as a LAN
IP, where `crypto.subtle` is undefined and PKCE cannot run at all.

Model returns source in a **fenced code block**, not `json_schema`: it works on every model, it
streams straight into the editor for live preview, and it avoids escaping source through JSON.
Only 194 of 396 models support both vision and structured outputs, and support is per-*provider*
while OpenRouter load-balances providers. This once argued for `provider: {require_parameters:
true}`; **that is now obsolete** — default routing already applies a soft provider preference for
`tools` / `response_format` / structured outputs, and setting the flag can only narrow routing to
a 503, which reads to a user as a broken app. Milestone 2 sends `{model, messages, stream}` and
nothing else.

Images: downscale to ≤1568 px longest edge, JPEG q0.85, `image_url` with a `data:` URL. One
normalization path that satisfies every upstream.

### Reference images

A user-attached reference image is **input**, not the vision-refine loop of §6 or §12's
"naive vision feedback" risk. §6's −20% compile-rate finding and its non-negotiable
structured-verification rule are about the app screenshotting its own mesh and feeding that
render back to the model for correction — Milestone 4's loop. A photo the user pastes
or picks before typing a prompt is not that: nothing renders it back, and no verification-question
protocol applies to it. Nothing in this work implements or presumes §6.

Paste or file picker, up to 4 images per message, normalised once at attach time to the
≤1568 px JPEG `data:` URL above — the one path this section already specifies, not a second one.
They travel as `{type:'image_url', image_url:{url}}` content parts, with the text part always
first: OpenRouter's own recommendation, and reversing it degrades the answer without erroring.

**Live for their own turn only**, including that turn's repair attempts and its verification
round (§6); every later turn degrades
to plain text. That is what keeps §12's unbounded-context risk from applying here — the images
never accumulate. `runCompact` strips them explicitly, because its caller closes over the turn
that just ran (so that turn's user event is still "live" when compaction sees it) and auto-compact
fires unattended at 60% of context, where nobody is present to notice a re-billed image.

**Never persisted.** The transcript is (§7); the images in it are not. `stripImages` runs at the
boundary into the session, so a reload or a document switch brings the conversation back without
its pictures, and §7's "never base64 in the store" holds with the log in the store.

The catalogue's vision flag (`architecture.input_modalities`) is **a hint, not a gate**: nothing
is filtered, hidden or disabled on it, because support is per-provider while OpenRouter
load-balances providers.

Config stays `{baseUrl, apiKey, model}` — the OpenAI-compatible shape — but in the built artifact
only OpenRouter can actually be reached: the CSP's `connect-src` allowlist (§11) is the one cheap
structural defence for the key, and it forbids every other host by design. Another host means
another allowlist entry, decided per host, not a provider abstraction layer.

**Key handling.** The key is XSS-extractable from any browser storage — that is inherent, not a
storage-choice bug. The only cheap structural defense is a strict CSP with an explicit
`connect-src` allowlist, plus keeping dependencies few. No in-bundle encryption; it is theater.
Tell the user in one sentence where the key lives and that it is revocable.

---

## 10. Chat commands

The session is an **append-only event log with a derived send-window**. Commands change the
window, never the log — which is what keeps the transcript and the version timeline from
desyncing.

| Command | Behaviour |
|---|---|
| `/clear` | New send-window at head. Source and version timeline untouched — "new conversation about the same model". |
| `/compact` | One cheap call summarising the transcript, then window := [system, summary, last 2 turns, current source]. **Never summarise the source** — re-attach it verbatim; it is ground truth and cheap. Auto-fires at ~60% of context. |
| `/undo` | Steps the head to the previous version — the same operation as the version picker, implemented once (§7). The window is not truncated: the current source is re-attached verbatim on every turn, so the model sees the truth either way, and the transcript keeps the failed turn visible. |
| `/export` | Pure client action. No LLM call, no history entry. |
| `/model`, `/key` | Switch model / re-enter key. |
| `/think` | `off` is one call per message; `low`, `medium`, `high` set `reasoning.effort` and let the model look, request views and correct until satisfied (§6, revised). Without an argument, opens the settings. |

`/compact` rewrites the message array and so invalidates OpenRouter's prompt cache. Cheap, not
free — don't rewrite history every turn.

---

## 11. Build, host, test

```ts
// vite.config.ts
export default defineConfig({
  base: './',                    // deploy-anywhere; no host-specific build
  worker: { format: 'es' },
})
```

Vite 8 + `@vitejs/plugin-react` + React 19 + TypeScript, on pnpm. No `vite-plugin-wasm`, no
`vite-plugin-top-level-await`, no `manualChunks` — Vite 8 handles all of it natively.

**Do not enable cross-origin isolation.** The kernel is single-threaded (0 `SharedArrayBuffer`
references), so COOP/COEP buys nothing and would cost remote-asset freedom. GitHub Pages already
serves `application/wasm` correctly, so streaming compile works.

Budget: ~320 KB gz first paint (shell + three + editor), then 3.1 MB gz of wasm on first compile.

Testing — the minimum that catches real breakage:

1. **Vitest, node env** — OFF parser, param extraction, history/restore, project-file migration.
   Pure functions, fast. Plus `kernel.node.test.ts`: the real wasm, instantiated with
   `wasmBinary`, for what the kernel decides (formats, imports, the lazy union).
2. **One jsdom test** round-tripping our 3MF through three's `3MFLoader`. (three ships a 3MF
   *loader* but no exporter, so the loader is a free independent oracle.) Lower priority now that
   the kernel writes the 3MF, but still the cheapest proof it is loadable.
3. **One Playwright smoke test** against `vite preview` of the real `dist/`: load, compile, assert
   a mesh appears and the STL download fires. This is the only test that sees base-path, worker
   bundling and wasm-URL regressions — precisely the bugs this stack produces. Pin an uncommon port
   with `--strictPort` and leave `reuseExistingServer` off: Vite's default 4173 is frequently
   already in use, and a silent fallback means testing a different application entirely.

Skip component tests and Vitest browser mode at MVP.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Unbounded context.** Full source every turn + a render sheet per iteration ≈ 80k tokens of mostly-dead content over 10 revisions. | Stub superseded sources out of history; keep only the current one verbatim. Implemented in `chat/log.ts`'s `buildWindow`, which stubs the fenced block of every assistant message except the current turn's, drops earlier turns' compile diagnostics entirely, and appends the source exactly once. This is the default failure of this architecture. |
| **Naive vision feedback is a measured regression** (−20% compile rate). | Structured verification questions, always. Never ship the bare "does this look right" formulation. |
| **Over-trusting the VLM.** IoU 0.07–0.09 will confidently ship wrong dimensions. | Deterministic checks gate completion, not the model's opinion. |
| **Non-manifold geometry that compiles fine.** OpenSCAD warns rather than fails; preview can look right while Bambu rejects it. | Printability gate is a post-export mesh check, not a compiler check. |
| **Losing stderr across the Worker boundary.** | Explicitly carry `stdErr` through `postMessage`; test it. |
| **Safari's 7-day eviction.** Returning user finds an empty app, no error. | `navigator.storage.persist()`, prominent export, honest durability copy. |
| **Storage-version footgun.** A shape change silently discards state. | No version number on the IndexedDB record: `reviveDoc` is the migration, tested against the pre-version shape. The project file carries `schemaVersion` and refuses a newer one by name. |
| **Loop behaviour is model-specific** and the user picks the model. | The controller imposes the budget; evals run per model. |

---

## 13. Open questions

- **Which snapshot to pin.** `2026-08-30` is verified working. Snapshots are nightly and the URL
  is not permanent — vendor the `.wasm` into the repo, or mirror it.
- ~~**Retry budget.**~~ **Resolved by measurement** — see §5. 30/30 parts compiled first try, so the
  2-retry budget is right but will rarely fire. Effort moves to the verification rounds.
- **Ambiguity handling.** The bake-off's real finding: models produce valid code of the wrong shape
  when the request is under-specified. Worth testing whether the system prompt should push the model
  to *state its interpretation* of ambiguous dimensions before building, so the user can correct it
  cheaply instead of after a 13-second compile.
- **Render style has no published ablation.** The 4–8 canonical-view convention is convergent
  practice, not evidence. Worth one internal A/B once there is a working loop. Model-requested
  views are in (§6, revised) — the loop exists; the A/B still does not.

---

## 14. Review 2026-08-31

The stage review that closed Milestone 3 found two runtime defects, both fixed: a turn survived a
document switch and committed into whichever document was current when it finished (the chat pane
now aborts its turn on unmount), and a preview compile still in flight could land after a turn's
commit and put a stale mesh under the new source (the commit cancels the preview). It also found
this document describing an M3 that had not been built — the automatic timeline, the persisted
transcript, the project file and `/undo` — which is what
`docs/superpowers/plans/2026-08-31-milestone-3-versions.md` then built.

Found in use after Milestone 4, both on opening a document from the launcher: the viewport kept
the previously current document's mesh until the new compile landed — seconds on a cold
kernel, forever when the new source did not compile — because nothing cleared it on a switch
(the compile effect now resets the on-screen state and its identity guard when the document
id changes); and the editor was mounted once for the app's lifetime, so a switch was a
transaction in CodeMirror's undo history — two undos after opening a document put the
boot-time starter plate into it, committed and compiled (the editor is now keyed by document
id, like the chat pane, and remounts with fresh history). One e2e test covers both.

---

## Appendix: evidence

Claims here were produced by parallel research agents and then adversarially fact-checked by
independent agents; the fact-check caught fabricated benchmark rows, wrong API signatures, and a
false claim about zustand's persist middleware. Numbers cited as *measured* were executed locally
on 2026-08-30 (Node 24.15.0, darwin arm64) — the kernel export matrix, the wasm payload sizes, the
`SharedArrayBuffer` greps, the 3MF structure, and the JSCAD-vs-manifold boolean benchmark.

Published sources leaned on: CADCodeVerify / CADPrompt (ICLR 2025) for numeric-vs-image feedback
and compile rates; P3D-Bench for format comparison and multi-turn behaviour; Text2CAD-Bench for
the bespoke-grammar ablation; IR3D-Bench for VLM geometric-reasoning limits; SIRI-Bench for
text-vs-pixel dimensions; "VLMs are Blind" (ACCV 2024) for resolution flatness.
