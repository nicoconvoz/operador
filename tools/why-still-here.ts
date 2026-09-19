/**
 * Everything the engine knows about ONE position, and why it has not left.
 *
 * The operator on PERK: *está re muerta y perdiendo, y nunca sacó esa moneda de
 * circulación... si todo da que está completamente inmóvil hay que hacerle un
 * corte antes de que nos consuma.*
 *
 * The machinery for that exists — abandonment freezes at 3h without a trade and
 * condemns at 12h, and `exitOnFreeze` sells on the freeze, exempt from the
 * no-loss guard precisely so a dead token can leave at any price. So either the
 * signal never fired or it fired and something refused it, and those are very
 * different repairs. Guessing between them is how this project has burned whole
 * afternoons; the tape says which.
 *
 * It also counts the BUYS, because the same operator reports two rungs per coin
 * where the configuration says one.
 *
 *   DATABASE_URL='...' npx tsx tools/why-still-here.ts PERK
 */
import { PostgresStore } from '../src/infrastructure/persistence/postgres-store.js'
import { evaluateGates, DEFAULT_GATE_POLICY } from '../src/domain/scanner/gates.js'

const wanted = (process.argv[2] ?? '').trim().toUpperCase()
if (!wanted) {
  console.error('Decime qué moneda mirar:  npx tsx tools/why-still-here.ts PERK')
  process.exit(1)
}

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

const positions = await store.loadPositions()
const found = positions.filter((p) => p.symbol.toUpperCase() === wanted)
if (found.length === 0) {
  console.log('')
  console.log(`  No hay ninguna posición abierta con el símbolo ${wanted}.`)
  console.log(`  Abiertas ahora: ${positions.map((p) => p.symbol).sort().join(', ')}`)
  console.log('')
  await pool.end()
  process.exit(0)
}

const allFills = await store.allFills()
const scans = await store.latestScansByChain()
const hours = (ms: number) => `${((Date.now() - ms) / 3_600_000).toFixed(1)}h`
const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d))

for (const position of found) {
  const fills = allFills.filter((f) => f.positionId === position.id).sort((a, b) => a.time - b.time)
  const buys = fills.filter((f) => f.side === 'buy')
  const qty = fills.reduce((t, f) => t + (f.side === 'buy' ? f.qty : -f.qty), 0)
  const paid = buys.reduce((t, f) => t + f.qty * f.price, 0)
  const avg = buys.length > 0 ? paid / buys.reduce((t, f) => t + f.qty, 0) : null
  const value = position.lastPriceUsd !== null ? qty * position.lastPriceUsd : null

  console.log('')
  console.log(`  ══ ${position.symbol}  (${position.chain})  ${position.tokenAddress}`)
  console.log('')
  console.log(`  capital asignado   $${n(position.capitalUsd)}`)
  console.log(`  COMPRAS            ${buys.length}     ← la configuración dice 1`)
  for (const [i, buy] of buys.entries()) {
    console.log(`     ${i + 1}. ${new Date(buy.time).toISOString().slice(5, 16).replace('T', ' ')}  ${buy.qty.toFixed(4)} @ ${buy.price}  = $${(buy.qty * buy.price).toFixed(2)}  ${buy.comment}`)
  }
  console.log(`  costo promedio     ${avg === null ? '—' : avg}`)
  console.log(`  precio del motor   ${position.lastPriceUsd ?? '—'}`)
  console.log(`  vale ahora         ${value === null ? '—' : '$' + value.toFixed(2)}   (contra $${paid.toFixed(2)} puesto)`)
  console.log('')

  // ── Why it has not left ──────────────────────────────────────────────────
  const watch = position.deathWatch
  console.log(`  VIGÍA DE MUERTE    etapa: ${watch.stage}`)
  console.log(`     evidencia de salida     ${watch.exitEvidence} de 3 consecutivas`)
  console.log(`     racha limpia            ${watch.cleanStreak}`)
  console.log(`     liquidez a la entrada   $${n(watch.entryLiquidityUsd, 0)}`)
  const recent = [...watch.evidence].slice(-6).reverse()
  if (recent.length === 0) {
    console.log('     sin observaciones registradas  ← el vigía nunca dijo nada')
  }
  for (const record of recent) {
    const signals = record.signals.map((s) => `[${s.stage}] ${s.kind}: ${s.detail}`).join(' | ')
    console.log(`     ${hours(record.observedAt).padStart(7)} atrás  ${record.verdict.padEnd(7)} ${signals || '(sin señales)'}`)
  }
  console.log('')

  // ── What the scanner last saw ────────────────────────────────────────────
  const scan = scans.find((s) => s.chain === position.chain)
  const snapshot = scan?.snapshots.find((s) => s.address === position.tokenAddress)
  console.log(`  ÚLTIMO EXAMEN      ${scan ? hours(scan.scannedAt) + ' atrás' : 'nunca'}`)
  if (!snapshot) {
    console.log('     el escáner NO la trae en el último barrido  ← nadie volvió a mirarla')
  } else {
    console.log(`     liquidez           $${n(snapshot.liquidityUsd, 0)}`)
    console.log(`     volumen 24h        $${n(snapshot.volumeUsd.h24, 0)}      1h: $${n(snapshot.volumeUsd.h1, 0)}`)
    console.log(`     operaciones 1h     ${snapshot.txns.h1.buys + snapshot.txns.h1.sells}   24h: ${snapshot.txns.h24.buys + snapshot.txns.h24.sells}`)
    console.log(`     cambio 1h / 24h    ${n(snapshot.priceChangePct.h1)}%  /  ${n(snapshot.priceChangePct.h24)}%`)
    console.log(`     sin operar hace    ${snapshot.lastTradeAgoHours === null || snapshot.lastTradeAgoHours === undefined ? 'NO MEDIDO  ← por eso el abandono no puede dispararse' : n(snapshot.lastTradeAgoHours, 1) + 'h'}`)
    console.log(`     examinada          ${snapshot.securityChecked === false ? 'NO' : 'sí'}`)
    const failures = evaluateGates(snapshot, DEFAULT_GATE_POLICY).failures
    console.log(`     compuertas         ${failures.length === 0 ? 'todas pasan' : failures.map((f) => `${f.gate}(${f.reason})`).join(', ')}`)
  }
  console.log('')
}

await pool.end()
