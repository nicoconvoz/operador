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
  /**
   * How many entries the venue will hold open at once, when production wants
   * fewer than the reference.
   *
   * Omitted means `PYRAMIDING` — the 10 from the `strategy()` header, which the
   * parity harness asserts is the backtest's input. That number is EVIDENCE,
   * so a production preference composes its own value rather than editing it,
   * exactly as `maxUsdPerLevel` does.
   *
   * The case for fewer: with `linInc` at 3, DCA-5 already needs a 13% fall and
   * DCA-10 needs 28%. A token down 28% is rarely an opportunity, and the
   * capital those deep rungs reserve buys more by going to another token —
   * which is finding 2 of the capital floor, arriving by a different road.
   */
  readonly maxOpenEntries?: number
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
/**
 * What a round trip actually costs, as a percentage of the money put in.
 *
 * Three terms, and the first is the one that surprises people: GAS IS FIXED,
 * so its share is enormous on a small fill and negligible on a large one. At
 * $0.05 a swap it is 0.67% of a $15 position and 0.20% of a $50 one, for the
 * identical trade.
 *
 * The spread and the impact are percentages already and simply double: you pay
 * them going in and coming out.
 */
export const roundTripCostPct = (
  fillUsd: number,
  spreadPct: number,
  slippagePct: number,
  gasUsdPerSwap: number,
): number => (fillUsd > 0 ? 2 * (spreadPct + slippagePct + (100 * gasUsdPerSwap) / fillUsd) : 100)

/**
 * The profit a position must show before the exit may take it, DERIVED from
 * what leaving actually costs rather than picked.
 *
 * `minProfitPct` was a flat 2, and on the book the operator was running that
 * was below the economic floor. Measured on his own numbers: a $15 position in
 * a deep pool pays about 1.27% to go in and out — $0.10 of gas and $0.09 of
 * spread — so a 2% target left ELEVEN CENTS of gross per winner, while the
 * losers had no bound at all. Winners capped, losers open: that shape cannot
 * work however good the selection is.
 *
 * The parameter is a SHARE, not a multiple picked by feel: `maxCostSharePct`
 * says how much of the gross gain the chain is allowed to eat. At a third, the
 * target is three times the round trip, and two thirds of every winner is
 * yours.
 *
 * ## It adapts to the position size, which is the point
 *
 * Because gas is fixed, a small position pays a larger percentage and is
 * therefore asked for a larger move. That is not a penalty invented here — it
 * is the capital floor's own finding stated as a rule: *tiny positions are
 * eaten by gas.* A $15 position needs about 3.8%; a $50 one needs 2.4% for
 * exactly the same net.
 *
 * ## What it COSTS, stated rather than discovered later
 *
 * A higher bar fires less often. A token that would have been sold at +2% is
 * now held for more, and some of those give it back instead. The trade is a
 * smaller number of trades that are each worth making, against a larger number
 * that were not — and the eleven cents says which side of that line a 2%
 * target on $15 was on.
 *
 * The FLOOR exists for the case the arithmetic cannot see: a pool so cheap the
 * derived target rounds to almost nothing would have the engine selling on
 * noise, paying its round trip for a move that means nothing.
 */
export const minProfitPctFor = (
  roundTripPct: number,
  maxCostSharePct = 33,
  floorPct = 2,
): number => (maxCostSharePct > 0 ? Math.max(floorPct, (roundTripPct * 100) / maxCostSharePct) : floorPct)

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

  const fillable = Math.min(params.maxLevels + 1, policy.maxOpenEntries ?? PYRAMIDING)
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
