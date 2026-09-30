import { describe, it, expect } from 'vitest'
import { marketVolatilityPct } from './market-volatility.js'

/**
 * *No quiero velas.* The operator. How much a token moves every five minutes,
 * estimated from the price changes Jupiter already reports with every token —
 * five minutes, one hour, six hours — at no request at all.
 */
describe('marketVolatilityPct — how much a token moves every five minutes, without a candle', () => {
  it('reads the five-minute move as it is, and scales the longer windows down to five minutes', () => {
    // √12 five-minute steps in an hour, √72 in six: a random walk's own scaling.
    expect(marketVolatilityPct({ m5: 2, h1: null, h6: null, h24: null })).toBeCloseTo(2, 9)
    expect(marketVolatilityPct({ h1: 12, h6: null, h24: null })).toBeCloseTo(12 / Math.sqrt(12), 9)
    expect(marketVolatilityPct({ h1: null, h6: -36, h24: null })).toBeCloseTo(36 / Math.sqrt(72), 9)
  })

  it('averages the windows it has, and a fall moves as much as a rise', () => {
    const v = marketVolatilityPct({ m5: -3, h1: 12, h6: 36, h24: 5 })!
    expect(v).toBeCloseTo((3 + 12 / Math.sqrt(12) + 36 / Math.sqrt(72)) / 3, 9)
  })

  it('is null when no window was reported — silence is not calm', () => {
    expect(marketVolatilityPct({ h1: null, h6: null, h24: 4 })).toBeNull()
  })
})
