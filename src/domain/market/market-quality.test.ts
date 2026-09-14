import { describe, it, expect } from 'vitest'
import {
  assertMarketQuality,
  estimatePriceImpactPct,
  expectedFillCostPct,
  MarketQualityError,
  type MarketQuality,
} from './market-quality.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../strategy/params.js'
import { usdForLevel } from '../strategy/ladder.js'

const quality: MarketQuality = {
  liquidityUsd: 100_000,
  spreadPct: 0.3,
  slippagePct: 0.2,
  referenceUsd: 100,
  observedAt: 0,
}

describe('market quality — price impact', () => {
  it('a buy of 1% of the quote side moves price 1%', () => {
    // liquidity 100k → quote reserve 50k → $500 is 1%
    expect(estimatePriceImpactPct(500, 100_000)).toBeCloseTo(1, 12)
  })

  it('is linear in size for the planning estimate', () => {
    expect(estimatePriceImpactPct(1000, 100_000)).toBeCloseTo(2 * estimatePriceImpactPct(500, 100_000), 12)
  })

  it('zero size costs nothing', () => {
    expect(estimatePriceImpactPct(0, 100_000)).toBe(0)
  })

  it('rejects an empty pool', () => {
    expect(() => estimatePriceImpactPct(100, 0)).toThrow(MarketQualityError)
  })
})

describe('market quality — expected fill cost', () => {
  it('adds spread and impact', () => {
    expect(expectedFillCostPct(500, quality)).toBeCloseTo(0.3 + 1, 12)
  })

  it('the default ladder against a $100k pool: level 4+ ($5,000) costs 10.3% per fill', () => {
    // This is the number that makes small pools untradeable at nominal size.
    expect(expectedFillCostPct(usdForLevel(DEFAULT_PARAMS, 4), quality)).toBeCloseTo(10.3, 9)
  })

  it('the ten fillable levels against a $1M pool stay under 1.5% each', () => {
    const deep = { ...quality, liquidityUsd: 1_000_000 }
    for (let level = 0; level < PYRAMIDING; level++) {
      expect(expectedFillCostPct(usdForLevel(DEFAULT_PARAMS, level), deep)).toBeLessThan(1.5)
    }
  })

  it('validates its inputs', () => {
    expect(() => assertMarketQuality({ ...quality, liquidityUsd: 0 })).toThrow(MarketQualityError)
    expect(() => assertMarketQuality({ ...quality, spreadPct: -1 })).toThrow(MarketQualityError)
    expect(() => assertMarketQuality({ ...quality, referenceUsd: 0 })).toThrow(MarketQualityError)
  })
})
