import { assertLength, type Series } from './series.js'
import { ema } from './ema.js'
import { roc } from './roc.js'
import { sma } from './sma.js'

export interface VwmParams {
  /** ROC lookback — `roc_len` in DCA.pine (default 10). */
  readonly rocLength: number
  /** EMA smoothing of the final series — `roc_sm` in DCA.pine (default 5). */
  readonly smooth: number
  /** Volume SMA length for relative volume — `vol_sm_len` in DCA.pine (default 10). */
  readonly volumeLength: number
}

/**
 * Volume-Weighted Momentum — the strategy's own exit indicator, from DCA.pine:
 *
 *   roc_raw = ta.roc(close, roc_len)
 *   vol_ma  = ta.sma(volume, vol_sm_len)
 *   rel_vol = volume / math.max(vol_ma, 1)
 *   vwm     = ta.ema(roc_raw * rel_vol, roc_sm)
 *
 * Price velocity scaled by how active the bar was relative to recent volume,
 * then smoothed. The exit fires when this has been falling for `decay_req`
 * bars after having been meaningfully positive — "the impulse died".
 *
 * Composed entirely from proven primitives; the golden test pins the
 * composition itself.
 */
export function vwm(close: Series, volume: Series, params: VwmParams): (number | null)[] {
  assertLength(params.rocLength, 'rocLength')
  assertLength(params.smooth, 'smooth')
  assertLength(params.volumeLength, 'volumeLength')

  const momentum = roc(close, params.rocLength)
  const averageVolume = sma(volume, params.volumeLength)

  const weighted: (number | null)[] = momentum.map((value, i) => {
    const current = volume[i]
    const average = averageVolume[i]
    if (value == null || current == null || average == null) return null
    return value * (current / Math.max(average, 1))
  })

  return ema(weighted, params.smooth)
}
