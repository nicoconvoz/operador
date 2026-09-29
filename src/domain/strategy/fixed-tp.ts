import { type CloseAllOrder } from './state.js'

/**
 * The FIXED take-profit: sell the whole holding the moment the live price
 * reaches its average cost plus a fixed percent.
 *
 * *Poné un TP fijo al 12.5% del promedio.* The operator — accepting, stated
 * and knowingly, that the big runs are given up: a token that would have run
 * to +80% leaves at +12.5% like one that would have turned at +13%.
 *
 * ## What it replaces in practice
 *
 * The strategy's own exit sells on a 15-minute bar CLOSE, over its floor, and
 * only once the impulse is seen to die or the Supertrend flips. This one asks
 * nothing of the chart: the stop sweep reads the live price every thirty
 * seconds and sells on the first one at the line. The strategy exit stays, and
 * its floor is raised to the same line so it can never sell under it.
 *
 * ## What it is not
 *
 * **Not a risk exit.** It is a strategy exit, measured from the average cost
 * and always above it, so it is NOT exempt from the no-loss guard: a quote at
 * the line that the fill gaps under cost is refused, and the position is held.
 *
 * Pure; the caller brings the average and the price.
 */

/**
 * Its own name on the tape. Not `🏁 Exit`, which is the strategy's and
 * parity-tested evidence, and not the gain lock's: `tools/loss-by-exit.ts` and
 * the day log group by comment, and two rules sharing one name would hide which
 * of them earned what.
 */
export const FIXED_TP_COMMENT = '🎯 TP fijo' as CloseAllOrder['comment']

/**
 * The price a holding sells at: its average cost plus `pct` percent. Null when
 * the TP is off — zero or absent — or there is no cost to measure from.
 */
export function fixedTpPrice(avgCostUsd: number | null, pct: number | null): number | null {
  if (pct === null || !(pct > 0)) return null
  if (avgCostUsd === null || !(avgCostUsd > 0)) return null
  return avgCostUsd * (1 + pct / 100)
}

/**
 * Whether a live price has reached the line — AT it counts. A price nobody
 * gave is not a rise: silence never sells.
 */
export function reachedFixedTp(priceUsd: number | null, avgCostUsd: number | null, pct: number | null): boolean {
  const line = fixedTpPrice(avgCostUsd, pct)
  return line !== null && priceUsd !== null && Number.isFinite(priceUsd) && priceUsd >= line
}
