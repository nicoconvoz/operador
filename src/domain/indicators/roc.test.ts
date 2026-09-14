import { describe, it, expect } from 'vitest'
import { roc } from './roc.js'
import { IndicatorError } from './series.js'

describe('roc — Pine Script ta.roc parity', () => {
  it('is the percent change against the bar `length` bars back', () => {
    // 100 * (3-1)/1 = 200, 100 * (4-2)/2 = 100, 100 * (5-3)/3 = 66.67
    const out = roc([1, 2, 3, 4, 5], 2)
    expect(out.slice(0, 2)).toEqual([null, null])
    expect(out[2]).toBe(200)
    expect(out[3]).toBe(100)
    expect(out[4]).toBeCloseTo(66.6666666667, 9)
  })

  it('returns na when the reference price is zero, as Pine does on x/0', () => {
    expect(roc([0, 5], 1)).toEqual([null, null])
  })

  it('propagates na from either end of the comparison', () => {
    expect(roc([null, 2, 3], 1)).toEqual([null, null, 50])
    expect(roc([1, null, 3], 1)).toEqual([null, null, null])
  })

  it('rejects a non-positive or non-integer length', () => {
    expect(() => roc([1, 2], 0)).toThrow(IndicatorError)
    expect(() => roc([1, 2], 1.5)).toThrow(IndicatorError)
  })
})
