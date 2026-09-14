import { buildDashboard, type DashboardView } from '../../src/application/dashboard.js'
import { PostgresStore } from '../../src/infrastructure/persistence/postgres-store.js'
import { Pool } from 'pg'

// A cached view of a trading system is worse than no view: a stale "all
// healthy" reads exactly like a live one.
export const dynamic = 'force-dynamic'
export const revalidate = 0

let pool: Pool | null = null

async function load(): Promise<DashboardView | { error: string }> {
  if (!process.env.DATABASE_URL) return { error: 'DATABASE_URL is not set' }
  try {
    pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    const sql = {
      query: async <T,>(text: string, params?: readonly unknown[]) => {
        const result = await pool!.query(text, params as unknown[])
        return { rows: result.rows as T[] }
      },
    }
    return await buildDashboard(new PostgresStore(sql), { now: () => Date.now() })
  } catch (error) {
    return { error: String(error).slice(0, 200) }
  }
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

const STAGE = { healthy: '', frozen: ' ❄️', dead: ' ☠️' } as const

export default async function Page() {
  const view = await load()

  if ('error' in view) {
    return (
      <>
        <h1 style={{ fontSize: 18 }}>Operador by Open Doors</h1>
        <p style={{ color: '#ff6b6b' }}>Cannot read state: {view.error}</p>
      </>
    )
  }

  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Operador by Open Doors</h1>
        <span style={{ color: view.killSwitchEngaged ? '#ff6b6b' : '#63e6a5' }}>
          {view.killSwitchEngaged ? '🛑 STOPPED' : '▶️ Running'}
        </span>
      </header>

      {view.warnings.length > 0 && (
        <section style={{ border: '1px solid #ffb454', borderRadius: 6, padding: '12px 16px', marginBottom: 24 }}>
          {view.warnings.map((warning) => (
            <div key={warning} style={{ color: '#ffb454' }}>⚠️ {warning}</div>
          ))}
        </section>
      )}

      <section style={{ display: 'flex', gap: 32, marginBottom: 24, flexWrap: 'wrap' }}>
        <Stat label="Positions" value={String(view.totals.positions)} />
        <Stat label="Committed" value={money(view.totals.committedUsd)} />
        <Stat label="Frozen" value={String(view.totals.frozen)} />
        <Stat label="Blacklisted" value={String(view.blacklistedCount)} />
      </section>

      {view.positions.length === 0 ? (
        <p style={{ color: '#8b949e' }}>No open positions.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#8b949e', borderBottom: '1px solid #21262d' }}>
              <th style={{ padding: '8px 0' }}>Token</th>
              <th>Capital</th>
              <th>DCA</th>
              <th>Price</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {view.positions.map((position) => (
              <tr key={position.id} style={{ borderBottom: '1px solid #161b22' }}>
                <td style={{ padding: '8px 0' }}>
                  {position.symbol}
                  {STAGE[position.deathStage]}
                  {position.hasPendingOrders ? ' ⏳' : ''}
                  {position.deathSignals.length > 0 && (
                    <div style={{ color: '#8b949e', fontSize: 12 }}>{position.deathSignals[0]}</div>
                  )}
                </td>
                <td>{money(position.capitalUsd)}</td>
                <td>{position.filledDcas}</td>
                <td>{position.lastPriceUsd === null ? '—' : position.lastPriceUsd.toPrecision(6)}</td>
                <td style={{ color: '#8b949e' }}>{ago(position.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer style={{ marginTop: 32, color: '#8b949e', fontSize: 12 }}>
        {view.lastScan
          ? `Last scan ${ago(view.lastScan.at)} · ${view.lastScan.tokensSeen} tokens seen`
          : 'No scan recorded yet'}
        {' · read-only'}
      </footer>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: '#8b949e', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20 }}>{value}</div>
    </div>
  )
}
