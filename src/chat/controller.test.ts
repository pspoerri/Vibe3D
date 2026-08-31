import { expect, test } from 'vitest'
import type { CompileResult } from '../kernel/compile'
import { stderrForModel } from '../kernel/noise'
import type { ChatMessage, StreamEvent, Usage } from '../llm/openrouter'
import {
  DRAFT_INTERVAL_MS,
  MAX_RETRIES,
  runCompact,
  runTurn,
  type TurnDeps,
  type TurnInput,
} from './controller'
import type { ChatEvent } from './log'
import { COMPACT_PROMPT } from './prompt'

const SYS = 'You write OpenSCAD.'
const SRC = 'wall = 2;\ncube([10, 10, wall]);'
const IMG = 'data:image/jpeg;base64,AAAA'
const fenced = (body: string, prose = 'Here you go.'): string =>
  `${prose}\n\n\`\`\`openscad\n${body}\n\`\`\``

const okResult = (): CompileResult => ({
  ok: true,
  data: new Uint8Array([1, 2, 3]),
  stderr: '',
  stderrRaw: '',
  ms: 12,
})
const failResult = (stderrRaw: string): CompileResult => ({
  ok: false,
  stderr: stderrRaw,
  stderrRaw,
  ms: 12,
})

/** One scripted stream call: the events it yields, then optionally a throw. */
interface Reply {
  events?: StreamEvent[]
  error?: unknown
}
const says = (text: string, reason = 'stop'): Reply => ({
  events: [
    { type: 'delta', text },
    { type: 'finish', reason },
  ],
})

interface Harness {
  deps: TurnDeps
  /** The message list handed to every stream call, in order. */
  windows: ChatMessage[][]
  /** The AbortSignal handed to each stream call. Stop is dead without it. */
  signals: (AbortSignal | undefined)[]
  appended: ChatEvent[]
  drafts: (string | null)[]
  texts: string[]
  reasonings: string[]
  usages: Usage[]
  compiled: string[]
  abort: () => void
}

function harness(options: {
  replies?: Reply[]
  compiles?: CompileResult[]
  /** Clock advance before each delta. 0 keeps every delta inside one interval. */
  tickMs?: number
}): Harness {
  const { replies = [], compiles = [], tickMs = 0 } = options
  const windows: ChatMessage[][] = []
  const signals: (AbortSignal | undefined)[] = []
  const appended: ChatEvent[] = []
  const drafts: (string | null)[] = []
  const texts: string[] = []
  const reasonings: string[] = []
  const usages: Usage[] = []
  const compiled: string[] = []
  const controller = new AbortController()
  let clock = 1000
  let ids = 0

  const deps: TurnDeps = {
    stream: (messages, signal) => {
      windows.push([...messages])
      signals.push(signal)
      const scripted = replies[windows.length - 1]
      return (async function* () {
        if (!scripted) throw new Error(`unscripted stream call #${windows.length}`)
        for (const event of scripted.events ?? []) {
          if (event.type === 'delta') clock += tickMs
          yield event
        }
        if (scripted.error) throw scripted.error
      })()
    },
    compile: async (source) => {
      compiled.push(source)
      const scripted = compiles[compiled.length - 1]
      if (!scripted) throw new Error(`unscripted compile call #${compiled.length}`)
      return scripted
    },
    append: (event) => appended.push(event),
    onDraft: (partial) => drafts.push(partial),
    onText: (text) => texts.push(text),
    onReasoning: (text) => reasonings.push(text),
    onUsage: (usage) => usages.push(usage),
    now: () => clock,
    newId: () => `id${++ids}`,
    signal: controller.signal,
  }

  return {
    deps,
    windows,
    signals,
    appended,
    drafts,
    texts,
    reasonings,
    usages,
    compiled,
    abort: () => controller.abort(),
  }
}

const turnInput = (
  userText = 'a box',
  log: ChatEvent[] = [],
  images?: readonly string[],
): TurnInput => ({
  userText,
  log,
  turn: 1,
  systemPrompt: SYS,
  source: SRC,
  ...(images ? { images } : {}),
})

const kinds = (appended: readonly ChatEvent[]): string[] => appended.map((e) => e.kind)
const contents = (messages: readonly ChatMessage[]): string[] =>
  messages.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
  )
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

test('a reply that compiles commits on the first attempt', async () => {
  const h = harness({ replies: [says(fenced('cube(3);'))], compiles: [okResult()] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'committed', source: 'cube(3);', result: okResult() })
  expect(h.compiled).toEqual(['cube(3);'])
  expect(h.windows).toHaveLength(1)
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'compile'])
  expect(h.appended[0]).toMatchObject({ kind: 'user', text: 'a box', turn: 1, ts: 1000 })
})

test('a failed compile is repaired on the retry, which carries the stderr verbatim', async () => {
  const stderr = 'ERROR: Parser error: syntax error in file /in.scad, line 2\nTRACE: called by cube'
  const h = harness({
    replies: [says(fenced('cube(')), says(fenced('cube(3);'))],
    compiles: [failResult(stderr), okResult()],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('committed')
  expect(h.compiled).toEqual(['cube(', 'cube(3);'])
  // I7: byte-identical, with /in.scad and the line number untouched.
  const retry = h.windows[1] ?? []
  expect(retry.at(-1)).toEqual({ role: 'user', content: stderrForModel(stderr) })
  // design.md §5: the model already has the source it just wrote.
  expect(count(contents(retry).join('\n'), SRC)).toBe(0)
  expect(h.appended.filter((e) => e.kind === 'compile').map((e) => e.attempt)).toEqual([0, 1])
})

test('three failures spend the budget and stop at exactly 3 streams and 3 compiles', async () => {
  const h = harness({
    replies: [says(fenced('a')), says(fenced('b')), says(fenced('c'))],
    compiles: [failResult('ERROR: one'), failResult('ERROR: two'), failResult('ERROR: three')],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'failed', source: 'c' })
  // I4: MAX_RETRIES repairs on top of the initial call, and nothing else. A
  // fourth stream call has no script and would surface as a stream error.
  expect(h.windows).toHaveLength(MAX_RETRIES + 1)
  expect(h.compiled).toEqual(['a', 'b', 'c'])
})

test('the source crosses the wire once per turn, and only live stderr does', async () => {
  const h = harness({
    replies: [says(fenced('a')), says(fenced('b')), says(fenced('c'))],
    compiles: [failResult('ERROR: one'), failResult('ERROR: two'), failResult('ERROR: three')],
  })
  await runTurn(turnInput(), h.deps)

  // I6. The tail source message is attached to the first request only; every
  // later request already carries the source as the model's own reply.
  expect(h.windows.map((w) => count(contents(w).join('\n'), SRC))).toEqual([1, 0, 0])
  // Each attempt's diagnostic follows the reply that caused it, verbatim.
  expect(h.windows.map((w) => contents(w).filter((c) => c.startsWith('ERROR:')))).toEqual([
    [],
    ['ERROR: one'],
    ['ERROR: one', 'ERROR: two'],
  ])
})

test('a prose-only reply is an answer, and compiles nothing', async () => {
  const h = harness({ replies: [says('A 2 mm wall is plenty for PLA at this size.')] })
  const outcome = await runTurn(turnInput('how thick should the wall be?'), h.deps)

  expect(outcome).toEqual({ status: 'answered' })
  expect(h.compiled).toEqual([])
  expect(kinds(h.appended)).toEqual(['user', 'assistant'])
})

test('a reply that echoes the committed source is an answer, and compiles nothing', async () => {
  const h = harness({ replies: [says(fenced(SRC))] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'answered' })
  expect(h.compiled).toEqual([])
})

test('a reply cut off by the output limit never reaches compile', async () => {
  // I9: the fence closed, but the provider says it ran out of tokens.
  const h = harness({ replies: [says(fenced('cube(3);'), 'length')] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('error')
  expect(h.compiled).toEqual([])
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'note'])
  expect(h.appended.at(-1)).toMatchObject({ kind: 'note', tone: 'error' })
})

test('an unclosed fence never reaches compile, even when the provider reports stop', async () => {
  const h = harness({ replies: [says('Here you go.\n\n```openscad\ncube(3);')] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('error')
  expect(h.compiled).toEqual([])
})

test('a stream error records the partial and returns an error without compiling', async () => {
  const h = harness({
    replies: [
      { events: [{ type: 'delta', text: 'Here yo' }], error: new Error('Rate limit exceeded') },
    ],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'error', message: 'Rate limit exceeded' })
  expect(h.compiled).toEqual([])
  expect(h.appended[1]).toMatchObject({ kind: 'assistant', text: 'Here yo', stopped: true })
  expect(h.appended.at(-1)).toMatchObject({
    kind: 'note',
    tone: 'error',
    text: 'Rate limit exceeded',
  })
})

test('an abort mid-stream stops the turn and keeps what arrived', async () => {
  // I5: the log is append-only precisely so it can record the partial.
  const h = harness({
    replies: [
      {
        events: [{ type: 'delta', text: 'Here yo' }],
        error: new DOMException('The user aborted a request.', 'AbortError'),
      },
    ],
  })
  h.abort()
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'stopped' })
  expect(h.compiled).toEqual([])
  expect(kinds(h.appended)).toEqual(['user', 'assistant'])
  expect(h.appended[1]).toMatchObject({ text: 'Here yo', stopped: true })
})

test('a cancelled compile stops the turn, logs nothing and spends no attempt', async () => {
  // I8. 'Compile cancelled.' is synthetic: logged, buildWindow would replay it
  // to the model as a diagnostic to repair.
  const h = harness({
    replies: [says(fenced('cube(3);'))],
    compiles: [
      {
        ok: false,
        stderr: 'Compile cancelled.',
        stderrRaw: 'Compile cancelled.',
        ms: 3,
        cancelled: true,
      },
    ],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toEqual({ status: 'stopped' })
  expect(kinds(h.appended)).toEqual(['user', 'assistant'])
  expect(h.windows).toHaveLength(1)
})

test('a timed-out compile fails the turn immediately, with no compile event', async () => {
  const h = harness({
    replies: [says(fenced('cube(3);'))],
    compiles: [
      {
        ok: false,
        stderr: 'Compile timed out after 60s.',
        stderrRaw: 'Compile timed out after 60s.',
        ms: 60_000,
        timedOut: true,
      },
    ],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'failed', source: 'cube(3);' })
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'note'])
  expect(h.windows).toHaveLength(1)
})

test('a crashed worker fails the turn immediately, with no compile event', async () => {
  const h = harness({
    replies: [says(fenced('cube(3);'))],
    compiles: [
      { ok: false, stderr: 'Kernel worker crashed.', stderrRaw: '', ms: 4, crashed: true },
    ],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'failed' })
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'note'])
})

test('a failure carrying no diagnostic at all is unrepairable too', async () => {
  const h = harness({ replies: [says(fenced('cube(3);'))], compiles: [failResult('  \n ')] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome).toMatchObject({ status: 'failed' })
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'note'])
})

test('deltas inside one draft interval produce one draft, plus the final push', async () => {
  const h = harness({
    replies: [
      {
        events: [
          { type: 'delta', text: '```openscad\ncube(1);' },
          { type: 'delta', text: '\ncube(2);' },
          { type: 'delta', text: '\ncube(3);' },
          { type: 'delta', text: '\n```' },
        ],
      },
    ],
    compiles: [okResult()],
  })
  await runTurn(turnInput(), h.deps)

  expect(h.drafts).toEqual(['cube(1);', 'cube(1);\ncube(2);\ncube(3);'])
})

test('a draft is pushed again once the interval has elapsed', async () => {
  const h = harness({
    replies: [
      {
        events: [
          { type: 'delta', text: '```openscad\ncube(1);' },
          { type: 'delta', text: '\ncube(2);' },
          { type: 'delta', text: '\n```' },
        ],
      },
    ],
    compiles: [okResult()],
    tickMs: DRAFT_INTERVAL_MS,
  })
  await runTurn(turnInput(), h.deps)

  expect(h.drafts).toEqual([
    'cube(1);',
    'cube(1);\ncube(2);',
    'cube(1);\ncube(2);',
    'cube(1);\ncube(2);',
  ])
})

test('usage is reported and the stream is read past the first finish reason', async () => {
  const usage: Usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
  const h = harness({
    replies: [
      {
        events: [
          { type: 'delta', text: fenced('cube(3);') },
          { type: 'finish', reason: 'stop' },
          { type: 'usage', usage },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ],
    compiles: [okResult()],
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('committed')
  expect(h.usages).toEqual([usage])
})

test('a port that throws synchronously yields an error outcome, never a rejection', async () => {
  const h = harness({})
  const deps: TurnDeps = {
    ...h.deps,
    stream: () => {
      throw new TypeError('stream is not a function')
    },
  }
  await expect(runTurn(turnInput(), deps)).resolves.toEqual({
    status: 'error',
    message: 'stream is not a function',
  })
})

test('a compile port that rejects yields an error outcome, never a rejection', async () => {
  const h = harness({ replies: [says(fenced('cube(3);'))] })
  const deps: TurnDeps = { ...h.deps, compile: () => Promise.reject(new Error('worker is dead')) }
  await expect(runTurn(turnInput(), deps)).resolves.toEqual({
    status: 'error',
    message: 'worker is dead',
  })
})

const compactDeps = (h: Harness) => ({
  stream: h.deps.stream,
  append: h.deps.append,
  now: h.deps.now,
  newId: h.deps.newId,
  signal: h.deps.signal,
})

const asked = (turn: number, id: string, text: string): ChatEvent => ({
  id,
  ts: 0,
  turn,
  kind: 'user',
  text,
})
const answered = (turn: number, id: string, text: string): ChatEvent => ({
  id,
  ts: 0,
  turn,
  kind: 'assistant',
  text,
})

test('compacting fewer than two completed turns does nothing and calls no model', async () => {
  const h = harness({})
  const log = [asked(1, 'a', 'a box'), answered(1, 'b', fenced('cube(1);'))]
  const outcome = await runCompact({ log, turn: 2, systemPrompt: SYS, source: SRC }, compactDeps(h))

  expect(outcome).toEqual({ status: 'nothing-to-compact' })
  expect(h.windows).toEqual([])
  expect(h.appended).toEqual([])
})

test('compacting summarises through the last event of turn n-2', async () => {
  const h = harness({ replies: [says('The user asked for a box, then a taller one.')] })
  const log = [
    asked(1, 'a', 'a box'),
    answered(1, 'b', fenced('cube(1);')),
    asked(2, 'c', 'taller'),
    answered(2, 'd', fenced('cube(2);')),
    asked(3, 'e', 'wider'),
  ]
  const outcome = await runCompact({ log, turn: 4, systemPrompt: SYS, source: SRC }, compactDeps(h))

  expect(outcome).toEqual({ status: 'compacted' })
  expect(h.appended).toHaveLength(1)
  expect(h.appended[0]).toMatchObject({
    kind: 'summary',
    text: 'The user asked for a box, then a taller one.',
    coversThrough: 'd',
    turn: 4,
  })
  // The summary request is the ordinary window plus one instruction, and it
  // never asks for the source back.
  expect(contents(h.windows[0] ?? []).at(-1)).toBe(COMPACT_PROMPT)
})

test('an aborted compaction appends nothing', async () => {
  const h = harness({
    replies: [
      {
        events: [{ type: 'delta', text: 'The user' }],
        error: new DOMException('The user aborted a request.', 'AbortError'),
      },
    ],
  })
  const log = [
    asked(1, 'a', 'a box'),
    answered(1, 'b', fenced('cube(1);')),
    asked(2, 'c', 'taller'),
  ]
  const outcome = await runCompact({ log, turn: 3, systemPrompt: SYS, source: SRC }, compactDeps(h))

  expect(outcome).toEqual({ status: 'stopped' })
  expect(h.appended).toEqual([])
})

test('a failed compaction reports the error and appends nothing', async () => {
  const h = harness({ replies: [{ error: new Error('Rate limit exceeded') }] })
  const log = [asked(1, 'a', 'a box'), asked(2, 'c', 'taller')]
  const outcome = await runCompact({ log, turn: 3, systemPrompt: SYS, source: SRC }, compactDeps(h))

  expect(outcome).toEqual({ status: 'error', message: 'Rate limit exceeded' })
  expect(h.appended).toEqual([])
})

test('an empty summary is refused rather than appended', async () => {
  // buildWindow would advance past coversThrough on the strength of it, so an
  // empty summary silently deletes the history it claims to replace.
  const h = harness({ replies: [says('   ')] })
  const log = [asked(1, 'a', 'a box'), asked(2, 'c', 'taller')]
  const outcome = await runCompact({ log, turn: 3, systemPrompt: SYS, source: SRC }, compactDeps(h))

  expect(outcome.status).toBe('error')
  expect(h.appended).toEqual([])
})

test('a reply that opened a fence and then stopped is an error, not an answer', async () => {
  // extractSource reports "prose only" and "fence opened, nothing usable in it"
  // identically, as a null source. Treating the second as an answer silently
  // swallows a refusal that opened a code block, or a provider cut that still
  // reports finish_reason 'stop'.
  const h = harness({ replies: [says('Here you go.\n\n```openscad')] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('error')
  expect(h.compiled).toEqual([])
  expect(kinds(h.appended)).toEqual(['user', 'assistant', 'note'])
})

test('a closed but empty code block never reaches the compiler', async () => {
  const h = harness({ replies: [says('Done.\n\n```openscad\n```')] })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('error')
  expect(h.compiled).toEqual([])
})

test('every stream call carries the turn signal, or Stop cannot stop billing', async () => {
  const h = harness({
    replies: [says(fenced('cube([10,10,10);')), says(fenced('cube(3);'))],
    compiles: [failResult('ERROR: syntax error'), okResult()],
  })
  await runTurn(turnInput(), h.deps)

  expect(h.signals).toHaveLength(2)
  expect(h.signals.every((s) => s === h.deps.signal)).toBe(true)
})

test('a stop that lands while the compile is in flight spends no attempt', async () => {
  // The other abort case aborts before runTurn is called, so the stream throws
  // and this branch — the one that matters when Stop is pressed during a 13 s
  // compile — never runs.
  let h: Harness
  const compiles: CompileResult[] = []
  h = harness({ replies: [says(fenced('cube(3);'))], compiles })
  compiles.push(failResult('ERROR: x'))
  const deps: TurnDeps = {
    ...h.deps,
    compile: async (source) => {
      h.compiled.push(source)
      h.abort()
      return failResult('ERROR: x')
    },
  }
  const outcome = await runTurn(turnInput(), deps)

  expect(outcome).toEqual({ status: 'stopped' })
  // No compile event: its stderr would be replayed to the model as a diagnostic.
  expect(kinds(h.appended)).toEqual(['user', 'assistant'])
  expect(h.windows).toHaveLength(1)
})

test('reasoning is streamed out but never logged and never compiled', async () => {
  // A reasoning model can think for many seconds before its first content
  // token. Without a reasoning port the UI has nothing at all to show.
  const h = harness({
    replies: [
      {
        events: [
          { type: 'reasoning', text: 'The user wants a cube. ' },
          { type: 'reasoning', text: 'Three millimetres.' },
          { type: 'delta', text: fenced('cube(3);') },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ],
    compiles: [okResult()],
    tickMs: DRAFT_INTERVAL_MS,
  })
  const outcome = await runTurn(turnInput(), h.deps)

  expect(outcome.status).toBe('committed')
  expect(h.reasonings.at(-1)).toBe('The user wants a cube. Three millimetres.')
  // It is thinking, not an answer: it must not enter the append-only log, or
  // buildWindow would ship it back to the model on every later turn.
  expect(JSON.stringify(h.appended)).not.toContain('The user wants a cube')
  expect(h.compiled).toEqual(['cube(3);'])
})

test('the reply text is pushed as it arrives, not only at the end', async () => {
  const h = harness({
    replies: [says(fenced('cube(3);'))],
    compiles: [okResult()],
    tickMs: DRAFT_INTERVAL_MS,
  })
  await runTurn(turnInput(), h.deps)

  expect(h.texts.length).toBeGreaterThan(0)
  expect(h.texts.at(-1)).toContain('cube(3);')
})

test('a repair turn shows the model its image on every attempt', async () => {
  const h = harness({
    replies: [says(fenced('cube(')), says(fenced('cube(3);'))],
    compiles: [failResult('ERROR: one'), okResult()],
  })
  await runTurn(turnInput('like this', [], [IMG]), h.deps)

  // The model has to be repairing against what it was actually shown; dropping
  // the image on the retry changes the problem mid-turn.
  expect(h.windows).toHaveLength(2)
  for (const window of h.windows) {
    expect(JSON.stringify(window)).toContain(IMG)
  }
  expect(h.appended[0]).toMatchObject({ kind: 'user', text: 'like this', images: [IMG] })
})

test('a compaction never re-sends the images of the turn it is summarising', async () => {
  const h = harness({ replies: [says('A bracket, 40 mm wide.')] })
  const log: ChatEvent[] = [
    // Old enough (turn <= 3 - 2) that runCompact finds something to cover.
    { id: 'u0', ts: 0, turn: 1, kind: 'user', text: 'a box' },
    { id: 'a0', ts: 0, turn: 1, kind: 'assistant', text: fenced('cube(1);') },
    // The same turn number runCompact is called with, so buildWindow reads it
    // as "live": the guarantee has to hold even for a caller that gets it wrong.
    { id: 'u1', ts: 0, turn: 3, kind: 'user', text: 'like this', images: [IMG] },
    { id: 'a1', ts: 0, turn: 3, kind: 'assistant', text: fenced('cube(3);') },
  ]

  await runCompact({ log, turn: 3, systemPrompt: SYS, source: SRC }, h.deps)

  expect(h.windows).toHaveLength(1)
  expect(JSON.stringify(h.windows[0])).not.toContain(IMG)
})
