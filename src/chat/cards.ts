import type { ChatEvent } from './log'

type Inspect = Extract<ChatEvent, { kind: 'inspect' }>

/** What the transcript draws: an event as it is, or a turn's inspection rounds folded into one card. */
export type Card = { kind: 'event'; event: ChatEvent } | { kind: 'checks'; turn: number; rounds: Inspect[] }

/**
 * The log as the reader sees it. A turn's inspection rounds fold into one
 * card where the first of them was, and a turn that has a result card drops
 * its successful compile chips — the result says the same with the version.
 * Failed compiles stay: the user should see what the model was repairing.
 */
export function cardsOf(log: readonly ChatEvent[]): Card[] {
  const results = new Set(log.flatMap((e) => (e.kind === 'result' ? [e.turn] : [])))
  const folded = new Map<number, Inspect[]>()
  const out: Card[] = []
  for (const event of log) {
    if (event.kind === 'compile' && event.ok && results.has(event.turn)) continue
    if (event.kind === 'inspect') {
      const rounds = folded.get(event.turn)
      if (rounds) {
        rounds.push(event)
        continue
      }
      folded.set(event.turn, [event])
      out.push({ kind: 'checks', turn: event.turn, rounds: folded.get(event.turn)! })
      continue
    }
    out.push({ kind: 'event', event })
  }
  return out
}

/** The bracketed heads the chat puts on a user message, and the words after them. */
export function userHeads(text: string): { part: { n: string; size: string } | null; markup: boolean; body: string } {
  let part: { n: string; size: string } | null = null
  let markup = false
  const paragraphs = text.split('\n\n')
  while (paragraphs.length > 0) {
    const head = paragraphs[0]!
    const selected = /^\[Selected part (\d+) of \d+: ([^,]+?) mm, from .*\]$/.exec(head)
    if (selected) part = { n: selected[1]!, size: selected[2]! }
    else if (head === '[Attached: the viewport with my markup in red]') markup = true
    else break
    paragraphs.shift()
  }
  return { part, markup, body: paragraphs.join('\n\n') }
}

/** "once", "twice", "3 times". */
export const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
