import { authoriseControl } from '../../../../src/application/control-api.js'
import { killSwitchStatus } from '../../../../src/application/kill-switch.js'
import { controlOrderFrom } from '../../../../src/application/state-sync.js'
import { GitHubPublisher } from '../../../../src/infrastructure/adapters/github/github-publisher.js'
import { openStore, failed, STATE_REPO } from '../../../lib/store.js'

/**
 * The ONLY write path in the entire system.
 *
 * It earns that exception by being narrow: it can stop the engine from opening
 * new positions, release that stop, and — *un botón que borre y empiece de
 * cero, con confirmación* — wipe the book and start from zero. It cannot place
 * an order, size one or close one, and it never touches a wallet.
 *
 * It writes an ORDER, not the state: `control.json` on the `control` branch,
 * which the engine reads after every pass and applies once. The state itself
 * has one writer, the engine. So an order takes effect on the engine's next
 * pass, a minute or two, and the screen shows it once the engine has
 * published.
 *
 * Authorisation fails CLOSED. With no token configured this endpoint refuses
 * everything, because "we forgot to set it" and "anyone may stop the engine"
 * must not be the same state. Writing to GitHub needs `GITHUB_TOKEN` in
 * Vercel — a token allowed to write this repository's contents.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const verdict = authoriseControl(process.env.OPERADOR_CONTROL_TOKEN, request.headers.get('authorization'), {
    fromHeader: true,
  })
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: verdict.status })

  const token = process.env.GITHUB_TOKEN?.trim()
  if (!token) return Response.json({ error: 'falta GITHUB_TOKEN en Vercel' }, { status: 503 })

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const order = controlOrderFrom(body, Date.now())
    if ('error' in order) return Response.json({ error: order.error }, { status: 400 })

    await new GitHubPublisher({ repo: STATE_REPO, branch: 'control', token }).publish(
      {
        'control.json': JSON.stringify(order),
        // The control branch is pushed too: no deploys from it either.
        'vercel.json': '{ "git": { "deploymentEnabled": false } }\n',
        'dashboard/vercel.json': '{ "git": { "deploymentEnabled": false } }\n',
      },
      `control ${order.action} ${new Date(order.at).toISOString()}`,
    )
    return Response.json({ ok: true, order, pending: true }, { headers: { 'cache-control': 'no-store' } })
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
