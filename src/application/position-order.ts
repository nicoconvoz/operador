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
