/**
 * The operator's new rule, counted before anything is changed.
 *
 * *Los únicos filtros que valgan sean el costo bajo, que en el último día haya
 * subido más del 5% y en la última hora todavía sea positivo, y además que la
 * liquidez esté arriba de los 300k. Esas son las únicas reglas.*
 *
 * He asked for it in this order — *testealo antes que nada y luego verificalo
 * para aplicar los cambios* — which is the house rule arriving from his side:
 * measure, then change. Twice this week a change was made on a hypothesis that
 * turned out to be the wrong size.
 *
 * The number that needs checking hardest is the LIQUIDITY. $300k is a hundred
 * times the floor the engine runs today, and the target is more than thirty
 * tokens operating. Those two can easily be in conflict, and if they are, it is
 * far cheaper to know now.
 *
 *   npx tsx tools/new-rule-probe.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener, type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { estimatePriceImpactPct } from '../src/domain/market/market-quality.js'

const MIN_LIQUIDITY = Number(process.env.LIQ ?? 300_000)
const MIN_DAY_RISE = 5
const CAPITAL = Number(process.env.CAPITAL ?? 5_000)

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

/** Round trip = the venue spread plus the impact a reference order causes, both ways. */
const roundTripPct = (m: MarketSnapshot) =>
  m.liquidityUsd > 0 ? 2 * (0.3 + estimatePriceImpactPct(100, m.liquidityUsd)) : 100

const up = (v: number | null | undefined, over = 0) => v !== null && v !== undefined && v > over

console.log('')
console.log(`  descubiertos   ${universe.size}`)
console.log(`  con precio     ${markets.length}`)
console.log('')

// ── Each rule on its own, so the one doing the cutting is visible ──────────
const deep = markets.filter((m) => m.liquidityUsd >= MIN_LIQUIDITY)
const ranDay = markets.filter((m) => up(m.priceChangePct.h24, MIN_DAY_RISE))
const hourUp = markets.filter((m) => up(m.priceChangePct.h1))

console.log('  cada regla POR SEPARADO, sobre los que tienen precio:')
console.log(`    liquidez >= $${MIN_LIQUIDITY.toLocaleString()}          ${deep.length}`)
console.log(`    subió más de ${MIN_DAY_RISE}% en el día      ${ranDay.length}`)
console.log(`    la hora sigue positiva        ${hourUp.length}`)
console.log('')

// ── And together, which is the rule ───────────────────────────────────────
const passes = markets.filter(
  (m) => m.liquidityUsd >= MIN_LIQUIDITY && up(m.priceChangePct.h24, MIN_DAY_RISE) && up(m.priceChangePct.h1),
)
console.log(`  LAS TRES JUNTAS: ${passes.length}`)
console.log('')

// ── What the liquidity floor costs, since it is the untested number ───────
console.log('  qué pasaría con otros pisos de liquidez:')
for (const floor of [3_000, 25_000, 50_000, 100_000, 200_000, 300_000, 500_000]) {
  const n = markets.filter(
    (m) => m.liquidityUsd >= floor && up(m.priceChangePct.h24, MIN_DAY_RISE) && up(m.priceChangePct.h1),
  ).length
  const size = n > 0 ? CAPITAL / n : 0
  console.log(
    `    >= $${floor.toLocaleString().padStart(8)}   ${String(n).padStart(4)} tokens   ` +
      (n > 0 ? `$${size.toFixed(0)} cada una` : '—') +
      (floor === MIN_LIQUIDITY ? '   <- lo que pediste' : ''),
  )
}
console.log('')

// ── The cost filter, on top ───────────────────────────────────────────────
const cheap = passes.filter((m) => roundTripPct(m) <= 2.8)
console.log(`  y de esos, con costo bajo (vuelta <= 2.8%): ${cheap.length}`)
console.log('')

console.log('  los que pasarían TODO:')
for (const m of [...cheap].sort((a, b) => (b.priceChangePct.h24 ?? 0) - (a.priceChangePct.h24 ?? 0)).slice(0, 40)) {
  const c = m.priceChangePct
  console.log(
    `    ${m.symbol.padEnd(14)} día ${String((c.h24 ?? 0).toFixed(1)).padStart(8)}%   hora ${String((c.h1 ?? 0).toFixed(1)).padStart(7)}%   ` +
      `liq $${Math.round(m.liquidityUsd).toLocaleString().padStart(11)}   vuelta ${roundTripPct(m).toFixed(2)}%`,
  )
}
console.log('')
