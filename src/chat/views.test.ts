import { expect, test } from 'vitest'
import { describeView, parseView } from './views'

test('reads a view block, defaults, and rejects bad shapes', () => {
  expect(parseView('Let me look.\n\n```view\n{"view": "front", "section": {"axis": "z", "at": 12}}\n```')).toEqual({
    request: { view: 'front', section: { axis: 'z', at: 12 }, box: null },
    complete: true,
    error: null,
  })
  expect(parseView('```view\n{}\n```').request).toEqual({ view: 'iso', section: null, box: null })
  expect(parseView('```view\n{"view": "side"}\n```').error).toMatch(/"side" is not a view/)
  expect(parseView('```view\n{"section": {"axis": "w", "at": 1}}\n```').error).toMatch(/section needs/)
  expect(parseView('```view\nnope\n```').error).toMatch(/not valid JSON/)
  expect(parseView('```view\n{').complete).toBe(false)
  expect(parseView('```openscad\ncube(1);\n```')).toEqual({ request: null, complete: true, error: null })
})

test('describes a request', () => {
  expect(
    describeView({ view: 'iso_back', section: { axis: 'y', at: 5 }, box: { min: [0, 0, 0], max: [1, 2, 3] } }),
  ).toBe('iso back view, cut at y = 5 mm, nearer half removed, framed on [0, 0, 0] to [1, 2, 3]')
})
