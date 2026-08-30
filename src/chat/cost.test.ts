import { expect, test } from 'vitest'
import type { Usage } from '../llm/openrouter'
import { ZERO_SPEND, addUsage, formatTokens, formatUsd } from './cost'

/** Read off /api/v1/models: google/gemini-3.7-flash is $0.75/M in, $3.75/M out. */
const FLASH = { prompt: '0.00000075', completion: '0.00000375' }

const usage = (prompt: number, completion: number): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
})

test('accumulates tokens and cost without touching what it was given', () => {
  const first = addUsage(ZERO_SPEND, usage(1000, 200), FLASH)
  const second = addUsage(first, usage(2000, 400), FLASH)

  expect(second.prompt).toBe(3000)
  expect(second.completion).toBe(600)
  expect(second.usd).toBeCloseTo(3000 * 7.5e-7 + 600 * 3.75e-6, 12)

  expect(first).toEqual({ prompt: 1000, completion: 200, usd: first.usd })
  expect(first.usd).toBeCloseTo(0.00075 + 0.00075, 12)
  expect(ZERO_SPEND).toEqual({ prompt: 0, completion: 0, usd: 0 })
})

test('the -1 variable-pricing sentinel yields no total, but still counts tokens', () => {
  // openrouter/auto and friends really do ship pricing {"prompt":"-1"}.
  expect(addUsage(ZERO_SPEND, usage(1000, 200), { prompt: '-1', completion: '-1' })).toEqual({
    prompt: 1000,
    completion: 200,
    usd: null,
  })
})

test('a price that does not parse yields no total', () => {
  // '' is the one that matters: Number('') is 0, which would read as free.
  for (const bad of ['', ' ', 'free', 'NaN', 'Infinity', '$0.75', '0.0000,75']) {
    expect(addUsage(ZERO_SPEND, usage(10, 10), { ...FLASH, prompt: bad }).usd).toBeNull()
    expect(addUsage(ZERO_SPEND, usage(10, 10), { ...FLASH, completion: bad }).usd).toBeNull()
  }
})

test('a genuinely free model is priced at zero, not unknown', () => {
  expect(addUsage(ZERO_SPEND, usage(1000, 200), { prompt: '0', completion: '0' })).toEqual({
    prompt: 1000,
    completion: 200,
    usd: 0,
  })
})

test('one unpriced turn poisons the session total for good', () => {
  const priced = addUsage(ZERO_SPEND, usage(1000, 100), FLASH)
  // The catalogue fetch failed, or the model is not in it.
  const blind = addUsage(priced, usage(1000, 100))
  const pricedAgain = addUsage(blind, usage(1000, 100), FLASH)

  expect(priced.usd).toBeGreaterThan(0)
  expect(blind.usd).toBeNull()
  expect(pricedAgain.usd).toBeNull()
  expect(pricedAgain.prompt).toBe(3000)
  expect(pricedAgain.completion).toBe(300)
})

test('a usage frame that is not numbers cannot poison the counters', () => {
  // readChunk forwards the provider's frame unvalidated, so `number` is a claim.
  const junk = { prompt_tokens: undefined, completion_tokens: 'lots' } as unknown as Usage
  expect(addUsage(ZERO_SPEND, junk, FLASH)).toEqual({ prompt: 0, completion: 0, usd: null })
  expect(addUsage(ZERO_SPEND, usage(NaN, 500), FLASH)).toEqual({
    prompt: 0,
    completion: 500,
    usd: null,
  })
})

test('formats token counts on both sides of each boundary', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(847)).toBe('847')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(1049)).toBe('1k')
  expect(formatTokens(1050)).toBe('1.1k')
  expect(formatTokens(12400)).toBe('12.4k')
  expect(formatTokens(30000)).toBe('30k')
  expect(formatTokens(999499)).toBe('999.5k')
  // Rounds up across the suffix, which is the same rounding 12.4k already does.
  expect(formatTokens(999999)).toBe('1M')
  expect(formatTokens(1000000)).toBe('1M')
  expect(formatTokens(1200000)).toBe('1.2M')
  expect(formatTokens(1048576)).toBe('1M')
})

test('formats money on both sides of the cent, and never rounds a cost to zero', () => {
  expect(formatUsd(0)).toBe('$0.00')
  expect(formatUsd(0.01)).toBe('$0.01')
  expect(formatUsd(0.999)).toBe('$1.00')
  expect(formatUsd(1.5)).toBe('$1.50')
  expect(formatUsd(12.345)).toBe('$12.35')

  expect(formatUsd(0.00999)).toBe('$0.0100')
  expect(formatUsd(0.0075)).toBe('$0.0075')
  expect(formatUsd(0.0001)).toBe('$0.0001')
  expect(formatUsd(0.00005)).toBe('<$0.0001')

  // The rule the footer exists for: real money is never displayed as $0.00.
  for (const usd of [7.5e-7, 1e-9, 0.000099, 0.0001, 0.004, 0.00999]) {
    expect(formatUsd(usd)).not.toBe('$0.00')
  }
})

test('20 turns of gemini-3.7-flash total what hand arithmetic says', () => {
  let spend = ZERO_SPEND
  for (let turn = 1; turn <= 20; turn++) {
    spend = addUsage(spend, usage(20_000 * turn, 1_500), FLASH)
  }

  // prompt:     20_000 * (1+…+20) = 4_200_000 @ $0.75/M  = $3.15
  // completion: 20 * 1_500        =    30_000 @ $3.75/M  = $0.1125
  expect(spend.prompt).toBe(4_200_000)
  expect(spend.completion).toBe(30_000)
  expect(spend.usd).toBeCloseTo(3.2625, 12)
  // The accumulated double is not exactly 3.2625, but the drift is ~4e-16 —
  // twelve orders below the digit that reaches the screen.
  expect(Math.abs(spend.usd! - 3.2625)).toBeLessThan(1e-12)

  expect(formatTokens(spend.prompt)).toBe('4.2M')
  expect(formatTokens(spend.completion)).toBe('30k')
  expect(formatUsd(spend.usd!)).toBe('$3.26')
})
