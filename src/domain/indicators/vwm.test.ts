import { describe, it, expect } from 'vitest'
import { vwm } from './vwm.js'
import { roc } from './roc.js'
import { ema } from './ema.js'

describe('vwm — Volume-Weighted Momentum, the exit engine of CASCADE DCA', () => {
  const n = 60
  const close = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 5)

  it('reduces to ema(roc) when volume is constant (relative volume = 1)', () => {
    const volume = Array<number>(n).fill(1000)
    const actual = vwm(close, volume, { rocLength: 10, smooth: 5, volumeLength: 10 })
    const expected = ema(roc(close, 10), 5)
    for (let i = 0; i < n; i++) {
      if (expected[i] === null) expect(actual[i]).toBeNull()
      else expect(actual[i]).toBeCloseTo(expected[i]!, 12)
    }
  })

  it('scales momentum by relative volume', () => {
    // Doubling one bar's volume must scale that bar's VWM by its relative volume.
    const base = Array<number>(n).fill(1000)
    const spiked = [...base]
    spiked[40] = 2000
    const a = vwm(close, base, { rocLength: 10, smooth: 1, volumeLength: 10 })
    const b = vwm(close, spiked, { rocLength: 10, smooth: 1, volumeLength: 10 })
    // With smooth 1, vwm == roc * rel_vol. rel_vol at bar 40 = 2000 / mean(10 bars).
    const meanVol = (9 * 1000 + 2000) / 10
    expect(b[40]! / a[40]!).toBeCloseTo(2000 / meanVol, 9)
  })
})
