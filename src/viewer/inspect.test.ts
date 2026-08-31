import { expect, test } from 'vitest'
import type { CompileResult } from '../kernel/compile'
import { parseOff } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import {
  buildReport, changeBox, diffOf, formatReport, frameBox, lerpBox, type Report,
} from './inspect'

/** Axis-aligned box from (0,0,0) to (w,d,h), outward-facing, watertight. */
function box(w: number, d: number, h: number): string {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  return `OFF\n8 12 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f
    .map((t) => `3 ${t.join(' ')}`)
    .join('\n')}\n`
}
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
    genus: 0,
    tri_count: 12,
    was: null,
    changed_bbox_mm: null,
    added_volume_mm3: null,
    removed_volume_mm3: null,
    bbox_min_shift_mm: null,
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
  expect(report.bbox_min_shift_mm).toEqual([0, 0, 0])
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
