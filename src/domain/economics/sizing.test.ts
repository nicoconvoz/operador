import { describe, it, expect } from 'vitest'
import { DEFAULT_SIZING_POLICY as P, effectiveDepth, gasFloorUsd, sizeLadder } from './sizing.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../strategy/params.js'
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

  it('a thin pool is not refused — it is shrunk to what it can carry', () => {
    // HEV: 5.2% on $100 → $3,846 of real depth. The budgets, not the floor,
    // are what protect the position: a $14 fill on this pool costs the same
    // 1% as a $750 fill on a deep one. Refusing would be a different rule
    // from the one the budgets already enforce.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    expect(sized.tradeable).toBe(true)
    expect(sized.totalUsd).toBeLessThan(100) // against a $41,200 nominal ladder
    for (const level of sized.levels) expect(level.fillCostPct).toBeLessThanOrEqual(P.maxFillCostPct + 1e-9)
    expect(sized.exitCostPct).toBeLessThanOrEqual(P.maxExitCostPct + 1e-9)
  })

  it('reported liquidity never rescues a pool the quote says is thin', () => {
    // The scanner would call this a $5M pool. The quote says $2,500.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 5_000_000, slippagePct: 8 }))
    expect(sized.effectiveDepthUsd).toBeLessThan(3_000)
    expect(sized.totalUsd).toBeLessThan(50)
  })

  it('and IS refused once the budget cannot even clear the gas floor', () => {
    // 50% impact on $100 → $400 of depth → a 0.75% fill is $1.50.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 50 }))
    expect(sized.tradeable).toBe(false)
    expect(sized.reason).toMatch(/floor/)
  })

  it('still reports the nominal ladder when refusing, for the audit log', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ spreadPct: 2 }))
    expect(sized.nominalTotalUsd).toBe(41_200)
    expect(sized.depthSource).toBe('measured')
  })
})

describe('gasFloorUsd — the floor is derived, not guessed', () => {
  it('is the size at which gas costs exactly the share you will tolerate', () => {
    expect(gasFloorUsd(0.05, 1)).toBeCloseTo(5, 9)     // $0.05 is 1% of $5
    expect(gasFloorUsd(0.05, 0.5)).toBeCloseTo(10, 9)
    expect(gasFloorUsd(0.20, 1)).toBeCloseTo(20, 9)    // congested chain, higher floor
    expect(gasFloorUsd(0.01, 1)).toBeCloseTo(1, 9)     // cheap chain, lower floor
  })

  it('moves with gas, which a fixed number cannot', () => {
    // The same tolerance on a chain 20x more expensive demands 20x the size.
    expect(gasFloorUsd(0.20, 1) / gasFloorUsd(0.01, 1)).toBeCloseTo(20, 9)
  })

  it('a zero tolerance admits no fill at all', () => {
    expect(gasFloorUsd(0.05, 0)).toBe(Infinity)
  })

  it('a $15 ladder clears the derived floor at Solana gas', () => {
    const capped = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
    const policy = { ...P, minFillUsd: gasFloorUsd(0.05, 1) }
    const sized = sizeLadder(capped, quality(), policy, 200)
    expect(sized.tradeable).toBe(true)
    expect(sized.levels.every((l) => l.sizedUsd === 15)).toBe(true)
  })

  it('…and is refused at congested gas, which is the right answer', () => {
    const capped = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
    const policy = { ...P, minFillUsd: gasFloorUsd(0.20, 1) }
    expect(sizeLadder(capped, quality(), policy, 200).tradeable).toBe(false)
  })
})

// ── The venue cap is production's to choose ─────────────────────────────────
//
// PYRAMIDING is 10 because that is what the `strategy()` header ran, and the
// parity harness asserts those inputs are the backtest's. It is evidence, not a
// preference — so production overriding it must never edit it, exactly as with
// maxUsdPerLevel.
//
// The user's reason for 5: with linInc at 3, DCA-5 already needs a 13% fall and
// DCA-10 needs 28%. A token down 28% is rarely an opportunity, and the capital
// those deep rungs reserve buys more by going to another token — which is
// finding 2 of the capital floor, arriving again by a different road.

describe('sizeLadder — how many rungs the venue will actually fill', () => {
  /** Deep enough that depth never binds, so only the rung count moves. */
  const deep = quality({ liquidityUsd: 500_000_000, slippagePct: 0.001 })

  it('fills ten by default, which is what TradingView ran', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, deep, P, 1_000_000)
    expect(sized.levels).toHaveLength(10)
  })

  it('fills six when production allows five DCAs — the entry plus its ladder', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, deep, { ...P, maxOpenEntries: 6 }, 1_000_000)
    expect(sized.levels).toHaveLength(6)
  })

  it('leaves the reference untouched, because the harness asserts it', () => {
    expect(PYRAMIDING).toBe(10)
    expect(P.maxOpenEntries).toBeUndefined()
  })

  it('reserves capital for six swaps, not eleven, when the ladder is capped', () => {
    // The nominal total is what the ladder WANTS before any cap applies, and
    // a shorter ladder wants less. Sizing that against the old count would
    // hold back capital for rungs that can never fill.
    const ten = sizeLadder(DEFAULT_PARAMS, deep, P, 1_000_000)
    const six = sizeLadder(DEFAULT_PARAMS, deep, { ...P, maxOpenEntries: 6 }, 1_000_000)
    expect(six.nominalTotalUsd).toBeLessThan(ten.nominalTotalUsd)
  })
})
