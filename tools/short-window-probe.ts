/**
 * *Mira los últimos 15 minutos: si aumentó 1% para arriba queda, si no no.*
 *
 * There is no fifteen-minute window in the market feed. DexScreener reports
 * m5, h1, h6 and h24, so the operator's window sits between two of them and
 * the only exact source is the CANDLES — which are the expensive stage, one
 * throttled request per token.
 *
 * Two honest readings, then:
 *
 *   m5    five minutes, free, batched thirty at a time, and FRESHER than what
 *         he asked for. A 1% move inside five minutes is a stronger signal
 *         than the same move inside fifteen, not a weaker one.
 *
 *   15m   exact, and up to fifteen minutes old by the time it is read, because
 *         the newest bar is discarded while it is still forming. It costs a
 *         candle request per token.
 *
 * This counts both against the same universe so the choice is made on numbers.
 *
 *   npx tsx tools/short-window-probe.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal, FIFTEEN_MINUTES } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener, type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'

const RISE = 1
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
  } catch { /* a batch that fails is a batch */ }
}

const liquid = markets.filter((m) => m.liquidityUsd >= DEFAULT_GATE_POLICY.minLiquidityUsd)
console.log('')
console.log(`  descubiertos ${universe.size}   con precio ${markets.length}   con liquidez ${liquid.length}`)
console.log('')

// ── The free reading ──────────────────────────────────────────────────────
console.log('  ventana de CINCO minutos (gratis, en lotes de 30):')
for (const t of [0, 0.5, 1, 2, 5]) {
  const n = liquid.filter((m) => (m.priceChangePct.m5 ?? -999) >= t).length
  console.log(`    m5 >= ${String(t).padEnd(4)} ${String(n).padStart(4)} tokens` + (t === RISE ? '   <- tu 1%' : ''))
}
const quiet = liquid.filter((m) => m.priceChangePct.m5 === null || m.priceChangePct.m5 === undefined).length
console.log(`    sin m5 reportado   ${quiet}   (el silencio no es una subida: se rechazan)`)
console.log('')

// ── The exact one, on a sample, because it costs a request each ───────────
const sample = liquid.filter((m) => (m.priceChangePct.m5 ?? -999) > -50).slice(0, 40)
console.log(`  ventana de QUINCE minutos, exacta, sobre una muestra de ${sample.length}:`)
let up15 = 0
let measured = 0
for (const m of sample) {
  try {
    const c = await gecko.candles('solana', m.pairAddress, FIFTEEN_MINUTES, 3)
    const i = c.time.length - 1
    if (i < 0) continue
    measured++
    const rise = ((c.close[i]! - c.open[i]!) / c.open[i]!) * 100
    if (rise >= RISE) {
      up15++
      console.log(`    ${m.symbol.padEnd(14)} ${rise.toFixed(2).padStart(8)}%   (m5 ${String(m.priceChangePct.m5 ?? '—').padStart(7)}%)`)
    }
  } catch { /* the provider not answering is not a verdict */ }
}
console.log('')
console.log(`    medidos ${measured}, suben 1% o más en la última vela cerrada: ${up15}`)
console.log(`    extrapolado a los ${liquid.length} con liquidez: ~${measured > 0 ? Math.round((up15 / measured) * liquid.length) : 0}`)
console.log('')
