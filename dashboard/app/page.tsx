import { buildDashboard, type DashboardView } from '../../src/application/dashboard.js'
import { buildUniverse, type UniverseView } from '../../src/application/universe-view.js'
import { buildOperations, type OperationsView } from '../../src/application/operations-view.js'
import { PostgresStore } from '../../src/infrastructure/persistence/postgres-store.js'
import { Console } from './console.js'
import { Pool } from 'pg'

// A cached view of a trading system is worse than no view: a stale "all
// healthy" reads exactly like a live one.
export const dynamic = 'force-dynamic'
export const revalidate = 0

let pool: Pool | null = null

interface Loaded {
  dashboard: DashboardView
  universe: UniverseView
  operations: OperationsView
}

async function load(): Promise<Loaded | { error: string }> {
  if (!process.env.DATABASE_URL) return { error: 'DATABASE_URL is not set' }
  try {
    pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    const sql = {
      query: async <T,>(text: string, params?: readonly unknown[]) => {
        const result = await pool!.query(text, params as unknown[])
        return { rows: result.rows as T[] }
      },
    }
    const store = new PostgresStore(sql)
    const now = () => Date.now()
    const [dashboard, universe, operations] = await Promise.all([
      buildDashboard(store, { now }),
      buildUniverse(store, { now }),
      buildOperations(store, { now }),
    ])
    return { dashboard, universe, operations }
  } catch (error) {
    return { error: String(error).slice(0, 200) }
  }
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 60) return `hace ${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `hace ${hours}h` : `hace ${Math.round(hours / 24)}d`
}

export default async function Page() {
  const data = await load()

  if ('error' in data) {
    return (
      <>
        <h1 style={{ fontSize: 17, margin: '0 0 8px' }}>Operador by Open Doors</h1>
        <p style={{ color: '#ff6b6b' }}>No se puede leer el estado: {data.error}</p>
      </>
    )
  }

  const { dashboard, universe, operations } = data

  return (
    <>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        <h1 style={{ fontSize: 17, margin: 0 }}>Operador by Open Doors</h1>
        <span style={{ color: dashboard.killSwitchEngaged ? '#ff6b6b' : '#63e6a5' }}>
          {dashboard.killSwitchEngaged ? '🛑 DETENIDO' : '▶️ Funcionando'}
        </span>
      </header>

      {dashboard.warnings.length > 0 && (
        <section style={{ border: '1px solid #ffb454', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          {dashboard.warnings.map((warning) => (
            <div key={warning} style={{ color: '#ffb454', fontSize: 13 }}>
              ⚠️ {warning}
            </div>
          ))}
        </section>
      )}

      <section style={{ display: 'flex', gap: 22, marginBottom: 14, flexWrap: 'wrap' }}>
        <Stat label="Posiciones" value={String(dashboard.totals.positions)} />
        <Stat label="Comprometido" value={money(dashboard.totals.committedUsd)} />
        <Stat
          label="No realizado"
          value={`${operations.totals.unrealisedUsd >= 0 ? '+' : ''}${money(operations.totals.unrealisedUsd)}`}
          color={operations.totals.unrealisedUsd >= 0 ? '#63e6a5' : '#ff6b6b'}
        />
        <Stat label="Universo" value={String(universe.tokens.length)} />
        <Stat label="Congeladas" value={String(dashboard.totals.frozen)} />
        <Stat label="En lista negra" value={String(dashboard.blacklistedCount)} />
      </section>

      <Console universe={universe} operations={operations} />

      <footer style={{ marginTop: 18, color: '#8b949e', fontSize: 12 }}>
        {universe.scannedAt ? `Escaneado ${ago(universe.scannedAt)}` : 'Todavía no se registró ningún escaneo'}
        {' · tamaño = liquidez · anillos = oportunidad · brillo = en posición · solo lectura'}
      </footer>
    </>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ color: '#8b949e', fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 19, color }}>{value}</div>
    </div>
  )
}
