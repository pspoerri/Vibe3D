import { expect, test } from 'vitest'
import { parseOff } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import { partMesh, partModel } from './part'

const box = (o: number, at: number) => {
  const v = [
    [at, 0, 0], [at + 10, 0, 0], [at + 10, 10, 0], [at, 10, 0],
    [at, 0, 10], [at + 10, 0, 10], [at + 10, 10, 10], [at, 10, 10],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ].map((t) => t.map((k) => k + o))
  return { v, f }
}

test('partMesh keeps one solid, re-indexed, with its colours', () => {
  const a = box(0, 0)
  const b = box(8, 30)
  const faces = [...a.f.map((t) => `3 ${t.join(' ')} 255 0 0`), ...b.f.map((t) => `3 ${t.join(' ')} 0 0 255`)]
  const off = `OFF\n16 24 0\n${[...a.v, ...b.v].map((p) => p.join(' ')).join('\n')}\n${faces.join('\n')}\n`
  const second = partMesh(parseOff(off), 2)
  expect(second.vertexCount).toBe(8)
  expect(second.triangleCount).toBe(12)
  expect(Math.max(...second.indices)).toBe(7)
  expect([...(second.colors ?? []).slice(0, 3)]).toEqual([0, 0, 255])
  const stats = meshStats(second)
  expect(stats.parts).toBe(1)
  expect(stats.min).toEqual([30, 0, 0])
  expect(stats.volume).toBe(1000)
})

test('partModel keeps the Nth object and the item that builds it', () => {
  const xml = `<model><resources>
<object id="1" type="model"><mesh><vertices/><triangles/></mesh></object>
<object id="2" type="model"><mesh><vertices/><triangles/></mesh></object>
</resources><build><item objectid="1" partnumber="Part 1"/><item objectid="2" partnumber="Part 2"/></build></model>`
  const cut = partModel(xml, 2)
  expect(cut.match(/<object /g)).toHaveLength(1)
  expect(cut).toContain('<object id="2"')
  expect(cut.match(/<item /g)).toHaveLength(1)
  expect(cut).toContain('objectid="2"')
  expect(partModel(xml, 3)).toBe(xml)
})
