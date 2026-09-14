import { assertLength, type DenseSeries } from './series.js'

/**
 * Highest value of the trailing window — Pine Script `ta.highest(source, length)`.
 *
 * Takes a dense series: the strategy only ever applies this to `high`, which
 * has no gaps, so the question of how Pine treats `na` inside the window never
 * arises in practice and is deliberately not answered here.
 */
export function highest(source: DenseSeries, length: number): (number | null)[] {
  assertLength(length)

  const out: (number | null)[] = new Array<number | null>(source.length).fill(null)

  for (let i = length - 1; i < source.length; i++) {
    let max = -Infinity
    for (let j = i - length + 1; j <= i; j++) {
      const value = source[j]!
      if (value > max) max = value
    }
    out[i] = max
  }

  return out
}
