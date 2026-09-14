import { buildDashboard } from '../../src/application/dashboard.js'
import { buildUniverse } from '../../src/application/universe-view.js'
import { buildOperations } from '../../src/application/operations-view.js'
import { openStore } from '../lib/store.js'
import { Console, type ConsoleData } from './console.js'

// A cached view of a trading system is worse than no view: a stale "all
// healthy" reads exactly like a live one. This renders the FIRST frame on the
// server, so the page is useful before any JavaScript runs; from then on the
// Console keeps itself current by fetching, never by reloading.
export const dynamic = 'force-dynamic'
export const revalidate = 0

async function load(): Promise<ConsoleData | { error: string }> {
  try {
    const store = openStore()
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

  return <Console initial={data} />
}
