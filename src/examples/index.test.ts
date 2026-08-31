import { expect, test } from 'vitest'
import { scanParams } from '../editor/params'
import { EXAMPLES, STARTER } from './index'

test('every example is titled by its first line, carries PART markers, and its sliders scan', () => {
  for (const { name, source } of EXAMPLES) {
    expect(source.split('\n')[0], name).toMatch(new RegExp(`^// ${name}`))
    expect(source, name).toContain('// ---- PART 1 ----')
    expect(scanParams(source).length, name).toBeGreaterThan(0)
  }
  expect(EXAMPLES.map((e) => e.name)).toEqual(['A mounting plate', 'A potted plant', 'A Biergarten sign'])
  expect(STARTER).toBe(EXAMPLES[0]!.source)
})

test('the sign\'s string label is no slider, and stops none of the numbers becoming one', () => {
  const params = scanParams(EXAMPLES[2]!.source)
  expect(params.find((p) => p.name === 'label')).toBeUndefined()
  expect(params.map((p) => p.name)).toEqual(['sign_w', 'sign_h', 'plate_t', 'corner_r', 'frame_w', 'relief', 'text_size', 'hole_d'])
})
