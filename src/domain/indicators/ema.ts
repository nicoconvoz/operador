import { assertLength, type Series } from './series.js'
import { smaSeededRecursion } from './recursive.js'

/**
 * Exponential Moving Average — Pine Script `ta.ema(source, length)`.
 *
 *   alpha = 2 / (length + 1)
 *   ema[i] = alpha * source[i] + (1 - alpha) * ema[i - 1]
 *
 * Seeded with the SMA of the first full window. That seed was the single
 * highest-risk assumption in the indicator layer — a wrong one does not look
 * wrong, it converges toward the right values and quietly shifts everything
 * downstream (VWM, Supertrend, the trend re-entry EMA-200 gate).
 *
 * It is now proven, not assumed: see ema.golden.test.ts for the seed and
 * ema200.golden.test.ts for the recursion at length 200 over 4001 bars.
 */
export function ema(source: Series, length: number): (number | null)[] {
  assertLength(length)
  return smaSeededRecursion(source, length, 2 / (length + 1), 'ema')
}
