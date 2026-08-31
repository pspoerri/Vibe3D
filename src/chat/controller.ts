import type { CompileResult } from '../kernel/compile'
import { stderrForModel } from '../kernel/noise'
import type { ChatMessage, StreamEvent, Usage } from '../llm/openrouter'
import { applyEdits, parseEdits } from './edits'
import { extractSource } from './fence'
import { buildWindow, type ChatEvent, type ComponentRef } from './log'
import { applyParts, checkParts, parsePartBlocks } from './parts'
import { COMPACT_PROMPT } from './prompt'
import { describeView, parseView, type ViewRequest } from './views'

/** Repairs per candidate: 2 compile failures in a row and the turn gives up on it. */
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
  /**
   * The verification round's evidence for a source that compiled: the report,
   * and the render where the model can read one. Optional — absent means no
   * round, which is the shape the pre-M4 tests exercise.
   */
  readonly inspect?: (source: string, off: Uint8Array) => Promise<{ text: string; image?: string }>
  /**
   * A render the model asked for, of the latest source that compiled this turn
   * — or, when `off` is null, of the part on screen. null: nothing to show.
   */
  readonly render?: (request: ViewRequest, off: Uint8Array | null) => Promise<string | null>
  /** What the turn is doing right now, for the status line: "look 2 · compiling". */
  readonly onPhase?: (phase: string) => void
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
  /** Normalised data URLs attached to this message. Live for this turn only. */
  readonly images?: readonly string[]
  /** The log BEFORE this turn. runTurn appends the user event itself. */
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  /** The committed document at turn start. Read once; never re-read. */
  readonly source: string
  /** The document's mesh files, listed for the model with the source. */
  readonly components?: readonly ComponentRef[]
  /**
   * Whether the model may look — inspections and requested views — as often
   * as it likes; Stop is the only cap. False is thinking off: one call, compile
   * repairs only, no look at all.
   */
  readonly looks?: boolean
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
  // The source the model last produced or was last shown, whole: what a
  // partial update applies to, and what is re-attached after one.
  let base = committed

  type Verified = { source: string; result: Extract<CompileResult, { ok: true }> }
  let verified: Verified | null = null
  const looks = input.looks ?? true
  let rounds = 0

  /** "look 3", "repair 1 of 2", or nothing: the prefix of every status line. */
  const stage = (): string =>
    attempt > 0 ? `repair ${attempt} of ${MAX_RETRIES}` : rounds > 0 ? `look ${rounds}` : ''
  const phase = (doing: string): void => {
    const prefix = stage()
    deps.onPhase?.(prefix ? `${prefix} · ${doing}` : doing)
  }

  // Once a candidate has compiled, the turn commits it unless a later candidate
  // compiles. A stop, an error, or an unrepairable correction after that point
  // would otherwise throw away a part the user already waited for.
  const settle = (outcome: TurnOutcome): TurnOutcome => {
    if (!verified || outcome.status === 'committed') return outcome
    // 'answered' here is the model confirming its part; everything else is a
    // round that did not finish, which the user should be told.
    if (outcome.status !== 'answered') {
      emit({ kind: 'note', tone: 'info', text: 'Kept the last version that compiled.' })
    }
    return { status: 'committed', source: verified.source, result: verified.result }
  }

  const run = async (): Promise<TurnOutcome> => {
    emit({ kind: 'user', text: input.userText, images: input.images })

    for (;;) {
      const messages = buildWindow({
        log: [...input.log, ...turnEvents],
        turn,
        systemPrompt: input.systemPrompt,
        source: base,
        components: input.components,
      })

      let text = ''
      let reasoning = ''
      let finishReason: string | null = null
      phase('waiting for the model')

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
            if (text === '') phase('the model is writing')
            text += event.text
            pushProgress()
          } else if (event.type === 'reasoning') {
            // A reasoning model can think for many seconds before its first
            // content token. Without this the UI has nothing to show at all.
            if (reasoning === '' && text === '') phase('the model is thinking')
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

      const full = extractSource(text)
      const edits = parseEdits(text)
      const parts = parsePartBlocks(text)
      let candidate = full.source
      let complete = full.complete
      // A partial update: applied here, to the source the model was shown,
      // and the result is the candidate. A malformed or non-matching edit
      // is a diagnostic for the model, on the compile budget and wire path.
      let editError: string | null = null
      const partial =
        edits.edits.length + parts.blocks.length > 0 || edits.error !== null || parts.error !== null
      if (candidate === null && edits.complete && parts.complete && partial) {
        let applied: { source: string } | { error: string } =
          edits.error !== null ? { error: edits.error } : applyEdits(base, edits.edits)
        if (!('error' in applied)) {
          applied = parts.error !== null ? { error: parts.error } : applyParts(applied.source, parts.blocks)
        }
        if ('error' in applied) editError = applied.error
        else {
          candidate = applied.source
          complete = true
        }
      }
      deps.onDraft(candidate)
      deps.onText(text)
      emit({ kind: 'assistant', text })
      if (candidate !== null) phase('compiling')

      if (editError !== null) {
        emit({ kind: 'compile', ok: false, ms: 0, attempt, stderr: editError })
        if (attempt === MAX_RETRIES) return { status: 'error', message: editError }
        attempt++
        continue
      }

      // A look request, and no source with it: render what it asked for and
      // hand it back as an inspection. A source beside it wins — the
      // verification round after the compile is the look.
      const view = parseView(text)
      if (candidate === null && (view.request !== null || view.error !== null)) {
        if (!looks) {
          emit({
            kind: 'note',
            tone: 'info',
            text: 'The model asked to see the part. Set thinking above off to allow that.',
          })
          return { status: 'answered' }
        }
        rounds++
        let image: string | null = null
        if (view.request && deps.render) {
          phase(`rendering ${describeView(view.request)}`)
          try {
            image = await deps.render(view.request, verified?.result.data ?? null)
          } catch {
            image = null
          }
        }
        if (deps.signal.aborted) return { status: 'stopped' }
        const caption = view.request ? describeView(view.request) : ''
        const evidence =
          view.error ??
          (image
            ? `Requested view: ${caption}. Layout and proportion only — read every dimension from the report.`
            : `No render is available for the requested view (${caption}). Work from the numbers.`)
        emit({ kind: 'inspect', text: evidence, ...(image ? { image } : {}) })
        continue
      }

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
      // Echoing the document, or the source just inspected, is a confirmation.
      if (candidate === committed || candidate === verified?.source) return { status: 'answered' }
      base = candidate

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
      if (result.ok) {
        verified = { source: candidate, result }
        // Each candidate gets its own repairs: a turn of several looks would
        // otherwise run out of them on the third correction.
        attempt = 0
        // Static, so the user sees it even when the model gets no look.
        const issues = checkParts(candidate)
        if (issues.length > 0) emit({ kind: 'note', tone: 'info', text: issues.join(' ') })
        if (!deps.inspect || !looks) return { status: 'committed', source: candidate, result }
        rounds++
        phase('measuring the part')
        const evidence = await deps.inspect(candidate, result.data)
        if (deps.signal.aborted) return { status: 'stopped' }
        const checks = issues.length > 0 ? `\n\nSource checks:\n${issues.map((i) => `- ${i}`).join('\n')}` : ''
        emit({
          kind: 'inspect',
          text: evidence.text + checks,
          ...(evidence.image ? { image: evidence.image } : {}),
        })
        continue
      }
      if (attempt === MAX_RETRIES) return { status: 'failed', source: candidate, result }
      attempt++
    }
  }

  try {
    return settle(await run())
  } catch (error) {
    return settle({ status: 'error', message: messageOf(error) })
  }
}

export interface CompactInput {
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  readonly source: string
  readonly components?: readonly ComponentRef[]
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
      components: input.components,
      // Belt and braces. The caller passes the real next turn, so the turn that
      // just ran is no longer live here — but auto-compact fires unattended at
      // 60% of context, and re-billing an image with nobody watching is the one
      // failure worth guaranteeing against rather than reasoning about.
      images: false,
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
