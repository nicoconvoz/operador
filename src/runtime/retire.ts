/**
 * Operator entry point: take one token off the board.
 *
 * Separate from the engine on purpose. The engine decides for itself and is
 * meant to run unattended; this is a person overruling it, and the two should
 * not share a process, a schedule, or a reason to be running.
 *
 * Reads the same DATABASE_URL, does one thing, and exits.
 *
 *   npm run retire -- <chain> <address> "<reason>"
 */
import { retireToken } from '../application/retire.js'
import { PostgresStore } from '../infrastructure/persistence/postgres-store.js'
import { StoredAlertSink } from '../infrastructure/notifications/store-alerts.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { type PersistedPosition } from '../domain/persistence/store.js'

const CHAINS: readonly Chain[] = ['solana', 'bsc']

const [rawChain, address, ...reasonParts] = process.argv.slice(2)
const reason = reasonParts.join(' ').trim()

// Validated before anything connects. A retirement with no reason is a row in
// the blacklist that nobody can audit later, and "why is this token banned"
// is the only question that row exists to answer.
if (!rawChain || !CHAINS.includes(rawChain as Chain)) {
  console.error(`[fatal] chain must be one of ${CHAINS.join(', ')}`)
  process.exit(1)
}
if (!address) {
  console.error('[fatal] a token address is required')
  process.exit(1)
}
if (reason.length < 10) {
  console.error('[fatal] a reason is required, and it has to say something')
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[fatal] DATABASE_URL is required')
  process.exit(1)
}

const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
const sql = {
  query: async <T>(text: string, params?: readonly unknown[]) => {
    const result = await pool.query(text, params as unknown[])
    return { rows: result.rows as T[] }
  },
}

const store = new PostgresStore(sql)

try {
  const result = await retireToken(
    {
      store,
      alerts: new StoredAlertSink(store, (error) => console.error('[alerts]', error)),
      now: () => Date.now(),
      // Rebuilt from the fills, exactly as the engine does it. The fills are
      // the facts; anything else would be a second opinion about what is held.
      brokerFor: async (position: PersistedPosition) => {
        const broker = new PaperBroker({
          gasUsdPerSwap: Number(process.env.OPERADOR_GAS_USD ?? 0.05),
          initialCapital: position.capitalUsd,
          maxOpenEntries: Number(process.env.OPERADOR_MAX_DCA ?? 5) + 1,
          quality: () => position.quality,
        })
        broker.seed(await store.fillsFor(position.id))
        return broker
      },
    },
    { chain: rawChain as Chain, tokenAddress: address, reason },
  )

  if (!result.retired) {
    console.error(`[refused] ${result.refusal}`)
    process.exit(2)
  }

  console.log(`[retired] ${result.symbol ?? '(sin posición abierta)'} ${rawChain}:${address}`)
  console.log(`[retired] vendidos ${result.soldQty} por $${result.proceedsUsd.toFixed(2)}, ${result.cancelledOrders} orden(es) cancelada(s)`)
  console.log('[retired] en lista negra — el escáner no lo vuelve a ofrecer')
} finally {
  await pool.end()
}
