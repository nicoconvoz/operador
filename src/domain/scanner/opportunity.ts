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
  /** How much of the rise is still ahead. The higher it is, the further it can fall. */
  readonly headroom: number
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
   * The shape of the room left above a token: LOGARITHMIC.
   *
   * `headroomKneePct` is where the curve bends, and `headroomFullyRunPct` is
   * the rise at which nothing is left. A log curve spends its steepness early:
   * the first thirty percent of a run costs far more room than the last thirty,
   * which is the operator's reading — the higher a token already is, the less
   * one more percent tells you, while the difference between *barely moved* and
   * *already ran* is the one worth paying attention to.
   *
   * It began as `1 / (1 + run/100)` with a weight of 0.05, where a token up 10%
   * and one up 60% landed 1.27 points apart. That broke a tie and nothing more.
   */
  readonly headroomKneePct: number
  readonly headroomFullyRunPct: number
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
  weights: { volumeExpansion: 0.3, buyPressure: 0.15, liquidityGrowth: 0.1, activity: 0.1, volatility: 0.05, momentum: 0.14, headroom: 1.14, costEfficiency: 0.2 },
  fullExpansionRatio: 3,
  fullActivityTxnsPerHour: 60,
  fullVolatilityPct: 20,
  headroomKneePct: 30,
  headroomFullyRunPct: 200,
  worstRoundTripPct: 6,
}

export interface OpportunityComponents {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
  readonly momentum: number
  readonly headroom: number
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
/**
 * Room left above a token that has risen `runPct`, on a log curve.
 *
 * 1 when it has not moved, 0 once it has run `headroomFullyRunPct`, and never
 * negative past that — fully spent is fully spent, and a token up 400% is not
 * worse than one up 200% in any way this component can measure.
 *
 * Logarithmic on purpose. The steepness lands EARLY: the gap between a token
 * that barely moved and one that already ran is the distinction worth paying
 * for, while up near the top one more percent says very little.
 */
export function logHeadroom(runPct: number, policy: OpportunityPolicy): number {
  const knee = policy.headroomKneePct
  const spent = Math.log(1 + runPct / knee) / Math.log(1 + policy.headroomFullyRunPct / knee)
  return clamp01(1 - spent)
}

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
  // It asks only WHETHER each window is up, never by how much.
  //
  // A size threshold here would be an invented number pretending to be a
  // measurement: there is no percentage at which a rise becomes "a rise". What
  // the score needs from this component is the sign, and `volatility` above
  // already carries the magnitude — together they say "moving, and upward",
  // which is the whole point of having both.
  //
  // Weighted toward the RECENT, and the recent hour can outvote the other two
  // between them. Up on the day but falling this hour is a top rolling over;
  // down on the day but rising this hour is a bottom turning. The second is the
  // one worth buying, and only a weighting that lets the near window win can
  // tell them apart.
  //
  // A flat token scores 0.5, and so does an unreported window. Zero movement is
  // the absence of a reason either way, and silence is not evidence — the same
  // rule the gates run on. Scoring either as a FALL would push the book toward
  // whatever moved most in any direction, which is the bias this removes.
  const rising = (pct: number | null | undefined) =>
    pct === null || pct === undefined || pct === 0 ? 0.5 : pct > 0 ? 1 : 0
  const momentum =
    0.6 * rising(priceChangePct.h1) +
    0.25 * rising(priceChangePct.h6) +
    0.15 * rising(priceChangePct.h24)

  // HOW MUCH ROOM IS LEFT above it.
  //
  // Direction is not the whole question: the higher a token already is, the
  // further it can fall, so between two risers the one that has not run yet is
  // worth more than the one that has. The operator's rule.
  //
  // No threshold, and deliberately: a cut-off would be the same invented number
  // `momentum` was rewritten to remove. The curve is smooth, monotone at every
  // size, and never reaches zero — a token that has run is worth LESS, not
  // worthless. `headroomHalvingPct` is how fast it separates two risers, and
  // the gap widens the further either has run, which is the point.
  //
  // Only while RISING. "Low" and "cheap" are not the same claim: a token down
  // 40% and still sinking has enormous room above it and is exactly the knife
  // `momentum` exists to avoid, so it gets neither the bonus nor the penalty.
  const day = priceChangePct.h24
  const headroom =
    priceChangePct.h1 === null || priceChangePct.h1 === undefined || priceChangePct.h1 <= 0
      ? 0.5
      : logHeadroom(Math.max(0, day ?? 0), policy)

  // Round trip = pay to get in, pay to get out. 0.5 (neutral) when unmeasured,
  // so a token is never rewarded for a toll nobody checked.
  const costEfficiency = quality === null ? 0.5 : clamp01(1 - (2 * (quality.spreadPct + quality.slippagePct)) / policy.worstRoundTripPct)

  const components = { volumeExpansion, buyPressure, liquidityGrowth, activity, volatility, momentum, headroom, costEfficiency }
  const w = policy.weights
  const weightSum =
    w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.activity + w.volatility + w.momentum + w.headroom + w.costEfficiency
  const weighted =
    w.volumeExpansion * volumeExpansion +
    w.buyPressure * buyPressure +
    w.liquidityGrowth * liquidityGrowth +
    w.activity * activity +
    w.volatility * volatility +
    w.momentum * momentum +
    w.headroom * headroom +
    w.costEfficiency * costEfficiency

  return { score: (100 * weighted) / weightSum, components }
}
