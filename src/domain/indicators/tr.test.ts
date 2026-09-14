import { describe, it, expect } from 'vitest'
import { trueRange } from './tr.js'
import { atr } from './atr.js'

describe('trueRange — Pine Script ta.tr(handle_na = true) parity', () => {
  const high = [10, 12, 9]
  const low = [8, 11, 7]
  const close = [9, 11.5, 8]

  it('is high - low on the first bar, where there is no previous close', () => {
    expect(trueRange(high, low, close)[0]).toBe(2)
  })

  it('is the max of range, |high - prevClose|, |low - prevClose| afterwards', () => {
    // bar 1: max(1, |12-9|=3, |11-9|=2) = 3
    // bar 2: max(2, |9-11.5|=2.5, |7-11.5|=4.5) = 4.5
    expect(trueRange(high, low, close)).toEqual([2, 3, 4.5])
  })

  it('rejects series of mismatched length', () => {
    expect(() => trueRange([1, 2], [1], [1, 2])).toThrow()
  })
})

describe('atr — Pine Script ta.atr parity', () => {
  it('is the RMA of true range, so length 1 is true range itself', () => {
    const high = [10, 12, 9]
    const low = [8, 11, 7]
    const close = [9, 11.5, 8]
    expect(atr(high, low, close, 1)).toEqual([2, 3, 4.5])
  })
})
