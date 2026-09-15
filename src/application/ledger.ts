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
