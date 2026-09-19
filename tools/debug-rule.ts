/** Every reading of "que haya subido al menos 1%", counted on the real universe. */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { evaluateMarketGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jup = new JupiterTokens(http, makeAdaptiveThrottle())

const pools = await gecko.discoverPools('solana', 10).catch(() => [])
const universe = new Set<string>([...(await jup.discover().catch(() => [])), ...pools.map((p) => p.tokenAddress)])
const poolOf = new Map<string, string>()
for (const p of pools) if (!poolOf.has(p.tokenAddress)) poolOf.set(p.tokenAddress, p.poolAddress)
const addresses = [...universe]
const priced = new Map<string, any>()
for (let i = 0; i < addresses.length; i += 30) {
  try { for (const m of dex.toMarketSnapshots('solana', await dex.tokens('solana', addresses.slice(i, i + 30)))) priced.set(m.address, m) } catch { /* batch */ }
}
const faltan = addresses.filter((a) => !priced.has(a) && poolOf.has(a))
for (const m of await gecko.poolMarkets('solana', faltan.map((a) => poolOf.get(a)!)).catch(() => [])) if (!priced.has(m.address)) priced.set(m.address, m)

const all = [...priced.values()]
// Only tokens the machine can actually operate, so the rule is compared on
// equal terms with everything else already in the way.
const structural = new Set(['age', 'history', 'idle', 'staleBars', 'priceMismatch', 'liquidity', 'denylist', 'impersonation'])
const operable = all.filter((m) => {
  const s: TokenSnapshot = { ...m, security: {} as never, historyBars: null }
  return !evaluateMarketGates(s, DEFAULT_GATE_POLICY).failures.some((f) => structural.has(f.gate))
})

const h1 = (m: any) => m.priceChangePct.h1
const h24 = (m: any) => m.priceChangePct.h24
const up = (v: number | null, min = 0) => v !== null && v !== undefined && v > min

const reglas: [string, (m: any) => boolean][] = [
  ['HOY: la hora > 0', (m) => up(h1(m))],
  ['la hora >= 1%', (m) => up(h1(m), 1)],
  ['el dia >= 1%', (m) => up(h24(m), 1)],
  ['el dia >= 1% Y la hora > 0', (m) => up(h24(m), 1) && up(h1(m))],
  ['el dia >= 1% Y la hora >= 1%', (m) => up(h24(m), 1) && up(h1(m), 1)],
  ['el dia >= 1% O la hora >= 1%', (m) => up(h24(m), 1) || up(h1(m), 1)],
]

console.log(`con precio ${all.length}  |  operables por la maquina ${operable.length}`)
console.log('')
for (const [nombre, regla] of reglas) {
  const n = operable.filter(regla).length
  console.log(`  ${nombre.padEnd(32)} ${String(n).padStart(4)} = ${((100 * n) / operable.length).toFixed(0)}%`)
}
