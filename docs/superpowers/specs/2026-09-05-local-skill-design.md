# Local skill — design

Date: 2026-09-05. The app's loop — describe, write OpenSCAD, compile, measure, look, correct,
export — as a Claude Code skill, so a model running on the user's machine (Claude Code, or
anything that reads a `SKILL.md` and runs a shell command) can drive it without the browser or
an OpenRouter key.

## Goal

A directory that installs with one symlink and gives the local model the same evidence the
app gives the hosted one: the measured report and the app's checks after every compile, the
green-over-magenta diff and named views on request, and a 3MF, STL or OBJ at the end. The
modelling rules come from the app's own system prompt so they never fork.

## Layout

```
skills/vibe3d/
  SKILL.md       the workflow the model follows
  vibe3d         bash wrapper — resolves its own symlink, runs `pnpm exec tsx cli.ts` in the repo
  cli.ts         the commands
  look.ts        browser entry, bundled by vite: window.vibe3dLook(...) → JPEG data URL
  cli.test.ts    real-kernel tests
  .build/        the look bundle, gitignored, built on first use
```

Install: `ln -s "$PWD/skills/vibe3d" ~/.claude/skills/vibe3d`. The wrapper uses
`readlink -f` on itself, so it finds the repo whether it is run from the symlink or in place;
a copied skill directory does not work and the wrapper says so. The only new dependency is
`tsx` (dev), because nothing in the repo runs TypeScript from a shell today and the sources
use extensionless imports that Node's own type stripping cannot resolve.

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

**`vibe3d look part.scad out.jpg [--view V] [--cut z=12] [--box x0,y0,z0,x1,y1,z1] [--before prev.scad]`**
Renders through the app's `capture.ts`, in headless Chromium via Playwright:

- Without `--before`: `renderView` — a shaded view from `V` (`iso`, `iso_back`, `front`,
  `back`, `left`, `right`, `top`, `bottom`, `auto`; default `iso`), an optional cut, an
  optional frame box. `auto` looks from `idealView` of the box (or the part), as `Chat.tsx`
  does. The CONSTRUCTION section, compiled on its own by `constructionSource`, is the ghost.
- With `--before`: the same inspection as `check --before`, then `renderComposite` of the
  aligned before (green) over after (magenta), framed by `frameBox`, with the close-up pane
  when `detailOf` chooses one. `--view` etc. are ignored in this mode.

`look.ts` is the browser side: it takes the OFF texts and the request, calls the two render
functions and returns the data URL. It is built once by `vite build` (lib mode, IIFE, three.js
inlined) into `.build/look.js` when the file is missing; the CLI launches Chromium, adds the
script to an empty page, evaluates, decodes the data URL and writes the JPEG. 768 px, as in the
app; the composite is 1536 × 768 when it has a close-up pane. Exit 1 with one line when
Chromium is not installed (`pnpm exec playwright install chromium` is the fix it names).

**`vibe3d prompt`**
Prints the app's `SYSTEM_PROMPT` followed by the rendered `bosl2`, `fonts` and `diff` skills
(`renderSkill` with no mesh), each under a heading. A one-line preface says that the OUTPUT
CONTRACT, SELECTION and SKILLS sections are the browser app's chat protocol and do not apply
here: the local model writes the `.scad` file directly and the skills are already printed.
`SKILL.md` tells the model to read it once per session, so the modelling rules in this skill
are always the app's current ones.

## SKILL.md

Short: what the skill is for, the install line, then the loop —

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

`skills/vibe3d/cli.test.ts`, run by `pnpm test` with the rest (real kernel, ~0.5 s a compile):

- `check` on a two-PART source prints `solids: 2 for 2 PART sections: ok` and a report whose
  `parts` is 2; with `--before` on a grown part, `added_volume_mm3` is positive.
- `check` on a source with a syntax error exits 1 and prints the kernel's line.
- `export` to 3MF yields two `<object` entries; `--part 2` yields one.
- `look` writes a JPEG whose header is JFIF and whose size is 768 × 768 (and 1536 × 768 for a
  `--before` render that has a close-up); skipped with a message when the Chromium download
  is absent.

## Not in this design

A plugin manifest, a self-contained copy-installable bundle, per-part `look`, imported-mesh
listing for the model (it can read the file sizes itself), and a `chat` command that would
call a hosted model — the local model is the chat.
