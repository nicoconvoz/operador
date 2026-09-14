import { assertLength, type Series } from './series.js'

/**
 * Rate of Change — Pine Script `ta.roc(source, length)`.
 *
 *   roc[i] = 100 * (source[i] - source[i - length]) / source[i - length]
 *
 * `na` when either end of the comparison is `na`, and — as Pine does for any
 * division by zero — when the reference price is exactly zero.
 */
export function roc(source: Series, length: number): (number | null)[] {
  assertLength(length)

  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)

  for (let i = length; i < source.length; i++) {
    const current = source[i]
    const reference = source[i - length]
    if (current == null || reference == null || reference === 0) continue
    out[i] = (100 * (current - reference)) / reference
  }

  return out
}
