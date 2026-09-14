import { describe, it, expect } from 'vitest'
import { computeSignals } from './signals.js'
import { DEFAULT_PARAMS } from './params.js'
import { bars, column, dense, expectGolden } from '../indicators/__golden__/harness.js'

/**
 * The signal layer composes proven indicators into the booleans the state
 * machine consumes. The golden fixture carries TradingView's own values for
 * every input to those booleans, so each one can be recomputed from THEIR
 * columns and compared with OURS, bar for bar.
 */

const high = dense(column(bars, 'high'))
const low = dense(column(bars, 'low'))
const close = dense(column(bars, 'close'))
const volume = dense(column(bars, 'volume'))
const N = bars.length
const CONVERGED = 1000

const P = DEFAULT_PARAMS
const { contexts, series } = computeSignals({ high, low, close, volume }, P)

const cell = (i: number, key: string): number | null => bars[i]?.[key] ?? null

describe('signals — golden parity of the composed booleans', () => {
  it('produces one context per bar', () => {
    expect(contexts).toHaveLength(N)
  })

  it('is_lateral matches TradingView, using the BBW formula AS WRITTEN in DCA.pine', () => {
    for (let i = CONVERGED; i < N; i++) {
      const bbw = cell(i, 'bbw_as_written')
      const adx = cell(i, 'adx')
      const bbwOk = bbw !== null && bbw < P.bbwMax
      const adxOk = adx !== null && adx < P.adxMax
      const theirs = P.requireBoth ? bbwOk && adxOk : bbwOk || adxOk
      expect(contexts[i]!.isLateral, `is_lateral@${i}`).toBe(theirs)
    }
  })

  it('bbw_as_written and bbw_textbook both match TradingView', () => {
    for (let i = CONVERGED; i < N; i++) {
      expectGolden(series.bbwAsWritten[i], cell(i, 'bbw_as_written'), `bbw_as_written@${i}`)
      expectGolden(series.bbwTextbook[i], cell(i, 'bbw_textbook'), `bbw_textbook@${i}`)
    }
  })

  it('swing_high matches', () => {
    for (let i = 19; i < N; i++) expect(contexts[i]!.swingHigh).toBe(cell(i, 'swing_high'))
  })

  it('st_bear_flip = crossover(st_dir, 0) matches, derived from their st_dir', () => {
    for (let i = CONVERGED; i < N; i++) {
      const prev = cell(i - 1, 'st_dir')
      const now = cell(i, 'st_dir')
      const theirs = prev !== null && now !== null && prev <= 0 && now > 0
      expect(contexts[i]!.stBearFlip, `st_bear_flip@${i}`).toBe(theirs)
    }
  })

  it('trend_bullish matches, derived entirely from their columns', () => {
    for (let i = CONVERGED; i < N; i++) {
      const stDir = cell(i, 'st_dir')
      const adx = cell(i, 'adx')
      const dip = cell(i, 'dip')
      const dim = cell(i, 'dim')
      const emaTrend = cell(i, 'ema_trend')
      const bbw = cell(i, 'bbw_as_written')
      const lateral =
        (bbw !== null && bbw < P.bbwMax) || (adx !== null && adx < P.adxMax)
      const theirs =
        stDir !== null && stDir < 0 &&
        adx !== null && adx >= P.trendAdxMin &&
        dip !== null && dim !== null && dip > dim &&
        emaTrend !== null && close[i]! > emaTrend &&
        close[i]! > close[i - P.trendSlopeBars]! &&
        !lateral
      expect(contexts[i]!.trendBullish, `trend_bullish@${i}`).toBe(theirs)
    }
  })

  it('vwm and its lags match', () => {
    for (let i = 200; i < N; i++) {
      expectGolden(contexts[i]!.vwm, cell(i, 'vwm'), `vwm@${i}`)
      expectGolden(contexts[i]!.vwmPrev, cell(i - 1, 'vwm'), `vwm[1]@${i}`)
      expectGolden(contexts[i]!.vwmLagged, cell(i - P.decayBarsRequired, 'vwm'), `vwm[decay]@${i}`)
    }
  })

  it('the lateral filter is nearly inert with defaults — the BBW finding, pinned', () => {
    const lateralShare = contexts.slice(CONVERGED).filter((c) => c.isLateral).length / (N - CONVERGED)
    expect(lateralShare).toBeGreaterThan(0.9)
  })
})

describe('signals — Pine na semantics during warmup', () => {
  it('every boolean is false while its inputs are na', () => {
    const first = contexts[0]!
    expect(first.isLateral).toBe(false)
    expect(first.trendBullish).toBe(false)
    expect(first.stBearFlip).toBe(false)
    expect(first.swingHigh).toBeNull()
    expect(first.vwm).toBeNull()
  })

  it('is_lateral with OR is true when only one side has a value', () => {
    // ADX is an RMA of an RMA, so it seeds at 2*adxLength - 1 = bar 29 —
    // well before BBW(50) exists at bar 49. Find it rather than assume it.
    const i = series.adx.findIndex((v) => v !== null)
    expect(i).toBe(2 * P.adxLength - 1)
    expect(series.bbwAsWritten[i]).toBeNull()
    expect(series.adx[i]).not.toBeNull()
    expect(contexts[i]!.isLateral).toBe(series.adx[i]! < P.adxMax)
  })

  it('require_both changes the answer on some bars', () => {
    const both = computeSignals({ high, low, close, volume }, { ...P, requireBoth: true })
    const differs = contexts.filter((c, i) => c.isLateral !== both.contexts[i]!.isLateral).length
    expect(differs).toBeGreaterThan(0)
  })
})
