import { describe, it, expect } from 'vitest'
import { ema } from './ema.js'
import { sma } from './sma.js'
import { IndicatorError } from './series.js'

describe('ema — Pine Script ta.ema parity', () => {
  it('seeds the first emitted bar with the SMA of the window', () => {
    // PARITY ASSUMPTION (see ema.ts): Pine seeds ta.ema with ta.sma over the
    // first `length` bars, then recurses. This is the single highest-risk
    // assumption in the indicator layer — golden files must confirm it.
    const source = [1, 2, 3, 4, 5]
    const seeded = ema(source, 3)[2]
    expect(seeded).toBe(sma(source, 3)[2])
  })

  it('recurses with alpha = 2 / (length + 1) after seeding', () => {
    // length 3 → alpha 0.5. seed = 2, then 0.5*4 + 0.5*2 = 3, 0.5*5 + 0.5*3 = 4.
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('returns na for bars before the window is full', () => {
    const result = ema([10, 20, 30, 40], 3)
    expect(result[0]).toBeNull()
    expect(result[1]).toBeNull()
    expect(result[2]).not.toBeNull()
  })

  it('reacts faster than an SMA to a change in direction', () => {
    // NOT tested with a constant ramp: alpha = 2/(length+1) is chosen precisely
    // so the EMA's lag, (1-alpha)/alpha, equals the SMA's lag, (length-1)/2.
    // On a straight line the two are identical BY CONSTRUCTION — that is the
    // whole reason for that alpha. Responsiveness only shows on a step.
    const step = [10, 10, 10, 10, 10, 20, 20, 20]
    const emaLast = ema(step, 5).at(-1)!
    const smaLast = sma(step, 5).at(-1)!
    expect(emaLast).toBeGreaterThan(smaLast)
  })

  it('has the same lag as an SMA on a constant ramp', () => {
    // The flip side of the property above, pinned so nobody "fixes" it later.
    const ramp = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(ema(ramp, 5).at(-1)).toBeCloseTo(sma(ramp, 5).at(-1)!, 12)
  })

  it('treats length 1 as an identity mapping (alpha = 1)', () => {
    expect(ema([4, 8, 15], 1)).toEqual([4, 8, 15])
  })

  it('converges toward a constant series', () => {
    const flat = Array<number>(50).fill(7)
    expect(ema(flat, 10).at(-1)).toBeCloseTo(7, 12)
  })

  it('returns na for every bar when the series is shorter than the window', () => {
    expect(ema([1, 2], 5)).toEqual([null, null])
  })

  it('returns an empty series for an empty input', () => {
    expect(ema([], 3)).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = [1, 2, 3, 4]
    const copy = [...input]
    ema(input, 2)
    expect(input).toEqual(copy)
  })

  it('throws on a gap after seeding rather than guessing Pine na semantics', () => {
    // We control the OHLCV pipeline, so a post-seed gap means the data is
    // broken. Failing loudly beats silently inventing a recursion rule.
    expect(() => ema([1, 2, 3, null, 5], 3)).toThrow(IndicatorError)
  })

  it('rejects a non-positive or non-integer length', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(IndicatorError)
    expect(() => ema([1, 2, 3], 2.5)).toThrow(IndicatorError)
  })
})
