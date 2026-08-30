import type { CompileResult } from '../kernel/compile'
import { stderrForModel } from '../kernel/noise'
import type { ChatMessage, StreamEvent, Usage } from '../llm/openrouter'
import { extractSource } from './fence'
import { buildWindow, type ChatEvent } from './log'
import { COMPACT_PROMPT } from './prompt'

/** 1 initial call + 2 repairs = 3 LLM calls and 3 compiles, per turn, ever. */
export const MAX_RETRIES = 2
export const DRAFT_INTERVAL_MS = 100
export const COMPACT_AT = 0.6

export type TurnOutcome =
  | { status: 'committed'; source: string; result: Extract<CompileResult, { ok: true }> }
  | { status: 'answered' }
  | { status: 'failed'; source: string; result: CompileResult }
  | { status: 'error'; message: string }
  | { status: 'stopped' }

export interface TurnDeps {
  readonly stream: (
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ) => AsyncIterable<StreamEvent>
  /** MUST be a Compiler the preview does not share: compile() cancels whatever
   *  is in flight, so a stray preview would settle a paid-for turn as cancelled. */
  readonly compile: (source: string) => Promise<CompileResult>
  readonly append: (event: ChatEvent) => void
  /** Streamed partial. NEVER compiled, NEVER written into `source`. */
  readonly onDraft: (source: string | null) => void
  /** The reply so far, for the transcript. Throttled with onDraft. */
  readonly onText: (text: string) => void
  /** Reasoning so far, where the model emits it. Never logged, never re-sent. */
  readonly onReasoning: (text: string) => void
  readonly onUsage: (usage: Usage) => void
  /** Injected so the draft throttle is an assertion rather than a timing hope. */
  readonly now: () => number
  readonly newId: () => string
  readonly signal: AbortSignal
}

export interface TurnInput {
  readonly userText: string
  /** The log BEFORE this turn. runTurn appends the user event itself. */
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  /** The committed document at turn start. Read once; never re-read. */
  readonly source: string
}

/** Distributes over the union, so each variant keeps its own fields. */
type NewEvent<E extends ChatEvent = ChatEvent> = E extends E
  ? Omit<E, 'id' | 'ts' | 'turn'>
  : never

/** fetch rejects an aborted request with a DOMException named AbortError. */
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * One turn of the agent loop: stream, extract, compile, repair, at most twice.
 * Total and non-rejecting — a rejection would surface as an unhandled page
 * error instead of a chat message the user can act on.
 */
export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutcome> {
  const { turn, source: committed } = input
  // A mirror of everything appended, so each attempt's window stays a pure
  // function of the log instead of something accumulated across attempts.
  const turnEvents: ChatEvent[] = []
  const emit = (event: NewEvent): void => {
    const full = { ...event, id: deps.newId(), ts: deps.now(), turn }
    turnEvents.push(full)
    deps.append(full)
  }

  let attempt = 0
  // Starts in the past so the first delta always drafts, whatever the clock's origin.
  let lastDraftAt = -Infinity

  try {
    emit({ kind: 'user', text: input.userText })

    for (;;) {
      const messages = buildWindow({
        log: [...input.log, ...turnEvents],
        turn,
        systemPrompt: input.systemPrompt,
        source: committed,
      })

      let text = ''
      let reasoning = ''
      let finishReason: string | null = null

      const pushProgress = (): void => {
        if (deps.now() - lastDraftAt < DRAFT_INTERVAL_MS) return
        lastDraftAt = deps.now()
        const partial = extractSource(text).source
        // Never blank the editor mid-stream: prose before the fence has no
        // source yet, and null there would flash the committed doc.
        if (partial !== null) deps.onDraft(partial)
        deps.onText(text)
        deps.onReasoning(reasoning)
      }

      try {
        for await (const event of deps.stream(messages, deps.signal)) {
          if (event.type === 'delta') {
            text += event.text
            pushProgress()
          } else if (event.type === 'reasoning') {
            // A reasoning model can think for many seconds before its first
            // content token. Without this the UI has nothing to show at all.
            reasoning += event.text
            pushProgress()
          } else if (event.type === 'usage') {
            deps.onUsage(event.usage)
          } else {
            // Recorded, not obeyed: OpenRouter repeats finish_reason on the
            // accounting frame that carries usage, and /compact needs that frame.
            finishReason = event.reason
          }
        }
      } catch (error) {
        deps.onText(text)
        // Append-only, so what actually arrived is still recorded.
        emit({ kind: 'assistant', text, stopped: true })
        if (isAbort(error)) return { status: 'stopped' }
        const message = messageOf(error)
        emit({ kind: 'note', tone: 'error', text: message })
        return { status: 'error', message }
      }

      const { source: candidate, complete } = extractSource(text)
      deps.onDraft(candidate)
      deps.onText(text)
      emit({ kind: 'assistant', text })

      // A reply with no code block at all answers a question; it is not a
      // failure, and there is nothing to compile. But a reply that OPENED a
      // block and never produced a usable one is a truncation, not an answer —
      // that is §4.1's !complete arm, and extractSource reports both cases as
      // a null source.
      const opened = /^```[^\n]*$/m.test(text)
      if (candidate === null && !opened && finishReason !== 'length') {
        return { status: 'answered' }
      }
      if (finishReason === 'length' || !complete || candidate === null) {
        const message =
          finishReason === 'length'
            ? 'The reply hit the output limit before it finished. Try again.'
            : complete
              ? 'The reply contained an empty code block.'
              : 'The reply was cut off before the code block ended. Try again.'
        emit({ kind: 'note', tone: 'error', text: message })
        return { status: 'error', message }
      }
      if (candidate === committed) return { status: 'answered' }

      const result = await deps.compile(candidate)

      // All three unrepairable checks come BEFORE the log append: their
      // stderrRaw is synthetic ('Compile cancelled.', 'Compile timed out after
      // 60s.', an often-empty DOM message), and buildWindow would replay it to
      // the model as a diagnostic to repair.
      if (deps.signal.aborted) return { status: 'stopped' }
      if (!result.ok) {
        if (result.cancelled) return { status: 'stopped' }
        // Three 60-second timeouts is three minutes of dead UI and two paid
        // calls against a message no model can act on, so neither of these
        // two paths retries.
        if (result.timedOut) {
          emit({
            kind: 'note',
            tone: 'error',
            text: "Compile timed out — the model's source is too slow to render.",
          })
          return { status: 'failed', source: candidate, result }
        }
        if (result.crashed || result.stderrRaw.trim() === '') {
          emit({ kind: 'note', tone: 'error', text: 'The kernel worker crashed.' })
          return { status: 'failed', source: candidate, result }
        }
      }

      emit({
        kind: 'compile',
        ok: result.ok,
        ms: result.ms,
        attempt,
        stderr: stderrForModel(result.stderrRaw),
      })
      if (result.ok) return { status: 'committed', source: candidate, result }
      if (attempt === MAX_RETRIES) return { status: 'failed', source: candidate, result }
      attempt++
    }
  } catch (error) {
    return { status: 'error', message: messageOf(error) }
  }
}

export interface CompactInput {
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  readonly source: string
}

export type CompactOutcome =
  | { status: 'compacted' }
  | { status: 'nothing-to-compact' }
  | { status: 'error'; message: string }
  | { status: 'stopped' }

/**
 * One LLM call, no retry loop. Never summarises the source — buildWindow
 * re-attaches that verbatim on every turn, so restating it wastes exactly the
 * context this is meant to free.
 */
export async function runCompact(
  input: CompactInput,
  deps: Pick<TurnDeps, 'stream' | 'append' | 'now' | 'newId' | 'signal'>,
): Promise<CompactOutcome> {
  // The last event of turn n-2: design.md §10's "keep the last 2 turns"
  // verbatim. A plain reverse loop — findLastIndex does not exist under ES2022.
  let coversThrough: string | null = null
  for (let i = input.log.length - 1; i >= 0; i--) {
    const event = input.log[i]!
    if (event.turn <= input.turn - 2) {
      coversThrough = event.id
      break
    }
  }
  if (coversThrough === null) return { status: 'nothing-to-compact' }

  const messages: ChatMessage[] = [
    ...buildWindow({
      log: input.log,
      turn: input.turn,
      systemPrompt: input.systemPrompt,
      source: input.source,
    }),
    { role: 'user', content: COMPACT_PROMPT },
  ]

  let text = ''
  try {
    for await (const event of deps.stream(messages, deps.signal)) {
      if (event.type === 'delta') text += event.text
    }
  } catch (error) {
    if (isAbort(error)) return { status: 'stopped' }
    return { status: 'error', message: messageOf(error) }
  }

  // An empty summary is worse than none: buildWindow would advance past
  // coversThrough on the strength of it, deleting the history it replaces.
  if (text.trim() === '') return { status: 'error', message: 'The summary came back empty.' }

  deps.append({
    id: deps.newId(),
    ts: deps.now(),
    turn: input.turn,
    kind: 'summary',
    text,
    coversThrough,
  })
  return { status: 'compacted' }
}
