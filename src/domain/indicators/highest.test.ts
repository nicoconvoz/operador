import { describe, it, expect } from 'vitest'
import { highest } from './highest.js'
import { IndicatorError } from './series.js'

describe('highest — Pine Script ta.highest parity', () => {
  it('is the maximum of the trailing window, current bar included', () => {
    expect(highest([1, 5, 3, 2, 4], 3)).toEqual([null, null, 5, 5, 4])
  })

  it('treats length 1 as identity', () => {
    expect(highest([3, 1, 2], 1)).toEqual([3, 1, 2])
  })

  it('returns an empty series for empty input', () => {
    expect(highest([], 3)).toEqual([])
  })

  it('rejects a non-positive or non-integer length', () => {
    expect(() => highest([1], 0)).toThrow(IndicatorError)
  })
})
