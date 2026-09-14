import { createServer } from 'node:http'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { StoredAlertSink } from '../infrastructure/notifications/store-alerts.js'
import { buildPhoneStatus } from '../application/phone-status.js'
import { authoriseControl } from '../application/control-api.js'
import { engageKillSwitch, disengageKillSwitch, killSwitchStatus } from '../application/kill-switch.js'
import { alert, type AlertKind } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'

/**
 * The phone API, backed by memory instead of Postgres.
 *
 * The Android app needs something to talk to before a database exists, and a
 * hand-rolled fake would test the fake. This runs the REAL read models, the
 * REAL authorisation and the REAL kill switch against `MemoryStore` — so what
 * it proves about the app transfers, and the only thing not exercised is the
 * SQL.
 *
 * It is labelled DEMO in every response it can be, and it invents an alert
 * every so often, because an alerting channel you cannot watch arrive is a
 * channel you have not tested.
 */

const PORT = Number.parseInt(process.env.PORT ?? '3101', 10)
/**
 * Where the browser half lives. Derived from whichever host the CLIENT used
 * to reach us, not hardcoded: a phone that connects to 10.0.2.2 or to a LAN
 * address cannot follow a redirect to `localhost`, because on a phone
 * localhost is the phone.
 */
const DASHBOARD_PORT = process.env.OPERADOR_DASHBOARD_PORT ?? '3100'
const dashboardFor = (host: string): string =>
  process.env.OPERADOR_DASHBOARD_URL ?? `http://${host.split(':')[0]}:${DASHBOARD_PORT}/demo`
const TOKEN = process.env.OPERADOR_CONTROL_TOKEN ?? 'demo-token-not-for-real-money'
const ALERT_EVERY_MS = Number.parseInt(process.env.OPERADOR_DEMO_ALERT_MS ?? '45000', 10)

const store = new MemoryStore()
const alerts = new StoredAlertSink(store, (error) => console.error('[demo]', error))

const position = (symbol: string, frozen = false): PersistedPosition => ({
  id: `pos-${symbol}`,
  chain: symbol === 'TROLL' ? 'bsc' : 'solana',
  tokenAddress: symbol,
  pairAddress: `pair-${symbol}`,
  symbol,
  cascade: { ...initialState(), level: 3, ep1: 0.01, wasInTrade: true },
  deathWatch: { ...startDeathWatch(250_000, Date.now()), stage: frozen ? 'frozen' : 'healthy' },
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.4, referenceUsd: 100, observedAt: Date.now() },
  capitalUsd: 200,
  lastBarTime: Date.now(),
  lastPriceUsd: 0.011,
  pendingOrders: [],
  openedAt: Date.now() - 90 * 60_000,
  updatedAt: Date.now(),
})

/** A rotation that covers every level the phone treats differently. */
const SCRIPT: ReadonlyArray<readonly [AlertKind, string, string]> = [
  ['dca-filled', 'DREGG · DCA-3 ejecutada', '$18.00 a 0.009412 — nivel 3 de 10'],
  ['ladder-frozen', 'LEAFY · escalera congelada', 'La liquidez cayó al 38% de su profundidad al entrar. No entra capital nuevo.'],
  ['death-exit', 'TROLL · SALIDA POR MUERTE', 'La cotización de venta no encontró ruta en 3 chequeos seguidos. Posición liquidada, token en lista negra.'],
  ['heartbeat', 'Ciclo completo', '2 posiciones · 48 tokens escaneados · no se abrió nada'],
  ['position-halted', 'DREGG · DETENIDA', 'Una orden estaba en vuelo al reiniciar y el mercado no puede confirmarla. Necesita un humano.'],
  ['scan-empty', 'El escaneo no encontró nada', '0 de 217 tokens pasaron los filtros en este ciclo.'],
]

async function seed(): Promise<void> {
  await store.savePosition(position('DREGG'))
  await store.savePosition(position('LEAFY', true))
  await store.saveCheckpoint({ savedAt: Date.now(), lastCompletedBar: Date.now(), killSwitchEngaged: false })
  await alerts.send(alert('engine-started', 'Motor iniciado', 'Servidor DEMO — solo memoria, sin dinero', Date.now()))
}

let scriptIndex = 0
async function inventAlert(): Promise<void> {
  const [kind, title, body] = SCRIPT[scriptIndex % SCRIPT.length]!
  scriptIndex += 1
  await alerts.send(alert(kind, title, body, Date.now(), { demo: true }))
  await store.saveCheckpoint({ savedAt: Date.now(), lastCompletedBar: Date.now(), killSwitchEngaged: (await killSwitchStatus(store)).engaged })
  console.log(`[demo] alert #${scriptIndex}: ${title}`)
}

const json = (body: unknown, status = 200): { status: number; body: string } => ({ status, body: JSON.stringify(body) })

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const send = (result: { status: number; body: string }): void => {
      response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(result.body)
    }

    try {
      if (url.pathname === '/api/phone') {
        return send(json(await buildPhoneStatus(store, { now: () => Date.now() })))
      }

      if (url.pathname === '/api/alerts') {
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200)
        const page = await store.alertsSince(since, limit)
        return send(json({ alerts: page, cursor: page.at(-1)?.seq ?? since }))
      }

      if (url.pathname === '/api/control') {
        if (request.method === 'GET') return send(json(await killSwitchStatus(store)))

        const verdict = authoriseControl(TOKEN, request.headers.authorization ?? null, { fromHeader: true })
        if (!verdict.ok) return send(json({ error: verdict.reason }, verdict.status))

        const body = await readBody(request)
        const action = (JSON.parse(body || '{}') as { action?: string }).action
        if (action === 'kill') await engageKillSwitch(store, alerts, 'manual', 'detenido desde el teléfono (demo)', Date.now())
        else if (action === 'resume') await disengageKillSwitch(store, alerts, Date.now())
        else return send(json({ error: "action must be 'kill' or 'resume'" }, 400))

        return send(json(await killSwitchStatus(store)))
      }

      // Anything else is the human-facing half: hand it to the dashboard.
      response.writeHead(302, { location: dashboardFor(request.headers.host ?? 'localhost') })
      response.end()
    } catch (error) {
      send(json({ error: String(error).slice(0, 200) }, 500))
    }
  })()
})

const readBody = (request: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => resolve(body))
  })

await seed()
setInterval(() => void inventAlert(), ALERT_EVERY_MS)

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[demo] phone API on http://0.0.0.0:${PORT} — DEMO DATA, memory only`)
  console.log(`[demo] control token: ${TOKEN}`)
  console.log(`[demo] a new alert every ${Math.round(ALERT_EVERY_MS / 1000)}s`)
})
