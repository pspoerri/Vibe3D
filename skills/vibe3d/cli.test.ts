/**
 * The skill's CLI against the real kernel, ~0.5 s a compile. Sources are
 * written to a temp dir, as the model would write them.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
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

test('unknown command prints usage with exit 2, a missing file is exit 1', async () => {
  expect((await run(['frobnicate'])).code).toBe(2)
  expect((await run([])).out).toContain('vibe3d check')
  const missing = await run(['check', join(dir, 'nope.scad')])
  expect(missing.code).toBe(1)
  expect(missing.out).toContain('nope.scad')
})
