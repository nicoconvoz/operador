import { buildDashboard } from '../../../../src/application/dashboard.js'
import { buildUniverse } from '../../../../src/application/universe-view.js'
import { DEFAULT_PARAMS } from '../../../../src/domain/strategy/params.js'
import { productionLadder } from '../../../../src/application/production-ladder.js'
import { buildOperations } from '../../../../src/application/operations-view.js'
import { DexScreener } from '../../../../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { makeHttpGet } from '../../../../src/infrastructure/http.js'
import { openStore, failed } from '../../../lib/store.js'

/**
 * Everything the screen shows, in one request.
 *
 * The page used to be reloaded to refresh it, which wiped the canvas, reset
 * every orbit and dropped whatever the viewer had selected — a flinch once a
 * minute that told them nothing. Now the page fetches this and swaps the data
 * underneath itself.
 *
 * One request rather than three: three would arrive at three different moments
 * and the screen would show a position that exists in one panel and not the
 * other. A single read is a single instant.
 */
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const store = openStore()
    const now = () => Date.now()
    const ladder = productionLadder(process.env)
    const [dashboard, universe, operations] = await Promise.all([
      buildDashboard(store, { now }),
      buildUniverse(store, { now }),
      buildOperations(store, {
        now,
        // The ladder the ENGINE runs, not the reference's. Drawing
        // DEFAULT_PARAMS put a $1,000 rung beside a $15 order for days.
        params: { ...DEFAULT_PARAMS, maxUsdPerLevel: ladder.maxUsdPerLevel, dropInitPct: ladder.dropInitPct },
        maxOpenEntries: ladder.maxOpenEntries,
        // THIRTY, for the Registro tab. The tape grows without bound and the
        // screen does not: a page listing every buy and sell since the engine
        // started is a page nobody can read the top of, and on a phone that is
        // the whole page. The rest is a file — /api/fills, with a date range —
        // rather than deleted from view.
        tapeLength: 30,
        // The live market price for what is HELD, so the unrealised figure
        // moves between bars instead of standing still for fifteen minutes.
        //
        // One batched request per chain — DexScreener takes thirty addresses at
        // a time and allows three hundred a minute, against a page that polls
        // every twenty seconds. The read model decides what to do with it; this
        // only fetches.
        livePrices: async () => {
          const held = await store.loadPositions()
          const prices = new Map<string, number>()
          const byChain = new Map<string, string[]>()
          for (const p of held) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.tokenAddress])

          const dex = new DexScreener(makeHttpGet({ timeoutMs: 6_000 }))
          for (const [chain, addresses] of byChain) {
            for (let i = 0; i < addresses.length; i += 30) {
              // One chain failing must not cost the others their prices.
              try {
                const pairs = await dex.tokens(chain as 'solana' | 'bsc', addresses.slice(i, i + 30))
                for (const m of dex.toMarketSnapshots(chain as 'solana' | 'bsc', pairs)) {
                  if (m.priceUsd > 0) prices.set(`${chain}:${m.address}`, m.priceUsd)
                }
              } catch {
                // Falls back to the bar close, and the screen says which.
              }
            }
          }
          return prices
        },
      }),
    ])
    return Response.json({ dashboard, universe, operations }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failed(error)
  }
}
