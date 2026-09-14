import { openStore, failed } from '../../../lib/store.js'

/**
 * The alert feed the phone reads.
 *
 * A cursor, not a push. The app passes the last sequence it actually received
 * and gets what came after — so an app that was asleep for six hours catches
 * up instead of finding an empty pipe, which is exactly what Telegram gave us
 * when the phone was off.
 */
export const dynamic = 'force-dynamic'

const MAX_PAGE = 200

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams
    const since = Number.parseInt(params.get('since') ?? '0', 10)
    const limit = Number.parseInt(params.get('limit') ?? '50', 10)

    const store = openStore()
    const alerts = await store.alertsSince(
      Number.isFinite(since) && since > 0 ? since : 0,
      Math.min(Number.isFinite(limit) && limit > 0 ? limit : 50, MAX_PAGE),
    )

    return Response.json(
      // `cursor` is what the caller should send next time. Echoing it beats
      // making every client re-derive it from the last element — and a client
      // that derives it wrong silently replays or skips alerts.
      { alerts, cursor: alerts.at(-1)?.seq ?? (since > 0 ? since : 0) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return failed(error)
  }
}
