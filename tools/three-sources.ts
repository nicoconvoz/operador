/** The three discovery sources, and what the hour-positive rule keeps. */
import { evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms))
const source: Record<string, Set<string>> = { jupiter: new Set(), gecko: new Set(), dexscreener: new Set() }

for (const list of ['toptrending/24h', 'toptraded/24h', 'toporganicscore/24h']) {
  const r = await fetch(`https://lite-api.jup.ag/tokens/v2/${list}?limit=100`)
  if (r.ok) for (const t of (await r.json()) as any[]) if (typeof t.id === 'string') source.jupiter.add(t.id)
  await sleep(1_200)
}
for (const list of ['trending_pools', 'pools', 'new_pools']) {
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/${list}?page=${page}`, { headers: { accept: 'application/json' } })
    if (!r.ok) { await sleep(3_000); continue }
    const j = (await r.json()) as any
    if (!(j.data ?? []).length) break
    for (const p of j.data) { const t = p.relationships?.base_token?.data?.id; if (t) source.gecko.add(String(t).replace('solana_', '')) }
    await sleep(2_300)
  }
}
for (const path of ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1']) {
  const r = await fetch(`https://api.dexscreener.com${path}`)
  if (r.ok) for (const t of (await r.json()) as any[]) if (t.chainId === 'solana' && t.tokenAddress) source.dexscreener.add(t.tokenAddress)
  await sleep(500)
}

const all = new Set([...source.jupiter, ...source.gecko, ...source.dexscreener])
console.log('POR FUENTE (unicos de cada una):')
for (const [name, set] of Object.entries(source)) console.log(`  ${name.padEnd(13)} ${String(set.size).padStart(4)}`)
console.log(`  ${'UNION'.padEnd(13)} ${String(all.size).padStart(4)}`)
console.log('')
for (const [name, set] of Object.entries(source)) {
  const otros = new Set([...all].filter((a) => !set.has(a)))
  console.log(`  solo ${name.padEnd(13)} aporta ${String(all.size - otros.size).padStart(4)} de los que nadie mas tiene: ${[...set].filter((a) => !Object.entries(source).some(([n, s]) => n !== name && s.has(a))).length}`)
}

const list = [...all]
const snaps: TokenSnapshot[] = []
for (let i = 0; i < list.length; i += 30) {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`)
  if (!r.ok) continue
  for (const p of (await r.json()) as any[]) {
    if (!p.priceChange) continue
    snaps.push({
      chain: 'solana', address: p.baseToken.address, symbol: p.baseToken.symbol, pairAddress: p.pairAddress,
      observedAt: Date.now(), priceUsd: Number(p.priceUsd) || 0, liquidityUsd: p.liquidity?.usd ?? 0, fdvUsd: p.fdv ?? null,
      volumeUsd: { h1: p.volume?.h1 ?? 0, h6: p.volume?.h6 ?? 0, h24: p.volume?.h24 ?? 0 },
      priceChangePct: { h1: p.priceChange.h1 ?? null, h6: p.priceChange.h6 ?? null, h24: p.priceChange.h24 ?? null },
      txns: { h1: { buys: p.txns?.h1?.buys ?? 0, sells: p.txns?.h1?.sells ?? 0 }, h24: { buys: p.txns?.h24?.buys ?? 0, sells: p.txns?.h24?.sells ?? 0 } },
      pairCreatedAt: p.pairCreatedAt ?? null,
      security: { honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null, hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null },
      historyBars: null,
    } as TokenSnapshot)
  }
}
const seen = new Set<string>()
const u = snaps.filter((s) => !seen.has(s.address) && seen.add(s.address))
const structural = new Set(['age', 'history', 'idle', 'staleBars', 'priceMismatch'])
const operable = (s: TokenSnapshot) => !evaluateMarketGates(s, DEFAULT_GATE_POLICY).failures.some((f) => structural.has(f.gate))

console.log('')
console.log(`con datos de mercado            ${String(u.length).padStart(4)}`)
const pos = u.filter((s) => s.priceChangePct.h1 !== null && s.priceChangePct.h1 > 0)
console.log(`LA HORA ES POSITIVA             ${String(pos.length).padStart(4)}`)
const sinDato = u.filter((s) => s.priceChangePct.h1 === null)
console.log(`  (sin dato de hora, aparte:    ${String(sinDato.length).padStart(4)})`)
console.log(`+ la maquina puede operarlo     ${String(pos.filter(operable).length).padStart(4)}`)
console.log(`+ liquidez >= $3k               ${String(pos.filter(operable).filter((s) => s.liquidityUsd >= 3_000).length).padStart(4)}`)
