import { expect, test } from 'vitest'
import { decodeShare, encodeShare } from './share'

test('a source survives the round trip through the hash, and garbage decodes to nothing', async () => {
  const source = '// Knurled knob\n\n$fn = 48;\n\nmodule knob() { cylinder(h = 10, d = 30); }\nknob();\n'
  const hash = await encodeShare(source)
  expect(hash.startsWith('s=')).toBe(true)
  expect(hash).toMatch(/^s=[A-Za-z0-9_-]+$/)
  expect(await decodeShare(`#${hash}`)).toBe(source)
  expect(await decodeShare(hash)).toBe(source)
  expect(await decodeShare('#other')).toBe(null)
  expect(await decodeShare('#s=!!!')).toBe(null)
  expect(await decodeShare('#s=AAAA')).toBe(null)
})

test('a long source packs small', async () => {
  const source = Array.from({ length: 200 }, (_, i) => `translate([${i * 10}, 0, 0]) cube(5);`).join('\n')
  expect((await encodeShare(source)).length).toBeLessThan(source.length / 4)
})
