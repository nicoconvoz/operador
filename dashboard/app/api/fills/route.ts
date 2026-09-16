import { fillsCsv } from '../../../../src/application/fills-csv.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * The whole tape, as a file.
 *
 * The screen shows the last ten fills, because a phone rendering every buy and
 * sell since the engine started renders none of them usefully. This is where
 * the rest lives — the audit trail, and the only complete record of what the
 * system actually did.
 *
 * Read-only, like every other route here except the control one. It cannot
 * place, size or close anything: it hands over what already happened.
 *
 * Symbols come from the OPEN positions, and most rows will not find one —
 * `fills` deliberately has no foreign key to `positions`, so a closed
 * position's history survives it leaving the working set. Those rows carry the
 * position id instead of a blank.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const store = openStore()
    const [fills, positions] = await Promise.all([store.allFills(), store.loadPositions()])
    const symbols = new Map(positions.map((p) => [p.id, p.symbol]))

    const stamp = new Date().toISOString().slice(0, 10)
    return new Response(fillsCsv(fills, (id) => symbols.get(id) ?? null), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="operador-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    return failed(error)
  }
}
