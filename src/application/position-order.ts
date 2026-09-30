/**
 * The order Operaciones lists the book in: by name.
 *
 * *En Operaciones ordená los tokens alfabéticamente.* The operator. With the
 * book counted in the hundreds, a list in the order positions happened to be
 * stored is a list nobody can find a token in; by name, the eye goes straight
 * to it.
 *
 * Case is ignored and numbers read as numbers (TOKEN2 before TOKEN10). Two
 * positions on the same symbol keep a stable order by id, so a poll every ten
 * seconds never swaps them on screen. The input is never reordered in place.
 */
const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

export function alphabetical<T extends { readonly id: string; readonly symbol: string }>(positions: readonly T[]): T[] {
  return [...positions].sort((a, b) => collator.compare(a.symbol, b.symbol) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The three orders Operaciones offers. *Quiero un filtro por orden alfabético,
 * por mayor ganancia — o sea más cerca del 12.5% — y otro para las más
 * perdedoras, teniendo en cuenta la pérdida y el piso DCA más profundo.* The
 * operator.
 *
 * - `alphabetical` — by name, as the tab always listed it.
 * - `nearestTp` — the highest unrealised percent first: the closer to the
 *   +12.5% take-profit, the higher. A position with no price yet goes last.
 * - `losers` — the biggest loss in DOLLARS first. That figure already grows
 *   with every DCA, since each one puts five more dollars under water; on a
 *   tie the deeper ladder — more buys — goes first.
 *
 * Every mode falls back on the name, so a poll every ten seconds never swaps
 * two equal cards. The input is never reordered in place.
 */
export type PositionOrder = 'alphabetical' | 'nearestTp' | 'losers'

interface Sortable {
  readonly id: string
  readonly symbol: string
  readonly unrealisedPct: number | null
  readonly unrealisedUsd: number | null
  readonly steps?: { readonly bought: number } | null
}

const byName = (a: Sortable, b: Sortable) => collator.compare(a.symbol, b.symbol) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const pctOf = (p: Sortable) => (typeof p.unrealisedPct === 'number' && Number.isFinite(p.unrealisedPct) ? p.unrealisedPct : Number.NEGATIVE_INFINITY)

export function sortPositions<T extends Sortable>(positions: readonly T[], order: PositionOrder): T[] {
  const sorted = [...positions]
  if (order === 'nearestTp') {
    return sorted.sort((a, b) => (pctOf(b) === pctOf(a) ? 0 : pctOf(b) > pctOf(a) ? 1 : -1) || byName(a, b))
  }
  if (order === 'losers') {
    // No price yet is no loss yet.
    return sorted.sort((a, b) => (a.unrealisedUsd ?? 0) - (b.unrealisedUsd ?? 0) || (b.steps?.bought ?? 0) - (a.steps?.bought ?? 0) || byName(a, b))
  }
  return sorted.sort(byName)
}
