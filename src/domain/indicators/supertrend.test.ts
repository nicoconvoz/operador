import { describe, it, expect } from 'vitest'
import { supertrend } from './supertrend.js'

describe('supertrend — Pine Script ta.supertrend parity', () => {
  // A clean, steady uptrend: every bar one unit higher than the last.
  const n = 30
  const high = Array.from({ length: n }, (_, i) => i + 1)
  const low = Array.from({ length: n }, (_, i) => i)
  const close = Array.from({ length: n }, (_, i) => i + 0.5)

  it('uses Pine direction encoding: -1 = uptrend, +1 = downtrend', () => {
    const { direction } = supertrend(high, low, close, 1, 3)
    const defined = direction.filter((d) => d !== null)
    expect(defined.length).toBeGreaterThan(0)
    expect(defined.every((d) => d === 1 || d === -1)).toBe(true)
  })

  it('flips to uptrend once price clears the upper band, then holds', () => {
    const { direction, line } = supertrend(high, low, close, 1, 3)
    const firstUp = direction.indexOf(-1)
    expect(firstUp).toBeGreaterThan(0)
    // Never flips back on a monotone rise.
    expect(direction.slice(firstUp).every((d) => d === -1)).toBe(true)
    // In an uptrend the line is the lower band, sitting below price.
    for (let i = firstUp; i < n; i++) expect(line[i]!).toBeLessThan(close[i]!)
  })

  it('is na until ATR exists', () => {
    const { direction, line } = supertrend(high, low, close, 1, 3)
    expect(direction[0]).toBeNull()
    expect(line[0]).toBeNull()
  })
})
