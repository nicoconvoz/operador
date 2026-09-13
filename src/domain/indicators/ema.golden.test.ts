import { describe, it, expect } from 'vitest'
import { ema } from './ema.js'
import { sma } from './sma.js'
import golden from './__golden__/bless-1h.json' with { type: 'json' }

/**
 * Golden tests against TradingView's OWN computed values, exported from a live
 * chart via tools/golden-exporter.pine.
 *
 * These are the only tests in the indicator layer that prove parity. Every
 * other test proves internal consistency, which is a different and much weaker
 * claim. The values here must never be regenerated from our own output —
 * that would turn an external oracle into a mirror.
 */

type SeedRow = { bar_index: number | null; close: number | null;
                 ema3: number | null; sma3: number | null
                 ema5: number | null; sma5: number | null }

const seed = golden.seed as SeedRow[]
const closes = seed.map((row) => row.close)

/** Pine emitted ~10 significant digits; compare just inside that. */
const PRECISION = 9

describe('ema — golden parity against TradingView', () => {
  it('has seed rows to test against', () => {
    expect(seed.length).toBeGreaterThanOrEqual(12)
  })

  it('matches ta.ema(close, 3) bar for bar', () => {
    const actual = ema(closes, 3)
    seed.forEach((row, i) => {
      if (row.ema3 === null) expect(actual[i], `bar ${i}`).toBeNull()
      else expect(actual[i], `bar ${i}`).toBeCloseTo(row.ema3, PRECISION)
    })
  })

  it('matches ta.ema(close, 5) bar for bar', () => {
    const actual = ema(closes, 5)
    seed.forEach((row, i) => {
      if (row.ema5 === null) expect(actual[i], `bar ${i}`).toBeNull()
      else expect(actual[i], `bar ${i}`).toBeCloseTo(row.ema5, PRECISION)
    })
  })

  it('matches ta.sma(close, 3) and ta.sma(close, 5) bar for bar', () => {
    const ema3Len = sma(closes, 3)
    const ema5Len = sma(closes, 5)
    seed.forEach((row, i) => {
      if (row.sma3 === null) expect(ema3Len[i], `sma3 bar ${i}`).toBeNull()
      else expect(ema3Len[i], `sma3 bar ${i}`).toBeCloseTo(row.sma3, PRECISION)

      if (row.sma5 === null) expect(ema5Len[i], `sma5 bar ${i}`).toBeNull()
      else expect(ema5Len[i], `sma5 bar ${i}`).toBeCloseTo(row.sma5, PRECISION)
    })
  })

  it('SETTLED: ta.ema seeds from the SMA of the first full window', () => {
    // The question this whole exporter existed to answer. TradingView emits na
    // until the window fills, then the first emitted EMA equals the SMA of that
    // window — it does NOT start at bar 0 from the source value.
    const firstEma5 = seed.findIndex((row) => row.ema5 !== null)
    expect(firstEma5).toBe(4)
    expect(seed[firstEma5]!.ema5).toBeCloseTo(seed[firstEma5]!.sma5!, PRECISION)
    expect(seed[0]!.ema5).toBeNull()

    const firstEma3 = seed.findIndex((row) => row.ema3 !== null)
    expect(firstEma3).toBe(2)
    expect(seed[firstEma3]!.ema3).toBeCloseTo(seed[firstEma3]!.sma3!, PRECISION)
  })
})
