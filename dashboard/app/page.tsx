import { buildDashboard, type DashboardView } from '../../src/application/dashboard.js'
import { buildUniverse, type UniverseView } from '../../src/application/universe-view.js'
import { PostgresStore } from '../../src/infrastructure/persistence/postgres-store.js'
import { Universe } from './universe.js'
import { Pool } from 'pg'

// A cached view of a trading system is worse than no view: a stale "all
// healthy" reads exactly like a live one.
export const dynamic = 'force-dynamic'
export const revalidate = 0

let pool: Pool | null = null

async function load(): Promise<{ dashboard: DashboardView; universe: UniverseView } | { error: string }> {
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
    const [dashboard, universe] = await Promise.all([buildDashboard(store, { now }), buildUniverse(store, { now })])
    return { dashboard, universe }
  } catch (error) {
    return { error: String(error).slice(0, 200) }
  }
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export default async function Page() {
  const data = await load()

  if ('error' in data) {
    return (
      <>
        <h1 style={{ fontSize: 17, margin: '0 0 8px' }}>Operador by Open Doors</h1>
        <p style={{ color: '#ff6b6b' }}>Cannot read state: {data.error}</p>
      </>
    )
  }

  const { dashboard, universe } = data

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
          {dashboard.killSwitchEngaged ? '🛑 STOPPED' : '▶️ Running'}
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
        <Stat label="Positions" value={String(dashboard.totals.positions)} />
        <Stat label="Committed" value={money(dashboard.totals.committedUsd)} />
        <Stat label="Universe" value={String(universe.tokens.length)} />
        <Stat label="Frozen" value={String(dashboard.totals.frozen)} />
        <Stat label="Blacklisted" value={String(dashboard.blacklistedCount)} />
      </section>

      <Universe view={universe} />

      <footer style={{ marginTop: 18, color: '#8b949e', fontSize: 12 }}>
        {universe.scannedAt ? `Scanned ${ago(universe.scannedAt)}` : 'No scan recorded yet'}
        {' · size = liquidity · rings = opportunity · glow = in position · read-only'}
      </footer>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: '#8b949e', fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 19 }}>{value}</div>
    </div>
  )
}
