import { describe, it, expect } from 'vitest'
import { buyShare, stepPressureTp } from './pressure-tp.js'

// *Que el operador tenga como TP cuando haya un 10% de caída de la presión
// compradora, cuando ya estamos en ganancias* — measured from its peak.

describe('the buy share of the hour', () => {
  it('is the buys over every trade', () => {
    expect(buyShare(60, 40)).toBeCloseTo(0.6, 12)
  })

  it('is unknown on a silent hour', () => {
    expect(buyShare(0, 0)).toBeNull()
  })
})

describe('the TP on buy pressure, 10% off its peak while in profit', () => {
  it('starts the peak at the first reading in profit and never sells on it', () => {
    expect(stepPressureTp(null, 0.6, true, 10)).toEqual({ peak: 0.6, sell: false })
  })

  it('raises the peak as buyers keep coming', () => {
    expect(stepPressureTp(0.6, 0.7, true, 10)).toEqual({ peak: 0.7, sell: false })
  })

  it('holds a fall of less than 10% from the peak', () => {
    // 70% → 63.7%: 9% off the peak.
    expect(stepPressureTp(0.7, 0.637, true, 10)).toEqual({ peak: 0.7, sell: false })
  })

  it('sells at 10% off the peak', () => {
    // 70% → 63%.
    expect(stepPressureTp(0.7, 0.63, true, 10).sell).toBe(true)
  })

  it('forgets the peak out of profit, and sells nothing there', () => {
    expect(stepPressureTp(0.7, 0.3, false, 10)).toEqual({ peak: null, sell: false })
  })

  it('keeps the peak through a silent hour and sells nothing on it', () => {
    expect(stepPressureTp(0.7, null, true, 10)).toEqual({ peak: 0.7, sell: false })
  })

  it('is off at zero', () => {
    expect(stepPressureTp(0.7, 0.1, true, 0)).toEqual({ peak: null, sell: false })
  })
})
