import { describe, it, expect } from 'vitest'
import { FIXED_TP_COMMENT, fixedTpPrice, reachedFixedTp } from './fixed-tp.js'

/**
 * *Poné un TP fijo al 12.5% del promedio.* The operator — sell everything the
 * moment the price reaches the average cost plus 12.5%, accepting that the big
 * runs are given up.
 */
describe('the fixed take-profit — one line over the average cost', () => {
  it('sits at the average cost plus the percent', () => {
    expect(fixedTpPrice(1, 12.5)).toBe(1.125)
    expect(fixedTpPrice(0.004, 12.5)).toBeCloseTo(0.0045, 12)
  })

  it('is reached AT the line, not only past it', () => {
    expect(reachedFixedTp(1.125, 1, 12.5)).toBe(true)
    expect(reachedFixedTp(1.3, 1, 12.5)).toBe(true)
  })

  it('is not reached under it — +12% is not +12.5%', () => {
    expect(reachedFixedTp(1.12, 1, 12.5)).toBe(false)
    expect(reachedFixedTp(0.9, 1, 12.5)).toBe(false)
  })

  it('is off at zero, and off when nothing asked for it', () => {
    expect(fixedTpPrice(1, 0)).toBeNull()
    expect(fixedTpPrice(1, null)).toBeNull()
    expect(reachedFixedTp(5, 1, 0)).toBe(false)
    expect(reachedFixedTp(5, 1, null)).toBe(false)
  })

  it('has no line without a cost to measure from, and silence is not a rise', () => {
    expect(fixedTpPrice(null, 12.5)).toBeNull()
    expect(fixedTpPrice(0, 12.5)).toBeNull()
    expect(reachedFixedTp(null, 1, 12.5)).toBe(false)
    expect(reachedFixedTp(Number.NaN, 1, 12.5)).toBe(false)
    expect(reachedFixedTp(2, null, 12.5)).toBe(false)
  })

  it('carries its own name on the tape', () => {
    expect(FIXED_TP_COMMENT).toBe('🎯 TP fijo')
  })
})
