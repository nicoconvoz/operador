import { describe, it, expect } from 'vitest'
import { stdev } from './stdev.js'
import { IndicatorError } from './series.js'

describe('stdev — Pine Script ta.stdev parity (biased / population)', () => {
  it('is the POPULATION standard deviation, dividing by N not N-1', () => {
    // Classic textbook set: mean 5, squared deviations sum to 32, 32/8 = 4.
    // Sample stdev would give sqrt(32/7) = 2.138. Pine's default is biased,
    // and the golden data agrees to 9e-5% (sample was off by 1.02%).
    const out = stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)
    expect(out.slice(0, 7)).toEqual(Array(7).fill(null))
    expect(out[7]).toBeCloseTo(2, 12)
  })

  it('is zero on a constant series', () => {
    expect(stdev([7, 7, 7, 7], 3).slice(2)).toEqual([0, 0])
  })

  it('is zero with length 1', () => {
    expect(stdev([3, 9, 1], 1)).toEqual([0, 0, 0])
  })

  it('poisons a window that contains na', () => {
    expect(stdev([1, null, 3, 5], 2)).toEqual([null, null, null, 1])
  })

  it('rejects a non-positive or non-integer length', () => {
    expect(() => stdev([1, 2], 0)).toThrow(IndicatorError)
  })
})
