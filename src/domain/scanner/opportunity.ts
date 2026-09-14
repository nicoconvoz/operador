import { type TokenSnapshot } from './snapshot.js'

/**
 * Opportunity score — is this token "breathing"?
 *
 * The scanner does NOT time entries; CASCADE DCA does that with its own
 * swing-high drop and lateral-zone gates. The scanner ranks which tokens are
 * worth running the strategy on: active, gaining attention, volatile enough
 * to produce the drops the ladder needs, and not bleeding liquidity.
 *
 * Every component is exposed, in [0, 1], so a score can always be explained.
 * The weights are policy, and the formula is deliberately simple — this is a
 * v1 heuristic to be tuned against recorded outcomes, not a claim of alpha.
 */

export interface OpportunityWeights {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
}

export interface OpportunityPolicy {
  readonly weights: OpportunityWeights
  /** Hourly volume run-rate over the 24h average that counts as fully "expanding". */
  readonly fullExpansionRatio: number
  /** Trades per hour that count as fully active. */
  readonly fullActivityTxnsPerHour: number
  /** Absolute 1h move (plus half the 6h move) that counts as fully volatile, percent. */
  readonly fullVolatilityPct: number
}

export const DEFAULT_OPPORTUNITY_POLICY: OpportunityPolicy = {
  weights: { volumeExpansion: 0.35, buyPressure: 0.2, liquidityGrowth: 0.15, activity: 0.15, volatility: 0.15 },
  fullExpansionRatio: 3,
  fullActivityTxnsPerHour: 60,
  fullVolatilityPct: 20,
}

export interface OpportunityComponents {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
}

export interface Opportunity {
  /** 0..100 */
  readonly score: number
  readonly components: OpportunityComponents
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * @param previous the last snapshot of the same token, for liquidity growth;
 *        with none, growth is neutral.
 */
export function scoreOpportunity(
  snapshot: TokenSnapshot,
  policy: OpportunityPolicy,
  previous: TokenSnapshot | null = null,
): Opportunity {
  const { volumeUsd, txns, priceChangePct } = snapshot

  // Hourly run-rate vs the 24h hourly average: 1 = steady, 3 = tripling.
  const hourlyAverage = volumeUsd.h24 / 24
  const expansionRatio = hourlyAverage > 0 ? volumeUsd.h1 / hourlyAverage : 0
  const volumeExpansion = clamp01(expansionRatio / policy.fullExpansionRatio)

  // Share of buys in the last hour. 0.5 is neutral; only the excess counts.
  const trades1h = txns.h1.buys + txns.h1.sells
  const buyShare = trades1h > 0 ? txns.h1.buys / trades1h : 0.5
  const buyPressure = clamp01((buyShare - 0.5) * 2)

  // Liquidity vs the previous look: 1 = flat, ≥ 1.5 = fully growing, ≤ 0.5 = gone.
  const growthRatio = previous && previous.liquidityUsd > 0 ? snapshot.liquidityUsd / previous.liquidityUsd : 1
  const liquidityGrowth = clamp01((growthRatio - 0.5) / 1)

  const activity = clamp01(trades1h / policy.fullActivityTxnsPerHour)

  const move = Math.abs(priceChangePct.h1 ?? 0) + Math.abs(priceChangePct.h6 ?? 0) / 2
  const volatility = clamp01(move / policy.fullVolatilityPct)

  const components = { volumeExpansion, buyPressure, liquidityGrowth, activity, volatility }
  const w = policy.weights
  const weightSum = w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.activity + w.volatility
  const weighted =
    w.volumeExpansion * volumeExpansion +
    w.buyPressure * buyPressure +
    w.liquidityGrowth * liquidityGrowth +
    w.activity * activity +
    w.volatility * volatility

  return { score: (100 * weighted) / weightSum, components }
}
