import type { Usage } from '../llm/openrouter'

export interface Spend {
  prompt: number
  completion: number
  /** null once any turn of the session went unpriced. See addUsage. */
  usd: number | null
}

/** Frozen: this is the start state every session shares, not a scratch object. */
export const ZERO_SPEND: Spend = Object.freeze({ prompt: 0, completion: 0, usd: 0 })

/**
 * The figure, or NaN for "no usable number here". Everything this module is fed
 * is unvalidated network JSON — readChunk forwards the provider's usage frame
 * exactly as it arrived, and the pricing strings come straight off /models — so
 * `number` and `string` are claims, not facts. NaN is the right answer to a
 * broken one because IEEE-754 then carries "unknown" through the arithmetic for
 * us, with no flag to thread.
 *
 * Number(''), Number(' '), Number(null) and Number([]) are all 0, which would
 * silently price a turn as free, so only a non-blank string is ever converted
 * and anything that is not a number by then is refused. The "-1"
 * variable-pricing sentinel needs no case of its own: negative money is not a
 * price.
 */
function usable(value: unknown): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : NaN
}

/**
 * Pure — the caller holds the running Spend.
 *
 * Tokens always accumulate, but `usd` is all-or-nothing: a single turn with no
 * pricing (catalogue still loading, or a model missing from it) or an unusable
 * price leaves it null for the rest of the session, because NaN poisons the sum
 * and null feeds NaN back in on the next call. A partial total displayed as the
 * whole is worse than no total — the user is reading it to decide whether to
 * send another one of these.
 *
 * Plain float accumulation, deliberately. Twenty turns of a 1M-context model
 * land ~4e-16 from the exact sum; the smallest digit ever displayed is 1e-4, so
 * the drift would have to grow twelve orders of magnitude to change a character.
 */
export function addUsage(
  spend: Spend,
  usage: Usage,
  pricing?: { prompt: string; completion: string },
): Spend {
  const prompt = usable(usage.prompt_tokens)
  const completion = usable(usage.completion_tokens)
  const usd =
    (spend.usd ?? NaN) + prompt * usable(pricing?.prompt) + completion * usable(pricing?.completion)

  return {
    // `|| 0` because an unusable count must not turn the counter itself to NaN.
    prompt: spend.prompt + (prompt || 0),
    completion: spend.completion + (completion || 0),
    usd: Number.isFinite(usd) ? usd : null,
  }
}

/**
 * Built once, and pinned to 'en' rather than the machine locale, which would
 * render 12.4k as "12,4 Tsd." One fraction digit is the honesty limit: it makes
 * 999_999 print as 1M, the same rounding "12.4k" already performs.
 */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Intl gets everything right for this footer except the case of its K. */
export function formatTokens(n: number): string {
  return COMPACT.format(n).replace('K', 'k')
}

/**
 * Two decimals from a cent up; four below it, where "$0.01" overstates and
 * "$0.00" claims the session was free. Under $0.0001 no fixed rendering is
 * true any more, so it becomes a bound instead of a claim. Exact zero is
 * genuinely $0.00.
 */
export function formatUsd(usd: number): string {
  if (usd >= 0.01 || usd === 0) return `$${usd.toFixed(2)}`
  return usd < 0.0001 ? '<$0.0001' : `$${usd.toFixed(4)}`
}
