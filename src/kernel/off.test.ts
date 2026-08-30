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
