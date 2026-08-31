import { expect, test } from 'vitest'
import { kernelArgs } from './protocol'

test('every compile keeps top-level objects separate, so a 3MF carries one object per part', () => {
  expect(kernelArgs('3mf')).toEqual([
    '/in.scad', '-o', '/out.3mf', '--export-format=3mf', '--enable=lazy-union',
  ])
})

test('each define becomes its own -D pair, after the fixed arguments', () => {
  expect(kernelArgs('off', ['wall=2.5', '$fn=16']).slice(-4)).toEqual(['-D', 'wall=2.5', '-D', '$fn=16'])
})
