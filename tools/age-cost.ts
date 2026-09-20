/**
 * What the AGE gate costs, and whether what it cuts is an artefact or a pool.
 *
 * It is the last thing cutting the operator's shortlist: measured, 11 of the 32
 * tokens that pass his rule are refused for being younger than 24 hours.
 *
 * The argument for keeping it is real — the rule asks whether the token is up
 * more than 5% over the DAY, and a pool that has not existed for a day has no
 * such number; what the provider reports is the change since inception, which
 * is where NTDA's 3,706,097% comes from.
 *
 * It is also BLUNT. That artefact belongs to the first hours, when a starting
 * price near zero makes any ratio enormous. A pool at twenty hours has a
 * settled price and a reading that means what it says.
 *
 * So the question this answers is not *should the gate exist* but *where*. It
 * prints every young token the rule admits, with its age and its reported day,
 * so the line can be drawn on what is actually there instead of on a round
 * number.
 *
 *   npx tsx tools/age-cost.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { JupiterTokens } from '../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
import { DexScreener, type MarketSnapshot } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { risingAcrossWindows } from '../src/domain/scanner/momentum.js'
import { DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'

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

const NOW = Date.now()
const qualifying = markets.filter(
  (m) => m.liquidityUsd >= DEFAULT_GATE_POLICY.minLiquidityUsd && risingAcrossWindows(m.priceChangePct),
)

const ageOf = (m: MarketSnapshot) => (m.pairCreatedAt === null ? null : (NOW - m.pairCreatedAt) / 3_600_000)

console.log('')
console.log(`  pasan la regla y la liquidez:  ${qualifying.length}`)
console.log('')
console.log('  los MENORES de 24 horas, que la edad corta hoy:')
const young = qualifying
  .map((m) => ({ m, age: ageOf(m) }))
  .filter((x) => x.age !== null && x.age < 24)
  .sort((a, b) => a.age! - b.age!)

for (const { m, age } of young) {
  const day = m.priceChangePct.h24 ?? 0
  const absurd = Math.abs(day) > 1_000 ? '   <- artefacto' : ''
  console.log(
    '    ' + m.symbol.padEnd(14) +
      (age!.toFixed(1) + 'h').padStart(8) +
      ('  dia ' + day.toFixed(1) + '%').padStart(20) +
      ('  liq ' + Math.round(m.liquidityUsd).toLocaleString()).padStart(18) +
      absurd,
  )
}
if (young.length === 0) console.log('    (ninguno)')

console.log('')
console.log('  cuantos quedarian con cada piso de edad:')
for (const hours of [0, 2, 4, 6, 12, 18, 24]) {
  const kept = qualifying.filter((m) => {
    const age = ageOf(m)
    return age === null || age >= hours
  })
  const artefacts = kept.filter((m) => Math.abs(m.priceChangePct.h24 ?? 0) > 1_000).length
  console.log(
    `    >= ${String(hours).padStart(2)}h   ${String(kept.length).padStart(4)} tokens` +
      (artefacts > 0 ? `   de los cuales ${artefacts} con lecturas absurdas` : '   sin lecturas absurdas') +
      (hours === DEFAULT_GATE_POLICY.minAgeHours ? '   <- hoy' : ''),
  )
}
console.log('')
console.log('  Una edad NULA no la corta ninguna: el proveedor no dijo cuando nacio,')
console.log('  y la compuerta dispara sobre evidencia, nunca sobre el silencio.')
console.log('')
