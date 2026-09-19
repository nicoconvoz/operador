/**
 * What restoring the freefall gate would COST and what it would have SAVED.
 *
 * The operator's question, and it is the right one to ask before turning a
 * filter back on: *calculá cuántos perderíamos y cuánto dinero ganaríamos.*
 *
 * Two halves, measured separately because they are different questions:
 *
 *   A. THE COST — of the universe this engine currently sees, how many tokens
 *      does each threshold refuse? That is opportunity given up.
 *
 *   B. THE SAVING — of the positions actually opened, which ones had ALREADY
 *      fallen that far before we bought them, and what are they worth now?
 *
 * B rests on one piece of arithmetic. A snapshot gives the price now and the
 * change over 24h, so the price 24h ago is `now / (1 + change/100)`. The fills
 * give the exact price we paid. Between them, the fall the token had ALREADY
 * suffered when the engine arrived:
 *
 *     preEntryFall = (entryPrice / price24hAgo - 1) * 100
 *
 * That is precisely the number `maxDailyFallPct` reads at the door, recovered
 * after the fact. PERK came out at -92%: the collapse had happened before the
 * engine ever saw it, and we joined it for the last 44%.
 *
 * It is only valid for a position opened WITHIN the last 24 hours — beyond
 * that the window no longer contains the entry, and the tool says so rather
 * than quietly averaging a number it cannot compute. A measurement it cannot
 * make is reported as one it cannot make.
 *
 *   DATABASE_URL='...' npx tsx tools/freefall-what-if.ts
 */
import { PostgresStore } from '../src/infrastructure/persistence/postgres-store.js'
import { type TokenSnapshot } from '../src/domain/scanner/snapshot.js'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL no está puesta.')
  process.exit(1)
}

const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: url, max: 2 })
const sql = {
  query: async <T>(text: string, params?: readonly unknown[]) => {
    const result = await pool.query(text, params as unknown[])
    return { rows: result.rows as T[] }
  },
}
const store = new PostgresStore(sql)

const THRESHOLDS = [5, 10, 15, 20, 30, 50, 70]
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

const positions = await store.loadPositions()
const fills = await store.allFills()
const scans = await store.latestScansByChain()

const snapshots = new Map<string, TokenSnapshot>()
for (const scan of scans) for (const s of scan.snapshots) snapshots.set(`${scan.chain}:${s.address}`, s)

// ── A. What each threshold costs in candidates ──────────────────────────────
const universe = [...snapshots.values()]
const withChange = universe.filter((s) => s.priceChangePct.h24 !== null && s.priceChangePct.h24 !== undefined)

console.log('')
console.log(`  A. EL COSTO — sobre ${universe.length} tokens del último barrido`)
console.log(`     (${withChange.length} traen el cambio de 24h; al resto la compuerta no los toca:`)
console.log('      el silencio no es evidencia, solo dispara sobre un número medido)')
console.log('')
console.log('     umbral      rechaza      queda')
for (const limit of THRESHOLDS) {
  const cut = withChange.filter((s) => s.priceChangePct.h24! < -limit).length
  const pct = withChange.length > 0 ? ((100 * cut) / withChange.length).toFixed(1) : '0.0'
  console.log(`     -${String(limit).padStart(2)}%    ${String(cut).padStart(7)} (${pct.padStart(4)}%)   ${String(universe.length - cut).padStart(6)}`)
}

// ── B. What each threshold would have saved ─────────────────────────────────
type Judged = { symbol: string; fellBeforePct: number; pnlUsd: number; putInUsd: number }
const judged: Judged[] = []
const unmeasurable: string[] = []

for (const position of positions) {
  const buys = fills.filter((f) => f.positionId === position.id && f.side === 'buy').sort((a, b) => a.time - b.time)
  const entry = buys[0]
  const snapshot = snapshots.get(`${position.chain}:${position.tokenAddress}`)
  const change = snapshot?.priceChangePct.h24

  // Every reason this position cannot be judged, kept apart from a verdict of
  // "it was fine". An unmeasurable case is not a passing one.
  if (!entry || !snapshot || change === null || change === undefined || change <= -100 || now - entry.time > DAY) {
    unmeasurable.push(position.symbol)
    continue
  }

  const price24hAgo = snapshot.priceUsd / (1 + change / 100)
  if (!(price24hAgo > 0)) { unmeasurable.push(position.symbol); continue }

  const qty = fills.filter((f) => f.positionId === position.id).reduce((t, f) => t + (f.side === 'buy' ? f.qty : -f.qty), 0)
  const putIn = buys.reduce((t, f) => t + f.qty * f.price, 0)
  const price = position.lastPriceUsd ?? snapshot.priceUsd

  judged.push({
    symbol: position.symbol,
    fellBeforePct: (entry.price / price24hAgo - 1) * 100,
    pnlUsd: (price - entry.price) * qty,
    putInUsd: putIn,
  })
}

const usd = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`

console.log('')
console.log(`  B. EL AHORRO — ${judged.length} posiciones abiertas en las últimas 24h se pueden juzgar`)
if (unmeasurable.length > 0) {
  console.log(`     ${unmeasurable.length} no: abiertas hace más de un día, o el escáner ya no las trae`)
  console.log(`     (${[...new Set(unmeasurable)].sort().join(', ')})`)
}
console.log('')
console.log('     umbral   habría evitado    plata puesta       resultado de esas')
for (const limit of THRESHOLDS) {
  const refused = judged.filter((j) => j.fellBeforePct < -limit)
  const pnl = refused.reduce((t, j) => t + j.pnlUsd, 0)
  const putIn = refused.reduce((t, j) => t + j.putInUsd, 0)
  console.log(`     -${String(limit).padStart(2)}%   ${String(refused.length).padStart(10)}    ${('$' + putIn.toFixed(2)).padStart(12)}    ${usd(pnl).padStart(14)}`)
}

console.log('')
console.log('     las que MÁS venían cayendo cuando entramos:')
for (const j of [...judged].sort((a, b) => a.fellBeforePct - b.fellBeforePct).slice(0, 12)) {
  console.log(`       ${j.symbol.padEnd(12)} ya venía ${j.fellBeforePct.toFixed(1).padStart(7)}%   puesto $${j.putInUsd.toFixed(2).padStart(7)}   ahora ${usd(j.pnlUsd)}`)
}

const all = judged.reduce((t, j) => t + j.pnlUsd, 0)
console.log('')
console.log(`     las ${judged.length} juntas: ${usd(all)}`)
console.log('')
console.log('  Leer con cuidado: el "resultado" es de HOY. Una que viene cayendo puede')
console.log('  darse vuelta, y una que entró limpia puede hundirse después. Esto mide')
console.log('  qué habría rechazado la compuerta, no qué va a pasar mañana.')
console.log('')

await pool.end()
