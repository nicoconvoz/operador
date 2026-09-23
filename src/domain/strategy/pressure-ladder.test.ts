import { describe, it, expect } from 'vitest'
import { pressureOf, nextPressureRung, PRESSURE_THRESHOLD } from './pressure-ladder.js'

/**
 * *Cuando la presión compradora aumente más de 1%, compra; cuando la presión
 * vendedora aumente más del 1%, venta. Aplicalo para el DCA también — nada de
 * escalones, esa regla.* The operator.
 */

describe('pressureOf — who is leading the hour, on one scale for both sides', () => {
  it('reads the side that leads, 0..1 above the neutral half', () => {
    expect(pressureOf(60, 40, 'buy')).toBeCloseTo(0.2, 9)
    expect(pressureOf(60, 40, 'sell')).toBe(0)
    expect(pressureOf(40, 60, 'sell')).toBeCloseTo(0.2, 9)
  })

  it('is null on a silent hour — nobody counted is not nobody pushing', () => {
    expect(pressureOf(0, 0, 'buy')).toBeNull()
  })

  it('puts the door at 1% — trades above 50.5% on one side', () => {
    expect(PRESSURE_THRESHOLD).toBe(0.01)
  })
})

describe('nextPressureRung — a rung each time buyers push through 1%', () => {
  const policy = { maxEntries: 6, threshold: 0.01 }

  it('buys the next rung when buy pressure CROSSES 1% upward', () => {
    expect(nextPressureRung({ entries: 1, previous: 0, now: 0.2 }, policy)).toBe(1)
    expect(nextPressureRung({ entries: 3, previous: 0.01, now: 0.02 }, policy)).toBe(3)
  })

  it('does not buy again while it merely STAYS above — that would spend the ladder in minutes', () => {
    expect(nextPressureRung({ entries: 2, previous: 0.2, now: 0.3 }, policy)).toBeNull()
  })

  it('does not buy on the first reading — a crossing needs a before', () => {
    expect(nextPressureRung({ entries: 1, previous: null, now: 0.3 }, policy)).toBeNull()
  })

  it('does not buy on a silent hour', () => {
    expect(nextPressureRung({ entries: 1, previous: 0, now: null }, policy)).toBeNull()
  })

  it('stops at the last rung, and never opens a position — the first buy has its own door', () => {
    expect(nextPressureRung({ entries: 6, previous: 0, now: 0.2 }, policy)).toBeNull()
    expect(nextPressureRung({ entries: 0, previous: 0, now: 0.2 }, policy)).toBeNull()
  })
})
