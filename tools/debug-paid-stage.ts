/**
 * Who kills the 60? The paid stage, run locally, counted by cause.
 *
 * A live run reported 72 tokens clearing the free gates and 12 becoming
 * candidates, with only 2 of the 60 lost to errors. The other 58 were refused
 * by something the engine no longer records — `worthStoring` stopped
 * persisting rejections — so the funnel's largest cut is the one nobody can
 * see.
 *
 *   npx tsx tools/debug-paid-stage.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { GoPlus } from '../src/infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../src/infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { evaluateGates, evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { scoreOpportunity, meetsMinimums, DEFAULT_OPPORTUNITY_POLICY } from '../src/domain/scanner/opportunity.js'
import { estimatePriceImpactPct } from '../src/domain/market/market-quality.js'
import { DEFAULT_COMPONENT_FLOORS } from '../src/application/production-doors.js'
import { examineToken } from '../src/application/scan.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const LIMITE = Number(process.env.LIMITE ?? 40)

const http = makeHttpGet({ timeoutMs: 20_000 })
const jupThrottle = makeAdaptiveThrottle()
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const goplus = new GoPlus(http)
const jupiter = new Jupiter(http, jupThrottle)
const jupiterTokens = new JupiterTokens(http, jupThrottle)

console.log('descubriendo...')
const pools = await gecko.discoverPools('solana', 10).catch(() => [])
const universe = new Set<string>([...(await jupiterTokens.discover().catch(() => [])), ...pools.map((p) => p.tokenAddress)])
const poolOf = new Map<string, string>()
for (const p of pools) if (!poolOf.has(p.tokenAddress)) poolOf.set(p.tokenAddress, p.poolAddress)

const addresses = [...universe]
const priced = new Map<string, any>()
for (let i = 0; i < addresses.length; i += 30) {
  try {
    for (const m of dex.toMarketSnapshots('solana', await dex.tokens('solana', addresses.slice(i, i + 30)))) priced.set(m.address, m)
  } catch { /* a batch that fails is a batch */ }
}
const faltan = addresses.filter((a) => !priced.has(a) && poolOf.has(a))
for (const m of await gecko.poolMarkets('solana', faltan.map((a) => poolOf.get(a)!)).catch(() => [])) {
  if (!priced.has(m.address)) priced.set(m.address, m)
}
console.log(`  ${addresses.length} descubiertos, ${priced.size} con precio`)

// The free stage exactly as the scan runs it: gates, then the door.
const afford = [...priced.values()].filter((m) => {
  const provisional: TokenSnapshot = { ...m, security: {} as never, historyBars: null }
  const gates = evaluateMarketGates(provisional, DEFAULT_GATE_POLICY)
  if (!gates.passed) return false
  const score = scoreOpportunity(provisional, DEFAULT_OPPORTUNITY_POLICY, null, {
    liquidityUsd: m.liquidityUsd,
    spreadPct: 0.3,
    slippagePct: m.liquidityUsd > 0 ? estimatePriceImpactPct(100, m.liquidityUsd) : 100,
    referenceUsd: 100,
    observedAt: m.observedAt,
  })
  return meetsMinimums(score.components, DEFAULT_COMPONENT_FLOORS)
})
console.log(`  ${afford.length} pasan las compuertas gratis y la puerta`)
console.log('')
console.log(`— ETAPA CARA sobre ${Math.min(afford.length, LIMITE)} de ellos —`)

const blocks: Record<string, number> = {}
const sole: Record<string, number> = {}
let ok = 0
let errores = 0
for (const market of afford.slice(0, LIMITE)) {
  try {
    const { snapshot, slippagePct } = await examineToken(
      { dex, goplus, sellProbe: jupiter, decimals: { decimals: (c, a) => jupiterTokens.decimals(c, a), security: (c, a) => jupiterTokens.security(c, a) }, history: undefined },
      { chain: 'solana', ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 99, minScore: 0, minComponents: DEFAULT_COMPONENT_FLOORS }, referenceUsd: 100, spreadPct: 0.3, maxTokens: 9_999 } as never,
      market as never,
    )
    const verdict = evaluateGates(snapshot, DEFAULT_GATE_POLICY)
    const score = scoreOpportunity(snapshot, DEFAULT_OPPORTUNITY_POLICY, null, {
      liquidityUsd: snapshot.liquidityUsd, spreadPct: 0.3, slippagePct, referenceUsd: 100, observedAt: snapshot.observedAt,
    })
    const floors = meetsMinimums(score.components, DEFAULT_COMPONENT_FLOORS) ? [] : ['PISO-componente']
    const failed = [...verdict.failures.map((f) => f.gate), ...floors]
    if (failed.length === 0) { ok++; continue }
    for (const gate of failed) blocks[gate] = (blocks[gate] ?? 0) + 1
    if (failed.length === 1) sole[failed[0]!] = (sole[failed[0]!] ?? 0) + 1
  } catch (error) {
    errores++
    blocks['ERROR'] = (blocks['ERROR'] ?? 0) + 1
    if (errores <= 3) console.log(`    error: ${String(error).slice(0, 110)}`)
  }
}

const total = Math.min(afford.length, LIMITE)
console.log('')
console.log(`  SOBREVIVEN: ${ok} de ${total} = ${((100 * ok) / total).toFixed(0)}%`)
console.log('')
console.log('  quien los mata          bloquea   UNICA causa')
for (const [gate, count] of Object.entries(blocks).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${gate.padEnd(20)} ${String(count).padStart(4)}       ${String(sole[gate] ?? 0).padStart(4)}`)
}
