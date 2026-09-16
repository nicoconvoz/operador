import { describe, it, expect } from 'vitest'
import { hoursSinceLastTrade } from './idle-hours.js'
import { type Candles } from './replay.js'

const HOUR = 3_600_000
const BAR = 15 * 60_000
const NOW = 1_800_000_000_000

/** `bars` newest-last, each 15m apart, ending at the bar that opened `agoBars` ago. */
const series = (volumes: number[]): Candles => {
  const n = volumes.length
  return {
    time: volumes.map((_, i) => NOW - (n - i) * BAR),
    open: volumes.map(() => 1),
    high: volumes.map(() => 1),
    low: volumes.map(() => 1),
    close: volumes.map(() => 1),
    volume: volumes,
  }
}

describe('hoursSinceLastTrade — measured from the candles, not guessed', () => {
  it('is near zero while the newest bar is trading', () => {
    expect(hoursSinceLastTrade(series([100, 100, 100]), NOW)).toBeLessThan(0.3)
  })

  it('counts from the LAST bar that had volume, not from the last bar', () => {
    // Four empty bars on the end: an hour since anybody traded, even though
    // the provider is still emitting bars.
    expect(hoursSinceLastTrade(series([100, 0, 0, 0, 0]), NOW)).toBeCloseTo(1.25, 1)
  })

  it('measures a pool that simply stopped emitting bars', () => {
    // This is the live shape: PURR's newest candle was four hours old, which
    // is itself the measurement — nobody traded since.
    const stale: Candles = series([100, 100])
    const old = { ...stale, time: stale.time.map((t) => t - 4 * HOUR) }
    expect(hoursSinceLastTrade(old, NOW)).toBeGreaterThan(4)
  })

  it('reports nothing rather than zero when no bar ever traded', () => {
    // Silence is not "it traded just now". Returning 0 here would tell the
    // abandonment signal the pool is lively, which is the opposite of the truth.
    expect(hoursSinceLastTrade(series([0, 0, 0]), NOW)).toBeNull()
  })

  it('reports nothing for an empty series', () => {
    expect(hoursSinceLastTrade(series([]), NOW)).toBeNull()
  })

  it('never goes negative on a bar stamped in the future', () => {
    const ahead = series([100])
    expect(hoursSinceLastTrade({ ...ahead, time: [NOW + HOUR] }, NOW)).toBe(0)
  })
})
