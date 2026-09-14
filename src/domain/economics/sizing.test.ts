import { describe, it, expect } from 'vitest'
import { DEFAULT_SIZING_POLICY as P, effectiveDepth, sizeLadder } from './sizing.js'
import { DEFAULT_PARAMS } from '../strategy/params.js'
import { type MarketQuality } from '../market/market-quality.js'

const quality = (over: Partial<MarketQuality> = {}): MarketQuality => ({
  liquidityUsd: 1_000_000,
  spreadPct: 0.25,
  slippagePct: 0.1, // measured for $100 → implies $200k of effective depth
  referenceUsd: 100,
  observedAt: 0,
  ...over,
})

describe('effectiveDepth — a measured quote beats reported TVL', () => {
  it('inverts the impact model: 0.1% on $100 means $200k of usable depth', () => {
    expect(effectiveDepth(quality())).toEqual({ usd: 200_000, source: 'measured' })
  })

  it('exposes concentrated pools for what they are', () => {
    // HEV in the first live scan: $186k reported, 5.2% impact on $100.
    const hev = effectiveDepth(quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    expect(hev.usd).toBeCloseTo(3_846, 0)
    expect(hev.source).toBe('measured')
  })

  it('falls back to reported liquidity when nothing was measured', () => {
    expect(effectiveDepth(quality({ slippagePct: 0 }))).toEqual({ usd: 1_000_000, source: 'reported' })
  })
})

describe('sizeLadder — the strategy asks, the pool answers', () => {
  it('caps every fill at the impact budget left after the spread', () => {
    // depth 200k, budget 1% − 0.25% spread = 0.75% → max fill $750
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.tradeable).toBe(true)
    for (const level of sized.levels) {
      expect(level.sizedUsd).toBeLessThanOrEqual(750 + 1e-9)
      expect(level.fillCostPct).toBeLessThanOrEqual(P.maxFillCostPct + 1e-9)
    }
  })

  it('the exit budget binds the TOTAL, and later levels pay for it', () => {
    // depth 200k, exit budget 3% → position cap $3,000.
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.totalUsd).toBeLessThanOrEqual(3_000 + 1e-9)
    expect(sized.exitCostPct).toBeLessThanOrEqual(P.maxExitCostPct + 1e-9)
    expect(sized.levels.some((l) => l.limitedBy === 'exitCost')).toBe(true)
  })

  it('shrinks the ladder by an order of magnitude against the nominal', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.nominalTotalUsd).toBe(41_200)
    expect(sized.totalUsd).toBeLessThan(sized.nominalTotalUsd / 10)
  })

  it('a deep pool lets the full nominal ladder through untouched', () => {
    const deep = quality({ slippagePct: 0.001 }) // $20M of effective depth
    const sized = sizeLadder(DEFAULT_PARAMS, deep)
    expect(sized.totalUsd).toBe(sized.nominalTotalUsd)
    expect(sized.levels.every((l) => l.limitedBy === 'none')).toBe(true)
    expect(sized.levels).toHaveLength(10) // pyramiding, not maxLevels
  })

  it('stops placing levels once they fall below the gas floor', () => {
    // depth tuned so the position cap runs out mid-ladder.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 2 })) // depth $10k
    expect(sized.tradeable).toBe(true)
    expect(sized.levels.length).toBeLessThan(10)
    expect(sized.levels.every((l) => l.sizedUsd >= P.minFillUsd)).toBe(true)
  })
})

describe('sizeLadder — tokens the executor refuses', () => {
  it('refuses when the venue fee alone eats the fill budget', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ spreadPct: 1.5 }))
    expect(sized.tradeable).toBe(false)
    expect(sized.reason).toMatch(/spread/)
  })

  it('refuses a pool too thin to take even one minimum fill', () => {
    // 5.2% on $100 → $3,846 of depth → 0.75% budget allows $14, under the floor.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    expect(sized.tradeable).toBe(false)
    expect(sized.reason).toMatch(/floor/)
    expect(sized.levels).toEqual([])
  })

  it('refuses regardless of how good the reported liquidity looks', () => {
    // The scanner would call this a $5M pool. The quote says otherwise.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 5_000_000, slippagePct: 8 }))
    expect(sized.tradeable).toBe(false)
  })

  it('still reports the nominal ladder when refusing, for the audit log', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ spreadPct: 2 }))
    expect(sized.nominalTotalUsd).toBe(41_200)
    expect(sized.depthSource).toBe('measured')
  })
})
