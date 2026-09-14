import { IndicatorError, type DenseSeries } from './series.js'

/** Guards the three price series every OHLC-based indicator consumes. */
export function assertAligned(high: DenseSeries, low: DenseSeries, close: DenseSeries): void {
  if (high.length !== low.length || low.length !== close.length) {
    throw new IndicatorError(
      `high/low/close lengths differ: ${high.length}/${low.length}/${close.length}`,
    )
  }
}

/**
 * True Range — Pine Script `ta.tr(handle_na = true)`, which is what `ta.atr`
 * uses internally.
 *
 *   tr[i] = max(high - low, |high - close[i-1]|, |low - close[i-1]|)
 *
 * With `handle_na = true` the first bar, which has no previous close, falls
 * back to `high - low`. Note that `ta.dmi` uses `ta.tr` WITHOUT that flag, so
 * its first bar is `na` instead — see dmi.ts.
 */
export function trueRange(high: DenseSeries, low: DenseSeries, close: DenseSeries): number[] {
  assertAligned(high, low, close)

  const out = new Array<number>(high.length)

  for (let i = 0; i < high.length; i++) {
    const range = high[i]! - low[i]!
    if (i === 0) {
      out[i] = range
      continue
    }
    const previousClose = close[i - 1]!
    out[i] = Math.max(
      range,
      Math.abs(high[i]! - previousClose),
      Math.abs(low[i]! - previousClose),
    )
  }

  return out
}
