import { expect, test } from 'vitest'
import type { CompileResult } from '../kernel/compile'
import { parseOff, type Mesh } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import {
  buildReport, changeBox, changedPieces, detailOf, diffOf, formatReport, frameBox, hostOf, idealView,
  legendFor, lerpBox, meshChecks, partMoves, translateParts, type Report,
} from './inspect'

type V3 = [number, number, number]
const FACES = [
  [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
]
const corners = (w: number, d: number, h: number, [x, y, z]: V3): number[][] => [
  [x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z],
  [x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h],
]
/** Outward-facing, watertight boxes, one OFF: [w, d, h, at]. */
function boxes(...specs: [number, number, number, V3][]): string {
  const v = specs.flatMap(([w, d, h, at]) => corners(w, d, h, at))
  const f = specs.flatMap((_, i) => FACES.map((t) => t.map((k) => k + i * 8)))
  return `OFF\n${v.length} ${f.length} 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f
    .map((t) => `3 ${t.join(' ')}`)
    .join('\n')}\n`
}
/** Axis-aligned box from (0,0,0) to (w,d,h), outward-facing, watertight. */
const box = (w: number, d: number, h: number): string => boxes([w, d, h, [0, 0, 0]])
const mesh = (...specs: [number, number, number, V3][]): Mesh => parseOff(boxes(...specs))
const stats = (w: number, d: number, h: number) => meshStats(parseOff(box(w, d, h)))
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const fail = (stderrRaw: string): CompileResult => ({ ok: false, stderr: stderrRaw, stderrRaw, ms: 1 })

test('a diff that exported is a mesh; an empty top-level object is "empty"; anything else is unknown', () => {
  const mesh = diffOf({ ok: true, data: bytes(box(1, 1, 1)), stderr: '', stderrRaw: '', ms: 1 })
  expect(mesh !== null && mesh !== 'empty' && mesh.triangleCount).toBe(12)
  expect(
    diffOf(fail('Could not initialize localization\nCurrent top level object is empty.\n')),
  ).toBe('empty')
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
  expect(changeBox(stats(10, 20, 30), stats(5, 5, 40))).toEqual({
    min: [0, 0, 0],
    max: [10, 20, 40],
  })
})

test('a first generation reports the part alone, every diff field null', () => {
  const report = buildReport({ after: stats(10, 20, 30), before: null, added: null, removed: null })
  expect(report).toEqual({
    model_bbox_mm: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] },
    volume_mm3: 6000,
    watertight: true,
    parts: 1,
    per_part: [{ bbox_mm: { min: [0, 0, 0], max: [10, 20, 30], size: [10, 20, 30] }, volume_mm3: 6000 }],
    voids: [],
    genus: 0,
    tri_count: 12,
    was: null,
    changed_bbox_mm: null,
    added_volume_mm3: null,
    removed_volume_mm3: null,
    changed_pieces: [],
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
  expect(report.per_part[0]).not.toHaveProperty('moved_mm')
  // Unknown stays unknown: a failed boolean must not read as "nothing removed".
  expect(
    buildReport({ after: stats(1, 1, 1), before: stats(1, 1, 1), added: null, removed: null }),
  ).toMatchObject({ added_volume_mm3: null, removed_volume_mm3: null, changed_bbox_mm: null })
})

test('the formatted report is JSON, one field per line', () => {
  const report = buildReport({ after: stats(10, 20, 30), before: null, added: null, removed: null })
  const text = formatReport(report)
  expect(JSON.parse(text)).toEqual(report)
  expect(text.split('\n')).toHaveLength(Object.keys(report).length + 2)
})

const first = (w: number, d: number, h: number): Report =>
  buildReport({ after: stats(w, d, h), before: null, added: null, removed: null })
const shell = (min: [number, number, number], size: [number, number, number], volume_mm3: number) => ({
  bbox_mm: { min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] as [number, number, number], size },
  volume_mm3,
})

test('a sound single part passes every check in one line each', () => {
  expect(meshChecks(first(10, 20, 30), 1)).toEqual([
    'rests on Z=0: yes',
    'solids: 1 for 1 PART section: ok',
    'closed voids: none',
    'watertight: yes',
  ])
})

test('a part off the plane, a stray piece, a void and a genus change are each named with numbers', () => {
  const report: Report = {
    ...first(10, 20, 30),
    parts: 3,
    per_part: [shell([0, 0, 0], [100, 50, 20], 90000), shell([0, 0, 3], [10, 10, 10], 1000), shell([40, 0, 0], [2, 2, 2], 8)],
    voids: [shell([50, 20, 5], [4, 8, 6], 192)],
    genus: 7,
    was: { bbox_mm: first(1, 1, 1).model_bbox_mm, volume_mm3: 1, parts: 2, genus: 0, tri_count: 12 },
  }
  const checks = meshChecks(report, 2)
  expect(checks[0]).toBe('rests on Z=0: NO — part 2 floats 3 mm above the plane')
  expect(checks[1]).toMatch(/^solids: NO — 3 for 2 PART sections: .*smallest solid is 8 mm³ at \[40, 0, 0\] to \[42, 2, 2\]/)
  expect(checks[2]).toMatch(/^closed void: NO — 192 mm³ at \[50, 20, 5\] to \[54, 28, 11\] inside part 1/)
  expect(checks[3]).toBe('watertight: yes')
  expect(checks[4]).toBe('genus 0 → 7: the part gained 7 through-holes or loops — intended?')
})

test('too few solids, no PART sections, and a first-generation genus each get their own line', () => {
  expect(meshChecks(first(10, 20, 30), 2)[1]).toMatch(/^solids: NO — 1 for 2 PART sections: two parts touch/)
  expect(meshChecks(first(10, 20, 30), 0)[1]).toBe('solids: 1')
  expect(meshChecks({ ...first(10, 20, 30), genus: 1 }, 1).at(-1)).toBe('genus 1: 1 through-hole or loop')
  expect(meshChecks({ ...first(10, 20, 30), watertight: false }, 1)[3]).toMatch(/^watertight: NO/)
})

test('a part translated whole is reported as a move, with the vector rounded', () => {
  const report = buildReport({
    after: stats(10, 20, 20),
    before: stats(10, 20, 30),
    added: 'empty',
    removed: 'empty',
    moves: [[0, 0, 4.6000001]],
  })
  expect(report.per_part[0]?.moved_mm).toEqual([0, 0, 4.6])
})

test('partMoves finds the part that moved whole and leaves the one that stayed', () => {
  const before = mesh([10, 10, 10, [0, 0, 0]], [10, 10, 10, [30, 0, 0]])
  const after = mesh([10, 10, 10, [0, 0, 0]], [10, 10, 10, [30, 0, 4.6]])
  expect(partMoves(before, after)).toEqual([null, [0, 0, expect.closeTo(4.6, 5)]])
})

test('a part that grew, or was replaced, is not a move — staying put wins the vote', () => {
  expect(partMoves(mesh([10, 10, 10, [0, 0, 0]]), mesh([15, 10, 10, [0, 0, 0]]))).toEqual([null])
  expect(partMoves(mesh([10, 10, 10, [0, 0, 0]]), mesh([4, 4, 4, [1, 1, 1]]))).toEqual([null])
  // A part with no counterpart to pair with is left alone.
  expect(partMoves(mesh([10, 10, 10, [0, 0, 0]]), mesh([10, 10, 10, [0, 0, 0]], [2, 2, 2, [30, 0, 0]]))).toEqual([null, null])
})

test('translateParts moves only the named solid, and returns the same mesh when nothing moves', () => {
  const before = mesh([10, 10, 10, [0, 0, 0]], [10, 10, 10, [30, 0, 0]])
  expect(translateParts(before, [null, null])).toBe(before)
  const moved = translateParts(before, [null, [0, 0, 5]])
  const s = meshStats(moved)
  expect(s.shells.map((sh) => sh.min)).toEqual([[0, 0, 0], [30, 0, 5]])
  expect(before.positions[8 * 3 + 2]).toBe(0)
})

test('a moved vertex snaps onto the exact position the target mesh has for it', () => {
  const before = mesh([10, 10, 10, [0, 0, 0]])
  const after = mesh([10, 10, 10, [0, 0, 4.6]])
  // 4.6 is not exact in float32; adding it in doubles lands a hair off the kernel's own rounding.
  const snapped = translateParts(before, [[0, 0, 4.6000001]], after)
  expect([...snapped.positions]).toEqual([...after.positions])
})

test('idealView looks from the side of the host the box sits on, and keeps the iso side where it straddles', () => {
  const host = { min: [0, 0, 0] as V3, max: [100, 60, 40] as V3 }
  expect(idealView({ min: [80, 5, 0], max: [90, 10, 3] }, host)).toEqual({ direction: [1, -1, -1], from: 'front-right, below' })
  expect(idealView({ min: [10, 50, 37], max: [20, 55, 40] }, host)).toEqual({ direction: [-1, 1, 1], from: 'back-left, above' })
  expect(idealView({ min: [0, 0, 0], max: [100, 60, 40] }, host).direction).toEqual([1, -1, 1])
  // The host of a box is the part holding its centre, else the model.
  expect(hostOf({ min: [1, 1, 1], max: [2, 2, 2] }, [host, { min: [200, 0, 0], max: [210, 10, 10] }], host)).toBe(host)
  expect(hostOf({ min: [300, 0, 0], max: [301, 1, 1] }, [host], { min: [0, 0, 0], max: [400, 60, 40] }).max[0]).toBe(400)
})

test('changedPieces lists every changed shell largest first, with its kind and best side', () => {
  const part = { min: [0, 0, 0] as V3, max: [100, 60, 40] as V3 }
  const added = meshStats(mesh([2, 2, 3, [88, 53, 0]], [6, 6, 3, [10, 5, 0]]))
  const removed = meshStats(mesh([4, 4, 4, [50, 28, 36]]))
  const pieces = changedPieces(added, removed, [part], part)
  expect(pieces.map((p) => [p.kind, p.volume, p.from])).toEqual([
    ['added', 108, 'front-left, below'],
    ['removed', 64, 'front-right, above'],
    ['added', 12, 'back-right, below'],
  ])
  expect(changedPieces(null, 'empty', [part], part)).toEqual([])
})

test('the report names the pieces, and the close-up pane frames the largest from its side', () => {
  const part = { min: [0, 0, 0] as V3, max: [100, 60, 40] as V3 }
  const change = { min: [10, 5, 0] as V3, max: [90, 55, 3] as V3 }
  const added = meshStats(mesh([6, 6, 3, [10, 5, 0]], [2, 2, 3, [88, 53, 0]]))
  const pieces = changedPieces(added, 'empty', [part], part)
  const report = buildReport({ after: stats(100, 60, 40), before: stats(100, 60, 40), added, removed: 'empty', pieces })
  expect(report.changed_pieces).toEqual([
    { kind: 'added', bbox_mm: { min: [10, 5, 0], max: [16, 11, 3], size: [6, 6, 3] }, volume_mm3: 108, seen_from: 'front-left, below' },
    { kind: 'added', bbox_mm: { min: [88, 53, 0], max: [90, 55, 3], size: [2, 2, 3] }, volume_mm3: 12, seen_from: 'back-right, below' },
  ])
  const detail = detailOf(pieces, change, [part], part)
  expect(detail!.direction).toEqual([-1, -1, -1])
  expect(detail!.frame.min[0]).toBeCloseTo(10, 5)
  expect(detail!.frame.max[0]).toBeCloseTo(16 + 0.1 * (90 - 16), 5)
  // A piece already half the part's size needs no close-up; nothing changed needs none either.
  const big = changedPieces(meshStats(mesh([60, 10, 10, [0, 0, 0]])), 'empty', [part], part)
  expect(detailOf(big, change, [part], part)).toBeNull()
  expect(detailOf([], null, [part], part)).toBeNull()
})

test('the legend says what the image shows: first render, one pane, or two with the close-up side', () => {
  expect(legendFor(false, null)).toMatch(/in magenta/)
  expect(legendFor(false, null)).not.toMatch(/green/)
  expect(legendFor(true, null)).toMatch(/green.*magenta/)
  const two = legendFor(true, { frame: { min: [0, 0, 0], max: [1, 1, 1] }, direction: [1, -1, -1] })
  expect(two).toMatch(/two panes/)
  expect(two).toMatch(/changed piece 1, the largest, seen from the front-right, below/)
})
