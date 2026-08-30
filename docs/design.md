# ai-modeller — design

A browser-only 3D modelling tool where an LLM writes and edits OpenSCAD source, you see the
result in 3D, and everything — state, history, API key — lives in your browser. Static site,
no backend, bring your own API key.

Status: **Milestone 1 shipped** (kernel, viewport, editor, export). Milestone 2 in progress
(agent loop, OpenRouter client, Customizer sliders). Milestones 3–4 not started.
Plans: `docs/superpowers/plans/`.
Date: 2026-08-30. License: **GPL-3.0**.

---

## 1. What it is

A chat window, a 3D viewport, and a source editor over one OpenSCAD document.

- You describe a part. The model writes OpenSCAD. The browser compiles it and shows the mesh.
- You can edit the source directly, or drag sliders derived from the source's own parameters.
- Every change is a version you can step back to.
- Export STL or 3MF for Bambu Studio.

Explicit non-goals: assemblies, organic shapes (faces, terrain, soft curves), and multi-user
anything. Even frontier models reach only ~0.5 part-matching F1 on assemblies; promising that
would be promising a thing that does not work.

---

## 2. Decisions

Each row is a decision that was actually contested, with the evidence that settled it.

| Decision | Choice | Why |
|---|---|---|
| Modelling language | **OpenSCAD** | ~25× the public corpus of any alternative (7,141 repos vs 286 for JSCAD, keyword-matched). P3D-Bench rates it the strongest of four code formats for LLM 3D generation. Three shipping LLM+OpenSCAD products already exist. |
| Kernel | **openscad-wasm, official snapshot** | Pinned from `files.openscad.org`, not npm. See §3. |
| Renderer | **three.js (WebGL 2)** | ~134 KB gz buys orbit controls, `EdgesGeometry`, offscreen render targets, multi-view capture. |
| Editor | **CodeMirror 6** | 121 KB gz vs Monaco's 1.24 MB. Neither ships an OpenSCAD mode, so Monaco's ecosystem edge evaporates exactly where we'd need it. ~40-line `StreamLanguage` parser. |
| Export | **STL + 3MF, both native** | The kernel emits both. No serializer to write. STEP dropped — see §8. |
| LLM host | **OpenRouter only for v1** | Verified browser-callable. Hand-rolled client, no SDK. |
| Edit protocol | **Full source rewrite per turn** | A diff applier is a new silent-failure surface for a single-file artifact. Every reference implementation in this space uses whole-file. Revisit only if measured latency hurts. |
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

### Compile path

```
FS.writeFile('/in.scad', source)
  → callMain(['/in.scad','-o','/out.off','--export-format=off'])
  → FS.readFile('/out.off')  → parse → THREE.BufferGeometry
```

OFF rather than STL: indexed (so smaller), and it carries per-face colour indices if we ever
want multi-material.

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
    protocol.ts          worker message types, incl. -D defines
    openscad.worker.ts   fresh Worker per compile; terminate() to cancel
    compile.ts           Compiler — worker lifecycle, cancel, timeout
    off.ts               OFF → Mesh
    stats.ts             bbox, volume, tri count, watertightness
    noise.ts             stripKernelNoise (display) + stderrForModel (model)
  viewer/
    Viewport.tsx         WebGLRenderer, OrbitControls, adaptive grid
    camera.ts            pure fit / grid-spacing / standard-view maths
    ViewCube.ts          orientation widget
    capture.ts           M4 — 2nd offscreen renderer, 768², ortho
    inspect.ts           M4 — change inspection (§6)
  llm/
    sse.ts               SSE reader (hand-rolled, see below)
    openrouter.ts        streamChat, model catalogue, error normalisation
    auth.ts              OAuth PKCE
  chat/
    controller.ts        runTurn / runCompact — the deterministic loop (§5)
    log.ts               append-only ChatEvent[] + buildWindow (§10)
    fence.ts             fenced-source extraction, fence stubbing
    prompt.ts            system prompt
    commands.ts          /clear /compact /export /model /key
    Chat.tsx             the chat pane
  editor/
    Editor.tsx           CodeMirror 6 + StreamLanguage OpenSCAD mode
    openscad-mode.ts     the StreamLanguage tokenizer
    params.ts            Customizer annotations → sliders
    Params.tsx           the slider strip
  state/
    settings.ts          localStorage: baseUrl, model
    key.ts               localStorage: the API key, ALONE (see §7)
    project.ts           M3 — versions + chat, IndexedDB
  export/download.ts     bytes → file download
```

**No state library.** §2 once implied `zustand`; plain React state carries Milestone 2, and a
store is Milestone 3's problem, when a persisted version timeline gives it something to own.

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
      ok    → deterministic checks → answer
              (vision-refine rounds are Milestone 4, not Milestone 2)
  hard cap ~8 tool calls per user turn
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

---

## 7. State, time travel, persistence

**Split by growth.** `localStorage`: API key plus a few settings — chosen because it reads
synchronously at boot, *not* because it is safer. IndexedDB (`idb-keyval`): everything that grows
— versions, chat, image Blobs. Never base64 in the store; a few reference photos otherwise make
the whole thing multi-megabyte and janky, re-parsed on every rehydrate.

```ts
type Version = { id, parentId, ts, label, source, compileOk }
```

Append-only, plus a `head` pointer. **Restore appends a copy rather than truncating** — it makes
losing work structurally impossible and keeps the list a total order. Restoring source does *not*
delete chat: after a bad turn you want to step back and then tell the model what was wrong, with
the failure still visible in the transcript.

Commit a version on (a) an LLM turn that changed the source, (b) an explicit save, (c) a debounced
successful compile after manual editing. Not on every keystroke.

Full snapshots, no diffing — source is a few KB of text, so 200 versions ≈ 1 MB.

**Eviction is the real risk, not quota.** WebKit deletes all script-writable storage after 7 days
without interaction, and every browser evicts an origin *whole* under pressure. So
`navigator.storage.persist()` at boot (check the boolean — it is silently denied when heuristics
are unmet) and a first-class export are load-bearing, not nice-to-haves.

**Project file** — one `.json`, not a zip, since source is the only ground truth and thumbnails
regenerate on import:

```json
{ "type": "aimodeller/project", "schemaVersion": 1,
  "name": "...", "head": "...", "versions": [...], "chat": [...], "settings": {...} }
```

Never an `apiKey` field. The type system **cannot** enforce this: structural typing makes
`{baseUrl, model, apiKey}` assignable to a `PortableSettings` parameter, and a branded key type is
assignable to any `string` field, so the `SecretSettings` split this section once specified would
have been reassuring and inert. The mechanism is physical instead — the key lives in its own
module (`state/key.ts`) and its own localStorage record, no type in the app holds both, and the
project-export path never imports it. One forgotten field otherwise turns "share my project" into
"share my key".
If `schemaVersion` exceeds ours, refuse with a specific error rather than best-effort parsing.

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
allow-lists `Authorization`, `HTTP-Referer`, `X-Title`. `GET /api/v1/models` needs **no auth**, so
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

Config stays `{baseUrl, apiKey, model}` so OpenAI, Groq, Mistral, DeepSeek and Gemini's compat
endpoint work unchanged — but no provider abstraction layer is built for a v1 with one host.
Anthropic-direct needs a special header and local Ollama needs the *user* to change a server
setting; neither earns its complexity yet.

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
| `/undo` | Step to the previous version, truncate the window. Same operation as clicking a node in the time-travel UI — implement once. |
| `/export` | Pure client action. No LLM call, no history entry. |
| `/model`, `/key` | Switch model / re-enter key. |

`/compact` and `/undo` rewrite the message array and so invalidate OpenRouter's prompt cache.
Cheap, not free — don't rewrite history every turn.

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
   Pure functions, fast.
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
| **Storage-version footgun.** Bumping `persist` version without a `migrate` silently discards state. | `migrate` stub on day one plus a test that loads a v1 blob. |
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
  practice, not evidence. Worth one internal A/B once there is a working loop.

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
