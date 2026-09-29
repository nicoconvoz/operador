import { fillsCsv, fillsForToken, fillsInRange, tokenFileTag } from '../../../../src/application/fills-csv.js'
import { knownSymbols, normaliseTokenQuery } from '../../../../src/application/token-search.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * The whole tape, as a file.
 *
 * The screen shows the last thirty fills, because a phone rendering every buy and
 * sell since the engine started renders none of them usefully. This is where
 * the rest lives — the audit trail, and the only complete record of what the
 * system actually did.
 *
 * Read-only, like every other route here except the control one. It cannot
 * place, size or close anything: it hands over what already happened.
 *
 * Symbols come from the OPEN positions — by id, and failing that by the token
 * a closed position shares with one still open — and most rows will not find
 * one: `fills` deliberately has no foreign key to `positions`, so a closed
 * position's history survives it leaving the working set. Those rows carry the
 * position id instead of a blank.
 *
 * `token` narrows it to what the search box holds, with the same matcher every
 * tab uses, and composes with the dates: both apply. Blank or absent is no
 * filter, the way an untouched date is no bound.
 */
export const dynamic = 'force-dynamic'

/**
 * `2026-09-10` from a date input, or null when absent.
 *
 * A parameter that is PRESENT and unreadable is rejected rather than ignored:
 * quietly dropping it would hand back a file the operator believes is filtered,
 * and a wrong export is worse than a refused one when the thing exported is the
 * audit trail.
 */
function day(raw: string | null): number | null | 'bad' {
  if (raw === null || raw.trim() === '') return null
  const at = Date.parse(`${raw.trim()}T00:00:00Z`)
  return Number.isFinite(at) ? at : 'bad'
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams
    const from = day(params.get('from'))
    const to = day(params.get('to'))
    if (from === 'bad' || to === 'bad') {
      return new Response('Fecha inválida. Usá el formato AAAA-MM-DD.', { status: 400 })
    }

    const token = normaliseTokenQuery(params.get('token'))

    const store = openStore()
    const [all, positions] = await Promise.all([store.allFills(), store.loadPositions()])
    // One name per position, the same one the Registro draws, for the column
    // and for the search alike.
    const symbolFor = knownSymbols({ positions })
    const fills = fillsForToken(fillsInRange(all, from, to), token, symbolFor)

    // The file says WHICH range it holds, and which token. A folder of exports
    // all called `operador-<today>.csv` is a folder nobody can tell apart a week
    // later.
    const stamp = from === null && to === null
      ? new Date().toISOString().slice(0, 10)
      : `${from === null ? 'inicio' : new Date(from).toISOString().slice(0, 10)}_a_${to === null ? 'hoy' : new Date(to).toISOString().slice(0, 10)}`
    const tag = tokenFileTag(token)
    return new Response(fillsCsv(fills, symbolFor), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="operador-${tag === '' ? '' : `${tag}-`}${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    return failed(error)
  }
}
