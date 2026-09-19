/**
 * Why the engine opened THREE positions where the rule had 37 candidates.
 *
 * The operator relaunched with the momentum strategy on and got three tokens.
 * Something cuts after the entry rule, and guessing which is how this project
 * has burned whole afternoons — twice, on hypotheses that were both wrong.
 *
 * So this counts every stage and names what did the cutting:
 *
 *   discovered → priced → liquid → RISING → market gates → score → FLOORS
 *
 * The component floors are the prime suspect. They were measured cutting a
 * live book of 29 candidates to 8, and the operator's instruction was *sacá
 * todos los filtros mientras haya liquidez* — which they are not.
 *
 * ## What this tool CANNOT see
 *
 * The paid stage: GoPlus, the sell probe, the history count, bar freshness,
 * the candle price. Those cut further and this report says so rather than
 * implying its own number is the whole story. What it measures is the FREE
 * half, which is where a filter nobody meant to leave on would be hiding.
 *
 *   npx tsx tools/momentum-funnel.ts [capitalUsd]
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener, type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { risingAcrossWindows } from '../src/domain/scanner/momentum.js'
import { evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { scoreOpportunity, failedMinimums, DEFAULT_OPPORTUNITY_POLICY } from '../src/domain/scanner/opportunity.js'
import { DEFAULT_COMPONENT_FLOORS, DEFAULT_MIN_SCORE } from '../src/application/production-doors.js'
import { estimatePriceImpactPct } from '../src/domain/market/market-quality.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const CAPITAL = Number(process.argv[2] ?? 5_000)
const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jupiter = new JupiterTokens(http, makeAdaptiveThrottle())

const pools = await gecko.discoverPools('solana', 10).catch(() => [])
const universe = new Set([...pools.map((p) => p.tokenAddress), ...(await jupiter.discover().catch(() => []))])

const markets: MarketSnapshot[] = []
const list = [...universe]
for (let i = 0; i < list.length; i += 30) {
  try {
    markets.push(...dex.toMarketSnapshots('solana', await dex.tokens('solana', list.slice(i, i + 30))))
  } catch { /* a batch that fails is a batch, not a verdict */ }
}

const liquid = markets.filter((m) => m.liquidityUsd >= DEFAULT_GATE_POLICY.minLiquidityUsd)

const quality = (m: MarketSnapshot) => ({
  liquidityUsd: m.liquidityUsd,
  spreadPct: 0.3,
  slippagePct: m.liquidityUsd > 0 ? estimatePriceImpactPct(100, m.liquidityUsd) : 100,
  referenceUsd: m.observedAt > 0 ? 100 : 100,
  observedAt: m.observedAt,
})

let rising = 0
let pastGates = 0
let pastScore = 0
let pastFloors = 0
const gateBlame: Record<string, number> = {}
const floorBlame: Record<string, number> = {}
const survivors: { symbol: string; score: number }[] = []

for (const market of liquid) {
  if (!risingAcrossWindows(market.priceChangePct)) continue
  rising++

  // MARKET gates only — the free half. The security report is unknown here,
  // and pretending otherwise would blame the wrong stage.
  const snapshot = { ...market, historyBars: null, securityChecked: false } as unknown as TokenSnapshot
  const failures = evaluateMarketGates(snapshot, DEFAULT_GATE_POLICY).failures.filter((f) => f.reason === 'failed')
  if (failures.length > 0) {
    for (const f of failures) gateBlame[f.gate] = (gateBlame[f.gate] ?? 0) + 1
    continue
  }
  pastGates++

  const opportunity = scoreOpportunity(snapshot, DEFAULT_OPPORTUNITY_POLICY, null, quality(market))
  if (opportunity.score < DEFAULT_MIN_SCORE) continue
  pastScore++

  const failed = failedMinimums(opportunity.components, DEFAULT_COMPONENT_FLOORS)
  if (failed.length > 0) {
    for (const f of failed) floorBlame[f] = (floorBlame[f] ?? 0) + 1
    continue
  }
  pastFloors++
  survivors.push({ symbol: market.symbol, score: opportunity.score })
}

const line = (label: string, n: number, note = '') =>
  console.log('    ' + label.padEnd(28) + String(n).padStart(5) + (note ? '   ' + note : ''))

console.log('')
console.log('  EL EMBUDO — la mitad GRATIS. La etapa paga corta más, y esto no la ve.')
line('descubiertos', universe.size)
line('con precio', markets.length)
line('con liquidez', liquid.length, `>= $${DEFAULT_GATE_POLICY.minLiquidityUsd.toLocaleString()}`)
line('SUBIENDO (la regla)', rising)
line('pasan compuertas de mercado', pastGates)
line('pasan el puntaje mínimo', pastScore, `>= ${DEFAULT_MIN_SCORE}`)
line('pasan los PISOS', pastFloors, '<- lo que el motor puede comprar')
console.log('')

if (Object.keys(gateBlame).length > 0) {
  console.log('    qué compuerta corta:')
  for (const [g, n] of Object.entries(gateBlame).sort((a, b) => b[1] - a[1])) line('  ' + g, n)
}
if (Object.keys(floorBlame).length > 0) {
  console.log('    qué PISO corta:')
  for (const [f, n] of Object.entries(floorBlame).sort((a, b) => b[1] - a[1])) {
    const floor = (DEFAULT_COMPONENT_FLOORS as Record<string, number>)[f]
    line('  ' + f, n, `piso ${floor}`)
  }
}

console.log('')
if (pastFloors > 0) {
  console.log(`    $${CAPITAL.toLocaleString()} entre ${pastFloors} = $${(CAPITAL / pastFloors).toFixed(2)} cada una`)
  console.log('    los que sobreviven:', survivors.sort((a, b) => b.score - a.score).slice(0, 15).map((s) => `${s.symbol}(${s.score.toFixed(0)})`).join(' '))
} else {
  console.log('    NADIE sobrevive la mitad gratis.')
}
console.log('')
