import { assertLength, type Series } from './series.js'

/**
 * Simple Moving Average — Pine Script `ta.sma(source, length)`.
 *
 * Semantics reproduced from Pine:
 *  - The window is TRAILING: bar `i` averages bars `[i - length + 1 .. i]`.
 *  - Bars before the window is full are `na`.
 *  - `na` inside a window poisons that window — Pine does not skip gaps.
 *
 * Precision note: the window is summed directly on every bar rather than kept
 * as a rolling add/subtract accumulator. The rolling form is O(n) instead of
 * O(n·length), but it accumulates floating-point drift across long series —
 * and TradingView parity is this project's acceptance test, so correctness
 * wins over a micro-optimisation on an input we measure in thousands of bars.
 */
export function sma(source: Series, length: number): (number | null)[] {
  assertLength(length)

  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)

  for (let i = length - 1; i < source.length; i++) {
    let sum = 0
    let complete = true

    for (let j = i - length + 1; j <= i; j++) {
      const value = source[j]
      if (value === null || value === undefined) {
        complete = false
        break
      }
      sum += value
    }

    if (complete) out[i] = sum / length
  }

  return out
}
