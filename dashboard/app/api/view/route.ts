import { buildDashboard } from '../../../../src/application/dashboard.js'
import { buildUniverse } from '../../../../src/application/universe-view.js'
import { DEFAULT_PARAMS } from '../../../../src/domain/strategy/params.js'
import { productionLadder } from '../../../../src/application/production-ladder.js'
import { buildOperations } from '../../../../src/application/operations-view.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * Everything the screen shows, in one request.
 *
 * The page used to be reloaded to refresh it, which wiped the canvas, reset
 * every orbit and dropped whatever the viewer had selected — a flinch once a
 * minute that told them nothing. Now the page fetches this and swaps the data
 * underneath itself.
 *
 * One request rather than three: three would arrive at three different moments
 * and the screen would show a position that exists in one panel and not the
 * other. A single read is a single instant.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const store = openStore()
    const now = () => Date.now()
    const ladder = productionLadder(process.env)
    const [dashboard, universe, operations] = await Promise.all([
      buildDashboard(store, { now }),
      buildUniverse(store, { now }),
      buildOperations(store, {
        now,
        // The ladder the ENGINE runs, not the reference's. Drawing
        // DEFAULT_PARAMS put a $1,000 rung beside a $15 order for days.
        params: { ...DEFAULT_PARAMS, maxUsdPerLevel: ladder.maxUsdPerLevel },
        maxOpenEntries: ladder.maxOpenEntries,
        // THIRTY, for the Registro tab. The tape grows without bound and the
        // screen does not: a page listing every buy and sell since the engine
        // started is a page nobody can read the top of, and on a phone that is
        // the whole page. The rest is a file — /api/fills, with a date range —
        // rather than deleted from view.
        tapeLength: 30,
      }),
    ])
    return Response.json({ dashboard, universe, operations }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
