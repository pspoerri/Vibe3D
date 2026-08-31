import { expect, test } from 'vitest'
import { encodeOff, parseOff } from './off'

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

test('rejects a face that lists fewer indices than it declares', () => {
  expect(() => parseOff('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1\n')).toThrow(
    /declares 3 vertices but lists 2/,
  )
})

test('rejects a face referencing a vertex index that does not exist', () => {
  expect(() => parseOff('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 99\n')).toThrow(
    /invalid vertex index 99/,
  )
})

test('keeps per-face colour, defaulting the faces that had none', () => {
  const m = parseOff(`OFF
4 3 0
0 0 0
1 0 0
0 1 0
0 0 1
3 0 2 1 255 0 0
3 0 1 3
3 0 3 2 0 128 255 200
`)
  expect(Array.from(m.colors!)).toEqual([255, 0, 0, 249, 215, 44, 0, 128, 255])
})

test('reports no colours at all when no face had one', () => {
  expect(parseOff(TETRA).colors).toBeUndefined()
})

test('encodeOff round-trips positions and triangles', () => {
  const src = 'OFF\n4 2 0\n0 0 0\n1 0 0\n0 1 0\n0 0 1.5\n3 0 1 2\n3 0 2 3\n'
  const again = parseOff(new TextDecoder().decode(encodeOff(parseOff(src))))
  expect([...again.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1.5])
  expect([...again.indices]).toEqual([0, 1, 2, 0, 2, 3])
})
