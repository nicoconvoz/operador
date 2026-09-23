/**
 * The DCA ladder on ORDER FLOW: a rung each time buyers push through 1%.
 *
 * The operator: *cuando la presión compradora aumente más de 1%, compra;
 * cuando la presión vendedora aumente más del 1%, venta. Aplicalo para el DCA
 * también — nada de escalones, esa regla.* No price step, no floor of
 * one-minute candles: who is trading decides.
 *
 * A rung is bought on the CROSSING, never on the level. Pressure can sit above
 * 1% for an hour, and a sweep every thirty seconds reading the level would buy
 * all five rungs in under three minutes — ninety dollars on one reading. A
 * crossing needs a before and an after, so the first reading of a position
 * buys nothing, and neither does a silent hour.
 *
 * The first buy is not this ladder's: it has its own door, on volume
 * expansion and trend.
 *
 * Pure: the caller keeps the previous reading.
 */

/** Trades above 50.5% on one side: the door both ways, on the buy door's own scale. */
export const PRESSURE_THRESHOLD = 0.01

/**
 * How hard one side leads the hour, 0..1 above the neutral half — the same
 * scale as the opportunity score's buy pressure. Null on a silent hour: nobody
 * counted is not nobody pushing.
 */
export function pressureOf(buys: number, sells: number, side: 'buy' | 'sell'): number | null {
  const trades = buys + sells
  if (!(trades > 0)) return null
  const share = (side === 'buy' ? buys : sells) / trades
  return Math.min(1, Math.max(0, (share - 0.5) * 2))
}

export interface PressureLadderPolicy {
  /** Entries the ladder may hold in total: the first buy plus its DCA rungs. */
  readonly maxEntries: number
  /** Buy pressure a rung needs to cross upward. */
  readonly threshold: number
}

/** The rung to buy now — `n` for `DCA-n` — or null to wait. */
export function nextPressureRung(
  input: { readonly entries: number; readonly previous: number | null; readonly now: number | null },
  policy: PressureLadderPolicy,
): number | null {
  const { entries, previous, now } = input
  if (entries < 1 || entries >= policy.maxEntries) return null
  if (previous === null || now === null) return null
  return previous <= policy.threshold && now > policy.threshold ? entries : null
}
