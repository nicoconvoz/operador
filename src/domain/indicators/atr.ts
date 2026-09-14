import { type DenseSeries } from './series.js'
import { rma } from './rma.js'
import { trueRange } from './tr.js'

/**
 * Average True Range — Pine Script `ta.atr(length)`.
 *
 *   atr = ta.rma(ta.tr(true), length)
 *
 * Wilder smoothing over true range. Recursive, so it carries state from all
 * prior history — the golden test compares it once converged.
 */
export function atr(
  high: DenseSeries,
  low: DenseSeries,
  close: DenseSeries,
  length: number,
): (number | null)[] {
  return rma(trueRange(high, low, close), length)
}
