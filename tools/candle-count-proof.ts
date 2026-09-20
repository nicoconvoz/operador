/**
 * Proof that asking for ONE candle returns NONE.
 *
 * The engine produced a single candidate where the free-half funnel measured
 * twenty. The suspect is arithmetic rather than market conditions: the paid
 * stage sized its candle request as `minHistoryBars * 3 + 1`, and
 * `minHistoryBars` went to ZERO when door 3 removed the need for indicators.
 *
 * One requested, minus the bar still being built, is none. And no bars is not
 * silence — it is the strongest form of *this engine cannot watch this pool*,
 * so `staleBars` refuses everything.
 *
 * This asks the real provider for both sizes and prints what comes back, so
 * the cause is demonstrated rather than argued.
 *
 *   npx tsx tools/candle-count-proof.ts
 */
import { makeHttpGet } from '../src/infrastructure/http.js'
import { makeAdaptiveThrottle } from '../src/infrastructure/adaptive-throttle.js'
import { GeckoTerminal, FIFTEEN_MINUTES } from '../src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { DexScreener } from '../src/infrastructure/adapters/dexscreener/dexscreener.js'

const http = makeHttpGet({ timeoutMs: 20_000 })
const gecko = new GeckoTerminal(http, makeAdaptiveThrottle())
const dex = new DexScreener(http)

// A pool that certainly trades, so an empty answer can only be the arithmetic.
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const [market] = dex.toMarketSnapshots('solana', await dex.tokens('solana', [BONK]))
if (!market) {
  console.error('no se pudo precisar el pool de BONK')
  process.exit(1)
}

console.log('')
console.log(`  pool: ${market.symbol}  ${market.pairAddress}`)
console.log('')

for (const asked of [1, 2, 5, 60]) {
  try {
    const candles = await gecko.candles('solana', market.pairAddress, FIFTEEN_MINUTES, asked)
    const got = candles.time.length
    console.log(
      `    pedidas ${String(asked).padStart(3)}  ->  devueltas ${String(got).padStart(3)}` +
        (got === 0 ? '   <- SIN BARRAS: staleBars rechaza el token' : ''),
    )
  } catch (error) {
    console.log(`    pedidas ${String(asked).padStart(3)}  ->  error: ${String(error).slice(0, 60)}`)
  }
}

console.log('')
console.log('  Si "pedidas 1" devuelve 0, esa es la causa del candidato unico:')
console.log('  el adapter descarta la barra en formacion, y una menos una es ninguna.')
console.log('')
