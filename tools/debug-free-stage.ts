/**
 * The 500-to-20, stage by stage, with a cause for every loss.
 *
 * The paid stage was measured and it kills 83% of what reaches it — but only
 * 67 of 463 ever reach it. This counts the other cut, which is four times
 * larger and had never been broken down.
 *
 *   npx tsx tools/debug-free-stage.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { scoreOpportunity, DEFAULT_OPPORTUNITY_POLICY } from '../src/domain/scanner/opportunity.js'
import { estimatePriceImpactPct } from '../src/domain/market/market-quality.js'
import { DEFAULT_COMPONENT_FLOORS } from '../src/application/production-doors.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jupiterTokens = new JupiterTokens(http, makeAdaptiveThrottle())

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

const all = [...priced.values()]
console.log(`descubiertos ${addresses.length}  ->  con precio ${all.length}`)
console.log('')

const blocks: Record<string, number> = {}
const sole: Record<string, number> = {}
let pasan = 0

for (const m of all) {
  const snapshot: TokenSnapshot = { ...m, security: {} as never, historyBars: null }
  const gates = evaluateMarketGates(snapshot, DEFAULT_GATE_POLICY)
  const score = scoreOpportunity(snapshot, DEFAULT_OPPORTUNITY_POLICY, null, {
    liquidityUsd: m.liquidityUsd,
    spreadPct: 0.3,
    slippagePct: m.liquidityUsd > 0 ? estimatePriceImpactPct(100, m.liquidityUsd) : 100,
    referenceUsd: 100,
    observedAt: m.observedAt,
  })
  const failed = [...gates.failures.map((f) => f.gate)]
  for (const [name, floor] of Object.entries(DEFAULT_COMPONENT_FLOORS)) {
    const value = (score.components as Record<string, number>)[name]
    if (value === undefined || value < (floor as number)) failed.push(`PISO:${name}`)
  }
  if (failed.length === 0) { pasan++; continue }
  for (const gate of failed) blocks[gate] = (blocks[gate] ?? 0) + 1
  if (failed.length === 1) sole[failed[0]!] = (sole[failed[0]!] ?? 0) + 1
}

const pct = (n: number) => `${((100 * n) / all.length).toFixed(0)}%`
console.log(`PASAN la etapa gratis: ${pasan} de ${all.length} = ${pct(pasan)}`)
console.log('')
console.log('  quien los bloquea        bloquea          UNICA causa')
for (const [gate, count] of Object.entries(blocks).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${gate.padEnd(22)} ${String(count).padStart(4)} ${pct(count).padStart(6)}        ${String(sole[gate] ?? 0).padStart(4)}`)
}

console.log('')
console.log('si se levanta UNA sola, cuantos pasarian:')
for (const [gate] of Object.entries(blocks).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    sin ${gate.padEnd(22)} ${String(pasan + (sole[gate] ?? 0)).padStart(4)}`)
}
