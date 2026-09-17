import { describe, it, expect } from 'vitest'
import { DEFAULT_PORTFOLIO_POLICY, DEFAULT_PORTFOLIO_POLICY as P, planPortfolio, type AllocationCandidate, type PortfolioPolicy } from './portfolio.js'
import { DEFAULT_PARAMS } from '../strategy/params.js'
import { type MarketQuality } from '../market/market-quality.js'
import { type TokenSnapshot } from '../scanner/snapshot.js'

const quality = (over: Partial<MarketQuality> = {}): MarketQuality => ({
  liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0, ...over,
})

const candidate = (address: string, score: number, q: MarketQuality = quality()): AllocationCandidate => ({
  snapshot: { address, symbol: address, chain: 'solana' } as TokenSnapshot,
  quality: q,
  score,
})

const five = [candidate('a', 90), candidate('b', 80), candidate('c', 70), candidate('d', 60), candidate('e', 50)]

describe('planPortfolio — width comes from capital, not from the shortlist', () => {
  it('funds as many slots as the capital clears the floor for', () => {
    // $1,000 − 5% reserve = $950 deployable, floor $200 → 4 slots.
    const plan = planPortfolio(five, DEFAULT_PARAMS, P)
    expect(plan.allocations).toHaveLength(4)
    expect(plan.reserveUsd).toBeCloseTo(50, 9)
    expect(plan.deployableUsd).toBeCloseTo(950, 9)
  })

  it('serves the highest scores first', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, P)
    expect(plan.allocations.map((a) => a.snapshot.address)).toEqual(['a', 'b', 'c', 'd'])
    expect(plan.skipped.map((s) => [s.snapshot.address, s.reason])).toEqual([['e', 'no-slots']])
  })

  it('more capital buys more POSITIONS, not bigger ones — the whole point', () => {
    const small = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 500, maxPositions: 10 })
    const large = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 5_000, maxPositions: 10 })
    expect(small.allocations.length).toBeLessThan(large.allocations.length)
    expect(large.allocations).toHaveLength(5) // capped by the shortlist, not the wallet
  })

  it('respects the hard ceiling on simultaneous positions', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 100_000, maxPositions: 2 })
    expect(plan.allocations).toHaveLength(2)
    expect(plan.skipped.filter((s) => s.reason === 'no-slots')).toHaveLength(3)
  })

  it('caps concentration so one token dying cannot take the portfolio', () => {
    const plan = planPortfolio([candidate('solo', 99)], DEFAULT_PARAMS, { ...P, totalCapitalUsd: 10_000, maxPositionPct: 30 })
    expect(plan.allocations[0]!.weightPct).toBeCloseTo(30, 6)
    // The rest stays idle rather than piling into one name.
    expect(plan.idleUsd).toBeGreaterThan(0)
  })

  it('weights sum to the deployed share and leave the reserve alone', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, P)
    const totalWeight = plan.allocations.reduce((sum, a) => sum + a.weightPct, 0)
    expect(totalWeight).toBeCloseTo((plan.allocatedUsd / plan.deployableUsd) * 100, 6)
    expect(plan.allocatedUsd + plan.idleUsd).toBeCloseTo(plan.deployableUsd, 6)
  })
})

describe('planPortfolio — when the floor and the cap conflict', () => {
  it('the floor wins, and the plan says so', () => {
    // $500 − 5% = $475 deployable. 30% cap = $142, under the $200 floor.
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 500, maxPositions: 10 })
    expect(plan.floorOverrodeCap).toBe(true)
    expect(plan.allocations).toHaveLength(2)
    expect(plan.allocations[0]!.capitalUsd).toBeCloseTo(P.minPositionUsd, 9)
    // A position below the floor is a guaranteed zero; concentration is a risk.
    expect(plan.allocations[0]!.weightPct).toBeGreaterThan(P.maxPositionPct)
  })

  it('never overspends the deployable capital, even when the floor wins', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 500, maxPositions: 10 })
    expect(plan.allocatedUsd).toBeLessThanOrEqual(plan.deployableUsd + 1e-9)
    expect(plan.idleUsd).toBeGreaterThanOrEqual(0)
  })

  it('with enough capital the cap holds and the flag stays down', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 5_000, maxPositions: 4 })
    expect(plan.floorOverrodeCap).toBe(false)
    for (const a of plan.allocations) expect(a.weightPct).toBeLessThanOrEqual(P.maxPositionPct + 1e-9)
  })
})

describe('planPortfolio — capital below the floor', () => {
  it('opens nothing when the wallet cannot fund a single slot', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 100 })
    expect(plan.allocations).toEqual([])
    expect(plan.skipped.every((s) => s.reason === 'no-capital')).toBe(true)
    expect(plan.idleUsd).toBeCloseTo(95, 9)
  })

  it('the $1 experiment, at portfolio level', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 1 })
    expect(plan.allocations).toEqual([])
  })
})

describe('planPortfolio — the executor still validates', () => {
  it('refuses a top-ranked token whose pool cannot carry a ladder', () => {
    // A pool so thin that a 1% fill is worth less than its own gas.
    const thin = candidate('hev', 99, quality({ liquidityUsd: 186_000, slippagePct: 50 }))
    const plan = planPortfolio([thin, ...five], DEFAULT_PARAMS, P)
    expect(plan.allocations.map((a) => a.snapshot.address)).not.toContain('hev')
    expect(plan.skipped.find((s) => s.snapshot.address === 'hev')?.reason).toBe('pool-refused')
  })

  it('a refused token frees its slot for the next candidate', () => {
    const thin = candidate('hev', 99, quality({ liquidityUsd: 186_000, slippagePct: 50 }))
    const plan = planPortfolio([thin, ...five], DEFAULT_PARAMS, P)
    expect(plan.allocations).toHaveLength(4)
    expect(plan.allocations.map((a) => a.snapshot.address)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('every allocation carries a tradeable sizing for its own capital', () => {
    const plan = planPortfolio(five, DEFAULT_PARAMS, P)
    for (const allocation of plan.allocations) {
      expect(allocation.sizing.tradeable).toBe(true)
      expect(allocation.sizing.levels.length).toBeGreaterThan(0)
    }
  })
})

describe('planPortfolio — empty and degenerate input', () => {
  it('an empty shortlist plans nothing and idles everything', () => {
    const plan = planPortfolio([], DEFAULT_PARAMS, P)
    expect(plan.allocations).toEqual([])
    expect(plan.idleUsd).toBeCloseTo(plan.deployableUsd, 9)
  })

  it('ties break deterministically by address', () => {
    const tied: AllocationCandidate[] = [candidate('z', 50), candidate('y', 50), candidate('x', 50)]
    const plan = planPortfolio(tied, DEFAULT_PARAMS, { ...P, totalCapitalUsd: 10_000, maxPositions: 2 })
    expect(plan.allocations.map((a) => a.snapshot.address)).toEqual(['x', 'y'])
  })

  it('a zero reserve deploys everything', () => {
    const policy: PortfolioPolicy = { ...P, reservePct: 0 }
    expect(planPortfolio(five, DEFAULT_PARAMS, policy).deployableUsd).toBe(policy.totalCapitalUsd)
  })
})

// ── The book is as wide as the capital, at the size the ladder wants ────────
//
// `evenUsd = deployable / slots` spreads everything across whatever slots exist,
// so ten slots and $1,425 handed $142 to each — and a flat six-rung $15 ladder
// can only ever spend $95. The surplus came straight back as idle capital, and
// the answer to "why only five tokens" was a number nobody had recomputed.
//
// A slot should get what its ladder needs. How many slots there are is then the
// division, not a constant.

describe('planPortfolio — sized to the ladder, counted by the capital', () => {
  const target = 95.1
  const wide = (over: Partial<PortfolioPolicy> = {}): PortfolioPolicy => ({
    ...DEFAULT_PORTFOLIO_POLICY,
    totalCapitalUsd: 1_500,
    minPositionUsd: 32,
    targetPositionUsd: target,
    maxPositions: 0, // capital decides
    maxPositionPct: 30,
    ...over,
  })

  const many = (n: number) => Array.from({ length: n }, (_, i) => candidate(`t${i}`, 90 - i))

  it('gives a slot what its ladder needs, not an even share of everything', () => {
    const plan = planPortfolio(many(20), DEFAULT_PARAMS, wide())
    for (const allocation of plan.allocations) {
      expect(allocation.capitalUsd).toBeCloseTo(target, 6)
    }
  })

  it('opens as many tokens as the capital funds at that size', () => {
    // $1,500 less 5% reserve is $1,425; at $95.10 a ladder that is fourteen.
    expect(planPortfolio(many(30), DEFAULT_PARAMS, wide()).allocations).toHaveLength(14)
  })

  it('leaves almost nothing idle', () => {
    const plan = planPortfolio(many(30), DEFAULT_PARAMS, wide())
    expect(plan.idleUsd).toBeLessThan(target)
  })

  it('still obeys an explicit ceiling when one is set', () => {
    // Capital is not the only limit worth having. The ceiling bounds how many
    // tokens can be dying at once, which is a risk decision, not arithmetic.
    expect(planPortfolio(many(30), DEFAULT_PARAMS, wide({ maxPositions: 6 })).allocations).toHaveLength(6)
  })

  it('never hands a slot more than the concentration cap, target or not', () => {
    const plan = planPortfolio(many(30), DEFAULT_PARAMS, wide({ totalCapitalUsd: 200, maxPositionPct: 30 }))
    for (const allocation of plan.allocations) {
      expect(allocation.capitalUsd).toBeLessThanOrEqual((190 * 30) / 100 + 1e-9)
    }
  })

  it('falls back to spreading evenly when no target is given', () => {
    const { targetPositionUsd, ...noTarget } = wide({ maxPositions: 2 })
    const plan = planPortfolio(many(2), DEFAULT_PARAMS, noTarget)
    // Two slots, $1,425 deployable, 30% cap each.
    expect(plan.allocations[0]!.capitalUsd).toBeCloseTo((1_425 * 30) / 100, 6)
  })
})

describe('planPortfolio — the concentration cap is a share of the BOOK, not of the leftovers', () => {
  it('still funds a full ladder when little capital is left', () => {
    // Reported live: 40 positions where the capital funds 31. Twenty-four had a
    // full $47.57 ladder, and the tail sat at $15.99 — the gas floor — because
    // the cap is applied to whatever is FREE.
    //
    // With $50 left, 30% of it is $15, so the cap dropped BELOW the ladder and
    // dragged the slot size down to the floor. A limit meant to stop one token
    // being too much of the book ended up forcing positions too small to
    // cascade at all: a $16 slot fills one rung and can never average down,
    // which is the entire premise of the ladder.
    const plan = planPortfolio(
      [candidate('A', 90), candidate('B', 80), candidate('C', 70)],
      DEFAULT_PARAMS,
      { ...P, reservePct: 0, totalCapitalUsd: 50, concentrationBasisUsd: 1_500, targetPositionUsd: 47.57, minPositionUsd: 16, maxPositionPct: 30 },
    )

    expect(plan.allocations).toHaveLength(1)
    expect(plan.allocations[0]!.capitalUsd).toBeCloseTo(47.57, 2)
  })

  it('without a basis it still caps against what it was given', () => {
    // The old behaviour exactly, for any caller that does not know the book.
    const plan = planPortfolio(
      [candidate('A', 90)],
      DEFAULT_PARAMS,
      { ...P, reservePct: 0, totalCapitalUsd: 50, targetPositionUsd: 47.57, minPositionUsd: 16, maxPositionPct: 30 },
    )
    expect(plan.allocations[0]!.capitalUsd).toBeLessThan(47.57)
  })

  it('the cap still BINDS when a single token would be too much of the book', () => {
    // It must keep doing its real job: 30% of a $100 book is $30, so a ladder
    // wanting $47.57 is clipped. That is the case the limit exists for.
    const plan = planPortfolio(
      [candidate('A', 90)],
      DEFAULT_PARAMS,
      { ...P, reservePct: 0, totalCapitalUsd: 100, concentrationBasisUsd: 100, targetPositionUsd: 47.57, minPositionUsd: 16, maxPositionPct: 30 },
    )
    expect(plan.allocations[0]!.capitalUsd).toBeCloseTo(30, 2)
  })
})
