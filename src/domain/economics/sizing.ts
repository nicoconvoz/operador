import { type MarketQuality } from '../market/market-quality.js'
import { usdForLevel } from '../strategy/ladder.js'
import { type CascadeParams, PYRAMIDING } from '../strategy/params.js'

/**
 * Position sizing — where the strategy's nominal USD meets the pool's reality.
 *
 * `usd(n)` from DCA.pine is what the strategy WANTS. What the executor may
 * actually deploy is bounded by three things:
 *
 *  1. Per-fill cost. Every buy pays spread + price impact. The impact budget
 *     is what is left of `maxFillCostPct` after the venue's own fee.
 *  2. Exit cost. `close_all` sells the ENTIRE position in one order, so the
 *     total position — not each level — determines what leaving costs. This is
 *     the constraint people forget, and on a thin pool it binds first.
 *  3. A gas floor. A fill so small that fixed costs dominate is not worth
 *     placing at all.
 *
 * If the upper bounds fall below the floor, the token cannot carry this
 * ladder and the executor refuses it — regardless of what the scanner said.
 * "The executor validates, it does not trust."
 */

export interface SizingPolicy {
  /** Budget per BUY, spread + impact, in percent. The user's number: 1%. */
  readonly maxFillCostPct: number
  /**
   * Budget for the single sell that closes the whole position, in percent.
   * Looser than the fill budget on purpose: it happens once, and by the
   * strategy's own rules only in profit (or on a death exit, where getting
   * out at all beats getting out cheaply).
   */
  readonly maxExitCostPct: number
  /** Below this, gas and rounding dominate and the fill is not worth placing. */
  readonly minFillUsd: number
}

/**
 * The smallest fill worth placing, DERIVED from what gas costs rather than
 * picked by feel.
 *
 * A fixed floor is a guess that stops being true the moment gas moves: $20 is
 * generous on Solana at $0.01 a swap and reckless on a congested chain at
 * $0.20. The honest floor is whatever size keeps gas under the share of it you
 * are willing to lose.
 *
 * @param maxGasSharePct how much of a fill gas may eat, in percent.
 */
export const gasFloorUsd = (gasUsdPerSwap: number, maxGasSharePct = 1): number =>
  maxGasSharePct > 0 ? (gasUsdPerSwap * 100) / maxGasSharePct : Infinity

export const DEFAULT_SIZING_POLICY: SizingPolicy = {
  maxFillCostPct: 1.0,
  maxExitCostPct: 3.0,
  // Solana priority fees sit near $0.05, and a fill where gas is 1% is the
  // smallest one worth making. Recompute this whenever gas changes.
  minFillUsd: gasFloorUsd(0.05, 1),
}

export type SizingLimit = 'none' | 'fillCost' | 'exitCost' | 'capital'

export interface LevelSizing {
  readonly level: number
  /** What DCA.pine asks for. */
  readonly nominalUsd: number
  /** What the executor will actually deploy. */
  readonly sizedUsd: number
  readonly limitedBy: SizingLimit
  /** Expected cost of this buy: spread + impact, in percent. */
  readonly fillCostPct: number
}

export interface LadderSizing {
  readonly tradeable: boolean
  /** Why not, when `tradeable` is false. */
  readonly reason: string | null
  readonly levels: readonly LevelSizing[]
  readonly totalUsd: number
  readonly nominalTotalUsd: number
  /** Cost of selling the whole sized position in one order, in percent. */
  readonly exitCostPct: number
  /**
   * The depth the model uses. A MEASURED quote beats reported TVL: on
   * concentrated venues the pool can hold $186k and still move 5% on a $100
   * order, because almost none of it sits at the current price.
   */
  readonly effectiveDepthUsd: number
  readonly depthSource: 'measured' | 'reported'
}

/**
 * Depth implied by a measured quote, inverting the constant-product impact
 * model: impact% = usd / (depth/2) × 100  ⇒  depth = 200 × usd / impact%.
 *
 * Falls back to reported liquidity when nothing was measured, and when a
 * measurement of exactly zero impact makes the inversion meaningless.
 */
export function effectiveDepth(quality: MarketQuality): { usd: number; source: 'measured' | 'reported' } {
  if (quality.slippagePct > 0 && quality.referenceUsd > 0) {
    return { usd: (200 * quality.referenceUsd) / quality.slippagePct, source: 'measured' }
  }
  return { usd: quality.liquidityUsd, source: 'reported' }
}

/** Impact, in percent, of an order of `usd` against `depth`. */
const impactPct = (usd: number, depth: number): number => (depth > 0 ? (usd / (depth / 2)) * 100 : Infinity)

/** Largest order whose impact stays within `budgetPct`. */
const maxOrderUsd = (budgetPct: number, depth: number): number => (budgetPct <= 0 ? 0 : (budgetPct * depth) / 200)

/**
 * Sizes the whole ladder against one token's market quality.
 *
 * Levels are sized in order and the exit budget is consumed as the position
 * grows: an early level may take its full nominal size while a later one is
 * cut or dropped entirely, which is exactly the shape a DCA ladder needs —
 * the scouting entry matters less than being able to leave.
 *
 * @param availableCapitalUsd capital this position may deploy in total. The
 *        pool bounds what the market can absorb; this bounds what the wallet
 *        actually has. Omitting it sizes against the pool alone — useful for
 *        asking "what could this token carry", not for placing orders.
 */
export function sizeLadder(
  params: CascadeParams,
  quality: MarketQuality,
  policy: SizingPolicy = DEFAULT_SIZING_POLICY,
  availableCapitalUsd = Infinity,
): LadderSizing {
  const depth = effectiveDepth(quality)
  // Both budgets are TOTAL cost, so the venue's fee comes out of each before
  // anything is left for impact. Forgetting this on the exit side silently
  // lets the position grow past its own budget by exactly one spread.
  const fillImpactBudget = policy.maxFillCostPct - quality.spreadPct
  const exitImpactBudget = policy.maxExitCostPct - quality.spreadPct
  const perFillCap = maxOrderUsd(fillImpactBudget, depth.usd)
  // Two ceilings on the total, and the binding one is whichever is smaller:
  // what the pool can absorb on the way out, and what the wallet holds. A
  // ladder sized past the capital does not fail gracefully — every level
  // beyond it is simply rejected for funds, which reads as a strategy that
  // does not trade rather than a position that was sized wrong.
  const positionCap = Math.min(maxOrderUsd(exitImpactBudget, depth.usd), availableCapitalUsd)

  const fillable = Math.min(params.maxLevels + 1, PYRAMIDING)
  const nominalTotalUsd = Array.from({ length: fillable }, (_, level) => usdForLevel(params, level)).reduce((a, b) => a + b, 0)

  const empty = (reason: string): LadderSizing => ({
    tradeable: false, reason, levels: [], totalUsd: 0, nominalTotalUsd,
    exitCostPct: 0, effectiveDepthUsd: depth.usd, depthSource: depth.source,
  })

  if (fillImpactBudget <= 0) {
    return empty(`venue spread ${quality.spreadPct}% already exceeds the ${policy.maxFillCostPct}% fill budget`)
  }
  if (perFillCap < policy.minFillUsd) {
    return empty(`a ${policy.maxFillCostPct}% fill allows only $${perFillCap.toFixed(0)}, below the $${policy.minFillUsd} floor`)
  }
  if (positionCap < policy.minFillUsd) {
    const bound = positionCap === availableCapitalUsd ? 'capital' : `a ${policy.maxExitCostPct}% exit`
    return empty(`${bound} allows a position of only $${positionCap.toFixed(0)}, below the $${policy.minFillUsd} floor`)
  }

  const levels: LevelSizing[] = []
  let deployed = 0

  for (let level = 0; level < fillable; level++) {
    const nominalUsd = usdForLevel(params, level)
    const roomInPosition = positionCap - deployed

    const sizedUsd = Math.min(nominalUsd, perFillCap, roomInPosition)
    let limitedBy: SizingLimit = 'none'
    if (sizedUsd < nominalUsd) {
      if (roomInPosition >= perFillCap) limitedBy = 'fillCost'
      else limitedBy = positionCap === availableCapitalUsd ? 'capital' : 'exitCost'
    }

    // A level that cannot be funded above the gas floor is not placed, and
    // neither is anything after it — the ladder is exhausted.
    if (sizedUsd < policy.minFillUsd) {
      if (level === 0) return empty(`level 0 can only be funded with $${sizedUsd.toFixed(0)}, below the $${policy.minFillUsd} floor`)
      break
    }

    deployed += sizedUsd
    levels.push({ level, nominalUsd, sizedUsd, limitedBy, fillCostPct: quality.spreadPct + impactPct(sizedUsd, depth.usd) })
  }

  return {
    tradeable: levels.length > 0,
    reason: null,
    levels,
    totalUsd: deployed,
    nominalTotalUsd,
    exitCostPct: quality.spreadPct + impactPct(deployed, depth.usd),
    effectiveDepthUsd: depth.usd,
    depthSource: depth.source,
  }
}
