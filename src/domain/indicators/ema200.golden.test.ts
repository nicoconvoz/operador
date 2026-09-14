import { describe, it, expect } from 'vitest'
import { ema } from './ema.js'
import { bars, column, expectGolden } from './__golden__/harness.js'

/**
 * The hardest parity test in the layer: a length-200 EMA over 4001 bars.
 *
 * TradingView computed `ema_trend` with history that PRECEDES this window, so
 * its value at bar 0 is already converged while ours seeds fresh at bar 199.
 * The two therefore start apart and converge — which is itself the proof that
 * the recursion is identical, since a different recursion would converge to a
 * different place, or not at all.
 *
 * This matters beyond the indicator: `ema_trend` gates the trend re-entry, the
 * second of the strategy's two entry doors.
 */

const WARMUP_BARS = 2200 // seed at 199, then ~2000 bars for alpha=2/201 to decay

describe('ema(close, 200) — golden parity against TradingView', () => {
  const closes = column(bars, 'close')
  const actual = ema(closes, 200)

  it('has enough history to outrun the warmup', () => {
    expect(bars.length).toBeGreaterThan(WARMUP_BARS + 500)
  })

  it('matches ema_trend bar for bar once converged', () => {
    for (let i = WARMUP_BARS; i < bars.length; i++) {
      expectGolden(actual[i], bars[i]!.ema_trend, `ema200@${i}`)
    }
  })

  it('converges monotonically rather than tracking a constant offset', () => {
    // A wrong recursion can still look close. It cannot look close AND shrink
    // its error by orders of magnitude as history accumulates.
    const relAt = (i: number) => {
      const want = bars[i]!.ema_trend!
      return Math.abs(actual[i]! - want) / Math.abs(want)
    }
    expect(relAt(300)).toBeGreaterThan(relAt(1000))
    expect(relAt(1000)).toBeGreaterThan(relAt(2200))
  })

  it('stays converged through the final bar', () => {
    const last = bars.length - 1
    expectGolden(actual[last], bars[last]!.ema_trend, `ema200@last(${last})`)
  })
})
