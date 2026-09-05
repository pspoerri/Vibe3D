# Local skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A copy-installable Claude Code skill (`skills/vibe3d/`) whose CLI gives a local model the app's loop: compile, measured report and checks, renders, export.

**Architecture:** One TypeScript CLI (`cli.ts`) over the code the app and the eval runner already use — `eval/kernel.ts` for compiles, `src/viewer/inspect.ts` for the report and checks, `src/export/*` for files. Renders come from the app's `capture.ts`, bundled for the browser (`look.ts`) and screenshotted by headless Chrome. `bun build` turns both into single files; a build script copies them with the kernel's vendor assets into `dist/skill/`, which installs by copy.

**Tech Stack:** Bun 1.4 (runtime and bundler), the vendored OpenSCAD WASM kernel, three.js via `capture.ts`, headless Chrome (`--screenshot`), vitest for tests.

**Spec:** `docs/superpowers/specs/2026-09-05-local-skill-design.md`

## Global Constraints

- Every command is `<skill dir>/vibe3d <command> …`; the wrapper is `exec bun "$(dirname "$0")"/cli.[jt]s "$@"`.
- `cli.ts` must run unbuilt from the source tree (tests) and built as `dist/skill/cli.js` from any directory with only `vendor/`, `look.js`, `SKILL.md` and `vibe3d` beside it. Nothing in the built directory refers to the repo.
- Assets resolve from `vendor/` beside the running file, else `../src/kernel/vendor/` (relative to `eval/kernel.ts`).
- `check` output: `The source compiled. Measured from the mesh (millimetres, mm³):`, blank, `formatReport`, blank, `Checks the app ran:` with `- ` lines, then `Notes on the source:` with `- ` lines only when `checkParts` returns any.
- Exit 0 whenever the source compiled, even with checks marked NO. Exit 1 for a failed compile (cleaned stderr printed), a missing file, or an unusable argument. Exit 2 for an unknown command (usage printed).
- `look` output is PNG, 768 × 768, or 1536 × 768 for a composite with a close-up pane. Chrome flags exactly: `--headless=new --no-sandbox --user-data-dir=<tmp> --no-first-run --hide-scrollbars --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=W,768 --screenshot=<out> file://<page>`. Poll for the file up to 30 s, then kill Chrome.
- Chrome search order: `$VIBE3D_CHROME`, PATH names `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome`, then `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/Applications/Chromium.app/Contents/MacOS/Chromium`.
- No new dependencies. Ponytail is on: shortest working diff, `// ponytail:` on deliberate ceilings.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `eval/kernel.ts` (modify) | Find `vendor/` beside itself first, so the bundled CLI finds its copied assets |
| `skills/vibe3d/cli.ts` (create) | `run(argv)`: `check`, `export`, `look`, `prompt`; arg parsing; Chrome discovery and screenshot |
| `skills/vibe3d/look.ts` (create) | Browser entry: `window.vibe3dLook(job)` draws one render into the page |
| `skills/vibe3d/cli.test.ts` (create) | Real-kernel tests of every command and of the built bundle |
| `skills/vibe3d/vibe3d` (create) | Two-line bash wrapper |
| `skills/vibe3d/SKILL.md` (create) | The workflow the model follows |
| `scripts/build-skill.mjs` (create) | `bun build` both entries and copy assets into `dist/skill/` |
| `src/viewer/inspect.ts` (modify) | `Inspection.composite`: what `renderComposite` would draw, for a renderer elsewhere |
| `src/viewer/inspect.test.ts` (modify) | One test for `composite` |
| `vite.config.ts`, `tsconfig.test.json`, `package.json`, `.gitignore`, `README.md`, `CHANGELOG.md` (modify) | Test include paths, the `build:skill` script, the ignored dev bundle, docs |

---

### Task 1: `check` — the CLI skeleton over the real kernel

**Files:**
- Modify: `eval/kernel.ts:16-17`
- Create: `skills/vibe3d/cli.ts`
- Create: `skills/vibe3d/cli.test.ts`
- Modify: `vite.config.ts:71`, `tsconfig.test.json`

**Interfaces:**
- Consumes: `compileNode(source, format, files)` and `compileResult(source, files)` from `eval/kernel.ts`; `inspect`, `formatReport`, `meshChecks` from `src/viewer/inspect.ts`; `partCount`, `checkParts` from `src/chat/parts.ts`; `usesText` from `src/kernel/fonts.ts`; `stripKernelNoise` from `src/kernel/noise.ts`; `DEFAULT_BED` from `src/state/settings.ts`.
- Produces: `export async function run(argv: string[]): Promise<{ code: number; out: string }>` — every later task adds a `case` to its switch. Helpers later tasks call: `loadSource(path)`, `compiled(path, format)`, `inspected(path, before)`, `parse(args)`.

- [ ] **Step 1: Make the test runner see the skill**

In `vite.config.ts` change line 71 to:

```ts
  test: { environment: 'node', include: ['src/**/*.test.ts', 'skills/**/*.test.ts'] },
```

In `tsconfig.test.json` change `include` to:

```json
  "include": ["src/**/*.test.ts", "eval/**/*.ts", "skills/**/*.ts", "vitest.eval.config.ts"],
```

- [ ] **Step 2: Write the failing tests**

Create `skills/vibe3d/cli.test.ts`:

```ts
/**
 * The skill's CLI against the real kernel, ~0.5 s a compile. Sources are
 * written to a temp dir, as the model would write them.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { run } from './cli'

const dir = mkdtempSync(join(tmpdir(), 'vibe3d-cli-'))
const file = (name: string, text: string): string => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

const TWO = `// Two blocks

// ---- PART 1 ----
cube(10);
// ---- PART 1 END ----
// ---- PART 2 ----
translate([20, 0, 0]) cube(10);
// ---- PART 2 END ----
`
/** TWO with part 1 doubled in every dimension. */
const GROWN = TWO.replace('cube(10);\n// ---- PART 1 END', 'cube(20);\n// ---- PART 1 END')

test('check prints the report, the checks and no notes for a clean source', async () => {
  const { code, out } = await run(['check', file('two.scad', TWO)])
  expect(code).toBe(0)
  expect(out).toContain('The source compiled. Measured from the mesh (millimetres, mm³):')
  expect(out).toContain('"parts": 2')
  expect(out).toContain('- rests on Z=0: yes')
  expect(out).toContain('- fits the bed: yes')
  expect(out).toContain('- solids: 2 for 2 PART sections: ok')
  expect(out).not.toContain('Notes on the source')
})

test('check --before fills the diff', async () => {
  const { out } = await run(['check', file('grown.scad', GROWN), '--before', file('two.scad', TWO)])
  expect(out).toMatch(/"added_volume_mm3": [1-9]/)
  expect(out).toContain('"changed_pieces": [{"kind":"added"')
})

test('check --bed and a source note', async () => {
  const { out } = await run(['check', file('two.scad', TWO), '--bed', '20,20,20'])
  expect(out).toContain('- fits the bed: NO')
  const notes = await run(['check', file('loose.scad', `${TWO}cube(5);\n`)])
  expect(notes.out).toContain('Notes on the source:')
})

test('a compile error is exit 1 with the kernel line', async () => {
  const { code, out } = await run(['check', file('bad.scad', 'cube(10;')])
  expect(code).toBe(1)
  expect(out).toMatch(/syntax error/i)
})

test('a mesh named by import() is read from beside the source', async () => {
  const stl = join(dir, 'box.stl')
  await run(['export', file('two.scad', TWO), stl])
  const { code, out } = await run(['check', file('uses.scad', '// Import\n\n// ---- PART 1 ----\nimport("box.stl");\n// ---- PART 1 END ----\n')])
  expect(code, out).toBe(0)
  expect(out).toContain('"parts": 2')
})

test('unknown command prints usage with exit 2, a missing file is exit 1', async () => {
  expect((await run(['frobnicate'])).code).toBe(2)
  expect((await run([])).out).toContain('vibe3d check')
  const missing = await run(['check', join(dir, 'nope.scad')])
  expect(missing.code).toBe(1)
  expect(missing.out).toContain('nope.scad')
})
```

The `import()` test uses `export`, which Task 2 adds; it fails until then and that is expected.

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: FAIL — cannot resolve `./cli`.

- [ ] **Step 4: Let the kernel find copied assets**

In `eval/kernel.ts` replace lines 16–17:

```ts
const VENDOR = new URL('../src/kernel/vendor/', import.meta.url)
const wasmBinary = readFileSync(new URL('openscad.wasm', VENDOR))
```

with:

```ts
/** vendor/ beside the running file — the built skill's copy — else the repo's. */
const VENDOR = [new URL('vendor/', import.meta.url), new URL('../src/kernel/vendor/', import.meta.url)].find(
  (dir) => existsSync(dir),
)!
const wasmBinary = readFileSync(new URL('openscad.wasm', VENDOR))
```

and change the import on line 7 to `import { existsSync, readFileSync } from 'node:fs'`. Add to the doc comment at the top: "and the skill's CLI, built or not".

- [ ] **Step 5: Write the CLI**

Create `skills/vibe3d/cli.ts`:

```ts
/**
 * The app's loop from a shell — compile, measure, look, export — for a model
 * that runs on this machine. Runs unbuilt from the tree under bun, or as the
 * single file `pnpm build:skill` writes beside SKILL.md. Every command prints
 * what the app would show the model; a failure is the message and exit 1.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compileNode, compileResult } from '../../eval/kernel'
import { checkParts, partCount } from '../../src/chat/parts'
import { usesText } from '../../src/kernel/fonts'
import { stripKernelNoise } from '../../src/kernel/noise'
import type { ExportFormat } from '../../src/kernel/protocol'
import { DEFAULT_BED } from '../../src/state/settings'
import type { Vec3 } from '../../src/viewer/camera'
import { formatReport, inspect, meshChecks, type Inspection } from '../../src/viewer/inspect'

const USAGE = `vibe3d check  part.scad [--before prev.scad] [--bed 256,256,256]
vibe3d export part.scad out.3mf|out.stl|out.obj [--part N]
vibe3d look   part.scad out.png [--view iso|iso_back|front|back|left|right|top|bottom|auto] [--cut z=12] [--box x0,y0,z0,x1,y1,z1] [--before prev.scad]
vibe3d prompt`

const OPTIONS = {
  before: { type: 'string' },
  bed: { type: 'string' },
  part: { type: 'string' },
  view: { type: 'string' },
  cut: { type: 'string' },
  box: { type: 'string' },
} as const

const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true })

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** The source, and every file an import("name") names, read from beside it. */
// ponytail: flat names only — import("dir/x.stl") is not written into the kernel FS.
function loadSource(path: string): { source: string; files: Record<string, Uint8Array> } {
  if (!existsSync(path)) throw new Error(`${path}: no such file`)
  const source = readFileSync(path, 'utf8')
  const files: Record<string, Uint8Array> = {}
  for (const [, name] of source.matchAll(/\bimport\s*\(\s*"([^"/]+)"/g)) {
    const at = resolve(dirname(path), name!)
    if (existsSync(at)) files[`/${name}`] = new Uint8Array(readFileSync(at))
  }
  return { source, files }
}

/** One compile; the kernel's cleaned diagnostics are the thrown message. */
async function compiled(path: string, format: ExportFormat = 'off') {
  const { source, files } = loadSource(path)
  const { code, data, stderr } = await compileNode(source, format, files)
  if (code !== 0) {
    throw new Error(`${path} did not compile:\n${stripKernelNoise(stderr) || 'Compile failed with no diagnostics.'}`)
  }
  return { source, files, data }
}

/** The compile and the app's inspection of it, against `before` when given. */
async function inspected(path: string, before: string | undefined) {
  const after = await compiled(path)
  const prior = before ? (await compiled(before)).data : null
  const insp = await inspect({
    before: prior,
    after: after.data,
    vision: false,
    signal: new AbortController().signal,
    compile: (source, files) => compileResult(source, files),
  })
  return { ...after, insp }
}

/** What verifyMessage gives the hosted model, minus the question ritual — SKILL.md carries that. */
function checkText(source: string, insp: Inspection, bed: Vec3): string {
  const checks = meshChecks(insp.report, partCount(source), usesText(source), bed)
  const notes = checkParts(source)
  return [
    'The source compiled. Measured from the mesh (millimetres, mm³):',
    '',
    formatReport(insp.report),
    '',
    'Checks the app ran:',
    ...checks.map((line) => `- ${line}`),
    ...(notes.length > 0 ? ['', 'Notes on the source:', ...notes.map((line) => `- ${line}`)] : []),
  ].join('\n')
}

function bedOf(flag: string | undefined): Vec3 {
  if (!flag) return DEFAULT_BED
  const bed = flag.split(',').map(Number)
  if (bed.length !== 3 || bed.some((n) => !(n > 0))) throw new Error('--bed is three sizes in mm, like 256,256,256')
  return bed as unknown as Vec3
}

async function check(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path], values } = parse(args)
  if (!path) throw new Error(USAGE)
  const { source, insp } = await inspected(path, values.before)
  return { code: 0, out: checkText(source, insp, bedOf(values.bed)) }
}

export async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'check':
        return await check(rest)
      default:
        return { code: 2, out: USAGE }
    }
  } catch (error) {
    return { code: 1, out: error instanceof Error ? error.message : String(error) }
  }
}

if ((import.meta as { main?: boolean }).main) {
  const { code, out } = await run(process.argv.slice(2))
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
  process.exit(code)
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: the four `check` tests and the usage test PASS; the `import()` test FAILS (no `export` yet).

Run: `bun skills/vibe3d/cli.ts check src/examples/mounting-plate.scad`
Expected: the report and checks for the example, exit 0.

- [ ] **Step 7: Commit**

```bash
git add eval/kernel.ts skills/vibe3d/cli.ts skills/vibe3d/cli.test.ts vite.config.ts tsconfig.test.json
git commit -m "feat(skill): vibe3d check — the app's report and checks from a shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `export` — 3MF, STL, OBJ, one part or all

**Files:**
- Modify: `skills/vibe3d/cli.ts`
- Modify: `skills/vibe3d/cli.test.ts`

**Interfaces:**
- Consumes: `compiled(path, format)` and `loadSource` from Task 1; `paint3mf` (`src/export/threemf.ts`), `part3mf`, `partMesh` (`src/export/part.ts`), `encodeStl` (`src/export/stl.ts`), `encodeObj(mesh, name)` (`src/export/obj.ts`), `parseOff` (`src/kernel/off.ts`).
- Produces: the `export` case of `run`.

- [ ] **Step 1: Write the failing tests**

Append to `cli.test.ts` (add `import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'` at the top):

```ts
const objects = (path: string): number =>
  strFromU8(unzipSync(readFileSync(path))['3D/3dmodel.model']!).match(/<object /g)?.length ?? 0

test('export writes a 3MF with one object per part, or one part alone', async () => {
  const all = join(dir, 'two.3mf')
  const { code, out } = await run(['export', file('two.scad', TWO), all])
  expect(code, out).toBe(0)
  expect(out).toContain('two.3mf')
  expect(objects(all)).toBe(2)
  const one = join(dir, 'one.3mf')
  await run(['export', file('two.scad', TWO), one, '--part', '2'])
  expect(objects(one)).toBe(1)
})

test('export writes binary STL and OBJ with its MTL', async () => {
  const stl = join(dir, 'two.stl')
  await run(['export', file('two.scad', TWO), stl])
  // 80-byte header, a count, 50 bytes a triangle: two cubes are 24.
  expect(readFileSync(stl).length).toBe(84 + 50 * 24)
  const obj = join(dir, 'red.obj')
  await run(['export', file('red.scad', '// Red\n\n// ---- PART 1 ----\ncolor("red") cube(10);\n// ---- PART 1 END ----\n'), obj])
  expect(readFileSync(obj, 'utf8')).toContain('mtllib red.mtl')
  expect(existsSync(join(dir, 'red.mtl'))).toBe(true)
  const bad = await run(['export', file('two.scad', TWO), join(dir, 'two.step')])
  expect(bad.code).toBe(1)
  expect(bad.out).toContain('.3mf, .stl or .obj')
})
```

Add `existsSync` to the `node:fs` import in the test.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: the two export tests and the `import()` test FAIL with usage (exit 2).

- [ ] **Step 3: Implement `export`**

In `cli.ts` add imports:

```ts
import { basename } from 'node:path'   // merge into the existing node:path import
import { encodeObj } from '../../src/export/obj'
import { part3mf, partMesh } from '../../src/export/part'
import { encodeStl } from '../../src/export/stl'
import { paint3mf } from '../../src/export/threemf'
import { parseOff } from '../../src/kernel/off'
```

Add the command:

```ts
/** 3MF is the kernel's own, painted; STL and OBJ are the app's encoders over the OFF mesh. */
async function exportPart(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path, out], values } = parse(args)
  if (!path || !out) throw new Error(USAGE)
  const ext = out.split('.').pop() ?? ''
  const part = values.part ? Number(values.part) : 0
  if (!['3mf', 'stl', 'obj'].includes(ext)) throw new Error(`export writes .3mf, .stl or .obj, not .${ext}`)
  if (ext === '3mf') {
    const { data } = await compiled(path, '3mf')
    writeFileSync(out, paint3mf(part ? part3mf(data, part) : data))
  } else {
    const whole = parseOff(decode((await compiled(path)).data))
    const mesh = part ? partMesh(whole, part) : whole
    if (ext === 'stl') writeFileSync(out, encodeStl(mesh))
    else {
      const { obj, mtl } = encodeObj(mesh, basename(out, '.obj'))
      writeFileSync(out, obj)
      if (mtl) writeFileSync(out.replace(/\.obj$/, '.mtl'), mtl)
    }
  }
  return { code: 0, out: `wrote ${out}` }
}
```

and the case `case 'export': return await exportPart(rest)` in `run`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: all PASS, including Task 1's `import()` test.

- [ ] **Step 5: Commit**

```bash
git add skills/vibe3d/cli.ts skills/vibe3d/cli.test.ts
git commit -m "feat(skill): vibe3d export — 3MF, STL, OBJ, whole or one part

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `prompt` — the app's rules, verbatim

**Files:**
- Modify: `skills/vibe3d/cli.ts`
- Modify: `skills/vibe3d/cli.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROMPT` (`src/chat/prompt.ts`), `renderSkill(name, { source, mesh, looks })` (`src/chat/skills.ts`).
- Produces: the `prompt` case of `run`.

- [ ] **Step 1: Write the failing test**

```ts
test('prompt prints the system prompt, the protocol note and the three skills', async () => {
  const { code, out } = await run(['prompt'])
  expect(code).toBe(0)
  expect(out.indexOf('do not apply here')).toBeLessThan(out.indexOf('OUTPUT CONTRACT'))
  for (const heading of ['# BOSL2', 'text() has exactly these faces', '# Reading a report']) expect(out).toContain(heading)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts -t prompt`
Expected: FAIL, exit 2.

- [ ] **Step 3: Implement**

Imports:

```ts
import { SYSTEM_PROMPT } from '../../src/chat/prompt'
import { renderSkill } from '../../src/chat/skills'
```

Command:

```ts
const PROTOCOL_NOTE =
  "The browser app's system prompt follows. Its OUTPUT CONTRACT, SELECTION and SKILLS sections are the app's chat protocol and do not apply here: write the .scad file directly, and the skills are printed below it."

const prompt = (): string =>
  [
    PROTOCOL_NOTE,
    '',
    SYSTEM_PROMPT,
    ...['bosl2', 'fonts', 'diff'].flatMap((name) => ['', '---', '', renderSkill(name, { source: '', mesh: null, looks: true })!]),
  ].join('\n')
```

Case: `case 'prompt': return { code: 0, out: prompt() }`.

- [ ] **Step 4: Run the tests, then commit**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: all PASS.

```bash
git add skills/vibe3d/cli.ts skills/vibe3d/cli.test.ts
git commit -m "feat(skill): vibe3d prompt — the app's modelling rules and skills

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `inspect` hands out what the composite draws

**Files:**
- Modify: `src/viewer/inspect.ts:579-640`
- Modify: `src/viewer/inspect.test.ts`

**Interfaces:**
- Produces: `Inspection.composite: { before: Mesh | null; after: Mesh; frame: Box; detail: Detail | null }` — `before` is the previous mesh aligned onto the new one (moves taken out), exactly what `renderComposite(before, after, frame, detail)` takes.

- [ ] **Step 1: Write the failing test**

Append to `src/viewer/inspect.test.ts` (add `inspect` to the import list, and `import type { CompileResult } from '../kernel/compile'` is already there):

```ts
test('inspect exposes what the composite would draw', async () => {
  // An "empty" diff result: nothing added, nothing removed.
  // diffOf reads stderrRaw for the kernel's "empty" exit.
  const empty: CompileResult = { ok: false, stderr: '', stderrRaw: 'ERROR: Current top level object is empty.', ms: 0 }
  const same = new TextEncoder().encode(box(10, 10, 10))
  const insp = await inspect({ before: same, after: same, vision: false, signal: new AbortController().signal, compile: async () => empty })
  expect(insp.composite.after.triangleCount).toBe(12)
  expect(insp.composite.before?.triangleCount).toBe(12)
  expect(insp.composite.frame).toEqual({ min: [0, 0, 0], max: [10, 10, 10] })
  expect(insp.composite.detail).toBeNull()
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/viewer/inspect.test.ts -t composite`
Expected: FAIL — `composite` undefined.

- [ ] **Step 3: Implement**

In the `Inspection` interface add:

```ts
  /** What renderComposite would draw — before aligned onto after, the frame, the close-up — for a renderer outside this context. */
  composite: { before: Mesh | null; after: Mesh; frame: Box; detail: Detail | null }
```

In `inspect()`'s return add `composite: { before: aligned, after: afterMesh, frame: frameBox(change, model), detail }`. `frameBox(change, model)` is already computed for the image; hoist it into a `const frame` and use it in both places.

- [ ] **Step 4: Run the viewer tests, then commit**

Run: `pnpm vitest run src/viewer`
Expected: all PASS.

```bash
git add src/viewer/inspect.ts src/viewer/inspect.test.ts
git commit -m "feat(inspect): expose what the composite draws, for a renderer elsewhere

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `look` — a render through headless Chrome

**Files:**
- Create: `skills/vibe3d/look.ts`
- Modify: `skills/vibe3d/cli.ts`
- Modify: `skills/vibe3d/cli.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `inspected(path, before)` from Task 1; `Inspection.composite` from Task 4; `renderView(mesh, request, model, ghost, from)` and `renderComposite(before, after, frame, detail)` from `src/viewer/capture.ts`; `constructionSource` (`src/chat/parts.ts`); `VIEW_NAMES`, `describeView`, `ViewRequest` (`src/chat/views.ts`); `boxOf`, `hostOf`, `idealView`, `legendFor` (`src/viewer/inspect.ts`); `meshStats` (`src/kernel/stats.ts`).
- Produces: `export type LookJob` in `look.ts`; `export function findChrome(): string | null` in `cli.ts` (the test's skip condition); the `look` case of `run`.

- [ ] **Step 1: Write the failing tests**

Append to `cli.test.ts` (add `findChrome` to the `./cli` import):

```ts
/** Width and height from a PNG's IHDR. */
const png = (path: string): [number, number] => {
  const bytes = readFileSync(path)
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}
/** TWO with a small block fused onto part 1: a change small against its part, so the composite gets a close-up pane. */
const BUMPED = TWO.replace('cube(10);\n// ---- PART 1 END', 'union() { cube(10); translate([3, 3, 9]) cube(4); }\n// ---- PART 1 END')

test.skipIf(!findChrome())('look renders a 768 px view, and a two-pane composite after a change', async () => {
  const view = join(dir, 'view.png')
  const r = await run(['look', file('two.scad', TWO), view, '--view', 'front', '--cut', 'z=5'])
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('front view, cut at z = 5 mm')
  expect(png(view)).toEqual([768, 768])

  const composite = join(dir, 'composite.png')
  const c = await run(['look', file('bumped.scad', BUMPED), composite, '--before', file('two.scad', TWO)])
  expect(c.code, c.out).toBe(0)
  expect(c.out).toContain('two panes')
  expect(png(composite)).toEqual([1536, 768])
}, 60_000)

test('look rejects a bad view, cut or box before touching Chrome', async () => {
  const src = file('two.scad', TWO)
  expect((await run(['look', src, join(dir, 'x.png'), '--view', 'sideways'])).out).toContain('--view is one of')
  expect((await run(['look', src, join(dir, 'x.png'), '--cut', '12'])).out).toContain('--cut is axis=mm')
  expect((await run(['look', src, join(dir, 'x.png'), '--box', '1,2,3'])).out).toContain('--box is x0,y0,z0,x1,y1,z1')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts -t look`
Expected: FAIL — `findChrome` is not exported / exit 2.

- [ ] **Step 3: Write the browser entry**

Create `skills/vibe3d/look.ts`:

```ts
/**
 * The browser side of `vibe3d look`: bundled by bun into look.js and loaded
 * into an empty page that headless Chrome screenshots. The CLI has done the
 * geometry; this draws one render — the app's own capture.ts — into the body.
 */
import type { ViewRequest } from '../../src/chat/views'
import { parseOff } from '../../src/kernel/off'
import type { Vec3 } from '../../src/viewer/camera'
import { renderComposite, renderView, type Detail } from '../../src/viewer/capture'
import type { Box } from '../../src/viewer/inspect'

export type LookJob =
  | { kind: 'view'; off: string; ghost: string | null; request: ViewRequest; model: Box; from: Vec3 | null }
  | { kind: 'composite'; before: string | null; after: string; frame: Box; detail: Detail | null }

/** The render as an image filling the window from its top-left corner, or a line saying why there is none. */
function look(job: LookJob): void {
  const url =
    job.kind === 'view'
      ? renderView(parseOff(job.off), job.request, job.model, job.ghost ? parseOff(job.ghost) : null, job.from)
      : renderComposite(job.before ? parseOff(job.before) : null, parseOff(job.after), job.frame, job.detail)
  document.body.style.margin = '0'
  if (!url) {
    document.body.textContent = 'no WebGL in this browser'
    return
  }
  const img = new Image()
  img.style.display = 'block'
  img.src = url
  document.body.append(img)
}

;(window as unknown as { vibe3dLook: typeof look }).vibe3dLook = look
```

Add `skills/vibe3d/look.js` to `.gitignore` (the dev bundle the CLI builds beside itself).

- [ ] **Step 4: Implement `look` in the CLI**

Imports to add in `cli.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'          // merge into the node:fs import
import { tmpdir } from 'node:os'
import { join } from 'node:path'                       // merge into the node:path import
import { fileURLToPath } from 'node:url'
import { constructionSource } from '../../src/chat/parts'   // merge with checkParts, partCount
import { describeView, VIEW_NAMES, type Axis, type ViewName, type ViewRequest } from '../../src/chat/views'
import { meshStats } from '../../src/kernel/stats'
import { boxOf, hostOf, idealView, legendFor } from '../../src/viewer/inspect'   // merge
import type { LookJob } from './look'
```

Code:

```ts
const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
const CHROME_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/** $VIBE3D_CHROME, then PATH, then the macOS apps. null when there is none: check and export never need it. */
export function findChrome(): string | null {
  if (process.env.VIBE3D_CHROME) return process.env.VIBE3D_CHROME
  for (const name of CHROME_NAMES) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0) return found.stdout.trim()
  }
  return CHROME_APPS.find((app) => existsSync(app)) ?? null
}

/** look.js beside this file (the built skill), else built now from look.ts (the source tree). */
function lookBundle(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const built = join(here, 'look.js')
  if (!existsSync(built)) {
    const entry = join(here, 'look.ts')
    if (!existsSync(entry)) throw new Error(`${built} is missing: run pnpm build:skill`)
    const r = spawnSync('bun', ['build', entry, '--target=browser', '--format=iife', '--outfile', built], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('bun build look.ts failed')
  }
  return built
}

const V3 = (a: number[]): [number, number, number] => [a[0]!, a[1]!, a[2]!]

function viewRequest(values: { view?: string; cut?: string; box?: string }): ViewRequest {
  const view = values.view ?? 'iso'
  if (view !== 'auto' && !(VIEW_NAMES as readonly string[]).includes(view)) {
    throw new Error(`--view is one of ${VIEW_NAMES.join(', ')}, auto`)
  }
  const cut = values.cut === undefined ? null : /^([xyz])=(-?\d+(?:\.\d+)?)$/.exec(values.cut)
  if (values.cut !== undefined && !cut) throw new Error('--cut is axis=mm, like z=12')
  const box = values.box?.split(',').map(Number)
  if (box && (box.length !== 6 || box.some(Number.isNaN))) throw new Error('--box is x0,y0,z0,x1,y1,z1')
  return {
    view: view as ViewName | 'auto',
    section: cut ? { axis: cut[1] as Axis, at: Number(cut[2]) } : null,
    box: box ? { min: V3(box.slice(0, 3)), max: V3(box.slice(3)) } : null,
    closeup: null,
  }
}

/** One page, one Chrome, one screenshot. Chrome does not exit on its own under a sandbox, so the file is the signal. */
async function screenshot(chrome: string, job: LookJob, width: number, out: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vibe3d-look-'))
  const page = join(dir, 'look.html')
  writeFileSync(
    page,
    `<!doctype html><body><script src="file://${lookBundle()}"></script><script>vibe3dLook(${JSON.stringify(job)})</script></body>`,
  )
  rmSync(out, { force: true })
  const child = spawn(
    chrome,
    [
      '--headless=new', '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--hide-scrollbars',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--window-size=${width},768`,
      `--screenshot=${resolve(out)}`, `file://${page}`,
    ],
    { stdio: 'ignore' },
  )
  try {
    const tick = () => new Promise((done) => setTimeout(done, 250))
    const until = Date.now() + 30_000
    while (!existsSync(out) && Date.now() < until) await tick()
    if (!existsSync(out)) throw new Error(`${chrome} wrote no screenshot in 30 s`)
    await tick() // ponytail: one beat for the write to finish; a size-stable poll if a truncated PNG ever shows up
  } finally {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

async function look(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path, out], values } = parse(args)
  if (!path || !out) throw new Error(USAGE)
  const request = viewRequest(values)
  const chrome = findChrome()
  if (!chrome) throw new Error('No Chrome found: set VIBE3D_CHROME to a Chrome or Chromium binary. check and export work without it.')
  const { source, files, data, insp } = await inspected(path, values.before)
  let job: LookJob
  let legend: string
  let width = 768
  if (values.before) {
    const { before, after, frame, detail } = insp.composite
    job = { kind: 'composite', before: before && decode(encodeOff(before)), after: decode(encodeOff(after)), frame, detail }
    legend = legendFor(before !== null, detail)
    if (detail) width = 1536
  } else {
    const mesh = parseOff(decode(data))
    const stats = meshStats(mesh)
    const model = boxOf(stats)
    // An auto view looks from the side of its part the box sits on, as Chat.tsx does.
    const target = request.box ?? model
    const from = request.view === 'auto' ? idealView(target, hostOf(target, stats.shells.map(boxOf), model)).direction : null
    const ghostSource = constructionSource(source)
    const ghost = ghostSource ? await compileNode(ghostSource, 'off', files) : null
    job = {
      kind: 'view',
      off: decode(data),
      ghost: ghost?.code === 0 ? decode(ghost.data) : null,
      request,
      model,
      from,
    }
    legend = `Requested view: ${describeView(request)}. Layout and proportion only — read every dimension from the report.`
  }
  await screenshot(chrome, job, width, out)
  return { code: 0, out: `wrote ${out}\n${legend}` }
}
```

Add `encodeOff` to the `../../src/kernel/off` import and the case `case 'look': return await look(rest)`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: all PASS; the look test takes ~10 s (three compiles, two Chromes). Open the two PNGs in the temp dir and confirm: the front view shows the two blocks cut open at half height; the composite shows the block in grey with a magenta bump, and a right-hand close-up pane of the bump.

Run: `pnpm build` (type-checks `tsconfig.test.json`, which now covers `skills/`).
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add skills/vibe3d/look.ts skills/vibe3d/cli.ts skills/vibe3d/cli.test.ts .gitignore
git commit -m "feat(skill): vibe3d look — named views, cuts and the composite through headless Chrome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The installable skill — wrapper, SKILL.md, build script, docs

**Files:**
- Create: `skills/vibe3d/vibe3d`, `skills/vibe3d/SKILL.md`, `scripts/build-skill.mjs`
- Modify: `package.json` (scripts), `skills/vibe3d/cli.test.ts`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Produces: `pnpm build:skill` → `dist/skill/{SKILL.md,vibe3d,cli.js,look.js,vendor/}`.

- [ ] **Step 1: Write the failing test**

Append to `cli.test.ts` (add `cpSync` to the `node:fs` import and `import { spawnSync } from 'node:child_process'`):

```ts
const repo = join(import.meta.dirname, '..', '..')
const hasBun = spawnSync('bun', ['--version']).status === 0

test.skipIf(!hasBun)('the built skill runs from a directory outside the repo', () => {
  const build = spawnSync('node', ['scripts/build-skill.mjs'], { cwd: repo, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
  const copy = join(dir, 'skill')
  cpSync(join(repo, 'dist', 'skill'), copy, { recursive: true })
  for (const name of ['SKILL.md', 'vibe3d', 'cli.js', 'look.js', 'vendor/openscad.wasm', 'vendor/BOSL2.zip', 'vendor/fonts/LiberationSans-Regular.ttf']) {
    expect(existsSync(join(copy, name)), name).toBe(true)
  }
  const r = spawnSync(join(copy, 'vibe3d'), ['check', file('two.scad', TWO)], { cwd: dir, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toContain('- solids: 2 for 2 PART sections: ok')
}, 120_000)
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts -t built`
Expected: FAIL — `scripts/build-skill.mjs` not found.

- [ ] **Step 3: The wrapper**

Create `skills/vibe3d/vibe3d` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# cli.js in the built skill, cli.ts in the source tree — never both.
exec bun "$(dirname "$0")"/cli.[jt]s "$@"
```

- [ ] **Step 4: The build script**

Create `scripts/build-skill.mjs`:

```js
// Builds the copy-installable skill into dist/skill: the CLI and the look
// page bundled by bun into one file each, the kernel's vendor files beside
// them, SKILL.md and the wrapper copied. Needs bun on PATH.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const skill = new URL('skills/vibe3d/', root)
const vendor = new URL('src/kernel/vendor/', root)
const out = new URL('dist/skill/', root)
const path = (url) => fileURLToPath(url)

rmSync(out, { recursive: true, force: true })
mkdirSync(new URL('vendor/', out), { recursive: true })

const bun = (...args) => {
  const r = spawnSync('bun', ['build', ...args], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
bun(path(new URL('cli.ts', skill)), '--target=bun', '--outfile', path(new URL('cli.js', out)))
bun(path(new URL('look.ts', skill)), '--target=browser', '--format=iife', '--outfile', path(new URL('look.js', out)))

for (const name of ['SKILL.md', 'vibe3d']) cpSync(new URL(name, skill), new URL(name, out))
for (const name of ['openscad.wasm', 'BOSL2.zip', 'fonts']) cpSync(new URL(name, vendor), new URL(`vendor/${name}`, out), { recursive: true })
console.log(`built ${path(out)}`)
```

In `package.json` scripts add:

```json
    "build:skill": "node scripts/fetch-bosl2.mjs && node scripts/build-skill.mjs",
```

- [ ] **Step 5: SKILL.md**

Create `skills/vibe3d/SKILL.md`:

```markdown
---
name: vibe3d
description: Design a 3D-printable part in OpenSCAD with measured feedback — compile, check printability, look at renders, export 3MF/STL/OBJ for a slicer. Use when asked to model, design or print a part, bracket, mount, case, holder, knob, or any physical object.
---

# Vibe3D

The Vibe3D app's design loop, from the shell. Every command below is `<this skill's directory>/vibe3d …` — the directory this file is in. Needs `bun` on PATH; `look` also needs Chrome or Chromium, found on PATH or named by `VIBE3D_CHROME`. Everything else is in this directory.

## The loop

1. **Once per session:** run `vibe3d prompt` and follow it. It is the app's modelling rules — file structure, PART sections, printability, colour, BOSL2, fonts — and its skills. Write the source to a `.scad` file.
2. **Check:** `vibe3d check part.scad`. It prints the measured report (bounding box, volume, parts, genus, per-part colours and overhangs) and the app's checks. Fix every line marked `NO` and every note under "Notes on the source" before anything else. A compile error prints the kernel's line: fix it and check again.
3. **Verify against the request:** write 2 to 5 yes/no questions the request implies — the features it named, their sizes, where they sit relative to each other — and answer each from the report with one line of reasoning. Read every dimension from the report, never from a picture.
4. **Look when a number cannot answer:** `vibe3d look part.scad view.png --view front --cut z=12`, then Read the PNG. Views: `iso`, `iso_back`, `front`, `back`, `left`, `right`, `top`, `bottom`, `auto` (the best side of `--box`); `--cut axis=mm` removes the half nearer the camera; `--box x0,y0,z0,x1,y1,z1` frames a region. Construction geometry shows as a blue ghost.
5. **After a change**, keep a copy of the previous file and compare: `vibe3d check part.scad --before previous.scad` adds what was added and removed, largest pieces first, each with the side it is best seen from; `vibe3d look part.scad diff.png --before previous.scad` shows the previous version in green over the new one in magenta, unchanged material grey, with a close-up pane of the largest change when it is small.
6. **Export:** `vibe3d export part.scad part.3mf` for the slicer — one object per part, colours as materials. `.stl` or `.obj` when asked; `--part N` writes one part alone.

Iterate 2 → 5 until every check is yes and every answer is yes. Then export.

## Commands

| Command | Does |
|---|---|
| `vibe3d check part.scad [--before prev.scad] [--bed X,Y,Z]` | Report and checks; `--bed` is the printer's build volume in mm (default 256,256,256) |
| `vibe3d export part.scad out.3mf\|.stl\|.obj [--part N]` | Writes the file; OBJ gets an `.mtl` beside it when coloured |
| `vibe3d look part.scad out.png [--view V] [--cut a=mm] [--box …] [--before prev.scad]` | A PNG, 768 px; with `--before` the green/magenta composite |
| `vibe3d prompt` | The modelling rules and skills |

Files named by `import("name.stl")` in the source are read from beside the `.scad` file.
```

- [ ] **Step 6: README and CHANGELOG**

In `README.md`, after the "Libraries" section, add:

```markdown
## Local skill

The same loop for a model that runs on your machine — Claude Code, or anything that reads a
`SKILL.md` and runs a shell command. `pnpm build:skill` writes a self-contained directory to
`dist/skill`: copy it wherever skills live (`cp -r dist/skill ~/.claude/skills/vibe3d`, or into a
sandbox) and it needs only `bun`, plus Chrome or Chromium for renders. `vibe3d check` prints the
measured report and the app's checks, `vibe3d look` a named view, cut or before/after composite,
`vibe3d export` a 3MF, STL or OBJ, and `vibe3d prompt` the modelling rules the app gives its own
model. The skill's `SKILL.md` is the loop.
```

At the top of `CHANGELOG.md`, above `## v0.4.3`, add:

```markdown
## Unreleased

- **A local skill.** `pnpm build:skill` builds `dist/skill`, a copy-installable Claude Code skill
  whose `vibe3d` CLI runs the app's loop from a shell under bun: `check` (report and checks),
  `look` (views, cuts and the before/after composite through headless Chrome), `export` (3MF,
  STL, OBJ) and `prompt` (the app's modelling rules).
```

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run skills/vibe3d/cli.test.ts`
Expected: all PASS including the bundle test.

Run: `pnpm test && pnpm build`
Expected: the whole suite green, type-check clean, the app builds. Note that `pnpm build` empties `dist/`, which removes `dist/skill`; that is fine — `pnpm build:skill` recreates it.

Run: `pnpm build:skill && cp -r dist/skill /tmp/vibe3d-skill && cd /tmp && ./vibe3d-skill/vibe3d look "$OLDPWD/src/examples/mounting-plate.scad" plate.png --view auto && cd -`
Expected: `wrote plate.png` and the legend line; open `/tmp/plate.png` and see the plate.

- [ ] **Step 8: Commit**

```bash
git add skills/vibe3d/vibe3d skills/vibe3d/SKILL.md scripts/build-skill.mjs package.json skills/vibe3d/cli.test.ts README.md CHANGELOG.md
git commit -m "feat(skill): the installable vibe3d skill — wrapper, SKILL.md, build script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
