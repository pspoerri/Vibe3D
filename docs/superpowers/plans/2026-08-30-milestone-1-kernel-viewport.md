# Milestone 1 — Kernel & Viewport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable static site where you type OpenSCAD into an editor, it compiles in the browser, renders as a 3D mesh you can orbit, reports its own dimensions, and exports STL and 3MF — with no AI involved yet.

**Architecture:** OpenSCAD compiled to WebAssembly runs in a dedicated Web Worker, one fresh worker per compile (the kernel's `callMain` runs `main()` to process exit, so instances are single-use, and `terminate()` on supersede gives free cancellation). The kernel writes an OFF file into its in-memory filesystem; the main thread parses that into a `THREE.BufferGeometry` and renders it. Nothing crosses the network at runtime.

**Tech Stack:** Vite 8.2.2, React 19.2.8, TypeScript 7.0.2, three.js 0.185.1, CodeMirror 6, Vitest 4.1.11, Playwright 1.62.1, pnpm.

**Spec:** `docs/design.md`

## Global Constraints

- **License GPL-3.0.** The bundled OpenSCAD wasm is GPL-2.0-or-later and links Manifold (Apache-2.0). Every source file gets no header, but `LICENSE` must be GPL-3.0 and `README.md` must state the kernel's origin and license.
- **Units are millimetres. Z is up.** Model space is OpenSCAD's; the viewport converts for display only.
- **No cross-origin isolation.** Never add COOP/COEP headers. The kernel is single-threaded and adding them would break remote assets for nothing.
- **`base: './'` in Vite config.** One build artifact must deploy unchanged to a GitHub Pages subpath or any other static host. This forbids a path-based router — the app stays single-route.
- **Never bundle the kernel into the main chunk.** It must be reachable only from the worker chunk, so it loads lazily on first compile.
- **Node >= 22.12** for the toolchain.
- **Pure logic is tested in Vitest (node env); anything touching the real kernel or WebGL is tested in Playwright.** The vendored web build is browser/worker-only and will not load in node — do not attempt a node integration test of the kernel.

---

## File Structure

| File | Responsibility |
|---|---|
| `vite.config.ts` | Build config. `base: './'`, ES workers. |
| `src/kernel/vendor/openscad.js` | Vendored kernel glue (ESM, ~100 KB). Never edited. |
| `src/kernel/vendor/openscad.wasm` | Vendored kernel (~10.7 MB). Never edited. |
| `src/kernel/protocol.ts` | Message types shared between main thread and worker. |
| `src/kernel/noise.ts` | Strips the kernel's unconditional stderr noise. Pure. |
| `src/kernel/off.ts` | OFF text → `Mesh`. Pure. |
| `src/kernel/stats.ts` | `Mesh` → bbox / volume / watertightness. Pure. |
| `src/kernel/openscad.worker.ts` | Runs one compile then dies. |
| `src/kernel/compile.ts` | Main-thread API. Owns worker lifecycle, cancellation, timeout. |
| `src/viewer/Viewport.tsx` | three.js canvas, orbit controls, build plate. |
| `src/editor/openscad-mode.ts` | CodeMirror syntax mode for OpenSCAD. |
| `src/editor/Editor.tsx` | CodeMirror mount. |
| `src/export/download.ts` | Kernel bytes → file download. |
| `src/App.tsx` | Wires editor ↔ compiler ↔ viewport; debounce, errors, stats. |

Tasks 3, 4 and the pure half of 5 are dependency-free and fully unit-tested. Tasks 6–9 depend on them.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `LICENSE`, `README.md`
- Test: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm build`, `pnpm test`, `pnpm dev`. All later tasks assume these scripts exist.

- [ ] **Step 1: Initialise the package**

```bash
cd /Users/pascal/Code/ai-modeller
pnpm init
pnpm add react@19.2.8 react-dom@19.2.8 three@0.185.1
pnpm add -D vite@8.2.2 @vitejs/plugin-react@6.1.1 typescript@7.0.2 \
  @types/react@19 @types/react-dom@19 @types/three@0.185.4 \
  vitest@4.1.11 @playwright/test@1.62.1
```

- [ ] **Step 2: Write `package.json` scripts**

Replace the `"scripts"` block in `package.json` with:

```json
{
  "type": "module",
  "license": "GPL-3.0-or-later",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  }
}
```

- [ ] **Step 3: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base so one build artifact deploys to a GH Pages subpath,
  // a custom domain, or anywhere else. Forbids a path-based router.
  base: './',
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowJs": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ai-modeller</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write the app entry**

`src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/App.tsx`:

```tsx
export function App() {
  return <main>ai-modeller</main>
}
```

`src/index.css`:

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font: 14px/1.5 system-ui, sans-serif; }
```

- [ ] **Step 7: Write the smoke test**

`src/smoke.test.ts`:

```ts
import { expect, test } from 'vitest'

test('test runner is wired up', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 8: Run the test and the build**

```bash
pnpm test && pnpm build
```

Expected: test PASSES, build writes `dist/index.html` and hashed assets.

- [ ] **Step 9: Write LICENSE and README**

Write the full GPL-3.0 text to `LICENSE` (fetch from `https://www.gnu.org/licenses/gpl-3.0.txt`).

`README.md`:

```markdown
# ai-modeller

A browser-only 3D modelling tool. Write OpenSCAD, see the model, export STL or 3MF.
Nothing leaves your browser.

Design: [docs/design.md](docs/design.md)

## Licensing

GPL-3.0-or-later. This project bundles the OpenSCAD WebAssembly build, which is
GPL-2.0-or-later and links Manifold (Apache-2.0); GPL-3.0 is the compatible
combination. OpenSCAD is © the OpenSCAD developers — https://openscad.org/

## Development

    pnpm install
    pnpm dev
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TS project"
```

---

### Task 2: Vendor the OpenSCAD kernel

**Files:**
- Create: `src/kernel/vendor/openscad.js`, `src/kernel/vendor/openscad.wasm`, `src/kernel/vendor/VERSION`, `src/kernel/vendor/openscad.d.ts`
- Test: `src/kernel/vendor/vendor.test.ts`

**Interfaces:**
- Produces: a default-exported async factory `OpenSCAD(opts) => Promise<OpenSCADModule>` with `FS` and `callMain`. Task 5 consumes it.

The snapshot URL is **not permanent** — nightly snapshots are rotated off the server. Vendoring the binary into the repo is deliberate.

- [ ] **Step 1: Download and pin the snapshot**

```bash
mkdir -p src/kernel/vendor && cd src/kernel/vendor
curl -sSO https://files.openscad.org/snapshots/OpenSCAD-2026.08.30-WebAssembly-web.zip
unzip -o OpenSCAD-2026.08.30-WebAssembly-web.zip
rm OpenSCAD-2026.08.30-WebAssembly-web.zip
shasum -a 256 openscad.js openscad.wasm | tee VERSION
sed -i '' '1i\
OpenSCAD 2026.08.30 WebAssembly (web build) — https://files.openscad.org/snapshots/\
' VERSION
cd ../../..
```

- [ ] **Step 2: Verify what was downloaded**

```bash
ls -l src/kernel/vendor/
```

Expected: `openscad.js` is 99,853 bytes and `openscad.wasm` is 10,726,590 bytes.

```bash
grep -c "SharedArrayBuffer\|pthread" src/kernel/vendor/openscad.js
```

Expected: `0`. If this is not zero, **stop** — a threaded build would require cross-origin isolation, which the Global Constraints forbid.

- [ ] **Step 3: Write the type declaration**

The vendored glue ships no types. `src/kernel/vendor/openscad.d.ts`:

```ts
export interface OpenSCADFS {
  writeFile(path: string, data: string | Uint8Array): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
}

export interface OpenSCADModule {
  FS: OpenSCADFS
  /** Runs main() to process exit — the module instance is single-use afterwards. */
  callMain(args: string[]): number
}

export interface OpenSCADOptions {
  noInitialRun?: boolean
  locateFile?: (path: string) => string
  print?: (text: string) => void
  printErr?: (text: string) => void
}

declare const OpenSCAD: (options?: OpenSCADOptions) => Promise<OpenSCADModule>
export default OpenSCAD
```

- [ ] **Step 4: Write the integrity test**

`src/kernel/vendor/vendor.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const sha = (p: string) =>
  createHash('sha256').update(readFileSync(new URL(p, import.meta.url))).digest('hex')

test('vendored kernel matches the pinned checksums', () => {
  const pins = readFileSync(new URL('./VERSION', import.meta.url), 'utf8')
  expect(pins).toContain(sha('./openscad.js'))
  expect(pins).toContain(sha('./openscad.wasm'))
})

test('vendored kernel is single-threaded', () => {
  const glue = readFileSync(new URL('./openscad.js', import.meta.url), 'utf8')
  expect(glue).not.toMatch(/SharedArrayBuffer|pthread/)
})
```

- [ ] **Step 5: Run the test**

```bash
pnpm test src/kernel/vendor
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(kernel): vendor pinned OpenSCAD 2026.08.30 wasm build"
```

---

### Task 3: OFF parser

**Files:**
- Create: `src/kernel/off.ts`
- Test: `src/kernel/off.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Mesh { positions: Float32Array; indices: Uint32Array; vertexCount: number; triangleCount: number }
  function parseOff(text: string): Mesh
  ```
  Tasks 4, 5 and 6 consume both.

Real OpenSCAD output looks like this — note the **trailing per-face RGB**, which must be ignored:

```
OFF
520 1052 0
-30 -20 -1.5
-24.9567 -16.3097 -1.5
3 84 9 19 157 203 81
```

- [ ] **Step 1: Write the failing test**

`src/kernel/off.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseOff } from './off'

const TETRA = `OFF
4 4 0
0 0 0
1 0 0
0 1 0
0 0 1
3 0 2 1
3 0 1 3
3 0 3 2
3 1 2 3
`

test('parses vertices and triangles', () => {
  const m = parseOff(TETRA)
  expect(m.vertexCount).toBe(4)
  expect(m.triangleCount).toBe(4)
  expect(Array.from(m.positions.slice(0, 3))).toEqual([0, 0, 0])
  expect(Array.from(m.indices.slice(0, 3))).toEqual([0, 2, 1])
})

test('ignores trailing per-face colour, which OpenSCAD always emits', () => {
  const m = parseOff(`OFF
3 1 0
0 0 0
1 0 0
0 1 0
3 0 1 2 157 203 81
`)
  expect(m.triangleCount).toBe(1)
  expect(Array.from(m.indices)).toEqual([0, 1, 2])
})

test('fan-triangulates an n-gon face', () => {
  const m = parseOff(`OFF
4 1 0
0 0 0
1 0 0
1 1 0
0 1 0
4 0 1 2 3
`)
  expect(m.triangleCount).toBe(2)
  expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3])
})

test('accepts counts on the header line', () => {
  const m = parseOff('OFF 3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')
  expect(m.triangleCount).toBe(1)
})

test('skips comments and blank lines', () => {
  const m = parseOff('OFF\n# a comment\n\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')
  expect(m.vertexCount).toBe(3)
})

test('rejects data that is not OFF', () => {
  expect(() => parseOff('solid cube\n')).toThrow(/not an OFF file/)
})

test('rejects a truncated file', () => {
  expect(() => parseOff('OFF\n4 4 0\n0 0 0\n')).toThrow(/unexpected end/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/kernel/off
```

Expected: FAIL — `Failed to resolve import "./off"`.

- [ ] **Step 3: Write the implementation**

`src/kernel/off.ts`:

```ts
export interface Mesh {
  /** Flat xyz triplets, one per vertex. */
  positions: Float32Array
  /** Flat triangle indices into `positions`. */
  indices: Uint32Array
  vertexCount: number
  triangleCount: number
}

/**
 * Parses the OFF that `openscad --export-format=off` produces.
 *
 * Shape: a magic line, then `nVerts nFaces nEdges`, then one vertex per line,
 * then one face per line as `n i0 i1 .. i(n-1) [r g b]`. The Manifold backend
 * always emits triangles, but n-gons are fan-triangulated defensively.
 */
export function parseOff(text: string): Mesh {
  const lines = text.split('\n')
  let cursor = 0

  const nextLine = (): string => {
    while (cursor < lines.length) {
      const line = lines[cursor++]!.trim()
      if (line && !line.startsWith('#')) return line
    }
    throw new Error('unexpected end of OFF data')
  }

  // Counts sit on their own line in OpenSCAD's output, but the OFF format also
  // permits `OFF 4 4 0` on one line. Accept both.
  const header = nextLine().split(/\s+/)
  if (header[0] !== 'OFF') {
    throw new Error(`not an OFF file (got ${JSON.stringify(header[0]?.slice(0, 16) ?? '')})`)
  }
  const counts = header.length > 1 ? header.slice(1) : nextLine().split(/\s+/)
  const vertexCount = Number(counts[0])
  const faceCount = Number(counts[1])
  if (!Number.isInteger(vertexCount) || !Number.isInteger(faceCount)) {
    throw new Error('OFF header does not declare vertex and face counts')
  }

  const positions = new Float32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) {
    const parts = nextLine().split(/\s+/)
    for (let axis = 0; axis < 3; axis++) {
      const value = Number(parts[axis])
      if (!Number.isFinite(value)) throw new Error(`invalid vertex on OFF line ${cursor}`)
      positions[v * 3 + axis] = value
    }
  }

  const indices: number[] = []
  for (let f = 0; f < faceCount; f++) {
    const parts = nextLine().split(/\s+/)
    const n = Number(parts[0])
    if (!Number.isInteger(n) || n < 3) throw new Error(`degenerate face on OFF line ${cursor}`)
    // parts[1..n] are the vertex indices; anything after them is per-face
    // colour, which we discard.
    const first = Number(parts[1])
    for (let k = 1; k <= n - 2; k++) {
      indices.push(first, Number(parts[1 + k]), Number(parts[2 + k]))
    }
  }

  return {
    positions,
    indices: Uint32Array.from(indices),
    vertexCount,
    triangleCount: indices.length / 3,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/kernel/off
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/off.ts src/kernel/off.test.ts
git commit -m "feat(kernel): parse OpenSCAD OFF output into a mesh"
```

---

### Task 4: Mesh statistics

**Files:**
- Create: `src/kernel/stats.ts`
- Test: `src/kernel/stats.test.ts`

**Interfaces:**
- Consumes: `Mesh` from `./off`.
- Produces:
  ```ts
  interface MeshStats {
    triangles: number
    min: [number, number, number]
    max: [number, number, number]
    size: [number, number, number]
    volume: number | null   // null when not watertight
    watertight: boolean
  }
  function meshStats(mesh: Mesh): MeshStats
  ```
  Task 8 renders this; Milestone 2's `measure()` tool reuses it verbatim.

`volume` returns `null` rather than a number when the mesh is not watertight. A signed-tetrahedron sum over an open mesh yields a plausible-looking but meaningless figure, and showing the user a fabricated cm³ is worse than showing nothing.

- [ ] **Step 1: Write the failing test**

`src/kernel/stats.test.ts`:

```ts
import { expect, test } from 'vitest'
import { parseOff } from './off'
import { meshStats } from './stats'

/** Axis-aligned box from (0,0,0) to (w,d,h), outward-facing, watertight. */
function box(w: number, d: number, h: number): string {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [1, 2, 6], [1, 6, 5], // right
    [2, 3, 7], [2, 7, 6], // back
    [3, 0, 4], [3, 4, 7], // left
  ]
  return `OFF\n8 12 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f
    .map((t) => `3 ${t.join(' ')}`)
    .join('\n')}\n`
}

test('reports triangle count and bounding box', () => {
  const s = meshStats(parseOff(box(10, 20, 30)))
  expect(s.triangles).toBe(12)
  expect(s.min).toEqual([0, 0, 0])
  expect(s.max).toEqual([10, 20, 30])
  expect(s.size).toEqual([10, 20, 30])
})

test('computes volume of a watertight box', () => {
  const s = meshStats(parseOff(box(10, 20, 30)))
  expect(s.watertight).toBe(true)
  expect(s.volume).toBeCloseTo(6000, 6)
})

test('refuses to report volume for an open mesh', () => {
  // A single triangle: every edge is used once, so it cannot be closed.
  const s = meshStats(parseOff('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'))
  expect(s.watertight).toBe(false)
  expect(s.volume).toBeNull()
})

test('handles an empty mesh without dividing by zero', () => {
  const s = meshStats(parseOff('OFF\n0 0 0\n'))
  expect(s.triangles).toBe(0)
  expect(s.size).toEqual([0, 0, 0])
  expect(s.volume).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/kernel/stats
```

Expected: FAIL — `Failed to resolve import "./stats"`.

- [ ] **Step 3: Write the implementation**

`src/kernel/stats.ts`:

```ts
import type { Mesh } from './off'

export interface MeshStats {
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  /** mm³. null when the mesh is not watertight, because the figure would be meaningless. */
  volume: number | null
  watertight: boolean
}

/**
 * A mesh is watertight when every undirected edge is shared by exactly two
 * triangles. OpenSCAD's OFF output is already indexed and welded, so comparing
 * index pairs is sufficient — no vertex merging step is needed.
 */
function isWatertight(indices: Uint32Array): boolean {
  if (indices.length === 0) return false
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
  for (const count of seen.values()) if (count !== 2) return false
  return true
}

/** Signed sum of tetrahedra from the origin. Only meaningful for a closed mesh. */
function signedVolume(mesh: Mesh): number {
  const { positions: p, indices } = mesh
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!
    total +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx)
  }
  return total / 6
}

export function meshStats(mesh: Mesh): MeshStats {
  const { positions, indices } = mesh
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!
      if (value < min[axis]!) min[axis] = value
      if (value > max[axis]!) max[axis] = value
    }
  }
  if (positions.length === 0) {
    min[0] = min[1] = min[2] = 0
    max[0] = max[1] = max[2] = 0
  }

  const watertight = isWatertight(indices)
  return {
    triangles: indices.length / 3,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volume: watertight ? Math.abs(signedVolume(mesh)) : null,
    watertight,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/kernel/stats
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/kernel/stats.ts src/kernel/stats.test.ts
git commit -m "feat(kernel): compute bbox, volume and watertightness"
```

---

### Task 5: Kernel worker and compile API

**Files:**
- Create: `src/kernel/protocol.ts`, `src/kernel/noise.ts`, `src/kernel/openscad.worker.ts`, `src/kernel/compile.ts`
- Test: `src/kernel/noise.test.ts`

**Interfaces:**
- Consumes: the vendored factory from Task 2.
- Produces:
  ```ts
  type ExportFormat = 'off' | 'binstl' | '3mf'
  type CompileResult =
    | { ok: true; data: Uint8Array; stderr: string; ms: number }
    | { ok: false; stderr: string; ms: number }
  class Compiler { compile(source: string, format: ExportFormat): Promise<CompileResult>; cancel(): void; dispose(): void }
  function stripKernelNoise(stderr: string): string
  ```
  Tasks 8 and 9 consume `Compiler`. Milestone 2's retry loop consumes `stderr` verbatim.

Three kernel behaviours drive this design, all verified against the pinned build:

1. `callMain` runs `main()` to process exit — a second call on a live instance throws. **One worker per compile.**
2. Failure is `rc !== 0` **and no output file** — both a parse error and empty geometry return 1. Do not try to detect failure by parsing stderr.
3. `Could not initialize localization (...)` is printed on **every** run including successes. It must be stripped or it will pollute every error the user and, later, the model sees.

- [ ] **Step 1: Write the failing test**

`src/kernel/noise.test.ts`:

```ts
import { expect, test } from 'vitest'
import { stripKernelNoise } from './noise'

test('strips the localization warning the kernel always prints', () => {
  const raw =
    "Could not initialize localization (application path is '/').\n" +
    'ERROR: Parser error: syntax error in file /in.scad, line 1\n'
  expect(stripKernelNoise(raw)).toBe('ERROR: Parser error: syntax error in file /in.scad, line 1')
})

test('rewrites the kernel virtual path to something a user recognises', () => {
  const raw = 'ERROR: Parser error: syntax error in file /in.scad, line 3\n'
  expect(stripKernelNoise(raw)).toBe('ERROR: Parser error: syntax error in file model.scad, line 3')
})

test('drops blank lines but keeps real content', () => {
  expect(stripKernelNoise('\n\nWARNING: something\n\n')).toBe('WARNING: something')
})

test('returns an empty string when there is nothing but noise', () => {
  expect(stripKernelNoise("Could not initialize localization (application path is '/').\n")).toBe('')
})

test('caps runaway output at 100 lines, keeping head and tail', () => {
  const raw = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
  const out = stripKernelNoise(raw).split('\n')
  expect(out).toHaveLength(101) // 50 head + 1 elision + 50 tail
  expect(out[0]).toBe('line 0')
  expect(out[50]).toBe('... 150 more lines ...')
  expect(out[100]).toBe('line 249')
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test src/kernel/noise
```

Expected: FAIL — `Failed to resolve import "./noise"`.

- [ ] **Step 3: Write `src/kernel/noise.ts`**

```ts
/** Printed unconditionally by the wasm build, including on successful runs. */
const NOISE = [/^Could not initialize localization/]

const HEAD = 50
const TAIL = 50

/**
 * Cleans kernel stderr for display and, in Milestone 2, for the model.
 *
 * The cap keeps the head and the tail rather than truncating, because the fatal
 * message is usually last and the root-cause include is usually first.
 */
export function stripKernelNoise(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !NOISE.some((re) => re.test(line)))
    // The kernel only ever sees our virtual path; show the user a real name.
    .map((line) => line.replaceAll('/in.scad', 'model.scad'))

  if (lines.length <= HEAD + TAIL) return lines.join('\n')
  const omitted = lines.length - HEAD - TAIL
  return [
    ...lines.slice(0, HEAD),
    `... ${omitted} more lines ...`,
    ...lines.slice(-TAIL),
  ].join('\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test src/kernel/noise
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Write `src/kernel/protocol.ts`**

```ts
export type ExportFormat = 'off' | 'binstl' | '3mf'

export interface CompileRequest {
  source: string
  format: ExportFormat
}

export type CompileResponse =
  | { type: 'ok'; data: Uint8Array; stderr: string; ms: number }
  | { type: 'error'; stderr: string; ms: number }
```

- [ ] **Step 6: Write `src/kernel/openscad.worker.ts`**

```ts
import OpenSCAD from './vendor/openscad.js'
// `?url` gives the emitted asset URL, so the wasm is fetched rather than
// inlined and stays out of the main chunk.
import wasmUrl from './vendor/openscad.wasm?url'
import type { CompileRequest, CompileResponse } from './protocol'

const post = (message: CompileResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { source, format } = event.data
  const started = performance.now()
  let stderr = ''

  try {
    const kernel = await OpenSCAD({
      noInitialRun: true,
      locateFile: () => wasmUrl,
      print: () => {},
      printErr: (text: string) => {
        stderr += text + '\n'
      },
    })

    kernel.FS.writeFile('/in.scad', source)
    const outputPath = `/out.${format}`
    // Failure is signalled by a non-zero exit code, for both parse errors and
    // empty top-level geometry. Never infer failure from stderr contents.
    const code = kernel.callMain(['/in.scad', '-o', outputPath, `--export-format=${format}`])
    const ms = Math.round(performance.now() - started)

    if (code !== 0) {
      post({ type: 'error', stderr, ms })
      return
    }

    // Copy off the wasm heap. Transferring the view's buffer would hand over
    // the kernel's entire memory.
    const data = new Uint8Array(kernel.FS.readFile(outputPath))
    post({ type: 'ok', data, stderr, ms }, [data.buffer as ArrayBuffer])
  } catch (error) {
    post({
      type: 'error',
      stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
      ms: Math.round(performance.now() - started),
    })
  }
}
```

- [ ] **Step 7: Write `src/kernel/compile.ts`**

```ts
import { stripKernelNoise } from './noise'
import type { CompileRequest, CompileResponse, ExportFormat } from './protocol'

export type { ExportFormat }

export type CompileResult =
  | { ok: true; data: Uint8Array; stderr: string; ms: number }
  | { ok: false; stderr: string; ms: number }

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Owns kernel worker lifecycle. Each compile gets a fresh worker because the
 * kernel's callMain runs main() to exit; terminating a superseded worker is
 * also how an outdated compile is cancelled.
 */
export class Compiler {
  #worker: Worker | null = null

  compile(
    source: string,
    format: ExportFormat = 'off',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CompileResult> {
    this.cancel()

    const worker = new Worker(new URL('./openscad.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.#worker = worker

    return new Promise<CompileResult>((resolve) => {
      const finish = (result: CompileResult) => {
        clearTimeout(timer)
        worker.terminate()
        if (this.#worker === worker) this.#worker = null
        resolve(result)
      }

      const timer = setTimeout(
        () => finish({ ok: false, stderr: `Compile timed out after ${timeoutMs / 1000}s.`, ms: timeoutMs }),
        timeoutMs,
      )

      worker.onmessage = (event: MessageEvent<CompileResponse>) => {
        const message = event.data
        const stderr = stripKernelNoise(message.stderr)
        finish(
          message.type === 'ok'
            ? { ok: true, data: message.data, stderr, ms: message.ms }
            : { ok: false, stderr: stderr || 'Compile failed with no diagnostics.', ms: message.ms },
        )
      }

      worker.onerror = (event) =>
        finish({ ok: false, stderr: event.message || 'Kernel worker crashed.', ms: 0 })

      worker.postMessage({ source, format } satisfies CompileRequest)
    })
  }

  /** Terminates any in-flight compile. Safe to call when idle. */
  cancel(): void {
    this.#worker?.terminate()
    this.#worker = null
  }

  dispose(): void {
    this.cancel()
  }
}
```

- [ ] **Step 8: Verify it type-checks and the whole suite still passes**

```bash
pnpm build && pnpm test
```

Expected: build succeeds and all tests PASS. Confirm the kernel is **not** in the main chunk:

```bash
ls -la dist/assets/ | grep -i wasm
```

Expected: a hashed `openscad-*.wasm` of about 10.7 MB emitted as its own asset.

- [ ] **Step 9: Commit**

```bash
git add src/kernel/
git commit -m "feat(kernel): compile OpenSCAD in a worker with cancellation"
```

---

### Task 6: Viewport

**Files:**
- Create: `src/viewer/Viewport.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `Mesh` from `src/kernel/off`.
- Produces: `<Viewport mesh={mesh} />` where `mesh: Mesh | null`.

Plain three.js, no React Three Fiber: one canvas, one mesh, orbit controls. The scene stays three.js's native Y-up and the model is wrapped in a group rotated −90° about X, so OpenSCAD's Z-up maps correctly without fighting the library.

- [ ] **Step 1: Write the component**

`src/viewer/Viewport.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import {
  AmbientLight, AxesHelper, BoxGeometry, BufferAttribute, BufferGeometry,
  DirectionalLight, DoubleSide, EdgesGeometry, GridHelper, Group,
  LineBasicMaterial, LineSegments, Mesh as ThreeMesh, MeshStandardMaterial,
  PerspectiveCamera, Scene, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Mesh } from '../kernel/off'

/** Bambu A1 / P1S / X1C / X1E share this build volume. */
const PLATE_MM = 256

export function Viewport({ mesh }: { mesh: Mesh | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modelGroupRef = useRef<Group | null>(null)
  const renderRef = useRef<() => void>(() => {})

  // Scene is built once and reused; only the model group's contents change.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new Scene()
    const camera = new PerspectiveCamera(45, 1, 1, 5000)
    camera.position.set(220, 180, 220)

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new AmbientLight(0xffffff, 1.6))
    const key = new DirectionalLight(0xffffff, 2.0)
    key.position.set(1, 2, 1.5)
    scene.add(key)

    const grid = new GridHelper(PLATE_MM, 16, 0x888888, 0xcccccc)
    scene.add(grid)
    const axes = new AxesHelper(30)
    scene.add(axes)

    // Build-volume outline.
    const volume = new BoxGeometry(PLATE_MM, PLATE_MM, PLATE_MM)
    const outline = new LineSegments(
      new EdgesGeometry(volume),
      new LineBasicMaterial({ color: 0xbbbbbb }),
    )
    outline.position.y = PLATE_MM / 2
    scene.add(outline)

    // OpenSCAD is Z-up; three.js is Y-up. One group rotation reconciles them.
    const modelGroup = new Group()
    modelGroup.rotation.x = -Math.PI / 2
    scene.add(modelGroup)
    modelGroupRef.current = modelGroup

    const render = () => renderer.render(scene, camera)
    renderRef.current = render

    // frameloop-on-demand: the model is static, so only draw when something moved.
    controls.addEventListener('change', render)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    // Damping needs a loop, but it is cheap and stops when idle.
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (controls.update()) render()
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      renderer.dispose()
      volume.dispose()
      host.removeChild(renderer.domElement)
      modelGroupRef.current = null
    }
  }, [])

  // Swap geometry when a new compile lands.
  useEffect(() => {
    const group = modelGroupRef.current
    if (!group) return

    for (const child of [...group.children]) {
      group.remove(child)
      if (child instanceof ThreeMesh || child instanceof LineSegments) {
        child.geometry.dispose()
        ;(Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose())
      }
    }

    if (mesh && mesh.triangleCount > 0) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
      geometry.setIndex(new BufferAttribute(mesh.indices, 1))
      geometry.computeVertexNormals()

      group.add(
        new ThreeMesh(
          geometry,
          // DoubleSide so an inverted winding never renders as an invisible hole.
          new MeshStandardMaterial({ color: 0xf9d72c, roughness: 0.55, metalness: 0, side: DoubleSide }),
        ),
      )
      // Crease outline aids reading the shape; threshold keeps it sparse.
      group.add(
        new LineSegments(
          new EdgesGeometry(geometry, 30),
          new LineBasicMaterial({ color: 0x3b3b3b }),
        ),
      )
    }

    renderRef.current()
  }, [mesh])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 0 }} />
}
```

- [ ] **Step 2: Render it with a hard-coded mesh to verify it draws**

Temporarily replace `src/App.tsx`:

```tsx
import { useMemo } from 'react'
import { parseOff } from './kernel/off'
import { Viewport } from './viewer/Viewport'

const CUBE = `OFF
8 12 0
0 0 0
40 0 0
40 40 0
0 40 0
0 0 40
40 0 40
40 40 40
0 40 40
3 0 3 2
3 0 2 1
3 4 5 6
3 4 6 7
3 0 1 5
3 0 5 4
3 1 2 6
3 1 6 5
3 2 3 7
3 2 7 6
3 3 0 4
3 3 4 7
`

export function App() {
  const mesh = useMemo(() => parseOff(CUBE), [])
  return (
    <div style={{ height: '100vh' }}>
      <Viewport mesh={mesh} />
    </div>
  )
}
```

- [ ] **Step 3: Verify visually**

```bash
pnpm dev
```

Open the printed URL. Expected: a yellow 40 mm cube sitting on a grid, with a build-volume outline, that rotates when dragged and zooms on scroll. Confirm the cube sits **on** the grid rather than through it.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/ src/App.tsx
git commit -m "feat(viewer): three.js viewport with orbit controls and build plate"
```

---

### Task 7: Editor

**Files:**
- Create: `src/editor/openscad-mode.ts`, `src/editor/Editor.tsx`

**Interfaces:**
- Produces: `<Editor value={string} onChange={(next: string) => void} />` and `openscad(): LanguageSupport`.

Neither CodeMirror nor Monaco ships an OpenSCAD mode, so we write a `StreamLanguage` tokenizer. `EditorView` is mounted directly rather than through `@uiw/react-codemirror`, whose controlled-value handling causes cursor jumps exactly when the buffer is replaced wholesale — which is what Milestone 2's full-source rewrites will do every turn.

- [ ] **Step 1: Install CodeMirror**

```bash
pnpm add @codemirror/view@6.43.9 @codemirror/state@6.7.1 \
  @codemirror/language@6.12.4 @codemirror/commands@6.11.0
```

- [ ] **Step 2: Write `src/editor/openscad-mode.ts`**

```ts
import { LanguageSupport, StreamLanguage } from '@codemirror/language'

const KEYWORDS = new Set([
  'module', 'function', 'if', 'else', 'for', 'intersection_for', 'let', 'each',
  'true', 'false', 'undef', 'include', 'use', 'assert', 'echo',
])

const BUILTINS = new Set([
  // solids and 2D
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text',
  // operations
  'linear_extrude', 'rotate_extrude', 'translate', 'rotate', 'scale', 'resize',
  'mirror', 'multmatrix', 'color', 'offset', 'hull', 'minkowski', 'union',
  'difference', 'intersection', 'render', 'surface', 'projection', 'import', 'children',
  // functions
  'str', 'len', 'concat', 'chr', 'ord', 'search', 'norm', 'cross', 'abs', 'sign',
  'sin', 'cos', 'tan', 'acos', 'asin', 'atan', 'atan2', 'floor', 'round', 'ceil',
  'ln', 'log', 'pow', 'sqrt', 'exp', 'rands', 'min', 'max', 'version',
  'is_undef', 'is_bool', 'is_num', 'is_string', 'is_list', 'is_function',
])

interface ModeState {
  inBlockComment: boolean
}

export const openscadMode = StreamLanguage.define<ModeState>({
  name: 'openscad',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/')
        state.inBlockComment = false
      } else {
        stream.skipToEnd()
      }
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      state.inBlockComment = true
      return 'comment'
    }
    // Special variables: $fn, $fa, $fs, $t, $vpr ...
    if (stream.match(/^\$[a-zA-Z_]\w*/)) return 'variableName.special'
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      const word = stream.current()
      if (KEYWORDS.has(word)) return 'keyword'
      if (BUILTINS.has(word)) return 'typeName'
      return 'variableName'
    }
    if (stream.match(/^[-+*/%<>=!&|?:]+/)) return 'operator'
    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
})

export const openscad = () => new LanguageSupport(openscadMode)
```

- [ ] **Step 3: Write `src/editor/Editor.tsx`**

```tsx
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { openscad } from './openscad-mode'

export function Editor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep the latest callback without tearing down the editor on every render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          indentOnInput(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          openscad(),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, monospace' } }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Mount once. External value changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply externally-driven changes (Milestone 2's full-source rewrites) via a
  // transaction rather than a remount, guarded so we never fight the user's typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={hostRef} style={{ height: '100%', overflow: 'hidden' }} />
}
```

- [ ] **Step 4: Verify it type-checks**

```bash
pnpm build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/editor/ package.json pnpm-lock.yaml
git commit -m "feat(editor): CodeMirror 6 with an OpenSCAD syntax mode"
```

---

### Task 8: Wire the app together

**Files:**
- Modify: `src/App.tsx`, `src/index.css`

**Interfaces:**
- Consumes: `Compiler`, `parseOff`, `meshStats`, `Viewport`, `Editor`.
- Produces: the working single-route app.

Compiles are debounced at 600 ms. Every new compile cancels the one in flight, so a fast typist never queues work. Measured compile times on realistic parts run from 200 ms to 13 s, so a visible pending state is required, not optional.

- [ ] **Step 1: Write `src/App.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Compiler } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { Editor } from './editor/Editor'
import { Viewport } from './viewer/Viewport'

const STARTER = `// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;
plate_y = 40;
plate_z = 3;
hole_d  = 5;
inset   = 6;

difference() {
  cube([plate_x, plate_y, plate_z]);
  for (x = [inset, plate_x - inset], y = [inset, plate_y - inset])
    translate([x, y, -1])
      cylinder(h = plate_z + 2, d = hole_d);
}
`

const DEBOUNCE_MS = 600

export function App() {
  const [source, setSource] = useState(STARTER)
  const [mesh, setMesh] = useState<Mesh | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)

  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])

  // Guards against an earlier compile resolving after a later one.
  const runIdRef = useRef(0)

  useEffect(() => {
    const runId = ++runIdRef.current
    setBusy(true)
    const timer = setTimeout(async () => {
      const result = await compiler.compile(source, 'off')
      if (runIdRef.current !== runId) return // superseded
      setBusy(false)
      setMs(result.ms)
      if (result.ok) {
        try {
          setMesh(parseOff(new TextDecoder().decode(result.data)))
          setError(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } else {
        setError(result.stderr)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [source, compiler])

  const stats = mesh ? meshStats(mesh) : null

  return (
    <div className="app">
      <section className="pane">
        <Editor value={source} onChange={setSource} />
      </section>
      <section className="pane view">
        <Viewport mesh={mesh} />
        <div className="hud">
          {busy && <span className="tag busy">compiling…</span>}
          {!busy && ms !== null && <span className="tag">{ms} ms</span>}
          {stats && (
            <>
              <span className="tag">
                {stats.size.map((n) => n.toFixed(1)).join(' × ')} mm
              </span>
              <span className="tag">{stats.triangles.toLocaleString()} tris</span>
              <span className="tag">
                {stats.volume === null
                  ? 'not watertight'
                  : `${(stats.volume / 1000).toFixed(2)} cm³`}
              </span>
            </>
          )}
        </div>
        {error && <pre className="error">{error}</pre>}
      </section>
    </div>
  )
}
```

- [ ] **Step 2: Write `src/index.css`**

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font: 14px/1.5 system-ui, sans-serif; color: #16181c; background: #eceeea; }

.app { display: grid; grid-template-columns: minmax(320px, 40%) 1fr; height: 100%; }
.pane { min-width: 0; min-height: 0; position: relative; }
.pane + .pane { border-left: 1px solid #c8ccc4; }
.view { background: #f6f7f4; }

.hud {
  position: absolute; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 6px;
  pointer-events: none;
}
.tag {
  font: 500 11px/1 ui-monospace, monospace; letter-spacing: .04em;
  background: rgba(255, 255, 255, .9); border: 1px solid #c8ccc4; border-radius: 2px;
  padding: 5px 7px; color: #414741;
}
.tag.busy { border-color: #b8860b; color: #b8860b; }

.error {
  position: absolute; left: 10px; right: 10px; bottom: 10px; margin: 0; max-height: 42%;
  overflow: auto; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap;
  background: #fff0f4; border: 1px solid #a8256b; border-radius: 2px;
  padding: 10px 12px; color: #7a1a4e;
}
```

- [ ] **Step 3: Verify end to end**

```bash
pnpm dev
```

Check each of these in the browser:
1. The starter plate compiles and renders with four holes.
2. Changing `plate_x` to `120` re-renders wider after a short pause.
3. The HUD reports size, triangle count, volume in cm³, and a compile time.
4. Deleting a closing `)` shows a red panel reading `ERROR: Parser error: syntax error in file model.scad, line N` — **with no "Could not initialize localization" line**.
5. Replacing the whole body with `x = 1;` shows `Current top level object is empty.`
6. Fixing the error clears the panel and re-renders.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/index.css
git commit -m "feat: wire editor, compiler and viewport together"
```

---

### Task 9: Export STL and 3MF

**Files:**
- Create: `src/export/download.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `Compiler`.
- Produces: `function downloadBlob(data: Uint8Array, filename: string, mime: string): void`

Both formats come straight from the kernel — no serializer of our own. 3MF is the default because it carries units, which sidesteps the "object too small, scale to millimetres?" class of import failure that unitless STL invites.

- [ ] **Step 1: Write `src/export/download.ts`**

```ts
export const MIME = {
  binstl: 'model/stl',
  '3mf': 'model/3mf',
} as const

export function downloadBlob(data: Uint8Array, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on the next frame; revoking synchronously can cancel the download.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}
```

- [ ] **Step 2: Add export controls to `src/App.tsx`**

Add these imports:

```tsx
import { downloadBlob, MIME } from './export/download'
```

Add this state and handler inside `App`, after the `stats` line:

```tsx
  const [exporting, setExporting] = useState<null | 'binstl' | '3mf'>(null)

  // Export runs its own compile so the exported bytes always match the current
  // source, and never reuses the viewport's OFF.
  const exportAs = async (format: 'binstl' | '3mf') => {
    setExporting(format)
    const exporter = new Compiler()
    try {
      const result = await exporter.compile(source, format)
      if (result.ok) {
        downloadBlob(result.data, format === '3mf' ? 'model.3mf' : 'model.stl', MIME[format])
      } else {
        setError(result.stderr)
      }
    } finally {
      exporter.dispose()
      setExporting(null)
    }
  }
```

Add this block inside the `.view` section, immediately after `<Viewport ... />`:

```tsx
        <div className="actions">
          <button onClick={() => exportAs('3mf')} disabled={!mesh || exporting !== null}>
            {exporting === '3mf' ? 'Exporting…' : 'Export 3MF'}
          </button>
          <button onClick={() => exportAs('binstl')} disabled={!mesh || exporting !== null}>
            {exporting === 'binstl' ? 'Exporting…' : 'Export STL'}
          </button>
        </div>
```

- [ ] **Step 3: Style the buttons — append to `src/index.css`**

```css
.actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; }
.actions button {
  font: 500 12px/1 system-ui, sans-serif; padding: 7px 11px; cursor: pointer;
  background: #fff; border: 1px solid #c8ccc4; border-radius: 2px; color: #16181c;
}
.actions button:hover:not(:disabled) { border-color: #b8860b; color: #b8860b; }
.actions button:disabled { opacity: .5; cursor: default; }
.actions button:focus-visible { outline: 2px solid #b8860b; outline-offset: 1px; }
```

- [ ] **Step 4: Verify the exported files are real**

```bash
pnpm dev
```

Click **Export 3MF** and **Export STL**, then check the downloads:

```bash
cd ~/Downloads
unzip -l model.3mf
unzip -p model.3mf 3D/3dmodel.model | head -c 200
xxd -s 80 -l 4 model.stl
```

Expected: the 3MF contains exactly `3D/3dmodel.model`, `[Content_Types].xml` and `_rels/.rels`; the model part declares `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` and `unit="millimeter"`; the STL's triangle count at byte 80 is non-zero.

- [ ] **Step 5: Commit**

```bash
git add src/export/ src/App.tsx src/index.css
git commit -m "feat(export): native STL and 3MF download from the kernel"
```

---

### Task 10: Browser smoke test and deployment

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`, `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: the built `dist/`.
- Produces: CI that proves the real kernel runs in a real browser under the real base path.

This is the only test that can see base-path, worker-bundling and wasm-URL regressions — precisely the bugs this stack produces, and none of which the Vitest suite can reach.

- [ ] **Step 1: Install the browser**

```bash
pnpm exec playwright install chromium
```

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Test the real build artifact, not the dev server — dev and prod differ in
  // exactly the ways this test exists to catch.
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: { baseURL: 'http://localhost:4173' },
  // The kernel is a 10.7 MB download plus a compile.
  timeout: 120_000,
})
```

- [ ] **Step 3: Write `e2e/smoke.spec.ts`**

```ts
import { expect, test } from '@playwright/test'

test('compiles the starter model and reports its size', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  // 60 x 40 x 3 mm starter plate.
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.tag', { hasText: 'cm³' })).toBeVisible()
  expect(errors).toEqual([])
})

test('surfaces a compile error and recovers from it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 90_000 })

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([10,10,10);')

  const error = page.locator('.error')
  await expect(error).toBeVisible({ timeout: 60_000 })
  await expect(error).toContainText('syntax error')
  // The kernel prints this on every run; it must never reach the user.
  await expect(error).not.toContainText('Could not initialize localization')

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([10,10,10]);')
  await expect(error).toBeHidden({ timeout: 60_000 })
})

test('exports a 3MF', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 90_000 })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 3MF' }).click()
  expect((await download).suggestedFilename()).toBe('model.3mf')
})
```

- [ ] **Step 4: Run the browser tests**

```bash
pnpm e2e
```

Expected: 3 tests PASS. If the first fails on a wasm 404, the kernel asset is not resolving under `base: './'` — check that `dist/assets/` contains the hashed `.wasm` and that it is referenced from the worker chunk, not the main one.

- [ ] **Step 5: Write `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 11 }
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm build
      - uses: actions/upload-pages-artifact@v5
        with: { path: dist }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v5
```

Note: no COOP/COEP headers are set anywhere, and none must be added. The kernel is single-threaded and GitHub Pages already serves `application/wasm` correctly.

- [ ] **Step 6: Add e2e artifacts to `.gitignore`**

```bash
printf 'test-results/\nplaywright-report/\n' >> .gitignore
```

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e/ .github/ .gitignore package.json pnpm-lock.yaml
git commit -m "test: browser smoke test on the real build, plus Pages deploy"
```

---

## Done when

- `pnpm test` and `pnpm e2e` both pass.
- `pnpm build` produces a `dist/` that runs from any static path.
- Editing OpenSCAD in the browser re-renders the mesh; errors are legible and recoverable.
- Exported 3MF opens in Bambu Studio at the correct size in millimetres.

## Deliberately not in this milestone

The chat loop and compile retry (Milestone 2), time travel and persistence (Milestone 3), and change inspection (Milestone 4). Also deferred: parameter sliders from Customizer annotations — they belong with Milestone 2's deterministic-substitution path, not here.
