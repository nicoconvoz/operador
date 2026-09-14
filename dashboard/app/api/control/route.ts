import { authoriseControl } from '../../../../src/application/control-api.js'
import { engageKillSwitch, disengageKillSwitch, killSwitchStatus } from '../../../../src/application/kill-switch.js'
import { StoredAlertSink } from '../../../../src/infrastructure/notifications/store-alerts.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * The ONLY write path in the entire system.
 *
 * It earns that exception by being one-way safe: it can stop the engine from
 * opening new positions, and it can release that stop. It cannot place an
 * order, size one, close one, or touch a wallet. A control surface that could
 * trade would be a second attack surface on the money, guarded by a URL people
 * paste into chats.
 *
 * Authorisation fails CLOSED. With no token configured this endpoint refuses
 * everything, because "we forgot to set it" and "anyone may stop the engine"
 * must not be the same state.
 */
export const dynamic = 'force-dynamic'

type Action = 'kill' | 'resume'

export async function POST(request: Request): Promise<Response> {
  const verdict = authoriseControl(process.env.OPERADOR_CONTROL_TOKEN, request.headers.get('authorization'), {
    fromHeader: true,
  })
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: verdict.status })

  try {
    const body = (await request.json().catch(() => ({}))) as { action?: Action; detail?: string }
    if (body.action !== 'kill' && body.action !== 'resume') {
      return Response.json({ error: "action must be 'kill' or 'resume'" }, { status: 400 })
    }

    const store = openStore()
    // Routed through the same alert log the engine writes to, so the phone
    // sees its own action arrive the same way it sees a death exit — and so
    // the audit trail records that a human stopped this, not a loss limit.
    const alerts = new StoredAlertSink(store, (error) => console.error('[control]', error))
    const now = Date.now()

    if (body.action === 'kill') {
      await engageKillSwitch(store, alerts, 'manual', body.detail?.slice(0, 200) ?? 'stopped from the phone', now)
    } else {
      await disengageKillSwitch(store, alerts, now)
    }

    return Response.json(await killSwitchStatus(store), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}

/** Reading the switch needs no token: it is already on the dashboard. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await killSwitchStatus(openStore()), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
