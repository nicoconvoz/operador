import { volatilityPct, DEFAULT_DCA_SCALE_POLICY } from '../domain/strategy/dca-scale.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { type Candles } from './replay.js'

/**
 * How much a stranger moves every five minutes — what the volatility door reads.
 *
 * *Que la puerta de entrada haga pasar los mejores tokens, los de mayor
 * volatilidad.* The operator. The measure is `volatilityPct`, the same one the
 * DCA spacing already reads, over the last six hours of CLOSED 5-minute bars:
 * one definition of "how much it moves", not two that drift.
 */

/** Six hours of five-minute bars. */
export const VOLATILITY_CANDLES = 72
/** Fewer closes than this is too little to call it a measurement. */
export const MIN_VOLATILITY_CLOSES = 24
/**
 * How long an answer stands. Six hours of bars barely move in ten minutes, and
 * with free slots the scan runs every pass: without this, every rising stranger
 * would cost a chart request every eighty seconds.
 */
export const VOLATILITY_TTL_MS = 10 * 60_000

export interface VolatilityTarget {
  readonly chain: Chain
  readonly address: string
  readonly pairAddress: string
}

export function volatilityProbe(deps: {
  readonly candles: (target: VolatilityTarget) => Promise<Candles>
  readonly now: () => number
  readonly ttlMs?: number
}): (target: VolatilityTarget) => Promise<number | null> {
  const ttl = deps.ttlMs ?? VOLATILITY_TTL_MS
  const known = new Map<string, { readonly vol: number | null; readonly at: number }>()
  const policy = { ...DEFAULT_DCA_SCALE_POLICY, minReturns: MIN_VOLATILITY_CLOSES - 1 }
  return async (target) => {
    const key = `${target.chain}:${target.address}`
    const was = known.get(key)
    if (was && deps.now() - was.at <= ttl) return was.vol
    // A failure throws through and is never remembered: a provider that could
    // not answer has not measured anything.
    const series = await deps.candles(target)
    const vol = volatilityPct(series.close.slice(-VOLATILITY_CANDLES), policy)
    known.set(key, { vol, at: deps.now() })
    return vol
  }
}
