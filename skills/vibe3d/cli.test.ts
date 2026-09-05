/**
 * The skill's CLI against the real kernel, ~0.5 s a compile. Sources are
 * written to a temp dir, as the model would write them.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { expect, test } from 'vitest'
import { findChrome, run } from './cli'

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

test('unknown command prints usage with exit 2, a missing file is exit 1', async () => {
  expect((await run(['frobnicate'])).code).toBe(2)
  expect((await run([])).out).toContain('vibe3d check')
  const missing = await run(['check', join(dir, 'nope.scad')])
  expect(missing.code).toBe(1)
  expect(missing.out).toContain('nope.scad')
})

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

test('a mesh named by import() is read from beside the source', async () => {
  const stl = join(dir, 'box.stl')
  await run(['export', file('two.scad', TWO), stl])
  const { code, out } = await run(['check', file('uses.scad', '// Import\n\n// ---- PART 1 ----\nimport("box.stl");\n// ---- PART 1 END ----\n')])
  expect(code, out).toBe(0)
  expect(out).toContain('"parts": 2')
})

test('prompt prints the system prompt, the protocol note and the three skills', async () => {
  const { code, out } = await run(['prompt'])
  expect(code).toBe(0)
  // The note names the sections it waives, so its own "OUTPUT CONTRACT" mention comes first;
  // what matters is that the note precedes the real heading further down in SYSTEM_PROMPT.
  const noteEnd = out.indexOf('do not apply here')
  expect(noteEnd).toBeLessThan(out.indexOf('OUTPUT CONTRACT', noteEnd))
  for (const heading of ['# BOSL2', 'text() has exactly these faces', '# Reading a report']) expect(out).toContain(heading)
})

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
