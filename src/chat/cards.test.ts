import { describe, expect, it } from 'vitest'
import { cardsOf, userHeads } from './cards'
import type { ChatEvent } from './log'
import { referenceLine } from '../viewer/select'

const at = (turn: number, id: string) => ({ id, ts: 0, turn })

describe('cardsOf', () => {
  it("folds a turn's rounds into one card and drops compile chips the result covers", () => {
    const log: ChatEvent[] = [
      { ...at(1, 'u'), kind: 'user', text: 'a plate' },
      { ...at(1, 'c1'), kind: 'compile', ok: true, ms: 5, attempt: 1, stderr: '' },
      { ...at(1, 'i1'), kind: 'inspect', text: 'round 1' },
      { ...at(1, 'a'), kind: 'assistant', text: 'fixed' },
      { ...at(1, 'c2'), kind: 'compile', ok: false, ms: 5, attempt: 2, stderr: 'boom' },
      { ...at(1, 'i2'), kind: 'inspect', text: 'round 2' },
      { ...at(1, 'r'), kind: 'result', version: '2', ok: true, added: 3, removed: 0 },
      { ...at(2, 'c3'), kind: 'compile', ok: true, ms: 5, attempt: 1, stderr: '' },
    ]
    const cards = cardsOf(log)
    expect(cards.map((c) => (c.kind === 'checks' ? `checks:${c.rounds.length}` : c.event.id))).toEqual([
      'u', 'checks:2', 'a', 'c2', 'r', 'c3',
    ])
  })
})

describe('userHeads', () => {
  it('reads the selection and markup heads off a message, and leaves the words', () => {
    const line = referenceLine({ part: 2, of: 3, min: [0, 0, 0], max: [120, 80, 3], triangles: new Uint32Array() } as never)
    const heads = userHeads(`${line}\n\n[Attached: the viewport with my markup in red]\n\nadd a lip`)
    expect(heads).toEqual({ part: { n: '2', size: '120 × 80 × 3' }, markup: true, body: 'add a lip' })
    expect(userHeads('[not a head]\n\nhi').body).toBe('[not a head]\n\nhi')
  })
})
