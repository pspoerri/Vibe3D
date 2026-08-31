import { expect, test } from 'vitest'
import { applyEdits, parseEdits } from './edits'

const SRC = ['// Plate', '', 'wall = 2;      // [1:0.5:5]', 'size = 10;', '', 'cube([size, size, wall]);'].join('\n')

const block = (search: string, replace: string): string =>
  `\`\`\`openscad-edit\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n\`\`\``

test('parses one edit block out of a reply with prose around it', () => {
  const reply = `Thicker wall.\n\n${block('wall = 2;      // [1:0.5:5]', 'wall = 3;      // [1:0.5:5]')}\n\nDone.`
  expect(parseEdits(reply)).toEqual({
    edits: [{ search: 'wall = 2;      // [1:0.5:5]', replace: 'wall = 3;      // [1:0.5:5]' }],
    complete: true,
    error: null,
  })
})

test('parses several blocks in order, multi-line bodies included, and normalises CRLF', () => {
  const reply = `${block('wall = 2;      // [1:0.5:5]', 'wall = 3;      // [1:0.5:5]')}\n${block(
    'size = 10;\n\ncube([size, size, wall]);',
    'size = 12;\n\ncube([size, size, wall]);',
  )}`.replaceAll('\n', '\r\n')
  const { edits, complete } = parseEdits(reply)
  expect(complete).toBe(true)
  expect(edits).toHaveLength(2)
  expect(edits[1]).toEqual({
    search: 'size = 10;\n\ncube([size, size, wall]);',
    replace: 'size = 12;\n\ncube([size, size, wall]);',
  })
})

test('an unterminated edit block is incomplete, and a plain source block is not an edit', () => {
  expect(parseEdits('```openscad-edit\n<<<<<<< SEARCH\nwall = 2;\n=======\nwall = 3;\n').complete).toBe(false)
  expect(parseEdits('```openscad\ncube(1);\n```')).toEqual({ edits: [], complete: true, error: null })
})

test('a block without the three markers is reported, not silently dropped', () => {
  const { edits, error } = parseEdits('```openscad-edit\nwall = 3;\n```')
  expect(edits).toEqual([])
  expect(error).toMatch(/malformed/)
  expect(error).toContain('<<<<<<< SEARCH')
})

test('an edit replaces exactly the matched lines and leaves the rest byte-identical', () => {
  const result = applyEdits(SRC, [
    { search: 'wall = 2;      // [1:0.5:5]', replace: 'wall = 3;      // [1:0.5:5]' },
  ])
  expect(result).toEqual({ source: SRC.replace('wall = 2;', 'wall = 3;') })
})

test('edits apply in sequence, so a later one sees the earlier one', () => {
  const result = applyEdits(SRC, [
    { search: 'size = 10;', replace: 'size = 12;\nheight = 4;' },
    { search: 'height = 4;', replace: 'height = 5;' },
  ])
  expect(result).toEqual({ source: SRC.replace('size = 10;', 'size = 12;\nheight = 5;') })
})

test('a search that differs only in trailing whitespace still matches', () => {
  const result = applyEdits(SRC, [{ search: 'size = 10;   ', replace: 'size = 11;' }])
  expect(result).toEqual({ source: SRC.replace('size = 10;', 'size = 11;') })
})

test('a search is whole lines: a fragment of a line does not match', () => {
  const result = applyEdits(SRC, [{ search: 'size = 1', replace: 'size = 2' }])
  expect(result).toEqual({
    error: expect.stringMatching(/Edit 1 did not apply.*not in the current source/),
  })
})

test('a search that matches twice is refused, naming the count', () => {
  const twice = 'a = 1;\nb = 2;\na = 1;\n'
  const result = applyEdits(twice, [{ search: 'a = 1;', replace: 'a = 3;' }])
  expect(result).toEqual({ error: expect.stringMatching(/Edit 1 did not apply.*matches 2 places/) })
})

test('a missing search names the edit by position, and nothing before it is kept', () => {
  const result = applyEdits(SRC, [
    { search: 'size = 10;', replace: 'size = 12;' },
    { search: 'nothing like this', replace: 'x' },
  ])
  expect(result).toEqual({ error: expect.stringMatching(/^Edit 2 did not apply/) })
})

test('an empty search is refused', () => {
  expect(applyEdits(SRC, [{ search: '', replace: 'x' }])).toEqual({
    error: expect.stringMatching(/Edit 1 did not apply.*empty/),
  })
})

test('replacing with nothing deletes the lines', () => {
  expect(applyEdits('a;\nb;\nc;', [{ search: 'b;', replace: '' }])).toEqual({ source: 'a;\nc;' })
})
