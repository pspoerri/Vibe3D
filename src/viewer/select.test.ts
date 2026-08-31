import { expect, test } from 'vitest'
import { parseOff } from '../kernel/off'
import { describeColours, partColourShares, referenceLine, selectPart } from './select'

/** Two unit-ish boxes: (0,0,0)–(10,10,10) and (20,0,0)–(30,10,10), the second one red. */
function twoBoxes(coloured: boolean): string {
  const box = (x: number) => [
    [x, 0, 0], [x + 10, 0, 0], [x + 10, 10, 0], [x, 10, 0],
    [x, 0, 10], [x + 10, 0, 10], [x + 10, 10, 10], [x, 10, 10],
  ]
  const faces = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const v = [...box(0), ...box(20)]
  const f = [
    ...faces.map((t) => `3 ${t.join(' ')}`),
    ...faces.map((t) => `3 ${t.map((i) => i + 8).join(' ')}${coloured ? ' 255 0 0' : ''}`),
  ]
  return `OFF\n${v.length} ${f.length} 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f.join('\n')}\n`
}

test('picking a triangle selects its whole part, with its box and its triangles', () => {
  const selection = selectPart(parseOff(twoBoxes(false)), 15)
  expect(selection).toMatchObject({ part: 2, of: 2, min: [20, 0, 0], max: [30, 10, 10], rgb: null })
  expect([...selection.triangles]).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
  expect(selectPart(parseOff(twoBoxes(false)), 0)).toMatchObject({ part: 1, of: 2, min: [0, 0, 0] })
})

test('a coloured part carries its colour, and the reference line names it as hex', () => {
  const selection = selectPart(parseOff(twoBoxes(true)), 20)
  expect(selection.rgb).toEqual([255, 0, 0])
  expect(referenceLine(selection)).toBe(
    '[Selected part 2 of 2: 10 × 10 × 10 mm, from [20, 0, 0] to [30, 10, 10], colour #ff0000]',
  )
  expect(referenceLine(selectPart(parseOff(twoBoxes(true)), 3))).toBe(
    '[Selected part 1 of 2: 10 × 10 × 10 mm, from [0, 0, 0] to [10, 10, 10]]',
  )
})

test('a part\'s colours are shared by surface area, largest first, uncoloured faces left out', () => {
  // A 10 mm cube: its top face (100 mm²) gold, the other five (500 mm²) saddlebrown.
  const v = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]]
  const f = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const mesh = parseOff(`OFF\n8 12 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`)
  const colors = new Uint8Array(12 * 3)
  for (let t = 0; t < 12; t++) colors.set(t === 2 || t === 3 ? [255, 215, 0] : [139, 69, 19], t * 3)
  const shares = partColourShares({ ...mesh, colors })
  expect(shares).toHaveLength(1)
  expect(shares[0]!.map((s) => [s.rgb, Math.round(s.share * 100)])).toEqual([[[139, 69, 19], 83], [[255, 215, 0], 17]])
  expect(describeColours(shares[0]!)).toBe('saddlebrown (#8b4513) 83%, gold (#ffd700) 17%')
  expect(describeColours(partColourShares(mesh)[0]!)).toBe('no colour')
  // The default yellow is not a colour the model wrote.
  const plain = new Uint8Array(12 * 3)
  for (let t = 0; t < 12; t++) plain.set(t < 6 ? [249, 215, 44] : [255, 0, 0], t * 3)
  expect(describeColours(partColourShares({ ...mesh, colors: plain })[0]!)).toBe('red (#ff0000) 50%')
})
