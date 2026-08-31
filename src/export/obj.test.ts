import { expect, test } from 'vitest'
import { parseOff, type Mesh } from '../kernel/off'
import { encodeObj } from './obj'

const text = (b: Uint8Array | null): string => (b ? new TextDecoder().decode(b) : '')

/** Two boxes, one file; the first with a red top face and default sides, the second uncoloured. */
function twoBoxes(colour: boolean): Mesh {
  const corners = (at: number) => [
    [at, 0, 0], [at + 10, 0, 0], [at + 10, 10, 0], [at, 10, 0],
    [at, 0, 10], [at + 10, 0, 10], [at + 10, 10, 10], [at, 10, 10],
  ]
  const faces = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const v = [...corners(0), ...corners(30)]
  const f = [...faces, ...faces.map((t) => t.map((i) => i + 8))]
  const mesh = parseOff(`OFF\n${v.length} ${f.length} 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`)
  if (!colour) return mesh
  const colors = new Uint8Array(f.length * 3)
  for (let t = 0; t < f.length; t++) colors.set(t === 2 || t === 3 ? [255, 0, 0] : [249, 215, 44], t * 3)
  return { ...mesh, colors }
}

test('an uncoloured mesh is a plain OBJ: parts as o groups, faces 1-based, no material file', () => {
  const { obj, mtl } = encodeObj(twoBoxes(false), 'sign')
  const out = text(obj)
  expect(mtl).toBeNull()
  expect(out).not.toMatch(/mtllib|usemtl/)
  expect(out.match(/^v /gm)).toHaveLength(16)
  expect(out.match(/^f /gm)).toHaveLength(24)
  expect(out).toMatch(/^o part_1\n(f .*\n){12}o part_2\n/m)
  expect(out).toMatch(/^f 1 4 3$/m)
})

test('a coloured mesh names its MTL, groups faces by material, and defines each colour once', () => {
  const { obj, mtl } = encodeObj(twoBoxes(true), 'sign')
  const out = text(obj)
  expect(out).toMatch(/^mtllib sign\.mtl$/m)
  // Part 1: the default faces first, then the two red ones; part 2 is all default.
  expect(out).toMatch(/^o part_1\nusemtl c_ff0000\nf .*\nf .*\nusemtl default\n(f .*\n){10}o part_2\nusemtl default\n/m)
  expect(text(mtl)).toBe('# Vibe3D materials for sign.obj\nnewmtl c_ff0000\nKd 1.000 0.000 0.000\nnewmtl default\nKd 0.976 0.843 0.173\n')
})
