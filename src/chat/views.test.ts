import { expect, test } from 'vitest'
import { describeView, parseView } from './views'

test('reads a view block, defaults, and rejects bad shapes', () => {
  expect(parseView('Let me look.\n\n```view\n{"view": "front", "section": {"axis": "z", "at": 12}}\n```')).toEqual({
    request: { view: 'front', section: { axis: 'z', at: 12 }, box: null, closeup: null },
    complete: true,
    error: null,
  })
  expect(parseView('```view\n{}\n```').request).toEqual({ view: 'iso', section: null, box: null, closeup: null })
  expect(parseView('```view\n{"view": "side"}\n```').error).toMatch(/"side" is not a view/)
  expect(parseView('```view\n{"section": {"axis": "w", "at": 1}}\n```').error).toMatch(/section needs/)
  expect(parseView('```view\nnope\n```').error).toMatch(/not valid JSON/)
  expect(parseView('```view\n{').complete).toBe(false)
  expect(parseView('```openscad\ncube(1);\n```')).toEqual({ request: null, complete: true, error: null })
})

test('auto picks the side for the caller; closeup names a changed piece', () => {
  expect(parseView('```view\n{"view": "auto", "box": {"min": [0, 0, 0], "max": [1, 1, 1]}}\n```').request).toMatchObject({
    view: 'auto',
    closeup: null,
  })
  expect(parseView('```view\n{"closeup": 2}\n```').request).toEqual({ view: 'iso', section: null, box: null, closeup: 2 })
  expect(parseView('```view\n{"closeup": 0}\n```').error).toMatch(/changed piece number/)
  expect(parseView('```view\n{"closeup": 1.5}\n```').error).toMatch(/changed piece number/)
  expect(describeView({ view: 'iso', section: null, box: null, closeup: 3 })).toMatch(/^close-up of changed piece 3.*green.*magenta/)
  expect(describeView({ view: 'auto', section: null, box: null, closeup: null })).toBe('view from the best side')
})

test('describes a request', () => {
  expect(
    describeView({ view: 'iso_back', section: { axis: 'y', at: 5 }, box: { min: [0, 0, 0], max: [1, 2, 3] }, closeup: null }),
  ).toBe('iso back view, cut at y = 5 mm, nearer half removed, framed on [0, 0, 0] to [1, 2, 3]')
})
