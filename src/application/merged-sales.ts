/**
 * One sale is one line on the tape.
 *
 * *Cuando hagas la venta de cada DCA no lo vendas todo por separado: una sola
 * venta que los englobe a todos los de ese token* (2026-10-14). The broker
 * already sells a whole position in ONE swap, with ONE gas charge and the
 * impact measured on the total; what it records is one fill per buy it closed,
 * because each keeps its own basis and its own result. On a thirty-buy ladder
 * that was thirty lines on the screen for one sale.
 *
 * So the READERS fold them: the fills of one position that share an instant
 * and a side of `sell` become one row — the quantities, the costs and the
 * results added up, the price weighted by quantity. The stored fills are
 * untouched, so recovery, the ledger and the broker's own seed read exactly
 * what they always did. Buys are never folded.
 */

interface SaleRow {
  readonly positionId: string
  readonly time: number
  readonly side: 'buy' | 'sell'
  readonly price: number
  readonly qty: number
  readonly costUsd: number
  readonly idempotencyKey: string
  readonly orderId: string
  readonly realisedUsd?: number | null
}

/** What a folded sale is called on the tape: it closed several buys at once. */
export const MERGED_SALE_ORDER = 'Venta'

export function mergeSales<R extends SaleRow>(rows: readonly R[]): R[] {
  const out: R[] = []
  const saleAt = new Map<string, number>()
  for (const row of rows) {
    if (row.side !== 'sell') {
      out.push(row)
      continue
    }
    const key = `${row.positionId}@${row.time}`
    const at = saleAt.get(key)
    if (at === undefined) {
      saleAt.set(key, out.length)
      out.push(row)
      continue
    }
    const first = out[at]!
    const qty = first.qty + row.qty
    const made =
      first.realisedUsd === null || first.realisedUsd === undefined || row.realisedUsd === null || row.realisedUsd === undefined
        ? first.realisedUsd ?? row.realisedUsd ?? null
        : first.realisedUsd + row.realisedUsd
    out[at] = {
      ...first,
      qty,
      price: qty > 0 ? (first.price * first.qty + row.price * row.qty) / qty : first.price,
      costUsd: first.costUsd + row.costUsd,
      orderId: MERGED_SALE_ORDER,
      ...('realisedUsd' in first || 'realisedUsd' in row ? { realisedUsd: made } : {}),
    }
  }
  return out
}
