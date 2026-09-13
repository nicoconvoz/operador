import { IndicatorError, assertLength, type Series } from './series.js'
import { sma } from './sma.js'

/**
 * Exponential Moving Average — Pine Script `ta.ema(source, length)`.
 *
 *   alpha = 2 / (length + 1)
 *   ema[i] = alpha * source[i] + (1 - alpha) * ema[i - 1]
 *
 * ⚠️ PARITY ASSUMPTION — the highest-risk line in the indicator layer.
 *
 * The recursion above is documented and uncontroversial. The SEED is not:
 * we assume Pine emits `na` until the window is full, then seeds the first
 * emitted bar with `ta.sma` over that window.
 *
 * A wrong seed does not produce an obviously wrong result — it produces a
 * subtly shifted series that converges toward the right values, so it survives
 * eyeballing and quietly corrupts every downstream indicator (VWM, Supertrend,
 * the trend re-entry EMA-200 gate). It is exactly the kind of bug that only a
 * golden-file diff catches.
 *
 * DO NOT treat this as settled until `ema.golden.test.ts` passes against real
 * TradingView-exported values.
 *
 * `na` handling: a gap before the seed simply delays it. A gap AFTER the seed
 * throws. We own the OHLCV pipeline, so a post-seed gap means the data is
 * broken — and inventing a recursion rule for a case we cannot verify would be
 * guessing in code that moves money.
 */
export function ema(source: Series, length: number): (number | null)[] {
  assertLength(length)

  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)
  const alpha = 2 / (length + 1)

  const seedSeries = sma(source, length)
  const seedIndex = seedSeries.findIndex((value) => value !== null)
  if (seedIndex === -1) return out

  out[seedIndex] = seedSeries[seedIndex]!

  for (let i = seedIndex + 1; i < source.length; i++) {
    const value = source[i]
    if (value === null || value === undefined) {
      throw new IndicatorError(
        `ema: gap at bar ${i}, after the series was seeded at bar ${seedIndex}. ` +
          `The OHLCV pipeline must not emit gaps mid-series.`,
      )
    }
    out[i] = alpha * value + (1 - alpha) * out[i - 1]!
  }

  return out
}
