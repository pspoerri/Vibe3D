import type { ChatMessage, ContentPart } from '../llm/openrouter'
import { stubFences } from './fence'

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
  | { id: string; ts: number; turn: number; kind: 'note'; text: string; tone: 'info' | 'error' }
  | { id: string; ts: number; turn: number; kind: 'clear' }
  | { id: string; ts: number; turn: number; kind: 'summary'; text: string; coversThrough: string }

export interface WindowInput {
  /** The full log INCLUDING the in-flight turn's events so far. */
  readonly log: readonly ChatEvent[]
  /** The turn number in flight. Events with this turn are treated as live. */
  readonly turn: number
  readonly systemPrompt: string
  /** The committed document. Never a streamed partial, never a retry candidate. */
  readonly source: string
  /**
   * False strips image parts from every message, live turn included. Exists for
   * exactly one caller — runCompact — whose window is built for the turn that
   * just ran and would otherwise re-bill its images unattended.
   */
  readonly images?: boolean
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
  images = true,
}: WindowInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

  let start = 0
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.kind === 'clear') {
      start = i + 1
      break
    }
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
        if (event.turn === turn) liveReply = true
        break
      case 'compile':
        // Verbatim, and only from the live turn: stderr that points at source
        // which no longer exists does not just waste tokens, it misleads.
        if (!event.ok && event.turn === turn) messages.push({ role: 'user', content: event.stderr })
        break
    }
  }

  // design.md §5: on a retry the model already has the source it just wrote,
  // so the document crosses the wire exactly once per request either way —
  // and a failed candidate is never mislabelled as the current source.
  if (!liveReply) {
    messages.push({
      role: 'user',
      content: `This is the current source of the part:\n\n\`\`\`openscad\n${source}\n\`\`\``,
    })
  }

  return messages
}
