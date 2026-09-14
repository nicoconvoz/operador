import { describe, it, expect } from 'vitest'
import { DEFAULT_PORTFOLIO_POLICY as P, planPortfolio, type AllocationCandidate, type PortfolioPolicy } from './portfolio.js'
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
