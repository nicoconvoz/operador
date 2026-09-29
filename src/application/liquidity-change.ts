import { type PersistedPosition } from '../domain/persistence/store.js'
import { type LiquidityReading } from '../domain/strategy/liquidity-brake.js'

/**
 * How long one reading of a pool's liquidity stands: a minute.
 *
 * The sweep looks every thirty seconds, from the cycle and from the loop
 * between cycles, and the watch follows every held position on every one of
 * them. Jupiter's own windows are five minutes and an hour; a reading a minute
 * old is still the same five minutes within a fifth of it, and the same hour
 * within a sixtieth.
 */
export const LIQUIDITY_CHANGE_MAX_AGE_MS = 60_000

/**
 * The brake's readings for a whole book: the tokens not held fresh asked in
 * ONE call, each answer held a minute. Keyed `chain:token`, like the prices
 * the sweep is handed.
 *
 * ONE instance for the runtime, because the cycle's sweeps and the loop's both
 * read it: two memories would each ask Jupiter for the same answers.
 *
 * What is remembered, and what is not — the rule every cache here runs on:
 *
 * - **An answer is kept for a minute**, whatever it says: Jupiter answered,
 *   and what it said will not change in a minute.
 * - **A failure is never kept.** A throw, or a token nobody answered about,
 *   said nothing about the pool. The sweep reads its absence as silence — the
 *   watch changes nothing on it — and the next sweep asks again. A throw still
 *   serves what is fresh: one refused request is not a reason to forget the
 *   answers already in hand.
 */
export function recentLiquidityChange(deps: {
  /** Readings for these positions' tokens, keyed `chain:token`; a token nobody answered about is absent. */
  readonly changes: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>
  readonly now: () => number
  readonly maxAgeMs?: number
}): (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>> {
  const maxAgeMs = deps.maxAgeMs ?? LIQUIDITY_CHANGE_MAX_AGE_MS
  const kept = new Map<string, { readonly at: number; readonly reading: LiquidityReading }>()
  return async (positions) => {
    const now = deps.now()
    const out = new Map<string, LiquidityReading>()
    // One position per token still to ask, so two positions in one token cost
    // one mint in the request.
    const missing = new Map<string, PersistedPosition>()
    for (const position of positions) {
      const key = `${position.chain}:${position.tokenAddress}`
      const hit = kept.get(key)
      if (hit !== undefined && now - hit.at <= maxAgeMs) out.set(key, hit.reading)
      else if (!missing.has(key)) missing.set(key, position)
    }
    if (missing.size === 0) return out

    let answered: ReadonlyMap<string, LiquidityReading>
    try {
      answered = await deps.changes([...missing.values()])
    } catch {
      return out
    }
    // Only fresh answers are worth holding; dropping the rest keeps the map the
    // size of the book rather than of every token the engine ever held.
    for (const [key, entry] of kept) if (now - entry.at > maxAgeMs) kept.delete(key)
    for (const key of missing.keys()) {
      const reading = answered.get(key)
      if (reading === undefined) continue
      kept.set(key, { at: now, reading })
      out.set(key, reading)
    }
    return out
  }
}
