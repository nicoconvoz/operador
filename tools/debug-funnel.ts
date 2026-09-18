/**
 * Where do the tokens go? The real scan, real network, counted at every step.
 *
 * Built because a live run reported 323 discovered and 173 priced and nobody
 * could say where the other 150 went — and waiting on CI to find out costs
 * fifteen minutes a guess.
 *
 * No store, so no caches: every number here is what the providers said just
 * now, not what one of them said six hours ago.
 *
 *   npx tsx tools/debug-funnel.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'

const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jupiterTokens = new JupiterTokens(http, makeAdaptiveThrottle())

console.log('— DESCUBRIMIENTO —')
const fromJupiter = await jupiterTokens.discover().catch((e) => { console.log('  jupiter FALLO', String(e)); return [] as string[] })
console.log(`  jupiter        ${String(fromJupiter.length).padStart(4)}`)

const pools = await gecko.discoverPools('solana', 10).catch((e) => { console.log('  gecko FALLO', String(e)); return [] })
console.log(`  gecko (pools)  ${String(pools.length).padStart(4)}`)

const fromDex = await dex.discoverTokens('solana').catch((e) => { console.log('  dexscreener FALLO', String(e)); return [] as string[] })
console.log(`  dexscreener    ${String(fromDex.length).padStart(4)}`)

const universe = new Set<string>([...fromJupiter, ...pools.map((p) => p.tokenAddress), ...fromDex])
const poolOf = new Map<string, string>()
for (const p of pools) if (!poolOf.has(p.tokenAddress)) poolOf.set(p.tokenAddress, p.poolAddress)
const addresses = [...universe]
console.log(`  UNICO          ${String(addresses.length).padStart(4)}`)

console.log('')
console.log('— MERCADO, en lotes de 30 —')
const priced = new Map<string, unknown>()
let lotes = 0
let fallos = 0
let paresCrudos = 0
let dropPrecio = 0
let dropLiquidez = 0
for (let i = 0; i < addresses.length; i += 30) {
  const batch = addresses.slice(i, i + 30)
  lotes++
  try {
    const pairs = await dex.tokens('solana', batch)
    paresCrudos += pairs.length
    for (const p of pairs as any[]) {
      if (p.chainId !== 'solana') continue
      if (p.priceUsd === null || p.priceUsd === undefined) { dropPrecio++; continue }
      if (p.liquidity?.usd == null) { dropLiquidez++; continue }
    }
    for (const m of dex.toMarketSnapshots('solana', pairs)) priced.set(m.address, m)
  } catch (error) {
    fallos++
    console.log(`  lote ${lotes} FALLO: ${String(error).slice(0, 90)}`)
  }
}
console.log(`  lotes ${lotes}, fallidos ${fallos}`)
console.log(`  pares crudos devueltos       ${String(paresCrudos).padStart(4)}`)
console.log(`  descartados sin precio       ${String(dropPrecio).padStart(4)}`)
console.log(`  descartados sin liquidez     ${String(dropLiquidez).padStart(4)}`)
console.log(`  TOKENS CON PRECIO            ${String(priced.size).padStart(4)} de ${addresses.length} = ${((100 * priced.size) / addresses.length).toFixed(0)}%`)

const sinPrecio = addresses.filter((a) => !priced.has(a))
console.log('')
console.log(`— LOS ${sinPrecio.length} SIN PRECIO —`)
console.log(`  tienen pool conocido:        ${String(sinPrecio.filter((a) => poolOf.has(a)).length).padStart(4)}`)
console.log(`  sin pool (Jupiter/DexScreener puros): ${String(sinPrecio.filter((a) => !poolOf.has(a)).length).padStart(4)}`)

const rescatables = sinPrecio.filter((a) => poolOf.has(a))
if (rescatables.length > 0) {
  const recuperados = await gecko.poolMarkets('solana', rescatables.map((a) => poolOf.get(a)!))
  console.log(`  RECUPERADOS por el pool:     ${String(recuperados.length).padStart(4)}`)
  console.log('')
  console.log(`TOTAL CON PRECIO TRAS EL ARREGLO: ${priced.size + recuperados.length} de ${addresses.length} = ${((100 * (priced.size + recuperados.length)) / addresses.length).toFixed(0)}%`)
}
