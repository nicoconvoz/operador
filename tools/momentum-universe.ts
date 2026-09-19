/**
 * How many tokens satisfy a momentum entry RIGHT NOW, and what that implies
 * for position size.
 *
 * The operator's rule, in his words: *mirá las últimas 4 horas, que no haya
 * bajado de 0% y que se haya incrementado en el total del tiempo hasta los 5m.*
 *
 * Every window green, all the way down to the freshest one. The providers give
 * m5, h1, h6 and h24, so four hours sits between two of them and the rule reads
 * `h6 > 0 AND h1 > 0 AND m5 > 0` — the same accommodation the freefall gate
 * makes, reading the windows that exist rather than inventing the one it wants.
 *
 * It exists because the binding constraint turned out not to be the threshold.
 * Measured: loosening from 1% to zero moves the count from 26 to 57, while the
 * whole liquid universe is about 212 on a shallow sweep. So the SIZE of each
 * position is set by how many tokens qualify, and a fixed-dollar stop only
 * makes sense at one particular size.
 *
 *   npx tsx tools/momentum-universe.ts [capitalUsd]
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'

const CAPITAL = Number(process.argv[2] ?? 5_000)
const MIN_LIQUIDITY = 3_000

const http = makeHttpGet({ timeoutMs: 20_000 })
const dex = new DexScreener(http)
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const jupiter = new JupiterTokens(http, makeAdaptiveThrottle())

// The DEEP sweep, as production does it — ten pages is GeckoTerminal's own
// ceiling. A shallow one understates the universe, and the universe is exactly
// what this is measuring.
const pools = await gecko.discoverPools('solana', 10).catch(() => [])
const universe = new Set([...pools.map((p) => p.tokenAddress), ...(await jupiter.discover().catch(() => []))])
console.log(`descubiertos   ${universe.size}`)

const markets: MarketSnapshot[] = []
const list = [...universe]
for (let i = 0; i < list.length; i += 30) {
  try {
    markets.push(...dex.toMarketSnapshots('solana', await dex.tokens('solana', list.slice(i, i + 30))))
  } catch { /* a batch that fails is a batch, not a verdict */ }
}
console.log(`con precio     ${markets.length}`)

const liquid = markets.filter((m) => m.liquidityUsd >= MIN_LIQUIDITY)
console.log(`con liquidez   ${liquid.length}   (>= $${MIN_LIQUIDITY.toLocaleString()})`)
console.log('')

/** A window counts as green only when somebody MEASURED it. Silence is not a rise. */
const up = (v: number | null | undefined) => v !== null && v !== undefined && v > 0

const rules: [string, (m: MarketSnapshot) => boolean][] = [
  ['h6>0 h1>0 m5>0   ← la regla', (m) => up(m.priceChangePct.h6) && up(m.priceChangePct.h1) && up(m.priceChangePct.m5)],
  ['h6>0 h1>0        (sin los 5m)', (m) => up(m.priceChangePct.h6) && up(m.priceChangePct.h1)],
  ['h1>0 m5>0        (sin las 6h)', (m) => up(m.priceChangePct.h1) && up(m.priceChangePct.m5)],
  ['m5>0             (solo lo fresco)', (m) => up(m.priceChangePct.m5)],
  ['m5>1%', (m) => (m.priceChangePct.m5 ?? -999) > 1],
  ['todo verde + m5>1%', (m) => up(m.priceChangePct.h6) && up(m.priceChangePct.h1) && (m.priceChangePct.m5 ?? -999) > 1],
]

console.log('  regla                                cuántos     cada una   y ahí -$1 es')
for (const [name, rule] of rules) {
  const n = liquid.filter(rule).length
  const size = n > 0 ? CAPITAL / n : 0
  const stop = size > 0 ? 100 / size : 0
  const verdict = n === 0 ? '' : stop < 3 ? '  ruido' : stop > 12 ? '  muy ancho' : '  razonable'
  console.log(
    '  ' + name.padEnd(36) +
      String(n).padStart(6) +
      (n > 0 ? `$${size.toFixed(2)}` : '—').padStart(12) +
      (n > 0 ? `-${stop.toFixed(1)}%` : '—').padStart(12) +
      verdict,
  )
}

// How much of the rule each window is responsible for, so the next person can
// see which one is doing the cutting rather than guessing at it.
console.log('')
console.log('  quién corta, por separado, sobre los que tienen liquidez:')
for (const [name, get] of [['m5', (m: MarketSnapshot) => m.priceChangePct.m5], ['h1', (m: MarketSnapshot) => m.priceChangePct.h1], ['h6', (m: MarketSnapshot) => m.priceChangePct.h6]] as const) {
  const green = liquid.filter((m) => up(get(m))).length
  const quiet = liquid.filter((m) => get(m) === null || get(m) === undefined).length
  console.log(`    ${name.padEnd(4)} verde ${String(green).padStart(4)}   sin medir ${String(quiet).padStart(4)}   en rojo ${String(liquid.length - green - quiet).padStart(4)}`)
}

const chosen = liquid.filter(rules[0]![1])
console.log('')
console.log(`  los que pasarían la regla ahora mismo (${chosen.length}), por fuerza de los 5 min:`)
for (const m of [...chosen].sort((a, b) => (b.priceChangePct.m5 ?? 0) - (a.priceChangePct.m5 ?? 0)).slice(0, 15)) {
  const c = m.priceChangePct
  console.log(
    `    ${m.symbol.padEnd(12)} 5m ${String(c.m5 ?? '—').padStart(7)}%   1h ${String(c.h1 ?? '—').padStart(7)}%   6h ${String(c.h6 ?? '—').padStart(7)}%   liq $${Math.round(m.liquidityUsd).toLocaleString().padStart(10)}`,
  )
}
console.log('')
