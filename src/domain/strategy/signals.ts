import { dmi } from '../indicators/dmi.js'
import { ema } from '../indicators/ema.js'
import { highest } from '../indicators/highest.js'
import { type DenseSeries } from '../indicators/series.js'
import { sma } from '../indicators/sma.js'
import { stdev } from '../indicators/stdev.js'
import { supertrend } from '../indicators/supertrend.js'
import { vwm } from '../indicators/vwm.js'
import { type CascadeParams } from './params.js'
import { type BarContext } from './state.js'

export interface Ohlcv {
  readonly high: DenseSeries
  readonly low: DenseSeries
  readonly close: DenseSeries
  readonly volume: DenseSeries
}

/** Every intermediate series, kept for the audit log and the dashboard. */
export interface SignalSeries {
  readonly bbBasis: readonly (number | null)[]
  readonly bbUpper: readonly (number | null)[]
  readonly bbLower: readonly (number | null)[]
  /** BBW exactly as DCA.pine computes it — see the note below. The strategy uses THIS. */
  readonly bbwAsWritten: readonly (number | null)[]
  /** Textbook BBW. Exported for a future A/B; the strategy does not read it. */
  readonly bbwTextbook: readonly (number | null)[]
  readonly adx: readonly (number | null)[]
  readonly dip: readonly (number | null)[]
  readonly dim: readonly (number | null)[]
  readonly swingHigh: readonly (number | null)[]
  readonly vwm: readonly (number | null)[]
  readonly stLine: readonly (number | null)[]
  readonly stDir: readonly (number | null)[]
  readonly emaTrend: readonly (number | null)[]
}

export interface Signals {
  readonly contexts: readonly BarContext[]
  readonly series: SignalSeries
}

/**
 * Composes the proven indicator layer into the per-bar facts the state
 * machine consumes. This is the ONLY place the strategy's indicator formulas
 * live; the state machine sees booleans and prices.
 *
 * Pine `na` semantics apply throughout: any comparison involving `na` is
 * false, so every boolean here is false until all of its inputs exist.
 */
export function computeSignals(ohlcv: Ohlcv, params: CascadeParams): Signals {
  const { high, low, close, volume } = ohlcv
  const n = close.length

  // ── Bollinger Bands and the BBW the strategy actually uses ─────────────────
  // ta.bb returns [basis, upper, lower]. DCA.pine:415 destructures it as
  // [bb_up, bb_mid, bb_lo] — so its `bb_up` IS the basis, `bb_mid` IS the
  // upper band and `bb_lo` the lower. Line 416 then computes
  //   bbw = (bb_up - bb_lo) / bb_mid * 100  ==  (basis - lower) / upper * 100
  // That reads ~2.26x below textbook BBW and is what bbw_max = 14 was tuned
  // against. Ported as written; see CLAUDE.md, "Finding: the BBW filter is inert".
  const bbBasis = sma(close, params.bbLength)
  const bbStd = stdev(close, params.bbLength)
  const bbUpper = bbBasis.map((b, i) => (b === null || bbStd[i] === null ? null : b + params.bbStdev * bbStd[i]!))
  const bbLower = bbBasis.map((b, i) => (b === null || bbStd[i] === null ? null : b - params.bbStdev * bbStd[i]!))
  const bbwAsWritten = bbBasis.map((basis, i) => {
    const upper = bbUpper[i]
    const lower = bbLower[i]
    if (basis === null || upper == null || lower == null) return null
    return ((basis - lower) / upper) * 100
  })
  const bbwTextbook = bbBasis.map((basis, i) => {
    const upper = bbUpper[i]
    const lower = bbLower[i]
    if (basis === null || upper == null || lower == null) return null
    return ((upper - lower) / basis) * 100
  })

  // ── Trend strength and direction ───────────────────────────────────────────
  const { plus: dip, minus: dim, adx } = dmi(high, low, close, params.adxLength, params.adxLength)

  // ── Lateral zone: `require_both ? (bbw < max and adx < max) : (or)` ────────
  const isLateral = bbwAsWritten.map((bbw, i) => {
    const a = adx[i]
    const bbwOk = bbw !== null && bbw < params.bbwMax
    const adxOk = a != null && a < params.adxMax
    return params.requireBoth ? bbwOk && adxOk : bbwOk || adxOk
  })

  const swingHigh = highest(high, params.swingLookback)

  const vwmSeries = vwm(close, volume, {
    rocLength: params.rocLength,
    smooth: params.rocSmooth,
    volumeLength: params.volumeLength,
  })

  const { line: stLine, direction: stDir } = supertrend(
    high, low, close, params.supertrendFactor, params.supertrendAtrLength,
  )

  const emaTrend = ema(close, params.trendEmaLength)

  const contexts: BarContext[] = new Array<BarContext>(n)
  for (let i = 0; i < n; i++) {
    const dir = stDir[i] ?? null
    const prevDir = i > 0 ? (stDir[i - 1] ?? null) : null
    // ta.crossover(st_dir, 0): above zero now, at or below zero on the previous bar.
    const stBearFlip = prevDir !== null && dir !== null && prevDir <= 0 && dir > 0

    const a = adx[i] ?? null
    const p = dip[i] ?? null
    const m = dim[i] ?? null
    const e = emaTrend[i] ?? null
    const slopeRef = i >= params.trendSlopeBars ? close[i - params.trendSlopeBars]! : null
    const trendBullish =
      dir !== null && dir < 0 &&
      a !== null && a >= params.trendAdxMin &&
      p !== null && m !== null && p > m &&
      e !== null && close[i]! > e &&
      slopeRef !== null && close[i]! > slopeRef &&
      !isLateral[i]!

    contexts[i] = {
      isLateral: isLateral[i]!,
      swingHigh: swingHigh[i] ?? null,
      trendBullish,
      stBearFlip,
      vwm: vwmSeries[i] ?? null,
      vwmPrev: i >= 1 ? (vwmSeries[i - 1] ?? null) : null,
      vwmLagged: i >= params.decayBarsRequired ? (vwmSeries[i - params.decayBarsRequired] ?? null) : null,
    }
  }

  return {
    contexts,
    series: {
      bbBasis, bbUpper, bbLower, bbwAsWritten, bbwTextbook,
      adx, dip, dim, swingHigh, vwm: vwmSeries, stLine, stDir, emaTrend,
    },
  }
}
