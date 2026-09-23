/**
 * The DCA ladder on the PRICE alone: a rung once the price has fallen
 * `dropPct` under the last buy.
 *
 * *Armá un solo paso de DCA: si el precio cae al 50% de lo que vale, volver a
 * comprar — sólo esa condición.* The operator. One step by default: two
 * entries, the first buy and the rung at half its price. Pure; the caller
 * brings the buys and the live price.
 */
export interface DropLadderPolicy {
  /** Entries the ladder may hold in total: the first buy plus its rungs. */
  readonly maxEntries: number
  /** How far under the LAST buy the price must be for the next rung, in percent. */
  readonly dropPct: number
}

/** The rung to buy now — `n` for `DCA-n` — or null to wait. */
export function nextDropRung(
  input: { readonly entries: number; readonly lastBuyPrice: number; readonly priceUsd: number },
  policy: DropLadderPolicy,
): number | null {
  const { entries, lastBuyPrice, priceUsd } = input
  if (entries < 1 || entries >= policy.maxEntries) return null
  if (!(priceUsd > 0) || !(lastBuyPrice > 0)) return null
  return priceUsd <= lastBuyPrice * (1 - policy.dropPct / 100) ? entries : null
}
