import { buildView } from '../lib/view.js'
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
    // The SAME builder the poll uses. They were two call sites with their own
    // arguments and they drifted within an hour: the page valued the book at
    // the last bar close while the poll valued it live, so opening the app
    // showed one number and replaced it with a different one seconds later.
    return await buildView(openStore())
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
