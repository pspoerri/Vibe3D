import { expect, test } from 'vitest'
import { parseOff } from './off'
import { meshStats } from './stats'

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

/** Axis-aligned box from (0,0,0) to (w,d,h), outward-facing, watertight. */
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
  expect(s.parts).toBe(0)
})

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
