/**
 * What the scanner hands the executor when a token is selected — and keeps
 * handing it while a position is open.
 *
 * The strategy signals in USD; the venue fills in pool depth. These numbers
 * are how the executor turns one into the other honestly:
 *
 *  - sizing: cap each ladder level so its price impact stays acceptable
 *  - paper fills: model slippage from depth instead of pretending it is zero
 *  - death exit: `liquidityUsd` at entry is the baseline that "liquidity
 *    collapse" is measured against
 */
export interface MarketQuality {
  /** Total pool liquidity in USD (both sides of the pair). */
  readonly liquidityUsd: number
  /**
   * Round-trip cost at negligible size, in percent: the AMM fee plus any
   * bid/ask gap the venue exposes. What you pay for merely being there.
   */
  readonly spreadPct: number
  /**
   * Observed or quoted price impact for a reference order size, in percent.
   * The scanner measures it (a quote for `referenceUsd`); the executor
   * extrapolates from it for other sizes.
   */
  readonly slippagePct: number
  readonly referenceUsd: number
  /** When these numbers were observed. Stale quality is no quality. */
  readonly observedAt: number
}

export class MarketQualityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketQualityError'
  }
}

export function assertMarketQuality(q: MarketQuality): void {
  if (!(q.liquidityUsd > 0)) throw new MarketQualityError('liquidityUsd must be positive')
  if (!(q.spreadPct >= 0)) throw new MarketQualityError('spreadPct must be non-negative')
  if (!(q.slippagePct >= 0)) throw new MarketQualityError('slippagePct must be non-negative')
  if (!(q.referenceUsd > 0)) throw new MarketQualityError('referenceUsd must be positive')
}

/**
 * Price impact of a buy of `usd` against a constant-product pool holding
 * `liquidityUsd` in total. With quote reserve Q = liquidity / 2, a swap of
 * Δ quote moves the average execution price by Δ / Q relative to spot.
 *
 * A first-order model: exact enough for the "is this level too big for this
 * pool" question, and deliberately simpler than reproducing every AMM curve.
 * Real fills come from real quotes; this is the planning estimate.
 */
export function estimatePriceImpactPct(usd: number, liquidityUsd: number): number {
  if (!(liquidityUsd > 0)) throw new MarketQualityError('liquidityUsd must be positive')
  if (!(usd >= 0)) throw new MarketQualityError('usd must be non-negative')
  return (usd / (liquidityUsd / 2)) * 100
}

/**
 * All-in expected cost of one fill of `usd`, in percent: spread plus impact.
 * This is what the paper broker charges, and what sizing must keep bounded.
 */
export function expectedFillCostPct(usd: number, quality: MarketQuality): number {
  assertMarketQuality(quality)
  return quality.spreadPct + estimatePriceImpactPct(usd, quality.liquidityUsd)
}
