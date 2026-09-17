import { type MarketQuality } from '../market/market-quality.js'
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
  /** Which WAY it has been going lately. `volatility` says only that it moved. */
  readonly momentum: number
  /**
   * How little of the move the chain will take. The first capital-floor run
   * measured 10% of gross on one token and 72% on another, same strategy and
   * same budget — so the venue's toll is a property OF THE TOKEN, and a
   * ranking that ignores it ranks a trap alongside a bargain.
   */
  readonly costEfficiency: number
}

export interface OpportunityPolicy {
  readonly weights: OpportunityWeights
  /** Hourly volume run-rate over the 24h average that counts as fully "expanding". */
  readonly fullExpansionRatio: number
  /** Trades per hour that count as fully active. */
  readonly fullActivityTxnsPerHour: number
  /** Absolute 1h move (plus half the 6h move) that counts as fully volatile, percent. */
  readonly fullVolatilityPct: number
  /**
   * The move that counts as a FULL lean in each window, up or down.
   *
   * One scale per window, because ±8% inside an hour and ±40% across a day are
   * the same amount of news — normalising all three against one number would
   * make the day dominate and the recent hour invisible, which is the opposite
   * of what "lately" means.
   */
  readonly momentumSpan1hPct: number
  readonly momentumSpan6hPct: number
  readonly momentumSpan24hPct: number
  /**
   * Round-trip cost, in percent, at which cost efficiency scores zero. A full
   * cycle pays the fill cost on the way in and the exit cost on the way out;
   * past this the toll plausibly exceeds what a DCA cycle can produce.
   */
  readonly worstRoundTripPct: number
}

export const DEFAULT_OPPORTUNITY_POLICY: OpportunityPolicy = {
  // `momentum` takes its weight from `volatility`, which it complements rather
  // than replaces: volatility says the token is MOVING, momentum says which
  // way. Rewarding the first alone made a token down 40% on the day and one up
  // 40% look identical to the shortlist.
  weights: { volumeExpansion: 0.3, buyPressure: 0.15, liquidityGrowth: 0.1, activity: 0.1, volatility: 0.08, momentum: 0.17, costEfficiency: 0.2 },
  fullExpansionRatio: 3,
  fullActivityTxnsPerHour: 60,
  fullVolatilityPct: 20,
  momentumSpan1hPct: 8,
  momentumSpan6hPct: 20,
  momentumSpan24hPct: 40,
  worstRoundTripPct: 6,
}

export interface OpportunityComponents {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
  readonly momentum: number
  readonly costEfficiency: number
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
 * @param quality the token's measured spread and impact; without it, cost
 *        efficiency is neutral rather than assumed good.
 */
export function scoreOpportunity(
  snapshot: TokenSnapshot,
  policy: OpportunityPolicy,
  previous: TokenSnapshot | null = null,
  quality: MarketQuality | null = null,
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

  // WHICH WAY it has been going lately.
  //
  // `volatility` above measures how much it moved and is blind to direction, so
  // a token down 40% on the day scored exactly like one up 40% — and the
  // shortlist was as happy to buy the falling knife as the climb.
  //
  // Each window is normalised against its OWN scale, because ±8% in an hour and
  // ±40% in a day are the same amount of news, and then weighted toward the
  // RECENT: up on the day but falling this hour is a top rolling over, while
  // down on the day but rising this hour is a bottom turning, and only the
  // recent window separates them.
  //
  // A flat token scores 0.5, and so does an unreported window. Zero movement is
  // the absence of a reason either way, and silence is not evidence — the same
  // rule the gates run on. Scoring either as a FALL would push the book toward
  // whatever moved most in any direction, which is the bias this removes.
  const lean = (pct: number | null, spanPct: number) =>
    pct === null || pct === undefined ? 0.5 : clamp01(0.5 + pct / (2 * spanPct))
  const momentum =
    0.5 * lean(priceChangePct.h1, policy.momentumSpan1hPct) +
    0.3 * lean(priceChangePct.h6, policy.momentumSpan6hPct) +
    0.2 * lean(priceChangePct.h24, policy.momentumSpan24hPct)

  // Round trip = pay to get in, pay to get out. 0.5 (neutral) when unmeasured,
  // so a token is never rewarded for a toll nobody checked.
  const costEfficiency = quality === null ? 0.5 : clamp01(1 - (2 * (quality.spreadPct + quality.slippagePct)) / policy.worstRoundTripPct)

  const components = { volumeExpansion, buyPressure, liquidityGrowth, activity, volatility, momentum, costEfficiency }
  const w = policy.weights
  const weightSum =
    w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.activity + w.volatility + w.momentum + w.costEfficiency
  const weighted =
    w.volumeExpansion * volumeExpansion +
    w.buyPressure * buyPressure +
    w.liquidityGrowth * liquidityGrowth +
    w.activity * activity +
    w.volatility * volatility +
    w.momentum * momentum +
    w.costEfficiency * costEfficiency

  return { score: (100 * weighted) / weightSum, components }
}
