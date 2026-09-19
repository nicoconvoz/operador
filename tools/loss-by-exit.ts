/**
 * Where the money actually goes, broken down by WHICH EXIT took it.
 *
 * The operator's reading from the tape: *el problema no son las comisiones, son
 * las congeladas... pierden muchísimo.* This turns that into a number, because
 * this project has been wrong twice about where its time went and both times
 * the bottleneck was in neither hypothesis.
 *
 * Four exits can close a position and they are NOT the same trade:
 *
 *   🏁 Exit                      the strategy took a profit — cannot fill below cost
 *   🛟 Rescue BE                 breakeven rescue — cannot fill below cost
 *   🔁 Rotación                  the switch went off — cannot fill below cost
 *   ❄️ Salida por congelamiento  the ladder froze — EXEMPT from the no-loss guard
 *   ☠️ Death Exit                the asset stopped being an asset — EXEMPT too
 *
 * Only the last two can sell at a loss, so if the book is bleeding they are
 * where it bleeds. What this prints is how much, per exit, against what those
 * positions cost to build.
 *
 *   DATABASE_URL=... npx tsx tools/loss-by-exit.ts
 */
import { PostgresStore } from '../src/infrastructure/persistence/postgres-store.js'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL no está puesta. Copiala de Neon y volvé a correr esto.')
  process.exit(1)
}

// Built exactly as runtime/index.ts builds it — the only file that opens a real
// connection. The driver is imported dynamically there for the same reason it is
// here: the codebase stays installable and testable without Postgres present.
const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: url, max: 2 })
const sql = {
  query: async <T>(text: string, params?: readonly unknown[]) => {
    const result = await pool.query(text, params as unknown[])
    return { rows: result.rows as T[] }
  },
}

const store = new PostgresStore(sql)

// A stack trace is the wrong thing to hand an operator at 3am. Every one of
// these is something they can act on; anything else is printed as it came,
// because a diagnostic that guesses is worse than one that admits it.
let fills
try {
  fills = await store.allFills()
} catch (error) {
  const why = String((error as { code?: string }).code ?? error)
  const shown = url.replace(/:[^:@/]*@/, ':***@')
  console.error('')
  console.error('  No pude leer la base. La URL que recibí es:')
  console.error('    ' + shown)
  console.error('')
  if (why.includes('ECONNREFUSED') || why.includes('ENOTFOUND')) {
    console.error('  No hay nadie en esa dirección. Suele ser una URL incompleta:')
    console.error('  en PowerShell las comillas DOBLES interpretan el $ como variable,')
    console.error('  así que si tu contraseña tiene uno, se borra sin avisar.')
    console.error('  Usá comillas simples.')
  } else if (why.includes('password') || why.includes('28P01')) {
    console.error('  El servidor contestó y rechazó la contraseña.')
  } else if (why.includes('SELF_SIGNED') || why.includes('certificate')) {
    console.error('  Falta ?sslmode=require al final de la URL.')
  } else if (why.includes('42P01')) {
    console.error('  Esa base existe pero no tiene las tablas — ¿es la correcta?')
  } else {
    console.error('  ' + why)
  }
  console.error('')
  await pool.end()
  process.exit(1)
}

/** Average cost per position, walked in order — the ledger's own basis. */
const basis = new Map<string, { qty: number; cost: number }>()
type Row = { comment: string; realised: number; costUsd: number; n: number; worst: number }
const byExit = new Map<string, Row>()

let boughtUsd = 0
let totalCosts = 0

for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
  const held = basis.get(fill.positionId) ?? { qty: 0, cost: 0 }
  totalCosts += fill.costUsd

  if (fill.side === 'buy') {
    held.qty += fill.qty
    held.cost += fill.qty * fill.price
    boughtUsd += fill.qty * fill.price
    basis.set(fill.positionId, held)
    continue
  }

  // A sale realises the difference against the average paid for what it sells.
  const avg = held.qty > 0 ? held.cost / held.qty : fill.price
  const realised = (fill.price - avg) * fill.qty
  held.cost -= avg * fill.qty
  held.qty -= fill.qty
  basis.set(fill.positionId, held)

  const comment = fill.comment ?? '(sin comentario)'
  const row = byExit.get(comment) ?? { comment, realised: 0, costUsd: 0, n: 0, worst: 0 }
  row.realised += realised
  row.costUsd += fill.costUsd
  row.n += 1
  row.worst = Math.min(row.worst, realised)
  byExit.set(comment, row)
}

const usd = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`
const rows = [...byExit.values()].sort((a, b) => a.realised - b.realised)

console.log('')
console.log('  salida                          ventas      realizado      comisiones        la peor')
console.log('  ' + '─'.repeat(84))
for (const row of rows) {
  console.log(
    '  ' +
      row.comment.padEnd(30) +
      String(row.n).padStart(6) +
      usd(row.realised).padStart(15) +
      `$${row.costUsd.toFixed(2)}`.padStart(16) +
      usd(row.worst).padStart(15),
  )
}

const realised = rows.reduce((sum, row) => sum + row.realised, 0)
console.log('  ' + '─'.repeat(84))
console.log('  ' + 'TOTAL'.padEnd(30) + String(rows.reduce((s, r) => s + r.n, 0)).padStart(6) + usd(realised).padStart(15) + `$${totalCosts.toFixed(2)}`.padStart(16))
console.log('')
console.log(`  comprado en total   $${boughtUsd.toFixed(2)}`)
console.log(`  realizado NETO      ${usd(realised - totalCosts)}   (realizado menos todo lo que se llevó la cadena)`)
console.log('')

// What is still open, so the screen's figure can be reconciled with this one.
const openQty = [...basis.values()].filter((h) => h.qty > 1e-12)
if (openQty.length > 0) {
  const stillIn = openQty.reduce((sum, h) => sum + h.cost, 0)
  console.log(`  ${openQty.length} posiciones abiertas, $${stillIn.toFixed(2)} de costo adentro`)
  console.log('  (lo NO realizado vale eso a precio de compra; a precio de hoy lo dice la pantalla)')
  console.log('')
}

await pool.end()
