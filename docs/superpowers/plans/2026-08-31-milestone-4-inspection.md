# Milestone 4 — Change Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a turn's source compiles, the model verifies it against a measured report and one before/after render, and corrects itself once, before the turn commits.

**Architecture:** The kernel gains a `files` channel so a source can `import()` the previous and the new OFF, which is how the added/removed volumes are booleans on the kernel already loaded (§6, no new dependency). `viewer/inspect.ts` turns two OFFs into a `Report` and a framing box; `viewer/capture.ts` renders the composite on one offscreen orthographic renderer. The controller runs one verification round per turn, pushed — not model-invoked tools — and settles by the rule *once a candidate has compiled, the turn commits it unless a later candidate compiles*. The log gains an `inspect` event whose image lives for its own turn only, the same way reference images do.

**Tech Stack:** React 19, three 0.185, openscad-wasm (vendored), Vitest (node), Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-change-inspection-design.md`; requirement in `docs/design.md` §5, §6.

## Global Constraints

- No new dependencies. `pnpm build` stays clean under `strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`, lib ES2022 (no `findLast*`; `.at()` only on a known-non-negative index).
- The image of an `inspect` event never reaches the store or the project file: `stripImages` covers it, `reviveLog` never reads one back.
- `inspect.ts`'s helpers and `stats.ts` stay pure and node-testable; only `capture.ts` touches WebGL, and it returns `null` rather than throwing when there is none.
- Every image the model receives is wrapped by `verifyMessage` (§6.5). No caller may send a render with any other text.
- Ponytail is on: shortest working diff, `// ponytail:` on any deliberate ceiling.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/kernel/protocol.ts`, `openscad.worker.ts`, `compile.ts` (modify) | `files?: Readonly<Record<string, Uint8Array>>` — extra files in the kernel FS before `main()` |
| `src/kernel/stats.ts` (modify) | `+ parts`, `+ genus` on `MeshStats` |
| `src/viewer/inspect.ts` (new) | `Box`, `Report`, `boxOf`, `lerpBox`, `changeBox`, `frameBox`, `buildReport`, `formatReport`, `diffOf`, `inspect` |
| `src/viewer/capture.ts` (new) | `renderComposite(before, after, frame)` → JPEG data URL or null |
| `src/chat/prompt.ts` (modify) | `verifyMessage(reportJson, withImage)` |
| `src/chat/log.ts` (modify) | `inspect` event; live-turn-only on the wire; `stripImages`, `reviveLog` |
| `src/chat/controller.ts` (modify) | `MAX_VERIFY`, `deps.inspect`, the verification round, the settle rule |
| `src/chat/Chat.tsx` (modify) | `before` prop; the `inspect` dep; the `inspect` event's view |
| `src/App.tsx` (modify) | `before` state — the OFF of the mesh on screen |
| `src/index.css` (modify) | `.chat-inspect` |
| `e2e/chat.spec.ts` (modify) | verification round against the real build |
| `docs/design.md`, `README.md` (modify) | status, §4 file map, §5 loop, §6 "what shipped" |
| Tests | `compile.test.ts`, `stats.test.ts`, `inspect.test.ts` (new), `prompt.test.ts`, `log.test.ts`, `controller.test.ts` |

---

### Task 1: Extra files for the kernel — `files`

**Files:** Modify `src/kernel/protocol.ts`, `src/kernel/openscad.worker.ts`, `src/kernel/compile.ts`, `src/kernel/compile.test.ts`.

**Produces:** `CompileOptions.files?: Readonly<Record<string, Uint8Array>>`, written to the worker FS at the given absolute paths before `callMain`.

- [ ] **Step 1: Failing test** (append to `compile.test.ts`)

```ts
test('extra files travel to the worker with the request', () => {
  const compiler = new Compiler()
  try {
    const bytes = new Uint8Array([79, 70, 70])
    compiler.compile('import("old.off");', 'off', { files: { '/old.off': bytes } })
    expect(FakeWorker.instances[0]?.sent[0]).toMatchObject({ files: { '/old.off': bytes } })
  } finally {
    compiler.dispose()
  }
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/kernel/compile.test.ts` — expect a type error on `files`.

- [ ] **Step 3: Implement**

`protocol.ts` — add to `CompileRequest`:

```ts
  /**
   * Written to the kernel's FS before main() runs, keyed by absolute path.
   * What lets a source `import()` a mesh — the diff booleans of design.md §6.
   */
  files?: Readonly<Record<string, Uint8Array>>
```

`openscad.worker.ts` — destructure `files` and, after `kernel.FS.writeFile('/in.scad', source)`:

```ts
    for (const [path, bytes] of Object.entries(files ?? {})) kernel.FS.writeFile(path, bytes)
```

`compile.ts` — `CompileOptions` gains `files?: Readonly<Record<string, Uint8Array>>`; destructure it with `defines` and send `{ source, format, defines, files } satisfies CompileRequest`.

- [ ] **Step 4: Run** the file's tests — PASS.

---

### Task 2: Parts and genus — `stats.ts`

**Files:** Modify `src/kernel/stats.ts`, `src/kernel/stats.test.ts`.

**Produces:** `MeshStats.parts: number` (connected components by shared vertex), `MeshStats.genus: number | null` (Euler; null when not watertight).

- [ ] **Step 1: Failing tests.** Replace the `box` helper in `stats.test.ts` with one that can offset and concatenate, and add three tests:

```ts
/** Axis-aligned box from `at` to `at + [w,d,h]`, outward-facing, as vertex and face lists. */
function boxLists(w: number, d: number, h: number, at: [number, number, number] = [0, 0, 0]) {
  const [x, y, z] = at
  const v = [
    [x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z],
    [x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [1, 2, 6], [1, 6, 5], // right
    [2, 3, 7], [2, 7, 6], // back
    [3, 0, 4], [3, 4, 7], // left
  ]
  return { v, f }
}

const off = (v: number[][], f: number[][]): string =>
  `OFF\n${v.length} ${f.length} 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f
    .map((t) => `3 ${t.join(' ')}`)
    .join('\n')}\n`

function box(w: number, d: number, h: number): string {
  const { v, f } = boxLists(w, d, h)
  return off(v, f)
}

/** Two boxes that share nothing, as one file. */
function twoBoxes(): string {
  const a = boxLists(10, 10, 10)
  const b = boxLists(10, 10, 10, [20, 0, 0])
  return off([...a.v, ...b.v], [...a.f, ...b.f.map((t) => t.map((i) => i + a.v.length))])
}

/** A coarse torus: an n×m grid of quads wrapping in both directions. Genus 1 by construction. */
function torus(n = 8, m = 6): string {
  const v: number[][] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const u = (2 * Math.PI * i) / n
      const w = (2 * Math.PI * j) / m
      const r = 10 + 3 * Math.cos(w)
      v.push([r * Math.cos(u), r * Math.sin(u), 3 * Math.sin(w)])
    }
  }
  const f: number[][] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j
      const b = ((i + 1) % n) * m + j
      const c = ((i + 1) % n) * m + ((j + 1) % m)
      const d = i * m + ((j + 1) % m)
      f.push([a, b, c], [a, c, d])
    }
  }
  return off(v, f)
}

test('one box is one part of genus zero', () => {
  const s = meshStats(parseOff(box(10, 20, 30)))
  expect(s.parts).toBe(1)
  expect(s.genus).toBe(0)
})

test('two disjoint boxes are two parts, still genus zero', () => {
  const s = meshStats(parseOff(twoBoxes()))
  expect(s.parts).toBe(2)
  expect(s.genus).toBe(0)
  expect(s.watertight).toBe(true)
})

test('a torus has genus one, and an open mesh has no genus', () => {
  const t = meshStats(parseOff(torus()))
  expect(t.watertight).toBe(true)
  expect(t.parts).toBe(1)
  expect(t.genus).toBe(1)
  const open = meshStats(parseOff('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'))
  expect(open.genus).toBeNull()
  expect(open.parts).toBe(1)
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/kernel/stats.test.ts` — the three new tests fail on `parts`/`genus` being undefined.

- [ ] **Step 3: Implement.** In `stats.ts`:

```ts
export interface MeshStats {
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  /** mm³. null when the mesh is not watertight, because the figure would be meaningless. */
  volume: number | null
  watertight: boolean
  /** Connected components, by shared vertex — "how many solids". */
  parts: number
  /**
   * Total genus across parts, from Euler's formula on a closed surface. null
   * when not watertight, because the formula needs one.
   */
  genus: number | null
}

/**
 * Distinct undirected edges, and whether every one of them is shared by
 * exactly two triangles. OpenSCAD's OFF output is already indexed and welded,
 * so comparing index pairs is sufficient — no vertex merging step is needed.
 */
function edgeCensus(indices: Uint32Array): { edges: number; watertight: boolean } {
  if (indices.length === 0) return { edges: 0, watertight: false }
  const seen = new Map<string, number>()
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i]!, indices[i + 1]!, indices[i + 2]!]
    for (let e = 0; e < 3; e++) {
      const a = t[e]!
      const b = t[(e + 1) % 3]!
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
  }
  let watertight = true
  for (const count of seen.values()) if (count !== 2) watertight = false
  return { edges: seen.size, watertight }
}

/** Connected components over the vertices a face touches. Union-find, path-compressed. */
function partCensus(indices: Uint32Array, vertexCount: number): { parts: number; used: number } {
  const parent = new Uint32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    while (parent[i] !== root) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(indices[i]!)
    parent[find(indices[i + 1]!)] = a
    parent[find(indices[i + 2]!)] = a
  }
  const roots = new Set<number>()
  const used = new Set<number>()
  for (let i = 0; i < indices.length; i++) {
    used.add(indices[i]!)
    roots.add(find(indices[i]!))
  }
  return { parts: roots.size, used: used.size }
}
```

and in `meshStats`, replace the `isWatertight` line and the return:

```ts
  const { edges, watertight } = edgeCensus(indices)
  const { parts, used } = partCensus(indices, mesh.vertexCount)
  const faces = indices.length / 3
  return {
    triangles: faces,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volume: watertight ? Math.abs(signedVolume(mesh)) : null,
    watertight,
    parts,
    // χ = V − E + F = 2·parts − 2·genus for a closed surface.
    genus: watertight ? (2 * parts - (used - edges + faces)) / 2 : null,
  }
```

Delete `isWatertight`.

- [ ] **Step 4: Run** the file's tests — PASS, the existing four included.

---

### Task 3: The report and the render — `inspect.ts`, `capture.ts`

**Files:** Create `src/viewer/inspect.ts`, `src/viewer/capture.ts`, `src/viewer/inspect.test.ts`.

**Interfaces:**
- Consumes: `Compiler` (`files` option from Task 1), `meshStats` (`parts`, `genus` from Task 2), `parseOff`, `Vec3` from `camera.ts`.
- Produces: `Box`, `Report`, `DiffResult`, `boxOf`, `lerpBox`, `changeBox`, `frameBox`, `buildReport`, `formatReport`, `diffOf`, `inspect(input: InspectInput): Promise<Inspection>` where `Inspection = { report: Report; image: string | null }`; `renderComposite(before: Mesh | null, after: Mesh, frame: Box): string | null`.

- [ ] **Step 1: Failing tests** — `src/viewer/inspect.test.ts`:

```ts
import { expect, test } from 'vitest'
import type { CompileResult } from '../kernel/compile'
import { parseOff } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import { buildReport, changeBox, diffOf, formatReport, frameBox, lerpBox, type Report } from './inspect'

/** Axis-aligned box from (0,0,0) to (w,d,h), outward-facing, watertight. */
function box(w: number, d: number, h: number): string {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  return `OFF\n8 12 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f
    .map((t) => `3 ${t.join(' ')}`)
    .join('\n')}\n`
}
const stats = (w: number, d: number, h: number) => meshStats(parseOff(box(w, d, h)))
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const fail = (stderrRaw: string): CompileResult => ({ ok: false, stderr: stderrRaw, stderrRaw, ms: 1 })

test('a diff that exported is a mesh; an empty top-level object is "empty"; anything else is unknown', () => {
  const mesh = diffOf({ ok: true, data: bytes(box(1, 1, 1)), stderr: '', stderrRaw: '', ms: 1 })
  expect(mesh !== null && mesh !== 'empty' && mesh.triangleCount).toBe(12)
  expect(diffOf(fail('Could not initialize localization\nCurrent top level object is empty.\n'))).toBe('empty')
  expect(diffOf(fail('ERROR: Parser error'))).toBeNull()
  expect(diffOf({ ok: true, data: bytes('not off'), stderr: '', stderrRaw: '', ms: 1 })).toBeNull()
})

test('the frame sits a quarter of the way from the change to the whole model', () => {
  const change = { min: [0, 0, 0] as const, max: [10, 10, 10] as const }
  const model = { min: [0, 0, 0] as const, max: [40, 40, 40] as const }
  expect(lerpBox(change, model, 0.25)).toEqual({ min: [0, 0, 0], max: [17.5, 17.5, 17.5] })
  expect(frameBox(change, model)).toEqual({ min: [0, 0, 0], max: [17.5, 17.5, 17.5] })
  expect(frameBox(null, model)).toBe(model)
})

test('the change box is the union of what was added and what was removed', () => {
  expect(changeBox(null, null)).toBeNull()
  expect(changeBox('empty', 'empty')).toBeNull()
  expect(changeBox(stats(10, 20, 30), 'empty')).toEqual({ min: [0, 0, 0], max: [10, 20, 30] })
  expect(changeBox(stats(10, 20, 30), stats(5, 5, 40))).toEqual({ min: [0, 0, 0], max: [10, 20, 40] })
})

test('a first generation reports the part alone, every diff field null', () => {
  const report = buildReport({ after: stats(10, 20, 30), before: null, added: null, removed: null })
  expect(report).toEqual({
    model_bbox_mm: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] },
    volume_mm3: 6000,
    watertight: true,
    parts: 1,
    genus: 0,
    tri_count: 12,
    was: null,
    changed_bbox_mm: null,
    added_volume_mm3: null,
    removed_volume_mm3: null,
    bbox_min_shift_mm: null,
  } satisfies Report)
})

test('a change reports what was, what moved, and the two volumes, rounded to 0.1', () => {
  const report = buildReport({
    after: stats(10, 20, 20),
    before: stats(10, 20, 30),
    added: 'empty',
    removed: stats(10, 20, 10),
  })
  expect(report.was).toEqual({
    bbox_mm: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] },
    volume_mm3: 6000,
    parts: 1,
    genus: 0,
    tri_count: 12,
  })
  expect(report.added_volume_mm3).toBe(0)
  expect(report.removed_volume_mm3).toBe(2000)
  expect(report.changed_bbox_mm).toEqual({ min: [0, 0, 0], max: [10, 20, 10] })
  expect(report.bbox_min_shift_mm).toEqual([0, 0, 0])
  // Unknown stays unknown: a failed boolean must not read as "nothing removed".
  expect(buildReport({ after: stats(1, 1, 1), before: stats(1, 1, 1), added: null, removed: null }))
    .toMatchObject({ added_volume_mm3: null, removed_volume_mm3: null, changed_bbox_mm: null })
})

test('the formatted report is JSON, one field per line', () => {
  const report = buildReport({ after: stats(10, 20, 30), before: null, added: null, removed: null })
  const text = formatReport(report)
  expect(JSON.parse(text)).toEqual(report)
  expect(text.split('\n')).toHaveLength(Object.keys(report).length + 2)
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/viewer/inspect.test.ts` — fails: module not found.

- [ ] **Step 3: Implement `src/viewer/inspect.ts`**

```ts
import { Compiler, type CompileResult } from '../kernel/compile'
import { parseOff, type Mesh } from '../kernel/off'
import { meshStats, type MeshStats } from '../kernel/stats'
import type { Vec3 } from './camera'
import { renderComposite } from './capture'

export interface Box {
  readonly min: Vec3
  readonly max: Vec3
}

/** What a diff boolean produced: material, none at all, or no answer. */
export type DiffResult = Mesh | 'empty' | null
type DiffStats = MeshStats | 'empty' | null

interface BoxReport {
  min: Vec3
  max: Vec3
  size: Vec3
}

/** design.md §6.1, the ~200-token text diff. Field names are the wire format. */
export interface Report {
  model_bbox_mm: BoxReport
  volume_mm3: number | null
  watertight: boolean
  parts: number
  genus: number | null
  tri_count: number
  was: {
    bbox_mm: BoxReport
    volume_mm3: number | null
    parts: number
    genus: number | null
    tri_count: number
  } | null
  changed_bbox_mm: { min: Vec3; max: Vec3 } | null
  added_volume_mm3: number | null
  removed_volume_mm3: number | null
  /** The origin-move trap of §6, as a number: non-zero means the diff volumes include a move. */
  bbox_min_shift_mm: Vec3 | null
}

const r1 = (n: number): number => Math.round(n * 10) / 10
const round3 = (v: Vec3): Vec3 => [r1(v[0]), r1(v[1]), r1(v[2])]

export const boxOf = (stats: MeshStats): Box => ({ min: stats.min, max: stats.max })

export function lerpBox(a: Box, b: Box, t: number): Box {
  const mix = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ]
  return { min: mix(a.min, b.min), max: mix(a.max, b.max) }
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b
  if (!b) return a
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

const diffBox = (diff: DiffStats): Box | null =>
  diff !== null && diff !== 'empty' && diff.triangles > 0 ? boxOf(diff) : null

/** The region that changed: the union of what was added and what was removed. */
export const changeBox = (added: DiffStats, removed: DiffStats): Box | null =>
  unionBox(diffBox(added), diffBox(removed))

/** design.md §6: the changed detail and the body it fused into, in one frame. */
export const frameBox = (change: Box | null, model: Box): Box =>
  change ? lerpBox(change, model, 0.25) : model

const boxReport = (stats: MeshStats): BoxReport => ({
  min: round3(stats.min),
  max: round3(stats.max),
  size: round3(stats.size),
})
const volumeOf = (stats: MeshStats): number | null => (stats.volume === null ? null : r1(stats.volume))
const diffVolume = (diff: DiffStats): number | null =>
  diff === null ? null : diff === 'empty' ? 0 : volumeOf(diff)

export function buildReport(input: {
  after: MeshStats
  before: MeshStats | null
  added: DiffStats
  removed: DiffStats
}): Report {
  const { after, before, added, removed } = input
  const change = changeBox(added, removed)
  return {
    model_bbox_mm: boxReport(after),
    volume_mm3: volumeOf(after),
    watertight: after.watertight,
    parts: after.parts,
    genus: after.genus,
    tri_count: after.triangles,
    was: before && {
      bbox_mm: boxReport(before),
      volume_mm3: volumeOf(before),
      parts: before.parts,
      genus: before.genus,
      tri_count: before.triangles,
    },
    changed_bbox_mm: change && { min: round3(change.min), max: round3(change.max) },
    added_volume_mm3: diffVolume(added),
    removed_volume_mm3: diffVolume(removed),
    bbox_min_shift_mm: before
      ? round3([after.min[0] - before.min[0], after.min[1] - before.min[1], after.min[2] - before.min[2]])
      : null,
  }
}

/** Valid JSON, one field per line: readable in the transcript, ~200 tokens on the wire. */
export const formatReport = (report: Report): string =>
  `{\n${Object.entries(report)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(',\n')}\n}`

const decode = (off: Uint8Array): Mesh => parseOff(new TextDecoder().decode(off))

/**
 * A boolean's compile result, read. The kernel exits 1 for an empty top-level
 * object (verified against the pinned build), which here means "nothing was
 * added" — not a failure. Any other failure is an unknown, never a zero.
 */
export function diffOf(result: CompileResult): DiffResult {
  if (result.ok) {
    try {
      return decode(result.data)
    } catch {
      return null
    }
  }
  return /top level object is empty/i.test(result.stderrRaw) ? 'empty' : null
}

/** Same source for both directions; only the files swap. Relative names resolve beside /in.scad. */
const DIFF_SOURCE = 'difference() { import("keep.off"); import("cut.off"); }'
// ponytail: a boolean slower than this reports "unknown" rather than holding the turn.
const DIFF_TIMEOUT_MS = 30_000

async function diff(keep: Uint8Array, cut: Uint8Array, signal: AbortSignal): Promise<DiffResult> {
  const compiler = new Compiler()
  const cancel = (): void => compiler.cancel()
  signal.addEventListener('abort', cancel)
  try {
    return diffOf(
      await compiler.compile(DIFF_SOURCE, 'off', {
        files: { '/keep.off': keep, '/cut.off': cut },
        timeoutMs: DIFF_TIMEOUT_MS,
      }),
    )
  } catch {
    return null
  } finally {
    signal.removeEventListener('abort', cancel)
    compiler.dispose()
  }
}

const statsOf = (diff: DiffResult): DiffStats =>
  diff === null || diff === 'empty' ? diff : meshStats(diff)

export interface InspectInput {
  /** OFF of the mesh on screen when the turn started; null when nothing had compiled. */
  readonly before: Uint8Array | null
  /** OFF the turn just compiled. */
  readonly after: Uint8Array
  /**
   * Whether to spend an image on this model. The catalogue's flag is a gate
   * here, unlike §9: the app is deciding to attach, and a provider that cannot
   * read it fails the turn after a compile the user already waited for.
   */
  readonly vision: boolean
  readonly signal: AbortSignal
}

export interface Inspection {
  report: Report
  image: string | null
}

/** The evidence for one verification round: the numbers always, the render when it is worth sending. */
export async function inspect(input: InspectInput): Promise<Inspection> {
  const afterMesh = decode(input.after)
  const after = meshStats(afterMesh)
  const beforeMesh = input.before ? decode(input.before) : null
  const before = beforeMesh ? meshStats(beforeMesh) : null
  // new − old is what was added; old − new is what was removed. Two kernels, in parallel.
  const [added, removed] = input.before
    ? await Promise.all([
        diff(input.after, input.before, input.signal),
        diff(input.before, input.after, input.signal),
      ])
    : [null, null]
  const addedStats = statsOf(added)
  const removedStats = statsOf(removed)
  const report = buildReport({ after, before, added: addedStats, removed: removedStats })
  const image =
    input.vision && !input.signal.aborted
      ? renderComposite(beforeMesh, afterMesh, frameBox(changeBox(addedStats, removedStats), boxOf(after)))
      : null
  return { report, image }
}
```

- [ ] **Step 4: Implement `src/viewer/capture.ts`**

```ts
import {
  BufferAttribute, BufferGeometry, EdgesGeometry, FrontSide, LineBasicMaterial, LineSegments,
  Mesh as ThreeMesh, MeshBasicMaterial, MultiplyBlending, OrthographicCamera, Scene, Vector3,
  WebGLRenderer,
} from 'three'
import type { Mesh } from '../kernel/off'
import type { Box } from './inspect'

/** design.md §6: 768 px is the ceiling worth paying for. */
const SIZE = 768
/** Light, so the product of the two reads as grey rather than black. */
const BEFORE = 0x8cf0a0
const AFTER = 0xf090e0
const EDGE = 0x202020
const ISO = new Vector3(1, -1, 1).normalize()

let renderer: WebGLRenderer | null | undefined

/**
 * One context for the app's lifetime. A WebGL context is a scarce resource
 * (browsers cap them around 16), and one per turn would leak them. null means
 * there is no WebGL here; the round then goes text-only.
 */
function acquire(): WebGLRenderer | null {
  if (renderer === undefined) {
    try {
      renderer = new WebGLRenderer({
        canvas: document.createElement('canvas'),
        antialias: true,
        // toDataURL reads the buffer after the render call returns.
        preserveDrawingBuffer: true,
      })
      renderer.setPixelRatio(1)
      renderer.setSize(SIZE, SIZE, false)
      renderer.setClearColor(0xffffff, 1)
    } catch {
      renderer = null
    }
  }
  return renderer
}

/** Orthographic, from the iso direction, +Z up, fitted exactly to the frame box's projection. */
function frameCamera(frame: Box): OrthographicCamera {
  const center = new Vector3(...frame.min).add(new Vector3(...frame.max)).multiplyScalar(0.5)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 1e5)
  camera.up.set(0, 0, 1)
  // Distance is irrelevant to an orthographic projection; this just keeps the
  // whole part in front of the near plane.
  camera.position.copy(center).addScaledVector(ISO, 1e4)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  let half = 0
  for (let corner = 0; corner < 8; corner++) {
    const p = new Vector3(
      corner & 1 ? frame.max[0] : frame.min[0],
      corner & 2 ? frame.max[1] : frame.min[1],
      corner & 4 ? frame.max[2] : frame.min[2],
    ).applyMatrix4(camera.matrixWorldInverse)
    half = Math.max(half, Math.abs(p.x), Math.abs(p.y))
  }
  half = Math.max(half * 1.1, 1)
  camera.left = -half
  camera.right = half
  camera.top = half
  camera.bottom = -half
  camera.updateProjectionMatrix()
  return camera
}

/**
 * design.md §6.2: before in green, after in magenta, multiplied, no depth —
 * so overlap is grey and added / removed material keeps its colour — plus a
 * sparse crease outline. The outline is depth-tested against a depth-only
 * pass of both parts, so hidden creases stay hidden: dense line work is where
 * these models fail hardest.
 */
export function renderComposite(before: Mesh | null, after: Mesh, frame: Box): string | null {
  const gl = acquire()
  if (!gl) return null
  const scene = new Scene()
  const owned: { dispose(): void }[] = []
  const add = (mesh: Mesh, color: number): void => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    geometry.setIndex(new BufferAttribute(mesh.indices, 1))
    const depth = new MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
    const prepass = new ThreeMesh(geometry, depth)
    prepass.renderOrder = -1
    const tint = new MeshBasicMaterial({
      color,
      side: FrontSide,
      transparent: true,
      blending: MultiplyBlending,
      depthTest: false,
      depthWrite: false,
    })
    const edges = new EdgesGeometry(geometry, 30)
    const line = new LineBasicMaterial({ color: EDGE })
    scene.add(prepass, new ThreeMesh(geometry, tint), new LineSegments(edges, line))
    owned.push(geometry, depth, tint, edges, line)
  }
  if (before) add(before, BEFORE)
  add(after, AFTER)
  gl.render(scene, frameCamera(frame))
  const url = gl.domElement.toDataURL('image/jpeg', 0.85)
  for (const item of owned) item.dispose()
  return url
}
```

- [ ] **Step 5: Run** `pnpm vitest run src/viewer/inspect.test.ts` — PASS. (`capture.ts` is imported but never called in node; three's module import is side-effect free.) Then `pnpm tsc --noEmit -p tsconfig.json` — clean.

---

### Task 4: The verification words — `prompt.ts`

**Files:** Modify `src/chat/prompt.ts`, `src/chat/prompt.test.ts`.

**Produces:** `verifyMessage(reportJson: string, withImage: boolean): string`.

- [ ] **Step 1: Failing tests** (append to `prompt.test.ts`; adjust the import line to include `verifyMessage`)

```ts
test('the verification message wraps the report in structured questions, never a bare look', () => {
  const text = verifyMessage('{ "volume_mm3": 1 }', true)
  expect(text).toContain('{ "volume_mm3": 1 }')
  expect(text).toContain('green')
  expect(text).toContain('magenta')
  expect(text).toMatch(/Yes, No or Unclear/)
  expect(text).toMatch(/never from a picture/)
  expect(text).toMatch(/NO code block/)
  expect(text).not.toMatch(/look right/i)
})

test('without a render the message says so and asks the same questions', () => {
  const text = verifyMessage('{}', false)
  expect(text).toContain('No render is attached')
  expect(text).not.toContain('magenta')
  expect(text).toMatch(/Yes, No or Unclear/)
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/chat/prompt.test.ts` — fails on the missing export.

- [ ] **Step 3: Implement** (append to `prompt.ts`)

```ts
/**
 * design.md §6.5, the non-negotiable: every render the app sends is wrapped in
 * 2–5 binary questions derived from the request, answered with reasoning,
 * "Unclear" permitted, then a correction or a confirmation. The bare "does
 * this look right" is the measured −20% regression and never goes out.
 */
export function verifyMessage(reportJson: string, withImage: boolean): string {
  const legend = withImage
    ? 'The image is one orthographic render framed on the changed region: the previous version in green, this version in magenta, unchanged material in grey, with crease outlines. It shows layout and proportion only.'
    : 'No render is attached; work from the numbers.'
  return `The source compiled. Measured from the mesh (millimetres, mm³):

${reportJson}

${legend} Read every dimension from the report, never from a picture. If bbox_min_shift_mm is not zero the whole part moved, and the added and removed volumes include that move.

Check the part against the request:
1. Write 2 to 5 yes/no questions the request implies — about dimensions, features, and where they sit.
2. Answer each Yes, No or Unclear, with one line of reasoning from the report or the render.
3. If any answer is No, reply with the corrected COMPLETE source in one fenced block.
   If every answer is Yes or Unclear, reply with one sentence and NO code block — the source on screen stays as it is.`
}
```

- [ ] **Step 4: Run** — PASS.

---

### Task 5: The `inspect` event — `log.ts`

**Files:** Modify `src/chat/log.ts`, `src/chat/log.test.ts`.

**Produces:** `ChatEvent` variant `{ kind: 'inspect'; text: string; image?: string }`; on the wire for the live turn only, as one `user` message with the text part first; stripped and revived like a user event's images.

- [ ] **Step 1: Failing tests** (append to `log.test.ts`; add an `inspected` helper next to the others)

```ts
const inspected = (turn: number, text: string, image?: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'inspect',
  text,
  ...(image ? { image } : {}),
})

test('a live inspection is one user message, text first, then its render', () => {
  const log = [user(1, 'a box'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT', 'data:image/jpeg;base64,AAAA')]
  const messages = win(log, 1)
  expect(messages.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'REPORT' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ],
  })
  // The live reply is on the wire, so the source is not re-attached after it.
  expect(count(texts(messages).join('\n'), SRC)).toBe(0)
})

test('an inspection without a render is a plain user message, and images:false strips one', () => {
  const plain = win([user(1, 'a'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT')], 1)
  expect(plain.at(-1)).toEqual({ role: 'user', content: 'REPORT' })
  const stripped = buildWindow({
    log: [user(1, 'a'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT', 'data:x')],
    turn: 1,
    systemPrompt: SYS,
    source: SRC,
    images: false,
  })
  expect(stripped.at(-1)).toEqual({ role: 'user', content: 'REPORT' })
})

test("an earlier turn's inspection is dropped entirely, like its stderr", () => {
  const log = [user(1, 'a'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT', 'data:x'), user(2, 'b')]
  expect(texts(win(log, 2))).toEqual([SYS, 'a', expect.any(String), 'b', expect.stringContaining(SRC)])
  expect(texts(win(log, 2)).join('\n')).not.toContain('REPORT')
})

test('stripping an inspection keeps its report and drops its render', () => {
  const event = inspected(1, 'REPORT', 'data:x')
  expect(stripImages(event)).toEqual({ id: event.id, ts: 0, turn: 1, kind: 'inspect', text: 'REPORT' })
  const plain = inspected(1, 'REPORT')
  expect(stripImages(plain)).toBe(plain)
})

test('a revived inspection has its report and never a render', () => {
  const revived = reviveLog([
    { id: 'i1', ts: 1, turn: 1, kind: 'inspect', text: 'REPORT', image: 'data:x' },
    { id: 'i2', ts: 1, turn: 1, kind: 'inspect' },
  ])
  expect(revived).toEqual([{ id: 'i1', ts: 1, turn: 1, kind: 'inspect', text: 'REPORT' }])
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/chat/log.test.ts` — type errors on `kind: 'inspect'`.

- [ ] **Step 3: Implement.** In `log.ts`:

Add the variant to `ChatEvent`:

```ts
  | {
      id: string
      ts: number
      turn: number
      kind: 'inspect'
      /** The measured report wrapped in the verification questions — what the model was handed. */
      text: string
      /** The composite render, live for this turn only and never persisted, like a user event's images. */
      image?: string
    }
```

In `buildWindow`'s switch, after `case 'compile'`:

```ts
      case 'inspect': {
        // Live only, like stderr: a report about a mesh that no longer exists
        // does not just waste tokens, it misleads (design.md §12).
        if (event.turn !== turn) break
        const url = images ? event.image : undefined
        if (!url) {
          messages.push({ role: 'user', content: event.text })
          break
        }
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: event.text },
            { type: 'image_url', image_url: { url } },
          ],
        })
        break
      }
```

`stripImages`:

```ts
export function stripImages(event: ChatEvent): ChatEvent {
  if (event.kind === 'user' && event.images) {
    return { id: event.id, ts: event.ts, turn: event.turn, kind: 'user', text: event.text }
  }
  if (event.kind === 'inspect' && event.image) {
    return { id: event.id, ts: event.ts, turn: event.turn, kind: 'inspect', text: event.text }
  }
  return event
}
```

`reviveEvent`, a new case:

```ts
    case 'inspect':
      return text === null ? null : { ...base, kind: 'inspect', text }
```

- [ ] **Step 4: Run** — PASS. Then `pnpm tsc --noEmit -p tsconfig.json`: `Chat.tsx`'s `ChatEventView` switch now misses a case — expected, fixed in Task 7. Everything else clean.

---

### Task 6: The verification round — `controller.ts`

**Files:** Modify `src/chat/controller.ts`, `src/chat/controller.test.ts`.

**Interfaces:**
- Consumes: the `inspect` event (Task 5).
- Produces: `MAX_VERIFY = 1`; `TurnDeps.inspect?: (source: string, off: Uint8Array) => Promise<{ text: string; image?: string }>`; the settle rule.

- [ ] **Step 1: Failing tests.** Extend the harness: `options.inspect?: { text: string; image?: string } | 'throws'`, a `inspected: string[]` field, and

```ts
    ...(inspect === undefined
      ? {}
      : {
          inspect: async (source: string) => {
            inspected.push(source)
            if (inspect === 'throws') throw new Error('no WebGL')
            return inspect
          },
        }),
```

inside the `deps` literal (and `inspected` in the returned harness). Then append:

```ts
const REPORT = { text: 'REPORT', image: IMG }
const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' })

test('a compiled reply is inspected once, and a prose confirmation commits it', async () => {
  const h = harness({
    replies: [says(fenced('cube(3);')), says('Looks right: 3 mm cube, one part.')],
    compiles: [okResult()],
    inspect: REPORT,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'committed', source: 'cube(3);', result: okResult() })
  expect(h.inspected).toEqual(['cube(3);'])
  expect(h.windows).toHaveLength(2)
  expect(h.windows[1]?.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'REPORT' },
      { type: 'image_url', image_url: { url: IMG } },
    ],
  })
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'compile', 'inspect', 'assistant'])
})

test('a correction after inspection is compiled and committed without a second look', async () => {
  const h = harness({
    replies: [says(fenced('a')), says(fenced('b'))],
    compiles: [okResult(), okResult()],
    inspect: REPORT,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'committed', source: 'b' })
  expect(h.compiled).toEqual(['a', 'b'])
  expect(h.inspected).toEqual(['a'])
  expect(h.windows).toHaveLength(2)
})

test('re-emitting the inspected source is a confirmation, not a recompile', async () => {
  const h = harness({
    replies: [says(fenced('a')), says(fenced('a'))],
    compiles: [okResult()],
    inspect: REPORT,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'committed', source: 'a' })
  expect(h.compiled).toEqual(['a'])
})

test('a stop during verification keeps the part that compiled', async () => {
  const h = harness({
    replies: [says(fenced('a')), { events: [], error: abortError() }],
    compiles: [okResult()],
    inspect: REPORT,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'committed', source: 'a' })
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'compile', 'inspect', 'assistant', 'note'])
})

test('a correction that cannot be repaired keeps the part that compiled', async () => {
  const h = harness({
    replies: [says(fenced('a')), says(fenced('b')), says(fenced('c')), says(fenced('d'))],
    compiles: [okResult(), failResult('ERROR: b'), failResult('ERROR: c'), failResult('ERROR: d')],
    inspect: REPORT,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'committed', source: 'a', result: okResult() })
  // 1 initial + 1 verification + MAX_RETRIES repairs, and no more.
  expect(h.windows).toHaveLength(2 + MAX_RETRIES)
  expect(h.compiled).toEqual(['a', 'b', 'c', 'd'])
  expect(h.appended.at(-1)).toMatchObject({ kind: 'note', text: expect.stringContaining('Kept') })
})

test('an inspection that throws still commits what compiled', async () => {
  const h = harness({ replies: [says(fenced('a'))], compiles: [okResult()], inspect: 'throws' })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'committed', source: 'a' })
  expect(h.windows).toHaveLength(1)
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'compile', 'note'])
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/chat/controller.test.ts` — the new tests fail (type error on `inspect`, then "unscripted stream call").

- [ ] **Step 3: Implement.** In `controller.ts`:

Constants and deps:

```ts
/** One look at the compiled part per turn (design.md §6). A correction is committed without a second. */
export const MAX_VERIFY = 1
```

```ts
  /**
   * The verification round's evidence for a source that compiled: the report,
   * and the render where the model can read one. Optional — absent means no
   * round, which is the shape the pre-M4 tests exercise.
   */
  readonly inspect?: (source: string, off: Uint8Array) => Promise<{ text: string; image?: string }>
```

Restructure `runTurn`: the `for (;;)` moves into an inner `run()`; the outer body becomes

```ts
  type Verified = { source: string; result: Extract<CompileResult, { ok: true }> }
  let verified: Verified | null = null
  let verifyRounds = 0

  // Once a candidate has compiled, the turn commits it unless a later candidate
  // compiles. A stop, an error, or an unrepairable correction after that point
  // would otherwise throw away a part the user already waited for.
  const settle = (outcome: TurnOutcome): TurnOutcome => {
    if (!verified || outcome.status === 'committed') return outcome
    emit({ kind: 'note', tone: 'info', text: 'Kept the last version that compiled.' })
    return { status: 'committed', source: verified.source, result: verified.result }
  }

  const run = async (): Promise<TurnOutcome> => {
    emit({ kind: 'user', text: input.userText, images: input.images })
    for (;;) {
      ... the existing loop body, unchanged except the two edits below ...
    }
  }

  try {
    return settle(await run())
  } catch (error) {
    return settle({ status: 'error', message: messageOf(error) })
  }
```

Edit one — the echo check becomes:

```ts
      if (candidate === committed || candidate === verified?.source) return { status: 'answered' }
```

Edit two — the `if (result.ok) return {...}` line becomes:

```ts
      if (result.ok) {
        verified = { source: candidate, result }
        if (!deps.inspect || verifyRounds >= MAX_VERIFY) {
          return { status: 'committed', source: candidate, result }
        }
        verifyRounds++
        const evidence = await deps.inspect(candidate, result.data)
        if (deps.signal.aborted) return { status: 'stopped' }
        emit({ kind: 'inspect', text: evidence.text, image: evidence.image })
        continue
      }
```

(`emit` with `image: undefined` is fine — the event type's `image` is optional and `buildWindow` reads it as absent. `NewEvent` distributes, so `{ kind: 'inspect', text, image }` type-checks.)

- [ ] **Step 4: Run** the whole file — PASS, all pre-existing tests included (they pass no `inspect`, so nothing changes for them).

---

### Task 7: Wiring — `Chat.tsx`, `App.tsx`, `index.css`

**Files:** Modify `src/chat/Chat.tsx`, `src/App.tsx`, `src/index.css`.

**Interfaces:** Consumes `inspect`, `formatReport` (Task 3), `verifyMessage` (Task 4), the `inspect` event (Task 5), `deps.inspect` (Task 6).

- [ ] **Step 1: `App.tsx`** — the OFF of the mesh on screen:

```ts
  // design.md §6: the "was" of a turn's inspection. Only a define-free compile
  // or a turn sets it, so a slider drag's reduced-$fn preview is never the before.
  const [before, setBefore] = useState<Uint8Array | null>(null)
```

In the debounce effect, next to `commitEdit`:

```ts
        if (result.ok && previewDefines.length === 0) {
          setBefore(result.data)
          setSession((s) => (s ? commitEdit(s, source, Date.now()) : s))
        }
```

In `onApply`, after `applyCompiled(...)`: `if (result.ok) setBefore(result.data)`. Pass `before={before}` to `<Chat>`.

- [ ] **Step 2: `Chat.tsx`** — the prop, the dep, the view.

Imports: `import { formatReport, inspect } from '../viewer/inspect'` and `verifyMessage` from `./prompt`.

Prop: `before: Uint8Array | null` with the doc comment `/** OFF of the mesh on screen — what a turn's inspection compares against. null when nothing has compiled. */`.

In the `runTurn` deps, after `compile`:

```ts
          inspect: async (_candidate, off) => {
            const { report, image } = await inspect({
              before,
              after: off,
              vision: models.find((m) => m.id === settings.model)?.vision ?? false,
              signal: controller.signal,
            })
            return { text: verifyMessage(formatReport(report), image !== null), ...(image ? { image } : {}) }
          },
```

In `ChatEventView`:

```tsx
    case 'inspect':
      return (
        <div className="chat-inspect">
          {event.image && <img src={event.image} alt="Before in green, after in magenta" />}
          <details>
            <summary className="chip">inspected</summary>
            <pre>{event.text}</pre>
          </details>
        </div>
      )
```

- [ ] **Step 3: `index.css`** (after `.msg-images img`):

```css
/* A verification round: the composite the model saw, and the report behind a toggle. */
.chat-inspect { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.chat-inspect img {
  width: 192px; height: 192px; display: block; background: #fff;
  border: 1px solid #dfe2db; border-radius: 2px;
}
.chat-inspect summary { cursor: pointer; list-style: none; }
.chat-inspect summary::-webkit-details-marker { display: none; }
.chat-inspect pre {
  font: 11px/1.5 ui-monospace, monospace; white-space: pre-wrap; margin: 6px 0 0; padding: 8px 10px;
  background: #fff; border: 1px solid #dfe2db; border-radius: 2px; color: #414741;
  max-height: 240px; overflow: auto;
}
```

- [ ] **Step 4: Verify** `pnpm build` clean, `pnpm test` green.

---

### Task 8: End to end

**Files:** Modify `e2e/chat.spec.ts`.

- [ ] **Step 1: Two tests** (append)

```ts
test('a compiled turn is verified against a report and a render before it commits', async ({
  page,
}) => {
  await seedKey(page)
  const bodies: string[] = []
  let call = 0
  await page.route(CHAT_URL, (route) => {
    bodies.push(JSON.stringify(route.request().postDataJSON()))
    call += 1
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(
        call === 1 ? fenced('cube([12, 8, 4]);') : 'Looks right: 12 × 8 × 4 mm, one part, no holes.',
      ),
    })
  })

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a 12 by 8 by 4 mm block')

  await expect(page.locator('.chat-inspect img')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 })
  expect(call).toBe(2)
  await expect(page.locator('.tag', { hasText: '12.0 × 8.0 × 4.0 mm' })).toBeVisible()

  // The second call is the verification round: the report, then the render,
  // as one user message with the text part first.
  const verify = JSON.parse(bodies[1] ?? '{}') as {
    messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[]
  }
  const last = verify.messages.at(-1)
  expect(last?.role).toBe('user')
  const parts = Array.isArray(last?.content) ? last.content : []
  expect(parts.map((p) => p.type)).toEqual(['text', 'image_url'])
  const text = parts[0]?.text ?? ''
  expect(text).toContain('"volume_mm3": 384')
  // The starter plate was on screen, so there is a "was" and a removed volume.
  expect(text).toMatch(/"removed_volume_mm3": \d/)
  expect(text).toContain('Unclear')
  const url = parts[1]?.image_url?.url ?? ''
  expect(url).toMatch(/^data:image\/jpeg;base64,/)
  expect(url.length).toBeGreaterThan(2000)
  await test.info().attach('composite', {
    body: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
    contentType: 'image/jpeg',
  })
})

test('a correction from the verification round is compiled and committed', async ({ page }) => {
  await seedKey(page)
  let call = 0
  await page.route(CHAT_URL, (route) => {
    call += 1
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced(call === 1 ? 'cube([12, 8, 4]);' : 'cube([12, 8, 5]);')),
    })
  })

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a block')

  await expect(page.locator('.tag', { hasText: '12.0 × 8.0 × 5.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 })
  // One look, no second: the correction commits without a third call.
  expect(call).toBe(2)
  await expect(page.locator('.cm-content')).toContainText('cube([12, 8, 5]);')
})
```

- [ ] **Step 2: Run** `pnpm e2e` — all green. Open the attached `composite` JPEG under `test-results/` and check by eye: grey where the plate and the block overlap, magenta for the block's new material, green for the removed plate, crease lines sparse.

---

### Task 9: Docs

**Files:** Modify `docs/design.md`, `README.md`.

- [ ] **Step 1: `design.md`.** Status line: "Milestones 1–4 shipped — … change inspection (M4)." §4: `capture.ts` → "offscreen 768² orthographic composite (§6)", `inspect.ts` → "measured report, diff booleans, framing (§6)". §5's loop: replace "deterministic checks → answer (vision-refine rounds are Milestone 4, not Milestone 2)" with "verification round (§6): report + render, one correction, then answer". §6: append a "Shipped 2026-08-31" paragraph carrying the spec's deviation table in prose — controller-pushed round instead of tools, `MAX_VERIFY = 1`, the settle rule, the toggle not built, the vision flag gating the app's own render.

- [ ] **Step 2: `README.md`.** One sentence in the feature list: after a compile the model checks its work against measured volumes and a before/after render, and corrects itself once.

- [ ] **Step 3: Verify** `pnpm build && pnpm test && pnpm e2e`.

---

## Self-review

- **Spec coverage:** report (T3), render (T3), verification words (T4), one round + settle rule (T6), live-only image on the wire and never persisted (T5), vision gate (T7), `before` = mesh on screen (T7), kernel diff via `files` (T1, T3), parts/genus (T2), e2e (T8), docs (T9). Deviations documented in the spec and carried to design.md (T9).
- **Types:** `DiffStats` is internal; `changeBox`/`buildReport` take it and the test passes `MeshStats` / `'empty'` / `null`, which is assignable. `TurnDeps.inspect` returns `{ text; image?: string }`, matching the event's `image?: string`. `Inspection.image` is `string | null`, converted in `Chat.tsx`.
