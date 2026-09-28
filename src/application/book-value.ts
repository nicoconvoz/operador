import { commonFund, positionLedger, type PositionLedger } from './ledger.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'

/**
 * What the book is worth, and the one answer to "are we ahead".
 *
 * Two readers need the headline figure — cobrada + sin cobrar − costos — and
 * they must never compute it twice: the SCREEN draws it every ten seconds, and
 * the ENGINE writes it into the day log every cycle. If those were two
 * implementations, the Log would one day record a number the headline never
 * showed, and the one on the screen is the one the operator believes. This
 * project has paid for that drift at every seam it has; here it is one
 * function with two callers.
 */

export interface PositionValue extends PositionLedger {
  /** The price it is valued at: the market's now when there is one, else the last bar close. */
  readonly priceUsd: number | null
  /** Whether `priceUsd` is the live market price or the last closed bar's. */
  readonly priceIsLive: boolean
  readonly marketValueUsd: number | null
  /** What the tokens still held are worth over what they cost. Null when flat or unpriced. */
  readonly unrealisedUsd: number | null
}

/**
 * One position, valued.
 *
 * At the LIVE price when one came back, because the figure is what the book is
 * WORTH and that moves continuously; at the last bar close otherwise, and the
 * result says which. A zero is not a price — letting it through would value the
 * position at nothing.
 *
 * `livePrices` is keyed `chain:tokenAddress`, the way both the screen's feed and
 * the engine's `marketPrices` key it.
 */
export function valuePosition(
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  livePrices: ReadonlyMap<string, number>,
): PositionValue {
  const ledger = positionLedger(fills)
  const live = livePrices.get(`${position.chain}:${position.tokenAddress}`)
  const priceIsLive = live !== undefined && live > 0
  const priceUsd = priceIsLive ? live : position.lastPriceUsd
  const marketValueUsd = priceUsd !== null && ledger.qty > 0 ? ledger.qty * priceUsd : null
  const unrealisedUsd =
    marketValueUsd !== null && priceUsd !== null && ledger.avgCostUsd !== null ? (priceUsd - ledger.avgCostUsd) * ledger.qty : null
  return { ...ledger, priceUsd, priceIsLive, marketValueUsd, unrealisedUsd }
}

/**
 * The headline: realised + unrealised − costs.
 *
 * Realised and costs from EVERY fill ever recorded — positions that closed and
 * left the working set included, which is most of the money — through the same
 * walk the allocator's common fund uses. Unrealised from the positions still
 * open, each valued by `valuePosition`.
 */
export function bookNetUsd(
  positions: readonly PersistedPosition[],
  allFills: readonly PersistedFill[],
  livePrices: ReadonlyMap<string, number>,
): number {
  const byPosition = new Map<string, PersistedFill[]>()
  for (const fill of allFills) {
    const own = byPosition.get(fill.positionId)
    if (own) own.push(fill)
    else byPosition.set(fill.positionId, [fill])
  }
  const unrealisedUsd = positions.reduce(
    (sum, position) => sum + (valuePosition(position, byPosition.get(position.id) ?? [], livePrices).unrealisedUsd ?? 0),
    0,
  )
  return commonFund(allFills).netUsd + unrealisedUsd
}
