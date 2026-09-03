import { expect, test } from 'vitest'
import { parseOff } from './off'
import { meshStats, partLabels } from './stats'

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

/** A 10 mm box with a 2 mm cavity inside it: the cavity's faces point inward. */
function boxWithVoid(): string {
  const a = boxLists(10, 10, 10)
  const b = boxLists(2, 2, 2, [4, 4, 4])
  const inward = b.f.map((t) => [t[0]!, t[2]!, t[1]!])
  return off([...a.v, ...b.v], [...a.f, ...inward.map((t) => t.map((i) => i + a.v.length))])
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

test('partLabels numbers each triangle by its part, in order of first appearance', () => {
  const { labels, count } = partLabels(parseOff(twoBoxes()))
  expect(count).toBe(2)
  expect([...labels]).toEqual([...Array(12).fill(0), ...Array(12).fill(1)])
  expect(partLabels(parseOff(box(1, 1, 1))).count).toBe(1)
})

test('a closed cavity is a void, not a part: it subtracts from the volume and keeps genus zero', () => {
  const s = meshStats(parseOff(boxWithVoid()))
  expect(s.parts).toBe(1)
  expect(s.shells).toHaveLength(1)
  expect(s.voids).toHaveLength(1)
  expect(s.voids[0]).toMatchObject({ min: [4, 4, 4], max: [6, 6, 6], size: [2, 2, 2], volume: 8 })
  expect(s.volume).toBe(992)
  expect(s.genus).toBe(0)
  expect(s.watertight).toBe(true)
})

test('shells carry each solid\'s box and volume in order of appearance', () => {
  const s = meshStats(parseOff(twoBoxes()))
  expect(s.shells.map((sh) => [sh.min, sh.volume])).toEqual([
    [[0, 0, 0], 1000],
    [[20, 0, 0], 1000],
  ])
})

test('a void takes its holder\'s label, so a click never sees a part number the source lacks', () => {
  const { labels, count } = partLabels(parseOff(boxWithVoid()))
  expect(count).toBe(1)
  expect(new Set(labels)).toEqual(new Set([0]))
})

test('overhang is the share of surface facing down past 45° that does not rest on the bed', () => {
  // On the bed: the bottom face rests, nothing hangs.
  expect(meshStats(parseOff(box(10, 10, 10))).shells[0]?.overhang).toBe(0)
  // Lifted: the bottom face is one sixth of the surface, and it hangs.
  const a = boxLists(10, 10, 10, [0, 0, 3])
  const b = boxLists(1, 1, 1, [30, 30, 0])
  const lifted = off([...a.v, ...b.v], [...a.f, ...b.f.map((t) => t.map((k) => k + 8))])
  expect(meshStats(parseOff(lifted)).shells[0]?.overhang).toBeCloseTo(1 / 6, 5)
})
