/**
 * The DCA ladder, confirmed on a FLOOR of one-minute candles.
 *
 * The operator: *agregá 5 escalones de DCA, pero pedí un piso lateral de 5
 * velas de 1 minuto antes de volver a comprar la bajada y promediar. Cada
 * escalón de 15 dólares.*
 *
 * The reference confirms a bottom with `confirm_bars` counted in the
 * STRATEGY's bars — twenty of them, five hours at 15m, longer than these
 * positions live. The same idea at the resolution the operator asked for:
 * the low of this dip has not been broken for five one-minute candles. A
 * token still printing new lows every minute is a falling knife; one that has
 * held its low for five is a floor, and a floor is what a rung buys.
 *
 * A rung also needs a real dip: `gapPct` under the LAST buy, the reference's
 * own `min_gap_pct`. Averaging down a hair pays a round trip for nothing, and
 * measuring from the last buy rather than the first means every rung needs a
 * new dip of its own.
 *
 * Pure: no clock, no network. The caller hands it the buys and the minutes.
 */

export interface FloorLadderPolicy {
  /** Entries the ladder may hold in total: the first buy plus its DCA rungs. */
  readonly maxEntries: number
  /** How far under the LAST buy the price must be before a rung, in percent. */
  readonly gapPct: number
  /** One-minute candles the low must have held for. */
  readonly floorBars: number
}

export interface FloorLadderInput {
  /** Every buy of the open position, oldest first. */
  readonly buys: readonly { readonly price: number; readonly time: number }[]
  /** The live price. */
  readonly priceUsd: number
  /** CLOSED one-minute candles, oldest first; `time` is each bar's open. */
  readonly bars: { readonly time: readonly number[]; readonly low: readonly number[] }
}

/** The rung to buy now — `n` for `DCA-n` — or null to wait. */
export function nextFloorRung(input: FloorLadderInput, policy: FloorLadderPolicy): number | null {
  const { buys, priceUsd, bars } = input
  if (buys.length === 0 || buys.length >= policy.maxEntries) return null
  if (!(priceUsd > 0)) return null

  const last = buys[buys.length - 1]!
  if (priceUsd > last.price * (1 - policy.gapPct / 100)) return null

  // Only the minutes of THIS dip. A low from before the last buy belongs to a
  // dip the ladder has already bought.
  const lows: number[] = []
  for (let i = 0; i < bars.time.length; i++) {
    if (bars.time[i]! > last.time) lows.push(bars.low[i]!)
  }
  if (lows.length < policy.floorBars + 1) return null

  const floor = Math.min(...lows.slice(0, lows.length - policy.floorBars))
  const since = Math.min(...lows.slice(lows.length - policy.floorBars))
  return since >= floor ? buys.length : null
}
