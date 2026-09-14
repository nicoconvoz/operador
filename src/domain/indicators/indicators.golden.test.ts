import { describe, it, expect } from 'vitest'
import { bars, column, dense, expectGolden } from './__golden__/harness.js'
import { roc } from './roc.js'
import { highest } from './highest.js'
import { stdev } from './stdev.js'
import { atr } from './atr.js'
import { supertrend } from './supertrend.js'
import { dmi } from './dmi.js'
import { vwm } from './vwm.js'

/**
 * Golden parity for every remaining indicator in the strategy, against
 * TradingView's own values over 4001 bars of BLESS 1H.
 *
 * Non-recursive indicators are compared from the first bar their window
 * allows. Recursive ones (anything built on RMA or EMA) carry state from
 * before the export window, so they are compared once converged — the same
 * argument used for EMA-200: a wrong recursion cannot converge onto the
 * right one.
 */

const high = dense(column(bars, 'high'))
const low = dense(column(bars, 'low'))
const close = dense(column(bars, 'close'))
const volume = dense(column(bars, 'volume'))
const N = bars.length

const CONVERGED = 1000

const compare = (actual: readonly (number | null)[], key: string, from: number) => {
  for (let i = from; i < N; i++) expectGolden(actual[i], bars[i]![key], `${key}@${i}`)
}

describe('golden parity — strategy indicators', () => {
  it('ta.roc(close, 10)', () => compare(roc(close, 10), 'roc', 10))

  it('ta.highest(high, 20)', () => compare(highest(high, 20), 'swing_high', 19))

  it('ta.stdev(close, 50) via the Bollinger band half-width (mult = 1)', () => {
    const actual = stdev(close, 50)
    for (let i = 49; i < N; i++) {
      const halfWidth = bars[i]!.bb_upper! - bars[i]!.bb_basis!
      expectGolden(actual[i], halfWidth, `stdev@${i}`)
    }
  })

  it('ta.atr(10)', () => compare(atr(high, low, close, 10), 'atr', CONVERGED))

  it('ta.supertrend(3, 10) — line and direction', () => {
    const { line, direction } = supertrend(high, low, close, 3, 10)
    compare(line, 'st_line', CONVERGED)
    for (let i = CONVERGED; i < N; i++) {
      expect(direction[i], `st_dir@${i}`).toBe(bars[i]!.st_dir)
    }
  })

  it('ta.dmi(15, 15) — +DI, -DI, ADX', () => {
    const { plus, minus, adx } = dmi(high, low, close, 15, 15)
    compare(plus, 'dip', CONVERGED)
    compare(minus, 'dim', CONVERGED)
    compare(adx, 'adx', CONVERGED)
  })

  it('VWM = ema(roc * volume / sma(volume), 5)', () => {
    const actual = vwm(close, volume, { rocLength: 10, smooth: 5, volumeLength: 10 })
    compare(actual, 'vwm', 200)
  })
})
