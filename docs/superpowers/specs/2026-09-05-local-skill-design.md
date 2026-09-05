# Local skill — design

Date: 2026-09-05. The app's loop — describe, write OpenSCAD, compile, measure, look, correct,
export — as a Claude Code skill, so a model running on the user's machine (Claude Code, or
anything that reads a `SKILL.md` and runs a shell command) can drive it without the browser or
an OpenRouter key.

## Goal

A directory that installs by copying it anywhere — sandboxes included — and gives the local
model the same evidence the app gives the hosted one: the measured report and the app's checks after every compile, the
green-over-magenta diff and named views on request, and a 3MF, STL or OBJ at the end. The
modelling rules come from the app's own system prompt so they never fork.

## Layout

Source, in the repo:

```
skills/vibe3d/
  SKILL.md       the workflow the model follows
  vibe3d         bash wrapper: exec bun "$(dirname "$0")"/cli.[jt]s "$@" — cli.js built, cli.ts in the tree
  cli.ts         the commands
  look.ts        browser entry: window.vibe3dLook(...) draws one render into the page
  cli.test.ts    real-kernel tests
```

Built, by `pnpm build:skill` (`scripts/build-skill.mjs`), into `dist/skill/`:

```
dist/skill/
  SKILL.md, vibe3d          copied
  cli.js                    bun build cli.ts --target=bun: one file, node_modules inlined
  look.js                   bun build look.ts --target=browser --format=iife: three.js inlined
  vendor/openscad.wasm      the kernel
  vendor/BOSL2.zip          the library
  vendor/fonts/*.ttf        the Liberation family
```

Install is a copy of that directory to wherever skills live — `cp -r dist/skill
~/.claude/skills/vibe3d`, or into a sandbox — and nothing in it refers back to the repo. The
runtime is Bun (`brew install oven-sh/bun/bun`; the sandboxes have it), which the wrapper
calls; no `node_modules` are needed. `cli.ts` finds its assets in `vendor/` beside itself and,
when that is absent, in `../../src/kernel/vendor/` — so the same file runs unbuilt from the
source tree, which is what the tests do. Verified 2026-09-05 with Bun 1.4.0: the bundled CLI
runs from a bare copied directory, the Emscripten kernel compiles in ~0.25 s.

## Commands

All take a `.scad` path. Files named by `import("name.ext")` in the source are read from the
`.scad` file's directory and handed to the kernel, as desktop OpenSCAD would. Fonts and BOSL2
are installed when the source uses them, as in the app (`eval/kernel.ts`).

**`vibe3d check part.scad [--before prev.scad] [--bed 256,256,256]`**
Compiles to OFF and prints to stdout what `verifyMessage` gives the hosted model, minus the
question ritual (that lives in `SKILL.md`):

```
The source compiled. Measured from the mesh (millimetres, mm³):
{ ...formatReport(report)... }
Checks the app ran:
- rests on Z=0: yes
- fits the bed: yes
- solids: 2 for 2 PART sections: ok
- ...
Notes on the source:              (only when checkParts finds something)
- ...
```

`--before` compiles the previous source too and runs the same `inspect` diff the app runs
(two kernel booleans, part moves taken out), so `was`, the diff volumes and `changed_pieces`
are filled. `--bed` defaults to the app's `DEFAULT_BED`. A failed compile prints the kernel's
cleaned stderr (`stripKernelNoise`) and exits 1; an unusable source (empty, missing file) is
also exit 1 with one line. Exit 0 whenever it compiled, even with checks marked NO — the model
reads them.

**`vibe3d export part.scad out.3mf|out.stl|out.obj [--part N]`**
The format is the output extension. 3MF is the kernel's own, painted by `paint3mf` (one object
per part, colours as materials); STL and OBJ are the app's encoders over the OFF mesh. `--part`
exports one part alone via `part3mf` / `partMesh`. OBJ writes its `.mtl` beside the `.obj` when
the mesh has colour. Exit 1 on a compile failure, with the diagnostics.

**`vibe3d look part.scad out.png [--view V] [--cut z=12] [--box x0,y0,z0,x1,y1,z1] [--before prev.scad]`**
Renders through the app's `capture.ts`, in headless Chrome:

- Without `--before`: `renderView` — a shaded view from `V` (`iso`, `iso_back`, `front`,
  `back`, `left`, `right`, `top`, `bottom`, `auto`; default `iso`), an optional cut, an
  optional frame box. `auto` looks from `idealView` of the box (or the part), as `Chat.tsx`
  does. The CONSTRUCTION section, compiled on its own by `constructionSource`, is the ghost.
- With `--before`: the same inspection as `check --before`, then `renderComposite` of the
  aligned before (green) over after (magenta), framed by `frameBox`, with the close-up pane
  when `detailOf` chooses one. `--view` etc. are ignored in this mode.

The CLI does the geometry (compile, inspect, frame, direction) and writes one temporary HTML
page: `look.js` inline, then a script that calls `window.vibe3dLook(job)` with the OFF texts
and the render parameters as JSON; `look.ts` parses the meshes, calls the render function and
appends the resulting image to the body. Chrome is run as

    chrome --headless=new --no-sandbox --user-data-dir=<tmp> --no-first-run --hide-scrollbars
           --use-angle=swiftshader --enable-unsafe-swiftshader
           --window-size=768,768 --screenshot=out.png file://…/look.html

(1536 × 768 when the composite has a close-up pane). The CLI polls for the output file, up to
30 s, then kills Chrome: verified 2026-09-05 that the screenshot lands in ~3 s and that the
process does not exit on its own under a sandbox. Chrome is found, in order, at
`$VIBE3D_CHROME`, then on PATH as `google-chrome`, `google-chrome-stable`, `chromium`,
`chromium-browser`, `chrome`, then the macOS app paths of Google Chrome and Chromium. None
found: exit 1 with one line naming `VIBE3D_CHROME`; `check` and `export` never need it.

**`vibe3d prompt`**
Prints the app's `SYSTEM_PROMPT` followed by the rendered `bosl2`, `fonts` and `diff` skills
(`renderSkill` with no mesh), each under a heading. A one-line preface says that the OUTPUT
CONTRACT, SELECTION and SKILLS sections are the browser app's chat protocol and do not apply
here: the local model writes the `.scad` file directly and the skills are already printed.
`SKILL.md` tells the model to read it once per session, so the modelling rules in this skill
are always the app's current ones.

## SKILL.md

Short: what the skill is for, that every command is `<this skill's directory>/vibe3d …` (the
harness names the directory when it loads the skill), then the loop —

1. Run `vibe3d prompt` once and write the source to a `.scad` file by its rules (title line,
   parameters, PART sections, construction, colour).
2. `vibe3d check`; fix every check marked NO and every note before anything else.
3. Ask the request's own 2–5 yes/no questions against the report; `vibe3d look` when a number
   cannot answer one, `--before` against the previous file after a change.
4. Iterate by editing the file; keep the previous version for `--before`.
5. `vibe3d export` to 3MF for the slicer (STL or OBJ when asked).

Plus a one-line note that dimensions are read from the report, never from a picture — the
app's rule, restated where the local model will see it.

## Tests

`skills/vibe3d/cli.test.ts`, run by `pnpm test` with the rest under vitest, against the
exported `run(argv)` from the source tree (real kernel, ~0.5 s a compile):

- `check` on a two-PART source prints `solids: 2 for 2 PART sections: ok` and a report whose
  `parts` is 2; with `--before` on a grown part, `added_volume_mm3` is positive.
- `check` on a source with a syntax error exits 1 and prints the kernel's line.
- `export` to 3MF yields two `<object` entries; `--part 2` yields one.
- `look` writes a PNG of 768 × 768 (the IHDR says so), and 1536 × 768 for a `--before` render
  that has a close-up; skipped with a message when no Chrome is found, and skipped when `bun`
  is absent, since the source-tree render path builds `look.js` with it.
- `pnpm build:skill` then `bun dist/skill/cli.js check` from a directory outside the repo
  prints the same checks: the bundle is self-contained.

## Not in this design

A plugin manifest, a single-binary `bun build --compile` (platform-specific; the JS bundle
is not), per-part `look`, imported-mesh
listing for the model (it can read the file sizes itself), and a `chat` command that would
call a hosted model — the local model is the chat.
