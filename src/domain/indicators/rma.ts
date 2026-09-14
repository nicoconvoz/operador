import { assertLength, type Series } from './series.js'
import { smaSeededRecursion } from './recursive.js'

/**
 * Running Moving Average (Wilder smoothing) — Pine Script `ta.rma(source, length)`.
 *
 *   alpha = 1 / length
 *   rma[i] = alpha * source[i] + (1 - alpha) * rma[i - 1]
 *
 * Same seeded recursion as `ta.ema`, with a smaller alpha — which is why
 * Wilder's ATR and ADX react more slowly than an EMA of the same length.
 * This is the smoothing under `ta.atr` and `ta.dmi`, so it inherits the
 * proven seed from `ta.ema`; the golden tests for ATR and ADX confirm it.
 */
export function rma(source: Series, length: number): (number | null)[] {
  assertLength(length)
  return smaSeededRecursion(source, length, 1 / length, 'rma')
}
