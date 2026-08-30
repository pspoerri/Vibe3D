import { expect, test } from 'vitest'
import { buildWindow, type ChatEvent } from './log'

const SYS = 'system prompt'
const SRC = 'wall = 2;\ncube([10, 10, wall]);'

let seq = 0
const nextId = (): string => `e${++seq}`

const user = (turn: number, text: string): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'user',
  text,
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
  expect(win(log, 2).map((m) => m.content)).toEqual([
    SYS,
    'a cylinder',
    expect.stringContaining(SRC),
  ])
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
  expect(win(log, 3).map((m) => m.content)).toEqual([
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
  const contents = win(log, 3).map((m) => m.content)
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
  const contents = win(log, 2).map((m) => m.content)
  expect(contents).toContain(live)
  expect(contents).not.toContain(old)
  expect(contents.join('\n')).not.toContain('cube(1);')
})

test('the tail source message is dropped once the current turn has an assistant reply', () => {
  const text = reply('cube(1);')
  const log = [user(1, 'a box'), assistant(1, text), compiled(1, false, 'ERROR: x')]
  // §5: on a retry the model already has the source it just wrote, so the
  // document still crosses the wire exactly once — as the model's own reply.
  expect(win(log, 1).map((m) => m.content)).toEqual([SYS, 'a box', text, 'ERROR: x'])
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
  const contents = win(log, 2).map((m) => m.content)
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
  const contents = win(log, 3).map((m) => m.content)
  expect(contents.filter((c) => c.startsWith('ERROR:'))).toEqual(['ERROR: turn 3'])
})

test('notes never reach the wire', () => {
  const log = [note(1, 'Compile timed out.'), user(1, 'a box'), note(1, 'Stopped.')]
  expect(win(log, 1).map((m) => m.content)).toEqual([SYS, 'a box', expect.stringContaining(SRC)])
})

test('the source text appears exactly once, in a fenced block', () => {
  const log = [user(1, 'a box'), assistant(1, reply(SRC)), user(2, 'taller')]
  const joined = win(log, 2)
    .map((m) => m.content)
    .join('\n')
  expect(count(joined, SRC)).toBe(1)
  expect(joined).toContain(`\`\`\`openscad\n${SRC}\n\`\`\``)
})

test('only the most recent summary is replayed', () => {
  const a = user(1, 'first')
  const b = user(2, 'second')
  const log = [a, b, summary(3, 'older', a.id), user(3, 'third'), summary(4, 'newer', b.id)]
  const contents = win(log, 4).map((m) => m.content)
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
