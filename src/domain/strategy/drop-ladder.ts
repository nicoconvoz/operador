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
 * **Then from the PREVIOUS buy, in production.** The operator watched it live:
 * *no espera a que el % de caída llegue al 10, al 15, al 20, al 25 o al 30 con
 * respecto al anterior — va comprando muy seguido.* Anchored to the first buy,
 * five lines five points apart asked each rung for only 5–6% under the one
 * before, and WORLD, falling −44% in a minute, bought all five in that minute.
 * Measured from the previous buy the lines sit at −10, −23.5, −38.8, −54 and
 * −68% of the first. The replay priced it and he took it knowingly — *aplicá
 * mi lógica, aunque ganemos menos*:
 *
 * | | Result | train / test | worst token | frozen | peak capital |
 * |---|---|---|---|---|---|
 * | from the first buy | **$538** | 251 / 302 | −$52 | −$65 | $2,430 |
 * | from the previous buy | $312 | 110 / 214 | **−$23** | **−$37** | **$1,550** |
 *
 * Almost the same return per dollar (20.1 against 22.2 per $100 of peak
 * capital) on a far smaller tail. The objection to chasing the last fill is
 * answered by the list itself: it has five numbers, so the ladder ends.
 *
 * Pure; the caller brings the buys and the live price.
 */
export interface DropLadderPolicy {
  /** Entries the ladder may hold in total: the first buy plus its rungs. */
  readonly maxEntries: number
  /**
   * How far under the anchor each rung buys, in percent, in order: the first
   * number is DCA-1. A list shorter than the entries allowed ends the ladder
   * where the list ends.
   */
  readonly dropsPct: readonly number[]
  /**
   * What each drop is measured from: the FIRST buy of the holding, or the
   * PREVIOUS one — the rung just bought, at what it actually paid. Absent:
   * the first.
   */
  readonly from?: 'first' | 'previous'
}

/** The rung to buy now — `n` for `DCA-n` — or null to wait. */
export function nextDropRung(
  input: {
    readonly entries: number
    readonly firstBuyPrice: number
    /** What the latest buy of the holding paid; needed when measuring from the previous buy. */
    readonly lastBuyPrice?: number
    readonly priceUsd: number
  },
  policy: DropLadderPolicy,
): number | null {
  const { entries, priceUsd } = input
  if (entries < 1 || entries >= policy.maxEntries) return null
  const drop = policy.dropsPct[entries - 1]
  if (drop === undefined) return null
  const anchor = policy.from === 'previous' ? input.lastBuyPrice : input.firstBuyPrice
  if (!(priceUsd > 0) || anchor === undefined || !(anchor > 0)) return null
  return priceUsd <= anchor * (1 - drop / 100) ? entries : null
}
