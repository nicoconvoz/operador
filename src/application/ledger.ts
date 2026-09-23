import { type PersistedFill } from '../domain/persistence/store.js'

/**
 * What a position holds and what it has made, walked forward through its fills.
 *
 * ONE implementation, because three things need the answer and any two of them
 * disagreeing is how a trading dashboard starts lying: the screen reports it,
 * the allocator decides how much capital is genuinely spoken for by it, and the
 * common fund is built from it. CLAUDE.md's rule about the numbers living in
 * one place applies hardest here — this is the place.
 *
 * Average-cost accounting, which is what the broker itself reports, so the
 * screen and the strategy can never disagree about what a position cost.
 *
 * A WALK rather than sums, and that is the whole correctness argument. Totalling
 * every buy ever made counts entries that were already sold, so a position that
 * closed once and re-entered reports twice the capital it holds — and dividing
 * that blend by every unit ever bought produces a cost basis the position never
 * paid, which then feeds the unrealised number.
 *
 * A sale realises against the basis at that moment and LEAVES the basis
 * unchanged for what remains, which is precisely why the two can be separated.
 */

export interface PositionLedger {
  /** Units still held. Zero means flat — it may still have traded. */
  readonly qty: number
  /** Cost basis of what is STILL held, not of everything ever bought. */
  readonly deployedUsd: number
  readonly avgCostUsd: number | null
  /** Profit already banked by sales, at the basis those sales left behind. */
  readonly realisedUsd: number
  /** Spread, impact and gas charged on every fill so far. */
  readonly costsUsd: number
  /** Whether anything was ever bought. Different from `qty > 0`. */
  readonly hasFills: boolean
}

export const EMPTY_LEDGER: PositionLedger = {
  qty: 0, deployedUsd: 0, avgCostUsd: null, realisedUsd: 0, costsUsd: 0, hasFills: false,
}

/**
 * What each individual SALE made, keyed by the fill's idempotency key.
 *
 * The tape showed a sale with its price and its size and nothing about whether
 * it was a win — which is the one thing a reader wants from a line that says
 * VENTA. The walk that answers it already existed: `positionLedger` computes
 * exactly this for the position as a whole and simply threw the per-sale
 * figure away.
 *
 * Grouped per position, because realised profit is defined against a cost basis
 * and a basis only means anything inside one position's own history. A sale in
 * one token priced against another's average cost is not a smaller error than
 * no number at all; it is a confident wrong one.
 *
 * Costs are NOT subtracted here. The tape already shows what the chain took as
 * its own column, and taking it off twice would make every line disagree with
 * the total beside it.
 */
export function realisedBySell(fills: readonly PersistedFill[]): ReadonlyMap<string, number> {
  const byPosition = new Map<string, PersistedFill[]>()
  for (const fill of fills) {
    const existing = byPosition.get(fill.positionId)
    if (existing) existing.push(fill)
    else byPosition.set(fill.positionId, [fill])
  }

  const made = new Map<string, number>()
  for (const positionFills of byPosition.values()) {
    let qty = 0
    let basisUsd = 0
    for (const fill of [...positionFills].sort((a, b) => a.time - b.time)) {
      if (fill.side === 'buy') {
        qty += fill.qty
        basisUsd += fill.price * fill.qty
        continue
      }
      // The same cap as the ledger: a sale is the moment to be careful rather
      // than clever, so a bad fill cannot invent profit out of thin air.
      const sold = Math.min(fill.qty, qty)
      if (sold <= 0) continue
      const avg = basisUsd / qty
      made.set(fill.idempotencyKey, sold * (fill.price - avg))
      basisUsd -= sold * avg
      qty -= sold
    }
  }
  return made
}

export function positionLedger(fills: readonly PersistedFill[]): PositionLedger {
  if (fills.length === 0) return EMPTY_LEDGER

  let qty = 0
  let basisUsd = 0
  let realisedUsd = 0
  let costsUsd = 0

  for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
    costsUsd += fill.costUsd

    if (fill.side === 'buy') {
      qty += fill.qty
      basisUsd += fill.price * fill.qty
      continue
    }

    // Selling more than the record says is held cannot come from our own
    // orders, but a sale is the moment to be careful rather than clever: cap
    // it, so a bad fill cannot invent profit out of a negative position.
    const sold = Math.min(fill.qty, qty)
    if (sold <= 0) continue
    const avg = basisUsd / qty
    realisedUsd += sold * (fill.price - avg)
    basisUsd -= sold * avg
    qty -= sold
  }

  // Floating point leaves crumbs after a full exit; a basis of 1e-17 on zero
  // units is not a cost, it is noise.
  if (qty <= 0) return { qty: 0, deployedUsd: 0, avgCostUsd: null, realisedUsd, costsUsd, hasFills: true }
  return { qty, deployedUsd: basisUsd, avgCostUsd: basisUsd / qty, realisedUsd, costsUsd, hasFills: true }
}

/**
 * The common fund: money the system has made, over and above what it started
 * with, available to open new positions.
 *
 * Built from EVERY fill, including those of positions that have since closed —
 * which is most of it. `fills` has no foreign key to `positions` for exactly
 * this reason.
 *
 * Costs are subtracted, and that is not a refinement. They were paid in cash,
 * at the moment of each fill; a fund built on gross profit would be handing the
 * allocator dollars the chain already took. On small caps that is the single
 * largest way a strategy that looks profitable is not.
 */
export interface CommonFund {
  readonly realisedUsd: number
  readonly costsUsd: number
  /** What is actually spendable: realised minus what the chain took. */
  readonly netUsd: number
}

export function commonFund(fills: readonly PersistedFill[]): CommonFund {
  const byPosition = new Map<string, PersistedFill[]>()
  for (const fill of fills) {
    const existing = byPosition.get(fill.positionId)
    if (existing) existing.push(fill)
    else byPosition.set(fill.positionId, [fill])
  }

  let realisedUsd = 0
  let costsUsd = 0
  // Per position, because realised profit is defined against a cost basis and
  // a basis only means anything within one position's own history.
  for (const positionFills of byPosition.values()) {
    const ledger = positionLedger(positionFills)
    realisedUsd += ledger.realisedUsd
    costsUsd += ledger.costsUsd
  }

  return { realisedUsd, costsUsd, netUsd: realisedUsd - costsUsd }
}

/**
 * What one token has made across EVERY position it ever had, net of costs.
 *
 * The operator: *tener en cuenta la ganancia total del token a lo largo del
 * tiempo, y si la ganancia es mayor a la pérdida también SL y rotar; si no, no
 * salir en pérdida.* A loss the token has already paid for out of its own
 * winnings leaves it still ahead; one it has not is a loss the book eats.
 *
 * A position id is `chain:address:openedAt`, and fills deliberately outlive
 * their positions, so the token's whole history is still on the tape. The
 * open position counts too: its buy fees are already spent.
 */
export function tokenNetUsd(fills: readonly PersistedFill[], chain: string, address: string): number {
  const prefix = `${chain}:${address}:`
  const byPosition = new Map<string, PersistedFill[]>()
  for (const fill of fills) {
    if (!fill.positionId.startsWith(prefix)) continue
    byPosition.set(fill.positionId, [...(byPosition.get(fill.positionId) ?? []), fill])
  }
  let net = 0
  for (const own of byPosition.values()) {
    const ledger = positionLedger(own)
    net += ledger.realisedUsd - ledger.costsUsd
  }
  return net
}

/**
 * The fees paid on the round trip still OPEN: every fill since the position
 * was last flat. Zero when it holds nothing.
 *
 * The floor a winner must clear before a swap or a rotation may sell it is
 * what THIS round trip cost. A position that sold once and bought back paid
 * its old fees out of the old sale, and counting them again would hold a
 * winner for a debt it no longer owes.
 */
export function openLotCostsUsd(fills: readonly PersistedFill[]): number {
  let qty = 0
  let costs = 0
  for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
    if (fill.side === 'buy') {
      qty += fill.qty
      costs += fill.costUsd
      continue
    }
    qty -= Math.min(fill.qty, qty)
    if (qty <= 0) costs = 0
  }
  return qty > 0 ? costs : 0
}
