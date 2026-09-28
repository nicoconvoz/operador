import { type Candles } from './replay.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { lastHourVolatilityPct, REALTIME_BAR_MS } from '../domain/strategy/dca-scale.js'

/** The last hour's volatility of one token, and when it was read. */
export interface RecentVolatility {
  /** In percent per 5-minute bar — what `realtimeDcaScale` reads. */
  readonly volPct: number
  /**
   * When the candles it came from were fetched. The SAME for every answer
   * served out of one bar's cache, so a caller that writes the reading down
   * can tell a new one from one it has already written.
   */
  readonly measuredAt: number
}

/**
 * The last hour of closed 5-minute bars, asked ONCE per position per bar.
 *
 * *Tiempo real.* The sweep looks every thirty seconds and a new 5-minute bar
 * is the only thing that can change this answer, so asking every sweep would
 * fetch the same twelve closes ten times over. Keyed on the BAR, not on a
 * five-minute timer from the fetch: a timer started at 12:04:50 would hold the
 * old hour until 12:09:50, blind to the bar that closed at 12:05.
 *
 * What is remembered, and what is not — the rule every cache here runs on:
 *
 * - **An answer is kept for the bar**, including "too few bars in the hour to
 *   measure": that is a fact about the token, and it cannot change before
 *   another bar closes.
 * - **A refusal is never kept.** A feed that could not answer said nothing
 *   about the token; remembering it would turn one bad request into five
 *   minutes of the fallback spacing, and the next sweep asks again.
 *
 * Null when there is nothing to measure from: the caller falls back to the
 * at-buy scale, then to one. Silence is not evidence.
 */
export function lastHourVolatility(deps: {
  /** Enough recent 5-minute bars to cover the last hour; null when no source answered. */
  readonly candles: (position: PersistedPosition) => Promise<Candles | null>
  readonly now: () => number
}): (position: PersistedPosition) => Promise<RecentVolatility | null> {
  const answers = new Map<string, { readonly bar: number; readonly answer: RecentVolatility | null }>()
  return async (position) => {
    const at = deps.now()
    const bar = Math.floor(at / REALTIME_BAR_MS)
    const kept = answers.get(position.id)
    if (kept !== undefined && kept.bar === bar) return kept.answer

    let candles: Candles | null
    try {
      candles = await deps.candles(position)
    } catch {
      candles = null
    }
    if (candles === null) return null

    const volPct = lastHourVolatilityPct(candles, at)
    const answer = volPct === null ? null : { volPct, measuredAt: at }
    // Only the current bar's answers are worth holding. Dropping the rest here
    // keeps the map the size of the book rather than of every position the
    // engine ever held.
    for (const [id, entry] of answers) if (entry.bar !== bar) answers.delete(id)
    answers.set(position.id, { bar, answer })
    return answer
  }
}
