import { describe, it, expect } from 'vitest'
import { sma } from './sma.js'
import { IndicatorError } from './series.js'

describe('sma — Pine Script ta.sma parity', () => {
  it('returns na for bars before the window is full', () => {
    // Pine emits na until `length` values exist. Bar 2 is the first full window.
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('averages the trailing window, not a leading or centered one', () => {
    // A centered window would give 3 at the last bar; a trailing one gives 9.
    expect(sma([1, 2, 3, 10, 20, 30], 3)?.at(-1)).toBe(20)
  })

  it('treats length 1 as an identity mapping', () => {
    expect(sma([4, 8, 15], 1)).toEqual([4, 8, 15])
  })

  it('returns na for every bar when the series is shorter than the window', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
  })

  it('returns an empty series for an empty input', () => {
    expect(sma([], 3)).toEqual([])
  })

  it('propagates na: a window containing na yields na', () => {
    // Pine does not silently skip na — it poisons the window it falls in.
    expect(sma([1, null, 3, 4, 5], 3)).toEqual([null, null, null, null, 4])
  })

  it('does not mutate its input', () => {
    const input = [1, 2, 3]
    const copy = [...input]
    sma(input, 2)
    expect(input).toEqual(copy)
  })

  it('handles negative and fractional values without precision drift', () => {
    expect(sma([-1.5, 2.5, 0.5], 3)?.at(-1)).toBeCloseTo(0.5, 12)
  })

  it('rejects a non-positive or non-integer length', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(IndicatorError)
    expect(() => sma([1, 2, 3], -2)).toThrow(IndicatorError)
    expect(() => sma([1, 2, 3], 1.5)).toThrow(IndicatorError)
  })
})
