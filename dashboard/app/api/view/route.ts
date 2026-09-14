import { buildDashboard } from '../../../../src/application/dashboard.js'
import { buildUniverse } from '../../../../src/application/universe-view.js'
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
    const [dashboard, universe, operations] = await Promise.all([
      buildDashboard(store, { now }),
      buildUniverse(store, { now }),
      buildOperations(store, { now }),
    ])
    return Response.json({ dashboard, universe, operations }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
