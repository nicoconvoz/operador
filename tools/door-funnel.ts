// Where the universe is cut today: Jupiter's discovery, the free gates, then
// the doors, each cause counted. Read-only; nothing is stored.
//   npx tsx tools/door-funnel.ts
import { makeHttpGet } from '../src/infrastructure/http.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { evaluateGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { scoreOpportunity, DEFAULT_OPPORTUNITY_POLICY, meetsMinimums } from '../src/domain/scanner/opportunity.js'
import { risingInTheHour } from '../src/domain/scanner/momentum.js'
import { DEFAULT_COMPONENT_FLOORS } from '../src/application/production-doors.js'

const jupiter = new JupiterTokens(makeHttpGet({ timeoutMs: 20_000 }))
const mints = await jupiter.discover(100)
const markets = await jupiter.markets('solana', mints)
const cut = new Map<string, number>()
const count = (why: string) => cut.set(why, (cut.get(why) ?? 0) + 1)
let pass = 0
for (const m of markets) {
  const snapshot = { ...m, security: { honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0, hasBlacklist: false, topHoldersPct: 10, creatorPct: 0, lpLockedPct: 100, isProxy: false, verifiedSource: null }, historyBars: null, securityChecked: true } as never
  const opportunity = evaluateGates(snapshot, DEFAULT_GATE_POLICY).failures.filter((f) => !DEFAULT_GATE_POLICY.ignoredGates.includes(f.gate))
  const scored = scoreOpportunity(snapshot, DEFAULT_OPPORTUNITY_POLICY)
  const doors: string[] = []
  if (!risingInTheHour(m.priceChangePct.h1)) doors.push('door:hour not rising')
  if (!meetsMinimums(scored.components, { activity: DEFAULT_COMPONENT_FLOORS.activity })) doors.push('door:activity < 50%')
  if (!meetsMinimums(scored.components, { liquidityGrowth: DEFAULT_COMPONENT_FLOORS.liquidityGrowth })) doors.push('door:liquidity not growing')
  const all = [...opportunity.map((f) => f.gate === 'age' ? (f.detail.includes('days') ? 'gate:age > 30 days' : 'gate:age < 6h or unknown') : `gate:${f.gate}`), ...doors]
  if (all.length === 0) pass++
  if (all.length === 1) count(`ONLY ${all[0]}`)
  for (const why of new Set(all)) count(why)
}
console.log('discovered', mints.length, 'priced', markets.length, 'pass everything', pass)
for (const [why, n] of [...cut].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), why)
