/**
 * How many tokens clear liquidity AND holder concentration, and nothing else.
 *
 * The operator's new rule: *dejá pasar todas las monedas que tengan más de
 * 100k de liquidez y tengan menos del 50% topholders, y comprá solo 15 usd por
 * moneda.*
 *
 * Liquidity is free — it comes with the batched price. Concentration is NOT:
 * it is one throttled GoPlus call per token, which is why the scanner only
 * ever asks it of what already cleared the free gates. So this samples rather
 * than sweeping, and says so.
 *
 * The number that matters is the SHARE: of the tokens deep enough to trade,
 * how many are not owned by ten wallets. Multiply it out and you have the book
 * size, and at $15 each you have the capital it uses.
 *
 *   npx tsx tools/holders-probe.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener, type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus } from '../src/infrastructure/adapters/goplus/goplus.js'

const MIN_LIQUIDITY = 100_000
const MAX_TOP_HOLDERS = 50
const PER_TOKEN_USD = 15
const SAMPLE = Number(process.env.SAMPLE ?? 45)

const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jupiter = new JupiterTokens(http, makeAdaptiveThrottle())
const goplus = new GoPlus(http)

const pools = await gecko.discoverPools('solana', 10).catch(() => [])
const universe = new Set([...pools.map((p) => p.tokenAddress), ...(await jupiter.discover().catch(() => []))])

const markets: MarketSnapshot[] = []
const list = [...universe]
for (let i = 0; i < list.length; i += 30) {
  try {
    markets.push(...dex.toMarketSnapshots('solana', await dex.tokens('solana', list.slice(i, i + 30))))
  } catch { /* a batch that fails is a batch */ }
}

const deep = markets.filter((m) => m.liquidityUsd >= MIN_LIQUIDITY)
console.log('')
console.log(`  descubiertos ${universe.size}   con precio ${markets.length}`)
console.log(`  con liquidez >= $${MIN_LIQUIDITY.toLocaleString()}:  ${deep.length}`)
console.log('')

// Deepest first: if the sample has to be partial, it should be the half the
// allocator would reach for anyway.
const sample = [...deep].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, SAMPLE)
console.log(`  pidiendo concentración a GoPlus para ${sample.length} de ellos...`)
console.log('')

let clean = 0
let concentrated = 0
let unknown = 0
const worst: { symbol: string; pct: number }[] = []

for (const market of sample) {
  try {
    const report = await goplus.securityReport('solana', market.address)
    const pct = report?.topHoldersPct ?? null
    if (pct === null || pct === undefined) { unknown++; continue }
    if (pct < MAX_TOP_HOLDERS) clean++
    else { concentrated++; worst.push({ symbol: market.symbol, pct }) }
  } catch {
    // A provider that could not answer has not condemned anything. Counted
    // apart, because the gates fail CLOSED on it and a refusal for silence is
    // not the same fact as a refusal for concentration.
    unknown++
  }
}

const measured = clean + concentrated
console.log(`    menos de ${MAX_TOP_HOLDERS}% en diez billeteras   ${clean}`)
console.log(`    concentrados                        ${concentrated}`)
console.log(`    GoPlus no contestó                  ${unknown}   (los gates fallan CERRADO: se rechazan)`)
console.log('')

if (measured > 0) {
  const share = clean / measured
  const expected = Math.round(share * deep.length)
  console.log(`    pasan ${(share * 100).toFixed(0)}% de los medidos`)
  console.log(`    sobre los ${deep.length} con liquidez, eso es ~${expected} monedas`)
  console.log(`    a $${PER_TOKEN_USD} cada una = $${(expected * PER_TOKEN_USD).toLocaleString()} desplegados`)
  console.log('')
  console.log('    (el "no contestó" se rechaza igual, así que el número real es menor')
  console.log('     en la misma proporción que esa columna)')
}

if (worst.length > 0) {
  console.log('')
  console.log('    los más concentrados de la muestra:')
  for (const w of worst.sort((a, b) => b.pct - a.pct).slice(0, 10)) {
    console.log(`      ${w.symbol.padEnd(14)} ${w.pct.toFixed(1)}%`)
  }
}
console.log('')
