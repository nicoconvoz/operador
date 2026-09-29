/**
 * Operaciones opens the book fifty positions at a time.
 *
 * *Armame un paginado para abrir de a 50 tokens y que no se trabe nada.* The
 * operator, with a book heading for 250 positions: every card on one screen is
 * a phone that stalls on each ten-second poll.
 *
 * A page past the end is clamped to the last one rather than drawn empty — a
 * sale can shrink the book while somebody is reading page five — and an empty
 * book is one empty page, never a division by zero. `from` and `to` are
 * 1-based, as the screen prints them.
 */
export const PAGE_SIZE = 50

export interface Page<T> {
  readonly items: readonly T[]
  /** 0-based, clamped into range. */
  readonly page: number
  readonly pages: number
  readonly from: number
  readonly to: number
  readonly total: number
}

export function pageOf<T>(items: readonly T[], page: number, size: number = PAGE_SIZE): Page<T> {
  const total = items.length
  const pages = Math.max(1, Math.ceil(total / size))
  const at = Math.min(pages - 1, Math.max(0, Math.floor(page)))
  const start = at * size
  const shown = items.slice(start, start + size)
  return { items: shown, page: at, pages, from: total === 0 ? 0 : start + 1, to: start + shown.length, total }
}
