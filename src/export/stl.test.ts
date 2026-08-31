import { expect, test } from 'vitest'
import { parseOff } from '../kernel/off'
import { encodeStl, facetColour } from './stl'

const TRI = 'OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'

test('a facet is 50 bytes: unit normal, three vertices, and the colour word', () => {
  const stl = encodeStl(parseOff(TRI))
  expect(stl.length).toBe(84 + 50)
  const view = new DataView(stl.buffer)
  expect(view.getUint32(80, true)).toBe(1)
  expect([view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)]).toEqual([0, 0, 1])
  expect(view.getFloat32(84 + 12 + 12, true)).toBe(1) // second vertex x
  expect(view.getUint16(84 + 48, true)).toBe(0) // no colour: attribute word 0
})

test('a coloured facet sets bit 15 and five bits per channel', () => {
  expect(facetColour([255, 0, 0])).toBe(0x8000 | (31 << 10))
  expect(facetColour([0, 255, 0])).toBe(0x8000 | (31 << 5))
  expect(facetColour([0, 0, 255])).toBe(0x8000 | 31)
  const mesh = { ...parseOff(TRI), colors: new Uint8Array([139, 69, 19]) }
  const view = new DataView(encodeStl(mesh).buffer)
  expect(view.getUint16(84 + 48, true)).toBe(facetColour([139, 69, 19]))
})
