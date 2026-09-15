import { sizeLadder, type LadderSizing, type SizingPolicy } from '../economics/sizing.js'
import { type MarketQuality } from '../market/market-quality.js'
import { type CascadeParams } from '../strategy/params.js'
import { type TokenSnapshot } from '../scanner/snapshot.js'

/**
 * Portfolio allocation — the answer to the capital-floor experiment's second
 * finding.
 *
 * Above a pool's capacity, extra capital does nothing: Leafy returned the same
 * $159 at $200 and at $20,000. So scale cannot come from bigger positions. It
 * has to come from MORE of them, and that turns capital allocation into a real
 * problem with real limits:
 *
 *  - every slot needs enough capital to clear the floor, or it trades nothing
 *  - no single token may hold so much that its death takes the portfolio
 *  - the number of slots is bounded by capital, not by how many the scanner
 *    happens to like
 *
 * Pure: it decides, it does not act.
 */

export interface PortfolioPolicy {
  /** Capital the portfolio may deploy in total. */
  readonly totalCapitalUsd: number
  /**
   * Hard ceiling on simultaneous positions, whatever the capital allows.
   *
   * ZERO means no ceiling: the capital decides, at `targetPositionUsd` each.
   * That is the honest default once every slot is the same size — what bounds
   * the damage one token can do is then the SIZE of a slot, not how many there
   * are, and capping the count only leaves capital idle.
   */
  readonly maxPositions: number
  /**
   * Largest share of the portfolio one token may be allocated, in percent.
   * The death exit bounds how a position dies; this bounds how much dies
   * with it.
   */
  readonly maxPositionPct: number
  /**
   * Capital below which a slot is not worth opening: under it the ladder cannot
   * clear the gas floor and the position places no orders at all.
   *
   * The live engine DERIVES this and overrides whatever is here, via
   * `slotFloorUsd`. The 200 below was a real measurement — the first
   * capital-floor run traded nothing under it — taken before sizing began
   * reserving gas and 5% of price headroom. That change dropped the floor to
   * under $50 and this number did not move, so it spent weeks capping the book
   * at four slots however much capital was free. Kept as a conservative default
   * for offline experiments; a floor that is derived cannot go stale that way.
   */
  readonly minPositionUsd: number
  /**
   * What a slot SHOULD get when the capital allows it: the wallet a full ladder
   * needs, and not a dollar more.
   *
   * Without it the split is `deployable / slots`, which spreads everything
   * across whatever slots exist — ten slots and $1,425 handed $142 each while a
   * flat six-rung $15 ladder can only ever spend $95. The surplus came straight
   * back as idle capital, and "why only five tokens" had a number nobody had
   * recomputed as its answer.
   *
   * With it, a slot gets what its ladder wants and the WIDTH of the book is the
   * division — which is finding 2 of the capital floor: scale comes from more
   * tokens, not more size per token.
   */
  readonly targetPositionUsd?: number
  /** Held back from allocation for gas and rebalancing. */
  readonly reservePct: number
}

export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  totalCapitalUsd: 1_000,
  maxPositions: 5,
  maxPositionPct: 30,
  minPositionUsd: 200,
  reservePct: 5,
}

export interface AllocationCandidate {
  readonly snapshot: TokenSnapshot
  readonly quality: MarketQuality
  /** 0..100 from the scanner. Higher gets served first. */
  readonly score: number
}

export interface Allocation {
  readonly snapshot: TokenSnapshot
  readonly quality: MarketQuality
  readonly score: number
  /** Capital assigned to this position. */
  readonly capitalUsd: number
  /** What that capital can actually deploy against this pool. */
  readonly sizing: LadderSizing
  /** Share of deployable capital this position holds, in percent. */
  readonly weightPct: number
}

export interface Skipped {
  readonly snapshot: TokenSnapshot
  readonly reason: 'below-floor' | 'pool-refused' | 'no-slots' | 'no-capital'
  readonly detail: string
}

export interface PortfolioPlan {
  readonly allocations: readonly Allocation[]
  readonly skipped: readonly Skipped[]
  readonly deployableUsd: number
  readonly allocatedUsd: number
  readonly reserveUsd: number
  /** Capital that found no home: fewer viable tokens than the wallet could fund. */
  readonly idleUsd: number
  /**
   * True when the position floor forced a position past its concentration cap.
   *
   * The two constraints genuinely conflict at small capital: $950 deployable
   * with a 30% cap allows $285 a slot, but $475 with the same cap allows only
   * $142 — under the floor, where a position places no orders at all.
   *
   * The floor wins, and loudly. A position below it is a GUARANTEED zero,
   * while concentration is a probabilistic loss; refusing to trade in order to
   * stay diversified is diversifying into nothing. But a portfolio running
   * over its concentration target should say so rather than quietly drift, so
   * this flag exists to be surfaced and alerted on.
   */
  readonly floorOverrodeCap: boolean
}

/**
 * Splits capital across the best candidates the pools can actually carry.
 *
 * Slots are equal-weight by design. A score-weighted split would concentrate
 * capital in whatever the heuristic likes most today — and that heuristic is
 * an untuned v1 whose own documentation says it is not a claim of alpha.
 * Equal weight makes the portfolio's survival depend on breadth rather than
 * on the score being right, which is the honest bet while the score is young.
 *
 * The slot count is derived, not configured: as many as the capital can fund
 * above the floor, capped by policy.
 */
export function planPortfolio(
  candidates: readonly AllocationCandidate[],
  params: CascadeParams,
  policy: PortfolioPolicy,
  sizingPolicy?: SizingPolicy,
): PortfolioPlan {
  const reserveUsd = (policy.totalCapitalUsd * policy.reservePct) / 100
  const deployableUsd = policy.totalCapitalUsd - reserveUsd
  const skipped: Skipped[] = []

  // How many slots the capital can fund AT THE SIZE A LADDER WANTS — the
  // portfolio's real width, which is a property of the wallet, not of the
  // shortlist. Falls back to the floor when nothing says what a ladder wants,
  // which is the old behaviour exactly.
  // A target above the concentration cap means nothing: no slot can be given
  // that much, whatever its ladder would like. Clamping here is what keeps an
  // unscaled reference ladder — nominally tens of thousands — from making the
  // book look unaffordable, when in practice `scaledParams` shrinks it to fit.
  const concentrationCapUsd = (deployableUsd * policy.maxPositionPct) / 100
  const slotSize = Math.max(
    Math.min(policy.targetPositionUsd ?? policy.minPositionUsd, concentrationCapUsd),
    policy.minPositionUsd,
  )
  const affordableSlots = Math.floor(deployableUsd / slotSize)
  if (affordableSlots < 1) {
    for (const c of candidates) {
      skipped.push({ snapshot: c.snapshot, reason: 'no-capital', detail: `$${deployableUsd.toFixed(0)} deployable cannot fund one $${policy.minPositionUsd} slot` })
    }
    return { allocations: [], skipped, deployableUsd, allocatedUsd: 0, reserveUsd, idleUsd: deployableUsd, floorOverrodeCap: false }
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.snapshot.address.localeCompare(b.snapshot.address))
  // Zero is not a ceiling of zero — it is no ceiling at all, and the capital
  // decides. With every slot the same size, what bounds the damage one token
  // can do is that size, not the count.
  const ceiling = policy.maxPositions > 0 ? policy.maxPositions : Number.POSITIVE_INFINITY
  const slots = Math.min(affordableSlots, ceiling, ranked.length)

  // What a ladder wants, clipped by the concentration cap, never below the
  // floor — and never more than an even share, because a slot cannot be given
  // capital the book does not have. `slots` is already bounded by what the
  // capital can fund, so raising back to the floor is always affordable.
  const evenUsd = deployableUsd / slots
  const capUsd = concentrationCapUsd
  const wanted = Math.min(evenUsd, policy.targetPositionUsd ?? evenUsd)
  const perSlotUsd = Math.max(Math.min(wanted, capUsd), policy.minPositionUsd)
  const floorOverrodeCap = perSlotUsd > capUsd

  const allocations: Allocation[] = []
  let allocatedUsd = 0

  for (const candidate of ranked) {
    // Stop when the slots are full, or when the next slot would overspend.
    if (allocations.length >= slots || allocatedUsd + perSlotUsd > deployableUsd + 1e-9) {
      skipped.push({ snapshot: candidate.snapshot, reason: 'no-slots', detail: `${allocations.length} of ${slots} slots filled, $${(deployableUsd - allocatedUsd).toFixed(0)} left` })
      continue
    }

    // The executor validates, it does not trust: a token the scanner ranked
    // highly still has to prove its pool can carry a ladder.
    const sizing = sizeLadder(params, candidate.quality, sizingPolicy, perSlotUsd)
    if (!sizing.tradeable) {
      skipped.push({ snapshot: candidate.snapshot, reason: 'pool-refused', detail: sizing.reason ?? 'pool cannot carry a ladder' })
      continue
    }

    allocations.push({ snapshot: candidate.snapshot, quality: candidate.quality, score: candidate.score, capitalUsd: perSlotUsd, sizing, weightPct: 0 })
    allocatedUsd += perSlotUsd
  }

  const withWeights = allocations.map((a) => ({ ...a, weightPct: (a.capitalUsd / deployableUsd) * 100 }))

  return { allocations: withWeights, skipped, deployableUsd, allocatedUsd, reserveUsd, idleUsd: deployableUsd - allocatedUsd, floorOverrodeCap }
}
