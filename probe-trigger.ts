import { GeckoTerminal, FIFTEEN_MINUTES } from './src/infrastructure/adapters/geckoterminal/geckoterminal.js'
import { makeHttpGet, makeThrottle } from './src/infrastructure/http.js'
import { highest } from './src/domain/indicators/highest.js'

// Does the classic entry ever FIRE on a large cap? The gate is `close <=
// swing_high(20) * (1 - 10%)`. If a deep token never falls ten percent inside
// five hours, admitting it adds a name to the screen and no trades at all.
const http = makeHttpGet({ timeoutMs: 20_000 })
const gecko = new GeckoTerminal(http, makeThrottle(2_500))

const top = (await http('https://api.geckoterminal.com/api/v2/networks/solana/pools?page=1').then((r) => r.json())) as any
for (const item of (top.data ?? []).slice(0, 5)) {
  const pool = item.attributes?.address
  const name = item.attributes?.name
  const fdv = Math.round(Number(item.attributes?.fdv_usd ?? 0))
  if (!pool) continue
  const c = await gecko.candles('solana', pool, FIFTEEN_MINUTES, 1000)
  if (c.close.length < 100) { console.log(name, 'pocas barras', c.close.length); continue }

  const swing = highest(c.high, 20)
  let fired = 0
  for (let i = 20; i < c.close.length; i++) {
    const h = swing[i - 1]
    if (h !== null && h !== undefined && c.close[i]! <= h * 0.9) fired++
  }
  const bars = c.close.length - 20
  console.log(JSON.stringify({
    name, fdvUsd: fdv, bars,
    barsTriggering: fired,
    pctOfBars: +((fired / bars) * 100).toFixed(1),
  }))
}
