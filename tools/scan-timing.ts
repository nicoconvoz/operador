/**
 * Where does a scan's time actually go? The REAL `scanOnce`, cold, timed.
 *
 * The operator: *revisar las monedas se hace súper lento y en realidad es
 * súper rápido... es una consulta de unos segundos y la estamos haciendo
 * demorar más de veinte minutos. No necesitamos toda la info, sólo lo
 * primordial.*
 *
 * Before cutting anything, count it. This builds the scanner exactly as
 * `main.ts` does — same adapters, same hedging, same throttles, same gates,
 * the production config from `loadConfig` — minus the store. No store means no
 * caches, which is precisely the case he lives in: every relaunch follows a
 * truncate, so every first scan is the cold one.
 *
 * It records every HTTP request (host, duration, status) and stamps every
 * progress event, then prints two tables: the stages in wall-clock order, and
 * each provider's share of the calls, the waiting and the refusals.
 *
 *   npx tsx tools/scan-timing.ts
 */
import { makeHttpGet, type HttpGet } from '../src/infrastructure/http.js'
import { makeHedgedGet } from '../src/infrastructure/hedged-get.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal, barMinutes } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { GoPlus } from '../src/infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../src/infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { SolanaMints } from '../src/infrastructure/adapters/solana/mint-facts.js'
import { scanOnce } from '../src/application/scan.js'
import { DEFAULT_GATE_POLICY, minAgeForHistory } from '../src/domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../src/domain/scanner/opportunity.js'
import { DEFAULT_COMPONENT_FLOORS } from '../src/application/production-doors.js'
import { loadConfig } from '../src/runtime/config.js'

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://timing:only@localhost/none' })

interface Call { host: string; ms: number; status: number }
const calls: Call[] = []
const raw = makeHttpGet({ timeoutMs: 20_000 })
const timed: HttpGet = async (url, init) => {
  const started = Date.now()
  let status = 0
  try {
    const response = await raw(url, init)
    status = response.status
    return response
  } catch (error) {
    status = -1
    throw error
  } finally {
    calls.push({ host: new URL(url).host, ms: Date.now() - started, status })
  }
}
const hedged = () => makeHedgedGet(timed)

const jupiterThrottle = makeAdaptiveThrottle()
const dex = new DexScreener(hedged())
const goplus = new GoPlus(hedged())
const jupiter = new Jupiter(hedged(), jupiterThrottle)
const jupiterTokens = new JupiterTokens(timed, jupiterThrottle)
const gecko = new GeckoTerminal(hedged(), makeAdaptiveThrottle())
void gecko
void goplus
const postJson = async (url: string, body: unknown) => {
  const started = Date.now()
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  calls.push({ host: new URL(url).host, ms: Date.now() - started, status: r.status })
  return { status: r.status, json: () => r.json() as Promise<unknown> }
}
const solanaMints = new SolanaMints(config.solanaRpcUrl, postJson)

const gates = {
  ...DEFAULT_GATE_POLICY,
  minAgeHours: Math.max(
    DEFAULT_GATE_POLICY.minAgeHours,
    minAgeForHistory(DEFAULT_GATE_POLICY.minHistoryBars, barMinutes(config.barSize)),
  ),
}

const t0 = Date.now()
const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const stamps: { at: number; stage: string; detail: string }[] = []

const result = await scanOnce(
  {
    dex,
    // Exactly as production wires Solana now: Jupiter and the chain, no GoPlus.
    onChain: solanaMints,
    prefetch: async (_chain, addresses) => { await Promise.all([jupiterTokens.prefetch(addresses), solanaMints.prefetch(addresses)]) },
    sellProbe: jupiter,
    decimals: {
      decimals: (chain, address) => jupiterTokens.decimals(chain, address),
      security: (chain, address) => jupiterTokens.security(chain, address),
      discover: () => jupiterTokens.discover(),
    },
    onProgress: (p) => {
      const { stage, ...rest } = p
      stamps.push({ at: Date.now() - t0, stage, detail: JSON.stringify(rest).slice(0, 90) })
      console.log(`  ${s(Date.now() - t0).padStart(7)}  [${stage}] ${JSON.stringify(rest).slice(0, 110)}`)
    },
  },
  {
    chain: 'solana',
    discover: true,
    ranking: {
      gates,
      opportunity: DEFAULT_OPPORTUNITY_POLICY,
      smallCapFdvUsd: 50_000_000,
      watchSlots: Number.POSITIVE_INFINITY,
      minScore: config.minScore,
      minComponents: DEFAULT_COMPONENT_FLOORS,
      requireRising: config.requireRising,
    },
    candleBudget: 67,
    maxBarAgeHours: 1,
    held: [],
    referenceUsd: 100,
    spreadPct: 0.3,
    maxTokens: 5_000,
  },
)
const total = Date.now() - t0

console.log()
console.log(`TOTAL ${s(total)} — ${result.snapshots.length} examinados/mercado, ${result.candidates.length} candidatos`)
console.log()
console.log('proveedor'.padEnd(26), 'llamadas'.padStart(9), 'tiempo'.padStart(9), 'prom'.padStart(7), '429'.padStart(5), 'fallas'.padStart(7))
const byHost = new Map<string, Call[]>()
for (const c of calls) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c])
for (const [host, list] of [...byHost].sort((a, b) => b[1].reduce((x, c) => x + c.ms, 0) - a[1].reduce((x, c) => x + c.ms, 0))) {
  const ms = list.reduce((x, c) => x + c.ms, 0)
  console.log(
    host.padEnd(26),
    String(list.length).padStart(9),
    s(ms).padStart(9),
    `${Math.round(ms / list.length)}ms`.padStart(7),
    String(list.filter((c) => c.status === 429).length).padStart(5),
    String(list.filter((c) => c.status < 0 || c.status >= 500).length).padStart(7),
  )
}
console.log()
console.log('Esperas por límite de tasa (medidas por los adaptadores):')
console.log('  goplus', JSON.stringify(goplus.rateLimit), '  gecko', JSON.stringify(gecko.rateLimit))
