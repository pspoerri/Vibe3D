import { expect, test } from 'vitest'
import type { ChatMessage } from '../llm/openrouter'
import { buildWindow, nextTurn, reviveLog, stripImages, type ChatEvent } from './log'

const SYS = 'system prompt'
const SRC = 'wall = 2;\ncube([10, 10, wall]);'

let seq = 0
const nextId = (): string => `e${++seq}`

const user = (turn: number, text: string, images?: readonly string[]): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'user',
  text,
  ...(images ? { images } : {}),
})
const assistant = (turn: number, text: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'assistant',
  text,
})
const compiled = (turn: number, ok: boolean, stderr: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'compile',
  ok,
  ms: 12,
  attempt: 0,
  stderr,
})
const note = (turn: number, text: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'note',
  text,
  tone: 'info',
})
const cleared = (turn: number): ChatEvent => ({ id: nextId(), ts: 0, turn, kind: 'clear' })
const summary = (turn: number, text: string, coversThrough: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'summary',
  text,
  coversThrough,
})

const reply = (body: string): string => `Here you go.\n\n\`\`\`openscad\n${body}\n\`\`\``

const win = (log: readonly ChatEvent[], turn: number, source = SRC) =>
  buildWindow({ log, turn, systemPrompt: SYS, source })

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** content is no longer always a string, and several assertions do string work. */
const text = (content: ChatMessage['content']): string =>
  typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')
const texts = (messages: readonly ChatMessage[]): string[] => messages.map((m) => text(m.content))

test('an empty log is the system prompt plus the current source', () => {
  const messages = win([], 1)
  expect(messages).toHaveLength(2)
  expect(messages[0]).toEqual({ role: 'system', content: SYS })
  expect(messages[1]?.role).toBe('user')
  expect(messages[1]?.content).toContain(SRC)
})

test('a clear cuts every event before it', () => {
  const log = [
    user(1, 'a box'),
    assistant(1, reply('cube(1);')),
    cleared(2),
    note(2, 'History cleared.'),
    user(2, 'a cylinder'),
  ]
  expect(texts(win(log, 2))).toEqual([SYS, 'a cylinder', expect.stringContaining(SRC)])
})

test('a summary replays as one user message and skips everything it covers', () => {
  const first = user(1, 'a box')
  const last1 = assistant(1, reply('cube(1);'))
  const log = [
    first,
    last1,
    user(2, 'taller'),
    assistant(2, reply('cube(2);')),
    summary(3, 'The user asked for a box, then a taller one.', last1.id),
    user(3, 'now round it'),
  ]
  expect(texts(win(log, 3))).toEqual([
    SYS,
    'The user asked for a box, then a taller one.',
    'taller',
    // Turn 2 is not the live turn, so its block is stubbed like any other.
    expect.stringContaining('superseded source elided'),
    'now round it',
    expect.stringContaining(SRC),
  ])
})

test('a summary reaching back past a clear is clamped to the clear', () => {
  const before = user(1, 'discarded')
  const log = [
    before,
    assistant(1, reply('cube(1);')),
    cleared(2),
    user(2, 'a cylinder'),
    // coversThrough points before the clear: without the clamp this would
    // replay history the user explicitly threw away.
    summary(3, 'stale summary', before.id),
    user(3, 'wider'),
  ]
  const contents = texts(win(log, 3))
  expect(contents).toEqual([
    SYS,
    'stale summary',
    'a cylinder',
    'wider',
    expect.stringContaining(SRC),
  ])
  expect(contents.join('\n')).not.toContain('discarded')
})

test("the current turn's assistant text is verbatim, earlier turns are stubbed", () => {
  const old = reply('cube(1);')
  const live = reply('cube(2);')
  const log = [user(1, 'a box'), assistant(1, old), user(2, 'taller'), assistant(2, live)]
  const contents = texts(win(log, 2))
  expect(contents).toContain(live)
  expect(contents).not.toContain(old)
  expect(contents.join('\n')).not.toContain('cube(1);')
})

test('the tail source message is dropped once the current turn has an assistant reply', () => {
  const text = reply('cube(1);')
  const log = [user(1, 'a box'), assistant(1, text), compiled(1, false, 'ERROR: x')]
  // §5: on a retry the model already has the source it just wrote, so the
  // document still crosses the wire exactly once — as the model's own reply.
  expect(texts(win(log, 1))).toEqual([SYS, 'a box', text, 'ERROR: x'])
})

test("a failed compile in the current turn crosses the wire byte-identical", () => {
  const stderr = 'ERROR: Parser error: syntax error in file /in.scad, line 3\nTRACE: called by cube'
  const log = [user(1, 'a box'), assistant(1, reply('cube(')), compiled(1, false, stderr)]
  expect(win(log, 1)[3]).toEqual({ role: 'user', content: stderr })
})

test('successful compiles and compiles from earlier turns are dropped', () => {
  const log = [
    user(1, 'a box'),
    assistant(1, reply('cube(1);')),
    compiled(1, false, 'ERROR: turn one'),
    assistant(1, reply('cube(1.5);')),
    compiled(1, true, ''),
    user(2, 'taller'),
    assistant(2, reply('cube(2);')),
    compiled(2, false, 'ERROR: turn two'),
  ]
  const contents = texts(win(log, 2))
  expect(contents.filter((c) => c.startsWith('ERROR:'))).toEqual(['ERROR: turn two'])
})

test('one stderr message survives across a three-turn log with a failure in each', () => {
  const log: ChatEvent[] = []
  for (const turn of [1, 2, 3]) {
    log.push(user(turn, `turn ${turn}`))
    log.push(assistant(turn, reply(`cube(${turn});`)))
    log.push(compiled(turn, false, `ERROR: turn ${turn}`))
    log.push(assistant(turn, reply(`cube(${turn}.5);`)))
    log.push(compiled(turn, true, ''))
  }
  const contents = texts(win(log, 3))
  expect(contents.filter((c) => c.startsWith('ERROR:'))).toEqual(['ERROR: turn 3'])
})

test('notes never reach the wire', () => {
  const log = [note(1, 'Compile timed out.'), user(1, 'a box'), note(1, 'Stopped.')]
  expect(texts(win(log, 1))).toEqual([SYS, 'a box', expect.stringContaining(SRC)])
})

test('the source text appears exactly once, in a fenced block', () => {
  const log = [user(1, 'a box'), assistant(1, reply(SRC)), user(2, 'taller')]
  const joined = texts(win(log, 2)).join('\n')
  expect(count(joined, SRC)).toBe(1)
  expect(joined).toContain(`\`\`\`openscad\n${SRC}\n\`\`\``)
})

test('only the most recent summary is replayed', () => {
  const a = user(1, 'first')
  const b = user(2, 'second')
  const log = [a, b, summary(3, 'older', a.id), user(3, 'third'), summary(4, 'newer', b.id)]
  const contents = texts(win(log, 4))
  expect(contents).toEqual([SYS, 'newer', 'third', expect.stringContaining(SRC)])
})

test('a compile error is addressed to the model as a user message', () => {
  const log = [user(1, 'a box'), assistant(1, reply('cube(1);')), compiled(1, false, 'ERROR: x')]
  expect(win(log, 1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
})

test('an assistant turn that produced nothing is not sent as an empty message', () => {
  // A Stop before the first delta leaves {kind:'assistant', text:''} in the
  // append-only log forever. Anthropic and Google both 400 on an empty content
  // block, so replaying it would poison every later request of the session.
  const messages = win([user(1, 'hi'), assistant(1, ''), user(2, 'again')], 2)
  expect(messages.some((m) => m.content === '')).toBe(false)
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
})

test('a summary naming an event that is not in the log does not replay it', () => {
  // findIndex returns -1, and -1 + 1 === 0 silently clamped to nothing, sending
  // the summary AND everything it covers — the double charge /compact avoids.
  const first = user(1, 'make a plate')
  const log = [first, assistant(1, reply('cube(1);')), summary(3, 'we made a plate', 'gone')]
  const messages = win(log, 3)
  // The history is still correct, so it is the summary that is dropped.
  expect(count(JSON.stringify(messages), 'make a plate')).toBe(1)
  expect(messages.some((m) => m.content === 'we made a plate')).toBe(false)
})

test('a clear as the final event leaves exactly the system prompt and the source', () => {
  const messages = win([user(1, 'hi'), assistant(1, reply('cube(1);')), cleared(2)], 2)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.role).toBe('system')
  expect(messages[1]?.content).toContain(SRC)
})

const PNG = 'data:image/jpeg;base64,AAAA'
const PNG2 = 'data:image/jpeg;base64,BBBB'

test('the live turn sends its images as parts, with the text part first', () => {
  const messages = win([user(1, 'like this bracket', [PNG, PNG2])], 1)
  expect(messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'like this bracket' },
      { type: 'image_url', image_url: { url: PNG } },
      { type: 'image_url', image_url: { url: PNG2 } },
    ],
  })
})

// Anthropic and Google both 400 on an empty content block — the same hazard the
// empty-assistant guard exists for.
test('an image with no words emits no empty text part', () => {
  const messages = win([user(1, '', [PNG])], 1)
  expect(messages[1]).toEqual({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: PNG } }],
  })
})

/**
 * The bill test. An image that rode turn 1 must not ride turn 2, or a long
 * session re-pays for every reference photo on every turn — design.md:499's
 * "default failure of this architecture", and it fails silently.
 */
test('an earlier turn keeps its words and loses its images', () => {
  const messages = win([user(1, 'like this', [PNG]), user(2, 'taller')], 2)
  expect(messages[1]).toEqual({ role: 'user', content: 'like this' })
  expect(JSON.stringify(messages)).not.toContain(PNG)
})

/**
 * The other half of that degradation. An image-only message has no words to
 * keep, so once its images are gone it is an empty content block — which
 * Anthropic and Google both 400 on, poisoning every later request of the
 * session exactly as an early Stop's empty assistant event would.
 */
test('an image-only message from an earlier turn is dropped, not sent empty', () => {
  const messages = win([user(1, '', [PNG]), user(2, 'taller')], 2)
  expect(messages.some((m) => m.content === '')).toBe(false)
  expect(texts(messages)).toEqual([SYS, 'taller', expect.stringContaining(SRC)])
  expect(JSON.stringify(messages)).not.toContain(PNG)
})

/**
 * runCompact's caller closes over the turn that just ran, so without this flag a
 * summarisation would re-bill the images of a turn it considers live — and
 * auto-compact fires unattended, so nobody would see the request that did it.
 */
test('images: false strips them even from the live turn', () => {
  const messages = buildWindow({
    log: [user(1, 'like this', [PNG])],
    turn: 1,
    systemPrompt: SYS,
    source: SRC,
    images: false,
  })
  expect(messages[1]).toEqual({ role: 'user', content: 'like this' })
})

test('the next turn continues a revived transcript instead of restarting at 1', () => {
  expect(nextTurn([])).toBe(1)
  expect(nextTurn([user(1, 'a'), assistant(1, 'b'), user(4, 'c')])).toBe(5)
})

test('stripping images leaves every other event untouched, by identity', () => {
  const plain = user(1, 'no image')
  expect(stripImages(plain)).toBe(plain)
  const withImage = user(2, 'like this', ['data:image/jpeg;base64,AAA'])
  expect(stripImages(withImage)).toEqual({
    id: withImage.id, ts: 0, turn: 2, kind: 'user', text: 'like this',
  })
  expect('images' in stripImages(withImage)).toBe(false)
})

test('a revived log keeps every well-formed event and drops the rest', () => {
  const good: ChatEvent[] = [
    user(1, 'a box'),
    { id: 'x1', ts: 1, turn: 1, kind: 'assistant', text: 'here', stopped: true },
    compiled(1, false, 'ERROR: boom'),
    { id: 'x2', ts: 1, turn: 1, kind: 'note', text: 'n', tone: 'error' },
    { id: 'x3', ts: 1, turn: 1, kind: 'clear' },
    { id: 'x4', ts: 1, turn: 2, kind: 'summary', text: 's', coversThrough: 'x1' },
  ]
  expect(reviveLog(JSON.parse(JSON.stringify(good)))).toEqual(good)
  const bad = [
    null,
    'text',
    42,
    // No text: it would put `undefined` on the wire on every later request.
    { id: 'b1', turn: 1, kind: 'user' },
    { id: 'b2', turn: 1, kind: 'user', text: 42 },
    { id: 'b3', turn: 'one', kind: 'user', text: 'x' },
    // No boundary: buildWindow could not tell what it replaces.
    { id: 'b4', turn: 1, kind: 'summary', text: 's' },
    { id: 'b5', turn: 1, kind: 'compile', ok: true },
    { id: 'b6', turn: 1, kind: 'wat', text: 'x' },
    { turn: 1, kind: 'user', text: 'no id' },
  ]
  expect(reviveLog(bad)).toEqual([])
  expect(reviveLog(undefined)).toEqual([])
  expect(reviveLog({ length: 2 })).toEqual([])
})

test('a revived log never carries two events with one id, so React keys stay unique', () => {
  const twice = [user(1, 'a'), user(1, 'a')].map((e) => ({ ...e, id: 'same' }))
  expect(reviveLog(twice)).toHaveLength(1)
})

test('a revived user event has no images, whatever the file said', () => {
  const raw = [
    { id: 'u', ts: 0, turn: 1, kind: 'user', text: 't', images: ['data:image/jpeg;base64,AAA'] },
  ]
  expect(reviveLog(raw)).toEqual([{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 't' }])
})

const inspected = (turn: number, text: string, image?: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'inspect',
  text,
  ...(image ? { image } : {}),
})

test('a live inspection is one user message, text first, then its render', () => {
  const log = [
    user(1, 'a box'),
    assistant(1, reply('cube(1);')),
    inspected(1, 'REPORT', 'data:image/jpeg;base64,AAAA'),
  ]
  const messages = win(log, 1)
  expect(messages.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'REPORT' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ],
  })
  // The live reply is on the wire, so the source is not re-attached after it.
  expect(count(texts(messages).join('\n'), SRC)).toBe(0)
})

test('an inspection without a render is a plain user message, and images:false strips one', () => {
  const plain = win([user(1, 'a'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT')], 1)
  expect(plain.at(-1)).toEqual({ role: 'user', content: 'REPORT' })
  const stripped = buildWindow({
    log: [user(1, 'a'), assistant(1, reply('cube(1);')), inspected(1, 'REPORT', 'data:x')],
    turn: 1,
    systemPrompt: SYS,
    source: SRC,
    images: false,
  })
  expect(stripped.at(-1)).toEqual({ role: 'user', content: 'REPORT' })
})

test("an earlier turn's inspection is dropped entirely, like its stderr", () => {
  const log = [
    user(1, 'a'),
    assistant(1, reply('cube(1);')),
    inspected(1, 'REPORT', 'data:x'),
    user(2, 'b'),
  ]
  expect(texts(win(log, 2))).toEqual([SYS, 'a', expect.any(String), 'b', expect.stringContaining(SRC)])
  expect(texts(win(log, 2)).join('\n')).not.toContain('REPORT')
})

test('stripping an inspection keeps its report and drops its render', () => {
  const event = inspected(1, 'REPORT', 'data:x')
  expect(stripImages(event)).toEqual({ id: event.id, ts: 0, turn: 1, kind: 'inspect', text: 'REPORT' })
  const plain = inspected(1, 'REPORT')
  expect(stripImages(plain)).toBe(plain)
})

test('a revived inspection has its report and never a render', () => {
  const revived = reviveLog([
    { id: 'i1', ts: 1, turn: 1, kind: 'inspect', text: 'REPORT', image: 'data:x' },
    { id: 'i2', ts: 1, turn: 1, kind: 'inspect' },
  ])
  expect(revived).toEqual([{ id: 'i1', ts: 1, turn: 1, kind: 'inspect', text: 'REPORT' }])
})
