/**
 * Which free gate is actually cutting the universe, measured on live tokens.
 *
 * `worthStoring` stopped persisting rejections, and CLAUDE.md names the cost:
 * tallying gate failures across the rejected set is what found three separate
 * bugs in one day. This is that tally, run on demand against the real market
 * instead of against the database.
 *
 *   npx tsx tools/gate-histogram.ts
 */
import { evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana'
const DEX = 'https://api.dexscreener.com/tokens/v1/solana'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function discover(): Promise<string[]> {
  const addresses = new Set<string>()
  for (const list of ['trending_pools', 'pools', 'new_pools']) {
    for (let page = 1; page <= 5; page++) {
      const response = await fetch(`${GECKO}/${list}?page=${page}`, { headers: { accept: 'application/json' } })
      if (response.ok) {
        const body = (await response.json()) as { data?: { relationships?: { base_token?: { data?: { id?: string } } } }[] }
        for (const pool of body.data ?? []) {
          const id = pool.relationships?.base_token?.data?.id
          if (id) addresses.add(id.replace('solana_', ''))
        }
      }
      await sleep(2_200)
    }
  }
  return [...addresses]
}

async function priced(addresses: readonly string[]): Promise<TokenSnapshot[]> {
  const out: TokenSnapshot[] = []
  for (let i = 0; i < addresses.length; i += 30) {
    const response = await fetch(`${DEX}/${addresses.slice(i, i + 30).join(',')}`)
    if (!response.ok) continue
    for (const pair of (await response.json()) as Record<string, any>[]) {
      if (!pair.priceChange) continue
      out.push({
        chain: 'solana',
        address: pair.baseToken.address,
        symbol: pair.baseToken.symbol,
        pairAddress: pair.pairAddress,
        observedAt: Date.now(),
        priceUsd: Number(pair.priceUsd) || 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        fdvUsd: pair.fdv ?? null,
        volumeUsd: { h1: pair.volume?.h1 ?? 0, h6: pair.volume?.h6 ?? 0, h24: pair.volume?.h24 ?? 0 },
        priceChangePct: {
          h1: pair.priceChange.h1 ?? null,
          h6: pair.priceChange.h6 ?? null,
          h24: pair.priceChange.h24 ?? null,
        },
        txns: {
          h1: { buys: pair.txns?.h1?.buys ?? 0, sells: pair.txns?.h1?.sells ?? 0 },
          h24: { buys: pair.txns?.h24?.buys ?? 0, sells: pair.txns?.h24?.sells ?? 0 },
        },
        pairCreatedAt: pair.pairCreatedAt ?? null,
        security: {
          honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
          hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null,
          verifiedSource: null, isProxy: null,
        },
        historyBars: null,
      } as TokenSnapshot)
    }
  }
  const seen = new Set<string>()
  return out.filter((snapshot) => !seen.has(snapshot.address) && seen.add(snapshot.address))
}

const universe = await priced(await discover())
console.log(`muestra: ${universe.length} tokens de Solana con datos de mercado`)

const blocks: Record<string, number> = {}
const soleCause: Record<string, number> = {}
let passing = 0

for (const snapshot of universe) {
  const gates = evaluateMarketGates(snapshot, DEFAULT_GATE_POLICY)
  if (gates.passed) {
    passing++
    continue
  }
  const failed = gates.failures.map((failure) => failure.gate)
  for (const gate of failed) blocks[gate] = (blocks[gate] ?? 0) + 1
  if (failed.length === 1) soleCause[failed[0]!] = (soleCause[failed[0]!] ?? 0) + 1
}

const pct = (n: number) => `${((100 * n) / universe.length).toFixed(0)}%`
console.log(`pasan TODAS las compuertas gratis: ${passing} = ${pct(passing)}`)
console.log('')
console.log('compuerta            bloquea         UNICA causa')
for (const [gate, count] of Object.entries(blocks).sort((a, b) => b[1] - a[1])) {
  console.log(
    `  ${gate.padEnd(20)} ${String(count).padStart(4)} ${pct(count).padStart(6)}   ${String(soleCause[gate] ?? 0).padStart(4)}`,
  )
}

// What each of the worst offenders would cost to relax, one at a time.
console.log('')
console.log('si se levanta UNA sola compuerta, cuantos pasarian:')
const worst = Object.entries(blocks).sort((a, b) => b[1] - a[1]).slice(0, 5)
for (const [gate] of worst) {
  const would = universe.filter((snapshot) => {
    const gates = evaluateMarketGates(snapshot, DEFAULT_GATE_POLICY)
    return gates.passed || gates.failures.every((failure) => failure.gate === gate)
  }).length
  console.log(`  sin ${gate.padEnd(20)} ${String(would).padStart(4)} = ${pct(would)}`)
}

// ── The operator's rule: three floors and nothing else ─────────────────────
const { scoreOpportunity, DEFAULT_OPPORTUNITY_POLICY } = await import('../src/domain/scanner/opportunity.js')
const { estimatePriceImpactPct } = await import('../src/domain/market/market-quality.js')

const componentsOf = (snapshot: TokenSnapshot) =>
  scoreOpportunity(snapshot, DEFAULT_OPPORTUNITY_POLICY, null, {
    liquidityUsd: snapshot.liquidityUsd,
    spreadPct: 0.3,
    slippagePct: snapshot.liquidityUsd > 0 ? estimatePriceImpactPct(100, snapshot.liquidityUsd) : 100,
    referenceUsd: 100,
    observedAt: snapshot.observedAt,
  }).components

console.log('')
console.log('LA REGLA NUEVA — tres pisos, sin compuertas de oportunidad:')
console.log('')
let m50 = 0, h30 = 0, c30 = 0, todos = 0
for (const snapshot of universe) {
  const c = componentsOf(snapshot)
  if (c.momentum >= 0.5) m50++
  if (c.headroom >= 0.3) h30++
  if (c.costEfficiency >= 0.3) c30++
  if (c.momentum >= 0.5 && c.headroom >= 0.3 && c.costEfficiency >= 0.3) todos++
}
console.log(`  tendencia >= 50%        ${String(m50).padStart(4)} = ${pct(m50)}`)
console.log(`  sube en la hora >= 30%  ${String(h30).padStart(4)} = ${pct(h30)}`)
console.log(`  eficiencia >= 30%       ${String(c30).padStart(4)} = ${pct(c30)}`)
console.log(`  LOS TRES                ${String(todos).padStart(4)} = ${pct(todos)}`)

// And what survives once the two structural gates stay in front of them.
const structural = new Set(['age', 'history', 'idle', 'staleBars', 'priceMismatch'])
let conEstructura = 0
for (const snapshot of universe) {
  const gates = evaluateMarketGates(snapshot, DEFAULT_GATE_POLICY)
  if (gates.failures.some((f) => structural.has(f.gate))) continue
  const c = componentsOf(snapshot)
  if (c.momentum >= 0.5 && c.headroom >= 0.3 && c.costEfficiency >= 0.3) conEstructura++
}
console.log('')
console.log(`  + age/idle (la maquina necesita barras)  ${String(conEstructura).padStart(4)} = ${pct(conEstructura)}`)
