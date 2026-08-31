import { expect, test } from 'vitest'
import { extractSource, stubFences } from './fence'
import { COMPACT_PROMPT, SYSTEM_PROMPT } from './prompt'

const BODY = 'wall = 2; // [1:0.5:5]\ncube([10, 10, wall]);'

test('extracts the block from a reply that opens with prose', () => {
  const reply = `Here is a plate.\n\n\`\`\`openscad\n${BODY}\n\`\`\`\n`
  expect(extractSource(reply)).toEqual({ source: BODY, complete: true })
})

test('accepts the scad info string and a bare fence', () => {
  for (const info of ['openscad', 'scad', '', ' ', 'OpenSCAD']) {
    expect(extractSource(`\`\`\`${info}\n${BODY}\n\`\`\``).source).toBe(BODY)
  }
})

test('reports no source when the reply is pure prose', () => {
  expect(extractSource('That is already what the model does.')).toEqual({
    source: null,
    complete: false,
  })
})

test('the last complete block wins', () => {
  const first = '```openscad\nfirst();\n```'
  const reply = `${first}\n\nOn reflection:\n\n\`\`\`openscad\n${BODY}\n\`\`\`\n`
  expect(extractSource(reply)).toEqual({ source: BODY, complete: true })
})

test('an unterminated block supersedes an earlier complete one', () => {
  // The streaming case for a model that rewrote its answer: committing the
  // stale first block would compile source the model has already abandoned.
  const reply = `\`\`\`openscad\nfirst();\n\`\`\`\n\nBetter:\n\n\`\`\`openscad\ncube(`
  expect(extractSource(reply)).toEqual({ source: 'cube(', complete: false })
})

test('backticks inside the body do not close the block', () => {
  const body = '// see ```the docs``` for offset()\ncube(1);\n```openscad is not a close'
  expect(extractSource(`\`\`\`openscad\n${body}\n\`\`\``)).toEqual({ source: body, complete: true })
})

test('a closing fence may carry trailing whitespace', () => {
  expect(extractSource(`\`\`\`openscad\n${BODY}\n\`\`\`   `).complete).toBe(true)
})

test('an unclosed fence is incomplete even when the body looks finished', () => {
  // The draft is what has arrived, trailing newline included: the blank final
  // line is only revealed as the closing fence's own line once it closes.
  expect(extractSource(`\`\`\`openscad\n${BODY}\n`)).toEqual({
    source: `${BODY}\n`,
    complete: false,
  })
})

test('a fence that has only just opened reports no source yet', () => {
  // '' here would blank the editor for a draft tick: the controller drafts on
  // any non-null source.
  expect(extractSource('```openscad\n')).toEqual({ source: null, complete: false })
})

test('a closed but empty block yields no source, so it cannot blank the part', () => {
  expect(extractSource('```openscad\n```')).toEqual({ source: null, complete: true })
})

test('prose after the closing fence is ignored', () => {
  const reply = `\`\`\`openscad\n${BODY}\n\`\`\`\n\nDrag the wall slider to try 3 mm.`
  expect(extractSource(reply)).toEqual({ source: BODY, complete: true })
})

test('surrounding blank lines and indentation outside the block are ignored', () => {
  expect(extractSource(`\n\n  \n\`\`\`openscad\n${BODY}\n\`\`\`\n\n`).source).toBe(BODY)
})

test('normalises CRLF, because it destroys every Customizer annotation', () => {
  const reply = `Here:\r\n\r\n\`\`\`openscad\r\n${BODY.replaceAll('\n', '\r\n')}\r\n\`\`\`\r\n`
  expect(extractSource(reply)).toEqual({ source: BODY, complete: true })
  expect(extractSource(reply).source).not.toContain('\r')
})

test('a fence indented by a space is not a fence', () => {
  // The fence patterns are column-anchored; loosening that would let an
  // indented example inside a body terminate the block.
  expect(extractSource(' ```openscad\ncube(1);\n ```')).toEqual({ source: null, complete: false })
})

/**
 * The prefix sweep. For every prefix of a reply, `complete: true` must carry
 * the same source the finished reply carries — otherwise the controller can
 * commit a half-written document. Excluded by construction: replies with two
 * complete blocks, where the first block genuinely is complete at its own
 * prefix and genuinely does differ from the last-block-wins answer.
 */
const SWEEP: Record<string, string> = {
  'prose then fence': `Sure.\n\n\`\`\`openscad\n${BODY}\n\`\`\`\n`,
  'bare fence': `\`\`\`\n${BODY}\n\`\`\``,
  'no trailing newline': `\`\`\`scad\n${BODY}\n\`\`\``,
  'trailing prose': `\`\`\`openscad\n${BODY}\n\`\`\`\nDone.`,
  'backticks in the body': '```openscad\n// ```notes```\ncube(1);\n```\n',
  crlf: `Here:\r\n\`\`\`openscad\r\n${BODY.replaceAll('\n', '\r\n')}\r\n\`\`\`\r\n`,
  'no fence at all': 'It already does that — nothing to change.',
}

for (const [name, reply] of Object.entries(SWEEP)) {
  test(`prefix sweep: ${name}`, () => {
    const final = extractSource(reply)
    for (let i = 0; i <= reply.length; i++) {
      const partial = extractSource(reply.slice(0, i))
      if (partial.complete) expect(partial.source, `at prefix length ${i}`).toBe(final.source)
    }
    expect(final.complete).toBe(reply.includes('```'))
  })
}

test('an edit block is not source, and its closing fence does not open one', () => {
  const reply =
    'Small change:\n```openscad-edit\n<<<<<<< SEARCH\nwall = 2;\n=======\nwall = 3;\n>>>>>>> REPLACE\n```\nDone.'
  expect(extractSource(reply)).toEqual({ source: null, complete: false })
  // A full source block after an edit block still wins.
  expect(extractSource(`${reply}\n\`\`\`openscad\n${BODY}\n\`\`\``)).toEqual({
    source: BODY,
    complete: true,
  })
  // And the stub still elides the edit's body.
  expect(stubFences(reply)).not.toContain('wall = 3')
})

test('stubFences replaces every body with one line and keeps the prose', () => {
  const reply = `Plate:\n\`\`\`openscad\n${BODY}\n\`\`\`\nAnd a lid:\n\`\`\`\nlid();\n\`\`\`\n`
  const stubbed = stubFences(reply)
  expect(stubbed).not.toContain('wall = 2')
  expect(stubbed).not.toContain('lid()')
  expect(stubbed).toContain('Plate:')
  expect(stubbed).toContain('And a lid:')
  expect(stubbed.split('```')).toHaveLength(5) // two blocks, still fenced
})

test('stubFences is idempotent', () => {
  const reply = `Plate:\n\`\`\`openscad\n${BODY}\n\`\`\`\ntry it.`
  const once = stubFences(reply)
  expect(stubFences(once)).toBe(once)
})

test('stubFences leaves fenceless prose alone', () => {
  expect(stubFences('No code this turn.')).toBe('No code this turn.')
})

test('stubFences stubs an unterminated block too', () => {
  // A stopped turn's assistant text is recorded verbatim, fence and all.
  expect(stubFences(`\`\`\`openscad\n${BODY}`)).not.toContain('cube')
})

test('the system prompt states the contracts the app depends on', () => {
  expect(SYSTEM_PROMPT).toContain('```openscad')
  expect(SYSTEM_PROMPT).toContain('Set `$fn` ONCE')
  expect(SYSTEM_PROMPT).toContain('Never pass `$fn=`')
  expect(COMPACT_PROMPT).toContain('Do NOT reproduce, quote or describe the OpenSCAD source')
})

test('stubbing closes a block the reply never closed', () => {
  // Otherwise the stub goes on the wire with a dangling fence, which invites
  // the model to continue the block instead of starting a new one.
  const stubbed = stubFences('here\n```openscad\ncube(1);')
  expect(stubbed.match(/```/g)).toHaveLength(2)
  expect(stubbed).not.toContain('cube(1);')
})

test('a lone carriage return still yields a usable source', () => {
  const { source, complete } = extractSource('```openscad\rcube(1);\r\n```')
  expect(complete).toBe(true)
  expect(source).toBe('cube(1);')
})
