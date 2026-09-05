import { expect, test } from 'vitest'
import { scanParams } from '../editor/params'
import { EXAMPLES, exampleFromHash, STARTER } from './index'

test('every example is titled by its first line, carries PART markers, and its sliders scan', () => {
  for (const { name, source } of EXAMPLES) {
    expect(source.split('\n')[0], name).toMatch(new RegExp(`^// ${name}`))
    expect(source, name).toContain('// ---- PART 1 ----')
    expect(scanParams(source).length, name).toBeGreaterThan(0)
  }
  expect(EXAMPLES.map((e) => e.name)).toEqual(['A mounting plate', 'A potted plant', 'A Biergarten sign'])
  expect(STARTER).toBe(EXAMPLES[0]!.source)
})

test('an #example=<slug> link names an example by its file stem', () => {
  expect(exampleFromHash('#example=potted-plant')).toBe(EXAMPLES[1]!.source)
  expect(exampleFromHash('#example=nope')).toBeNull()
  expect(exampleFromHash('')).toBeNull()
})

test('the sign\'s text strings are no sliders, and stop none of the numbers becoming one', () => {
  const params = scanParams(EXAMPLES[2]!.source)
  expect(params.find((p) => p.name === 'main_text')).toBeUndefined()
  expect(params.find((p) => p.name === 'sub_text')).toBeUndefined()
  expect(params.map((p) => p.name)).toEqual([
    'sign_width', 'sign_height', 'base_thick', 'relief_h', 'beer_relief_h',
    'text_size', 'show_beers', 'beer_spacing', 'mount_holes', 'hole_diam',
  ])
})
