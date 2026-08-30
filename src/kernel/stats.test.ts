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
