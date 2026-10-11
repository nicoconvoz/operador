import { buildDashboard } from '../../../../src/application/dashboard.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * The dashboard's numbers as JSON, from the engine's published state — the
 * same file every other endpoint reads. No database.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const view = await buildDashboard(openStore(), { now: () => Date.now() })
    return Response.json(view, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
