import { IndicatorError, type Series } from './series.js'
import { sma } from './sma.js'

/**
 * The recursion shared by `ta.ema` and `ta.rma`:
 *
 *   out[i] = alpha * source[i] + (1 - alpha) * out[i - 1]
 *
 * seeded, once the first full window exists, with the SMA of that window.
 * Only alpha differs: `2 / (length + 1)` for EMA, `1 / length` for RMA.
 *
 * SEEDING IS SETTLED. It was the open parity question of this layer, and the
 * golden data answers it (ema.golden.test.ts): TradingView emits `na` until
 * the window fills, and the first emitted value equals the SMA of that
 * window. It does not start at bar 0 from the source value.
 *
 * `na` handling: a gap before the seed simply delays it — the SMA window is
 * poisoned until the gap falls out of it, which is exactly Pine's behaviour.
 * A gap AFTER the seed throws. We own the OHLCV pipeline, so a post-seed gap
 * means the data is broken, and inventing a recursion rule for a case we
 * cannot verify would be guessing in code that moves money.
 */
export function smaSeededRecursion(
  source: Series,
  length: number,
  alpha: number,
  name: string,
): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)

  const seedSeries = sma(source, length)
  const seedIndex = seedSeries.findIndex((value) => value !== null)
  if (seedIndex === -1) return out

  out[seedIndex] = seedSeries[seedIndex]!

  for (let i = seedIndex + 1; i < source.length; i++) {
    const value = source[i]
    if (value === null || value === undefined) {
      throw new IndicatorError(
        `${name}: gap at bar ${i}, after the series was seeded at bar ${seedIndex}. ` +
          `The OHLCV pipeline must not emit gaps mid-series.`,
      )
    }
    out[i] = alpha * value + (1 - alpha) * out[i - 1]!
  }

  return out
}
