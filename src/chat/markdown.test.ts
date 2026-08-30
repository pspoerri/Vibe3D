import { expect, test } from 'vitest'
import { parseMarkdown, type Block } from './markdown'

const p = (text: string): Block => ({ kind: 'paragraph', spans: [{ text }] })

test('prose is one paragraph', () => {
  expect(parseMarkdown('That is already what the model does.')).toEqual([
    p('That is already what the model does.'),
  ])
})

test('a single newline is soft, a blank line is a break', () => {
  // Some models hard-wrap the wire text and some do not; the pane must look
  // the same either way.
  expect(parseMarkdown('one\ntwo')).toEqual([p('one two')])
  expect(parseMarkdown('one\n\ntwo')).toEqual([p('one'), p('two')])
  expect(parseMarkdown('')).toEqual([])
  expect(parseMarkdown('\n  \n')).toEqual([])
})

test('one to three hashes are all the same heading', () => {
  expect(parseMarkdown('# One\n## Two\n### Three')).toEqual([
    { kind: 'heading', spans: [{ text: 'One' }] },
    { kind: 'heading', spans: [{ text: 'Two' }] },
    { kind: 'heading', spans: [{ text: 'Three' }] },
  ])
  expect(parseMarkdown('#nothash')).toEqual([p('#nothash')])
})

test('a fence keeps its language and its line count but never its body', () => {
  const reply = 'Here is a plate.\n\n```openscad\nwall = 2;\ncube([10, 10, wall]);\n```\n\nDrag it.'
  const blocks = parseMarkdown(reply)
  expect(blocks).toEqual([
    p('Here is a plate.'),
    { kind: 'code', lang: 'openscad', lines: 2 },
    p('Drag it.'),
  ])
  // The point of the module: the source is already in the editor beside the
  // chat, so a copy of it here only pushes the prose off screen.
  expect(JSON.stringify(blocks)).not.toContain('cube')
})

test('an unclosed fence is still a code block', () => {
  // The streaming case, and the common one: most frames land mid-body.
  expect(parseMarkdown('Sure:\n```openscad\ncube(')).toEqual([
    p('Sure:'),
    { kind: 'code', lang: 'openscad', lines: 1 },
  ])
})

test('two fences stay two blocks with the prose between them', () => {
  expect(parseMarkdown('```openscad\nx\n```\nAnd a lid:\n```\ny\nz\n```')).toEqual([
    { kind: 'code', lang: 'openscad', lines: 1 },
    p('And a lid:'),
    { kind: 'code', lang: '', lines: 2 },
  ])
})

test('a list interrupts a paragraph with no blank line before it', () => {
  expect(parseMarkdown('Options:\n- one\n* two')).toEqual([
    p('Options:'),
    { kind: 'list', ordered: false, items: [[{ text: 'one' }], [{ text: 'two' }]] },
  ])
  expect(parseMarkdown('1. one\n2. two')).toEqual([
    { kind: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two' }]] },
  ])
  expect(parseMarkdown('- one\n\n- two')).toHaveLength(2)
  // A marker needs its space, so a line opening with emphasis is not a bullet.
  expect(parseMarkdown('*emphasis* opens the line')).toEqual([
    { kind: 'paragraph', spans: [{ text: 'emphasis', em: true }, { text: ' opens the line' }] },
  ])
})

test('emphasis spans a soft newline', () => {
  expect(parseMarkdown('a **bold\nspanning** b')).toEqual([
    {
      kind: 'paragraph',
      spans: [{ text: 'a ' }, { text: 'bold spanning', strong: true }, { text: ' b' }],
    },
  ])
  expect(parseMarkdown('*em*')).toEqual([{ kind: 'paragraph', spans: [{ text: 'em', em: true }] }])
})

test('an unmatched or arithmetic asterisk stays literal', () => {
  expect(parseMarkdown('a lone * stays')).toEqual([p('a lone * stays')])
  expect(parseMarkdown('the plate is 20 * 30 * 2 mm')).toEqual([p('the plate is 20 * 30 * 2 mm')])
  expect(parseMarkdown('**')).toEqual([p('**')])
})

test('inline code is verbatim, asterisks included', () => {
  expect(parseMarkdown('use `size * 2` here')).toEqual([
    {
      kind: 'paragraph',
      spans: [{ text: 'use ' }, { text: 'size * 2', code: true }, { text: ' here' }],
    },
  ])
})

test('CRLF is normalised out of every span', () => {
  const blocks = parseMarkdown('# H\r\n\r\ntext\r\n```js\r\nx\r\n```\r\n')
  expect(blocks).toEqual([
    { kind: 'heading', spans: [{ text: 'H' }] },
    p('text'),
    { kind: 'code', lang: 'js', lines: 1 },
  ])
  expect(JSON.stringify(blocks)).not.toContain('\\r')
})

const REPLY = `## Plate

Here is a **20 × 30** plate with a soft
newline in it, plus \`wall\` as a parameter.

- the wall is *2 mm*
- the corners use offset()

\`\`\`openscad
wall = 2;
cube([20, 30, wall]);
\`\`\`

Drag the slider to try 3 mm.`

test('parses a whole reply into the blocks the pane renders', () => {
  expect(parseMarkdown(REPLY)).toEqual([
    { kind: 'heading', spans: [{ text: 'Plate' }] },
    {
      kind: 'paragraph',
      spans: [
        { text: 'Here is a ' },
        { text: '20 × 30', strong: true },
        { text: ' plate with a soft newline in it, plus ' },
        { text: 'wall', code: true },
        { text: ' as a parameter.' },
      ],
    },
    {
      kind: 'list',
      ordered: false,
      items: [
        [{ text: 'the wall is ' }, { text: '2 mm', em: true }],
        [{ text: 'the corners use offset()' }],
      ],
    },
    { kind: 'code', lang: 'openscad', lines: 2 },
    p('Drag the slider to try 3 mm.'),
  ])
})

test('a bullet arriving mid-frame is never shown as prose', () => {
  // The frame between '\n' and '- ': rendering the bare marker as a paragraph
  // and unrendering it a frame later is a visible twitch at 10 Hz.
  expect(parseMarkdown('- one\n-')).toEqual(parseMarkdown('- one'))
  expect(parseMarkdown('- one\n- ').at(-1)).toEqual({
    kind: 'list',
    ordered: false,
    items: [[{ text: 'one' }], []],
  })
})

/**
 * The prefix sweep, the same shape as fence.test.ts. parseMarkdown runs on
 * every streamed frame, so it always sees a prefix: it must never throw, and no
 * block it has already handed the reader may be lost or rewritten by a longer
 * prefix. Every block but the last is asserted identical, content included.
 *
 * The last one is excluded because it is the line still arriving, and that line
 * stays ambiguous until its next character lands: in '- a\n1. b' the '1' is a
 * paragraph and the '1.' is the list's second item, and no parser can know
 * which is coming. Confining every such change to the tail is the property —
 * it is what stops the pane reflowing text the reader is in the middle of.
 */
const SWEEP: Record<string, string> = {
  'the whole reply': REPLY,
  'list under a paragraph': 'Options:\n- one\n- two',
  'ordered marker under a bullet': '- one\n1. two',
  'unclosed fence': 'Sure:\n```openscad\ncube([20, 30, 2]);',
  'two fences': '```openscad\nx\n```\nAnd a lid:\n```\ny\n```',
  'headings and emphasis': '# One\ntext\n### Three\nmore *text* here',
  crlf: REPLY.replaceAll('\n', '\r\n'),
  'no markup at all': 'It already does that — nothing to change.',
}

for (const [name, reply] of Object.entries(SWEEP)) {
  test(`prefix sweep: ${name}`, () => {
    let prev: Block[] = []
    for (let i = 0; i <= reply.length; i++) {
      const blocks = parseMarkdown(reply.slice(0, i))
      const settled = Math.max(Math.min(prev.length, blocks.length) - 1, 0)
      expect(blocks.slice(0, settled), `at prefix length ${i}`).toEqual(prev.slice(0, settled))
      prev = blocks
    }
  })
}

test('a long reply parses far inside a 10 Hz frame budget', () => {
  const long = Array.from({ length: 200 }, (_, i) => REPLY.replace('Plate', `Plate ${i}`)).join(
    '\n\n',
  )
  const start = Date.now()
  for (let i = 0; i < 10; i++) parseMarkdown(long)
  // 10 frames of a 40 KB reply, against a 100 ms per-frame budget.
  expect(Date.now() - start).toBeLessThan(500)
})

test('pathological input cannot freeze the tab', () => {
  // An unbounded-backtracking matcher dies on exactly these, and it takes the
  // whole tab with it: this runs on the UI thread on every frame.
  const start = Date.now()
  for (const input of [
    '*'.repeat(1000),
    '`'.repeat(1000),
    '#'.repeat(1000),
    '- '.repeat(1000),
    '1'.repeat(1000),
    `**${'*'.repeat(500)}\`${'`'.repeat(500)}`,
    'x'.repeat(100_000),
  ]) {
    expect(() => parseMarkdown(input)).not.toThrow()
  }
  expect(Date.now() - start).toBeLessThan(500)
})
