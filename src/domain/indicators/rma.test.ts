import { describe, it, expect } from 'vitest'
import { rma } from './rma.js'
import { sma } from './sma.js'
import { IndicatorError } from './series.js'

describe('rma — Pine Script ta.rma parity (Wilder smoothing)', () => {
  it('seeds with the SMA of the first full window, like ta.ema', () => {
    const source = [1, 2, 3, 4, 5]
    expect(rma(source, 3)[2]).toBe(sma(source, 3)[2])
    expect(rma(source, 3).slice(0, 2)).toEqual([null, null])
  })

  it('recurses with alpha = 1 / length', () => {
    // seed 2, then (1/3)*4 + (2/3)*2 = 8/3, then (1/3)*5 + (2/3)*(8/3) = 31/9
    const out = rma([1, 2, 3, 4, 5], 3)
    expect(out[3]).toBeCloseTo(8 / 3, 12)
    expect(out[4]).toBeCloseTo(31 / 9, 12)
  })

  it('is slower than an EMA of the same length on a step', () => {
    // alpha 1/n < 2/(n+1) for every n > 1 — Wilder smoothing lags more.
    const step = [10, 10, 10, 10, 10, 20, 20, 20]
    const r = rma(step, 5).at(-1)!
    expect(r).toBeGreaterThan(10)
    expect(r).toBeLessThan(20)
    // ema(5) at the same point is 17.04 (see ema.test); rma must trail it.
    expect(r).toBeLessThan(17)
  })

  it('treats length 1 as identity', () => {
    expect(rma([4, 8, 15], 1)).toEqual([4, 8, 15])
  })

  it('throws on a gap after seeding', () => {
    expect(() => rma([1, 2, 3, null, 5], 3)).toThrow(IndicatorError)
  })
})
