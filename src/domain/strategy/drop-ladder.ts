/**
 * The DCA ladder on the PRICE alone: rung `n` once the price has fallen
 * `dropsPct[n-1]` under the FIRST buy.
 *
 * *Podés calibrar según los datos para que las ganancias sean las máximas y
 * las pérdidas las mínimas* — then *apliquemos la configuración completa.* The
 * operator, on a replay of all 336 real entries (2026-09-23 → 09-27, 5-minute
 * Jupiter closes, 0.66% a fill, the real freezes applied per token, split in
 * time at 09-25 05:30):
 *
 * | | Result | train / test | per $100 of peak capital |
 * |---|---|---|---|
 * | one rung at −50% of the last buy | +$71 | 31 / 41 | 6.5 |
 * | three rungs at −10/−20/−30% of the FIRST buy | **+$373** | 185 / 203 | **23.3** |
 *
 * The replay was optimistic by about $35 on the rule it could check against
 * the tape (+$71 simulated, +$37 real), and the chosen shape held in BOTH
 * halves of the split, which is the only reason to trust it over a lucky fit.
 *
 * Then ladder A, on the same replay: *arriesguémonos, activá la A.* Five rungs
 * at −10, −15, −20, −25 and −30% of a $10 first buy, sized $15 to $35 — **+$520**
 * (264 / 270), 28.1 per $100 of peak capital. The deepest line did not move;
 * the rungs between got denser and heavier. What each rung BUYS is not this
 * function's business: it answers WHICH rung, and the caller sizes it.
 *
 * **From the FIRST buy, not the last**, and that is what keeps the ladder
 * bounded: measured from the last fill each rung would chase the one before it,
 * and three rungs of 10% would reach −27% on a slow bleed and keep going on a
 * fast one. Anchored to the first, the deepest rung is −30% of the price the
 * position was opened at, whatever order the fills arrived in.
 *
 * One rung per call. A price that gaps straight past −30% buys DCA-1 now,
 * DCA-2 on the next sweep and DCA-3 on the one after: the sweep runs every
 * thirty seconds, and a single call that bought three rungs at once would be
 * three fills on one reading of a price nobody has confirmed twice.
 *
 * Pure; the caller brings the buys and the live price.
 */
export interface DropLadderPolicy {
  /** Entries the ladder may hold in total: the first buy plus its rungs. */
  readonly maxEntries: number
  /**
   * How far under the FIRST buy each rung buys, in percent, in order: the
   * first number is DCA-1. A list shorter than the entries allowed ends the
   * ladder where the list ends.
   */
  readonly dropsPct: readonly number[]
}

/** The rung to buy now — `n` for `DCA-n` — or null to wait. */
export function nextDropRung(
  input: { readonly entries: number; readonly firstBuyPrice: number; readonly priceUsd: number },
  policy: DropLadderPolicy,
): number | null {
  const { entries, firstBuyPrice, priceUsd } = input
  if (entries < 1 || entries >= policy.maxEntries) return null
  const drop = policy.dropsPct[entries - 1]
  if (drop === undefined) return null
  if (!(priceUsd > 0) || !(firstBuyPrice > 0)) return null
  return priceUsd <= firstBuyPrice * (1 - drop / 100) ? entries : null
}
