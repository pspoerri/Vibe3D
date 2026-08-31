# Change inspection (Milestone 4) — design

Date: 2026-08-31. Source of truth for the requirement: `docs/design.md` §5 ("vision-refine
rounds are Milestone 4") and §6. This document records what M4 builds, and where it takes a
different shape from §6's text, why.

## Goal

After a turn's source compiles, the model checks its own work against **numbers first and one
picture second**, and gets one chance to correct itself before the turn commits. The
controller decides when this happens and how often; the model never does (§5). Every image
reaches the model wrapped in structured verification (§6.5) — the bare "does this look right"
is the measured −20% regression and is never sent.

## What the model receives

One `user` message after a successful compile, made of two parts:

1. **The measured report** — always, ~200 tokens, JSON:

   ```json
   { "model_bbox_mm": {"min":[0,0,0],"max":[60,40,3],"size":[60,40,3]},
     "volume_mm3": 7012.3, "watertight": true, "parts": 1, "genus": 4, "tri_count": 412,
     "was": {"bbox_mm":{...},"volume_mm3":7200,"parts":1,"genus":0,"tri_count":12},
     "changed_bbox_mm": {"min":[5,5,-1],"max":[55,35,4]},
     "added_volume_mm3": 0, "removed_volume_mm3": 187.7,
     "bbox_min_shift_mm": [0,0,0] }
   ```

   `was` and the three diff fields are `null` on a first generation (nothing on screen) and
   when the diff could not be computed. `bbox_min_shift_mm` is the origin-move trap of §6
   made visible as a number: when the whole part moved, the diff volumes are meaningless and
   the model is told so in the prose that follows the JSON.

2. **One 768×768 composite render** — only when the catalogue flags the model as
   vision-capable. Orthographic, the iso direction, +Z up, white background. The previous
   mesh in green and the new one in magenta, `MultiplyBlending`, `depthWrite: false`, so
   unchanged material multiplies to grey and added / removed material keeps its colour.
   A sparse crease outline (`EdgesGeometry`, 30°) on both — never a wireframe. Framed on
   `lerp(changeBox, modelBox, 0.25)` so the changed detail and the body it fused into are in
   frame together.

Then the verification instruction (`VERIFY_PROMPT`): write 2–5 yes/no questions the request
implies, answer each Yes / No / Unclear with one line of reasoning from the numbers or the
render, read every dimension from the report and never from the picture; if any answer is No,
reply with the corrected complete source in one fenced block, otherwise reply in one sentence
with no code block.

## The loop

```
stream → extract → compile
  error   → repair, MAX_RETRIES = 2 (unchanged)
  ok      → verified := {source, result}
            if no verification round has run yet:
              inspect → emit 'inspect' event → stream again (one more call)
                no fence            → commit verified
                same source         → commit verified
                new source          → compile; ok → commit it; repair budget shared;
                                      unrepairable → commit verified + note
            else → commit
```

`MAX_VERIFY = 1`: the model gets one look. A correction is compiled and committed without a
second look — the cheap half of §5's finding that later rounds inject bugs.

**Settle rule:** once a candidate has compiled, the turn commits it unless a later candidate
compiles. A stop during verification, a truncated correction, a stream error after the
compile — all return `committed` with the verified source, so the user never waits 20 seconds
for a compile and then loses it to a step they interrupted.

LLM calls per turn: at most 1 + 2 repairs + 1 verification = 4. Compiles per turn: at most 3
plus the two diff booleans.

## Deviations from §6, and why

| §6 says | M4 does | Why |
|---|---|---|
| Two tools, `render_view` and `measure`, the model calls them | The controller pushes one report and one render; no tool-calling protocol | Tool support on OpenRouter is per-model and the user picks any model; an image inside a tool result is the least portable part of the OpenAI-compatible surface; and the render + numbers is the evidence-backed core — §13 records that additional views have no ablation. Model-requested views (`view`, `fit`, `section`) wait for an A/B that shows the fixed iso composite is not enough. |
| The viewport toggle: added-green / removed-red meshes over grey, capped cross-section, auto-suggested | Not built | The composite thumbnail sits in the transcript, click to see it full size; that is the user's before/after. A clipping plane with capping is a viewport feature of its own, added when someone asks for a section. |
| Detect an origin move in the source | Report `bbox_min_shift_mm` and say what it means | A source-level detector is an OpenSCAD parser; the number plus one sentence gives the model the same information. |
| The vision flag is "a hint, not a gate" | It gates the app's own render, not the user's attachments | §9's rule protects what the user chose to attach. Here the app decides whether to spend an image on every turn, and a provider that cannot read it 400s the turn *after* a compile the user waited for. Text-only verification is still the more valuable half (§5: only volume told right from wrong). |

## Components

| File | Change |
|---|---|
| `kernel/protocol.ts`, `openscad.worker.ts`, `compile.ts` | `files?: Record<string, Uint8Array>` written to the kernel FS before `callMain` — what makes `import("old.off")` possible. |
| `kernel/stats.ts` | `+ parts` (connected components over shared vertices), `+ genus` (Euler: `(2·parts − (V − E + F)) / 2`, `null` when not watertight). |
| `viewer/inspect.ts` | `inspect({before, after, vision, signal})` → `{text, image?}`. Diff: two compiles in parallel, `difference(){ import("new.off"); import("old.off"); }` and the reverse, on the kernel already loaded (§6: no new dependency). Exit 1 with "top level object is empty" is an empty diff (volume 0); any other failure is `null`. Pure, tested helpers: `changeBox`, `frameBox`, `buildReport`, `formatReport`, `diffSource`. |
| `viewer/capture.ts` | `renderComposite(before, after, frame)` → JPEG data URL. One lazily created 768² renderer with `preserveDrawingBuffer`, kept for the app's lifetime. Returns `null` when WebGL is unavailable; the round proceeds text-only. |
| `chat/prompt.ts` | `VERIFY_PROMPT`, and the legend sentence for the render. |
| `chat/log.ts` | `inspect` event `{text, image?}`. Live turn → one `user` message, text first, then the image (the reference-image path, not a second one). Non-live turns → dropped, like compile stderr (§12). `stripImages` and `reviveLog` cover it: the image is never persisted. |
| `chat/controller.ts` | `deps.inspect` (optional: absent means no round, which is what the existing tests exercise) and the loop above. |
| `chat/Chat.tsx` | Builds `inspect` from the `before` prop and the catalogue's vision flag; renders the event as an `inspected` chip with the thumbnail and a `<details>` holding the report. |
| `App.tsx` | Keeps the OFF bytes of the mesh on screen (`beforeRef`, set only by define-free compiles and turn commits) and passes them to `Chat`. |
| `index.css`, `docs/design.md`, `README.md` | Chip styling; status line, §4 file map, §6 "what shipped"; README one line. |

Kernel facts this leans on, verified 2026-08-31 in node against the pinned wasm:
`import()` of the kernel's own OFF works on the Manifold backend (rc 0, valid OFF out, 9 ms
for a small part); an empty `difference()` exits 1 with `Current top level object is empty.`

## Testing

- **Vitest**: `stats` — parts and genus on one box, two boxes, and a coarse procedural torus
  (genus 1); `inspect` — `changeBox` / `frameBox` on boxes, `buildReport` with and without a
  `before`, empty-diff and failed-diff handling via a scripted compile; `log` — the inspect
  event on the wire for the live turn only, image stripped for persistence, revived from a
  project file; `controller` — confirm / correct / stop-during-verification / no-inspect-dep.
- **Playwright**: one test that the second chat call carries the report text and a
  `data:image/jpeg` part and that "Looks right." commits the compiled part; one that a
  corrected source is compiled and committed. Both against the built artifact — `capture.ts`
  is the only WebGL code outside the viewport and no node test can see it.
