import type { ChatMessage, ContentPart } from '../llm/openrouter'
import { EDIT_FENCE, extractSource, PART_FENCE, stubFences } from './fence'

/** A document component as the model needs it: a name to import() and a measured box. */
export interface ComponentRef {
  readonly name: string
  readonly min: readonly number[]
  readonly max: readonly number[]
}

/**
 * `id` and `ts` are carried from the start because Milestone 3 persists this
 * array verbatim as the project file and keys it in IndexedDB; adding them
 * after schemaVersion 1 shipped would be a migration. `turn` is what lets
 * buildWindow scope a compile error to the attempt that produced it.
 *
 * The log is append-only. /clear and /compact are events in it, not edits to
 * it, so a boundary can reference an id that is stable forever.
 */
export type ChatEvent =
  | {
      id: string
      ts: number
      turn: number
      kind: 'user'
      text: string
      /**
       * Normalised data URLs, live for this turn only (see buildWindow). Held
       * here rather than in a store because the log itself is not persisted:
       * design.md §7's "never base64 in the store" binds the store, and this
       * never reaches it.
       *
       * ponytail: revisit the day the log IS persisted — that is the point at
       * which these must become blob ids and buildWindow must be handed a
       * pre-resolved id → data URL map rather than being made async.
       */
      images?: readonly string[]
    }
  | { id: string; ts: number; turn: number; kind: 'assistant'; text: string; stopped?: true }
  | {
      id: string
      ts: number
      turn: number
      kind: 'compile'
      ok: boolean
      ms: number
      attempt: number
      stderr: string
    }
  | {
      id: string
      ts: number
      turn: number
      kind: 'inspect'
      /** The measured report wrapped in the verification questions — what the model was handed. */
      text: string
      /** The composite render, live for this turn only and never persisted, like a user event's images. */
      image?: string
    }
  | { id: string; ts: number; turn: number; kind: 'note'; text: string; tone: 'info' | 'error' }
  | {
      id: string
      ts: number
      turn: number
      kind: 'skill'
      /** What the model asked for. Its body is rendered at window time, so a listing is always current. */
      name: string
      /** Set when there is no such skill: what the model is told, live turn only. */
      error?: string
    }
  | { id: string; ts: number; turn: number; kind: 'clear' }
  | { id: string; ts: number; turn: number; kind: 'summary'; text: string; coversThrough: string }

export interface WindowInput {
  /** The full log INCLUDING the in-flight turn's events so far. */
  readonly log: readonly ChatEvent[]
  /** The turn number in flight. Events with this turn are treated as live. */
  readonly turn: number
  readonly systemPrompt: string
  /**
   * The source the model is to work from: the committed document, or, once a
   * reply has edited it, the result of those edits — a retry candidate ONLY
   * in that case, because the model never wrote it whole and would otherwise
   * repair a file it cannot see.
   */
  readonly source: string
  /** Listed after the source, so the model can import() them by name and place them by numbers. */
  readonly components?: readonly ComponentRef[]
  /**
   * False strips image parts from every message, live turn included. Exists for
   * exactly one caller — runCompact — whose window is built for the turn that
   * just ran and would otherwise re-bill its images unattended.
   */
  readonly images?: boolean
  /** The current body of a loaded skill, or null for a name that has none. Absent: no skills. */
  readonly skills?: (name: string) => string | null
}

/**
 * The ONLY translator from log to wire, and pure, so the window is a function
 * of the log rather than a thing the controller accumulates across attempts.
 *
 * Both backwards scans are plain reverse loops: Array.prototype.findLastIndex
 * does not exist under this project's lib (ES2022) and fails to compile.
 */
export function buildWindow({
  log,
  turn,
  systemPrompt,
  source,
  components,
  images = true,
  skills,
}: WindowInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

  let start = 0
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.kind === 'clear') {
      start = i + 1
      break
    }
  }
  // Loaded skills outlive a summary: they are reference, not history, and are
  // re-rendered at the end of every window rather than replayed from the log.
  const loaded: string[] = []
  for (let i = start; i < log.length; i++) {
    const event = log[i]!
    if (event.kind === 'skill' && !event.error && !loaded.includes(event.name)) loaded.push(event.name)
  }

  // The newest summary wins: an older one is already inside what it covers.
  for (let i = log.length - 1; i >= start; i--) {
    const event = log[i]!
    if (event.kind !== 'summary') continue
    const covered = log.findIndex((e) => e.id === event.coversThrough)
    // An unresolvable boundary means we cannot tell what this summary replaces,
    // and emitting it anyway sends the summary AND everything it covers — the
    // double charge /compact exists to avoid. The raw history is still correct,
    // so drop the summary rather than the history.
    if (covered < 0) break
    messages.push({ role: 'user', content: event.text })
    // Clamped to the clear. Without it a summary minted before a /clear
    // replays exactly the history the user asked to discard.
    start = Math.max(start, covered + 1)
    break
  }

  let liveReply = false
  // Whether the latest live reply carries the whole source. An edit, a part
  // block or a view request does not, so the source — the applied result, for
  // the first two — has to be attached for the next call.
  let liveSource = false
  let liveEdits = false
  for (let i = start; i < log.length; i++) {
    const event = log[i]!
    switch (event.kind) {
      case 'user': {
        // Bound to a local so the array narrows: `event.images?.length` as the
        // test leaves `event.images` possibly-undefined at the use site.
        const attached = images && event.turn === turn ? event.images : undefined
        if (!attached?.length) {
          // An image-only message is entirely its images, so degradation leaves
          // it with nothing at all — pushing it anyway puts an empty content
          // block on the wire, which Anthropic and Google both 400 on. Same
          // hazard, same shape and same consequence as the empty-assistant
          // guard below: one such message poisons every later request of the
          // session. The guard has to live HERE, inside the degraded branch,
          // and not ahead of the image check — a live image-only message is
          // legitimate and must still reach the model.
          if (event.text === '') break
          messages.push({ role: 'user', content: event.text })
          break
        }
        // Text first — OpenRouter recommends it explicitly, and getting it
        // backwards degrades the answer without erroring. No empty text part:
        // Anthropic and Google both 400 on an empty content block.
        const parts: ContentPart[] = event.text ? [{ type: 'text', text: event.text }] : []
        for (const url of attached) parts.push({ type: 'image_url', image_url: { url } })
        messages.push({ role: 'user', content: parts })
        break
      }
      case 'assistant':
        // A turn stopped before its first delta leaves an empty assistant
        // event. It is in the log forever, and Anthropic and Google both 400
        // on an empty content block, so one early Stop would poison every
        // later request of the session.
        if (event.text === '') break
        // design.md §12: only the live turn needs its code. Every earlier
        // block is superseded by `source`, and sending it again is a second
        // copy of the part for the model to confuse with the real one.
        messages.push({
          role: 'assistant',
          content: event.turn === turn ? event.text : stubFences(event.text),
        })
        if (event.turn === turn) {
          liveReply = true
          liveSource = extractSource(event.text).source !== null
          liveEdits = EDIT_REPLY.test(event.text)
        }
        break
      case 'compile':
        // Verbatim, and only from the live turn: stderr that points at source
        // which no longer exists does not just waste tokens, it misleads.
        if (!event.ok && event.turn === turn) messages.push({ role: 'user', content: event.stderr })
        break
      case 'skill':
        // The refusal is live only, like stderr; a body is attached below.
        if (event.error && event.turn === turn) messages.push({ role: 'user', content: event.error })
        break
      case 'inspect': {
        // Live only, like stderr: a report about a mesh that no longer exists
        // does not just waste tokens, it misleads (design.md §12).
        if (event.turn !== turn) break
        const url = images ? event.image : undefined
        if (!url) {
          messages.push({ role: 'user', content: event.text })
          break
        }
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: event.text },
            { type: 'image_url', image_url: { url } },
          ],
        })
        break
      }
    }
  }

  for (const name of loaded) {
    const body = skills?.(name)
    if (body) messages.push({ role: 'user', content: body })
  }

  // design.md §5: on a retry the model already has the source it just wrote,
  // so the document crosses the wire exactly once per request either way —
  // and a failed candidate is never mislabelled as the current source.
  if (!liveReply || !liveSource) {
    messages.push({ role: 'user', content: sourceMessage(source, components, liveEdits) })
  }

  return messages
}

/** An edit or a part reply: its source is not on the wire, so the applied result is re-attached. */
const EDIT_REPLY = new RegExp(`${EDIT_FENCE.source}|${PART_FENCE.source}`, 'im')

/** Whole numbers stay whole; anything else gets one decimal, like the measured report. */
const num = (n: number): string => String(Math.round(n * 10) / 10)
const vec = (v: readonly number[]): string => `[${v.map(num).join(', ')}]`

function sourceMessage(
  source: string,
  components: readonly ComponentRef[] | undefined,
  edited: boolean,
): string {
  const head = `This is the current source of the part${edited ? ', with your edits applied' : ''}:`
  const body = `\`\`\`openscad\n${source}\n\`\`\``
  if (!components?.length) return `${head}\n\n${body}`
  const list = components.map(
    (c) =>
      `- import("${c.name}") — ${c.max.map((hi, i) => num(hi - (c.min[i] ?? 0))).join(' × ')} mm, from ${vec(c.min)} to ${vec(c.max)}`,
  )
  return `${head}\n\n${body}\n\nMesh files in this document, for import():\n${list.join('\n')}`
}

/** The next turn number for a log, so a revived transcript continues rather than restarts. */
export function nextTurn(log: readonly ChatEvent[]): number {
  let max = 0
  for (const event of log) if (event.turn > max) max = event.turn
  return max + 1
}

/** The persisted form of a user event — design.md §9: images never reach the store. */
export function stripImages(event: ChatEvent): ChatEvent {
  if (event.kind === 'user' && event.images) {
    return { id: event.id, ts: event.ts, turn: event.turn, kind: 'user', text: event.text }
  }
  if (event.kind === 'inspect' && event.image) {
    return { id: event.id, ts: event.ts, turn: event.turn, kind: 'inspect', text: event.text }
  }
  return event
}

/**
 * Trust boundary for a transcript read back from the store or a project file.
 * An event with a missing text would put `undefined` on the wire on every later
 * request, so a malformed event is dropped rather than repaired.
 */
export function reviveLog(raw: unknown): ChatEvent[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const events: ChatEvent[] = []
  for (const item of raw) {
    const event = reviveEvent(item)
    if (event && !seen.has(event.id)) {
      seen.add(event.id)
      events.push(event)
    }
  }
  return events
}

function reviveEvent(raw: unknown): ChatEvent | null {
  const e = raw as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.turn !== 'number') {
    return null
  }
  const base = { id: e.id, ts: typeof e.ts === 'number' ? e.ts : 0, turn: e.turn }
  const text = typeof e.text === 'string' ? e.text : null
  switch (e.kind) {
    case 'user':
      return text === null ? null : { ...base, kind: 'user', text }
    case 'assistant':
      return text === null
        ? null
        : { ...base, kind: 'assistant', text, ...(e.stopped === true ? { stopped: true as const } : {}) }
    case 'note':
      return text === null
        ? null
        : { ...base, kind: 'note', text, tone: e.tone === 'error' ? 'error' : 'info' }
    case 'inspect':
      return text === null ? null : { ...base, kind: 'inspect', text }
    case 'skill':
      return typeof e.name !== 'string'
        ? null
        : { ...base, kind: 'skill', name: e.name, ...(typeof e.error === 'string' ? { error: e.error } : {}) }
    case 'summary':
      return text === null || typeof e.coversThrough !== 'string'
        ? null
        : { ...base, kind: 'summary', text, coversThrough: e.coversThrough }
    case 'compile':
      return typeof e.stderr !== 'string'
        ? null
        : {
            ...base,
            kind: 'compile',
            ok: e.ok === true,
            ms: typeof e.ms === 'number' ? e.ms : 0,
            attempt: typeof e.attempt === 'number' ? e.attempt : 0,
            stderr: e.stderr,
          }
    case 'clear':
      return { ...base, kind: 'clear' }
    default:
      return null
  }
}
