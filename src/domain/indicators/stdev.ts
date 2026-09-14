import { assertLength, type Series } from './series.js'

/**
 * Standard deviation — Pine Script `ta.stdev(source, length, biased = true)`.
 *
 * POPULATION standard deviation: squared deviations from the window's SMA,
 * divided by `length` — not `length - 1`. Pine's default is the biased
 * estimator, and the golden data leaves no doubt: population matches the
 * Bollinger half-width to the export grid, sample is off by a full 1%.
 *
 * Pine's reference implementation snaps a deviation to exactly zero when its
 * magnitude is at or below 1e-10. Reproduced for fidelity; on real prices it
 * never triggers.
 */
const PINE_ZERO_EPSILON = 1e-10

export function stdev(source: Series, length: number): (number | null)[] {
  assertLength(length)

  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)

  for (let i = length - 1; i < source.length; i++) {
    let sum = 0
    let complete = true
    for (let j = i - length + 1; j <= i; j++) {
      const value = source[j]
      if (value == null) {
        complete = false
        break
      }
      sum += value
    }
    if (!complete) continue

    const mean = sum / length
    let squares = 0
    for (let j = i - length + 1; j <= i; j++) {
      const deviation = source[j]! - mean
      const snapped = Math.abs(deviation) <= PINE_ZERO_EPSILON ? 0 : deviation
      squares += snapped * snapped
    }
    out[i] = Math.sqrt(squares / length)
  }

  return out
}
