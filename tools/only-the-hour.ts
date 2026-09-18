/** One rule: was the last hour positive. Measured against everything else. */
import { evaluateMarketGates, evaluateSafetyGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms))
const addrs = new Set<string>()
for (const list of ['trending_pools', 'pools', 'new_pools']) {
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/${list}?page=${page}`, { headers: { accept: 'application/json' } })
    if (r.ok) {
      const j = (await r.json()) as any
      if (!(j.data ?? []).length) break
      for (const p of j.data) { const t = p.relationships?.base_token?.data?.id; if (t) addrs.add(String(t).replace('solana_', '')) }
    }
    await sleep(2_300)
  }
}
const list = [...addrs]
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
const pct = (n: number) => `${((100 * n) / u.length).toFixed(0)}%`

const positiva = (s: TokenSnapshot) => s.priceChangePct.h1 !== null && s.priceChangePct.h1 > 0
const structural = new Set(['age', 'history', 'idle', 'staleBars', 'priceMismatch'])
const puedeOperarse = (s: TokenSnapshot) =>
  !evaluateMarketGates(s, DEFAULT_GATE_POLICY).failures.some((f) => structural.has(f.gate))

console.log(`descubiertos por GeckoTerminal: ${list.length}`)
console.log(`con datos de mercado en DexScreener: ${u.length}`)
console.log('')
const pos = u.filter(positiva)
console.log(`LA REGLA: la hora es positiva     ${String(pos.length).padStart(4)} = ${pct(pos.length)}`)
console.log('')
console.log('desglose de lo que NO pasa:')
console.log(`  la hora es cero o negativa      ${String(u.filter((s) => s.priceChangePct.h1 !== null && s.priceChangePct.h1 <= 0).length).padStart(4)}`)
console.log(`  la hora no viene informada      ${String(u.filter((s) => s.priceChangePct.h1 === null).length).padStart(4)}`)
console.log('')
const conEstructura = pos.filter(puedeOperarse)
console.log(`+ la maquina puede operarlo (age/idle) ${String(conEstructura.length).padStart(4)} = ${pct(conEstructura.length)}`)
const liq = conEstructura.filter((s) => s.liquidityUsd >= 3_000)
console.log(`+ se puede salir (liquidez >= $3k)     ${String(liq.length).padStart(4)} = ${pct(liq.length)}`)
console.log('')
console.log('el resto lo cortan seguridad y velas, que necesitan red.')
