import { buildDashboard } from '../../src/application/dashboard.js'
import { buildUniverse } from '../../src/application/universe-view.js'
import { buildOperations } from '../../src/application/operations-view.js'
import { productionLadder } from '../../src/application/production-ladder.js'
import { DEFAULT_PARAMS } from '../../src/domain/strategy/params.js'
import { DexScreener, type MarketSnapshot } from '../../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { makeHttpGet } from '../../src/infrastructure/http.js'
import { type StatePort } from '../../src/domain/persistence/store.js'

/**
 * Everything the screen shows, built ONCE.
 *
 * The server renders the first frame and the console then polls `/api/view` for
 * every frame after it. Those were two call sites with their own arguments, and
 * they drifted within an hour of the second one gaining a feature: the page
 * valued the book at the last BAR CLOSE while the poll valued it LIVE, so
 * opening the app showed one number and replaced it with a different one a few
 * seconds later.
 *
 * Reported exactly that way — *"me sale 1.78 positivo y después se pasa a 2
 * negativo, como si al principio se hubiera congelado en un monto que nunca
 * fue"*. Both numbers were real; they were answers to different questions asked
 * by two copies of the same view.
 *
 * It is the same failure `buildDashboard` exists to prevent, one layer out:
 * two implementations of "how much are we up" will eventually disagree, and the
 * one on the screen is the one you will believe. There is one now.
 */
export interface ViewData {
  readonly dashboard: Awaited<ReturnType<typeof buildDashboard>>
  readonly universe: Awaited<ReturnType<typeof buildUniverse>>
  readonly operations: Awaited<ReturnType<typeof buildOperations>>
}

export async function buildView(store: StatePort): Promise<ViewData> {
  const now = () => Date.now()
  const ladder = productionLadder(process.env)

  // ONE request for both readers.
  //
  // The universe wants the whole market to re-score what we hold; the
  // operations view wants the price to value it. Fetching twice would double a
  // bill that is already paid, and — worse — let the two views disagree about
  // the same token in the same frame, which is the exact failure this single
  // builder exists to prevent.
  const markets = liveMarkets(store)

  const [dashboard, universe, operations] = await Promise.all([
    buildDashboard(store, { now }),
    buildUniverse(store, { now, liveMarkets: () => markets }),
    buildOperations(store, {
      now,
      // The ladder the ENGINE runs, not the reference's. Drawing DEFAULT_PARAMS
      // put a $1,000 rung beside a $15 order for days.
      params: {
        ...DEFAULT_PARAMS,
        maxUsdPerLevel: ladder.maxUsdPerLevel,
        dropInitPct: ladder.dropInitPct,
        impatientProfitPct: ladder.impatientProfitPct,
        urgentProfitPct: ladder.urgentProfitPct,
      },
      maxOpenEntries: ladder.maxOpenEntries,
      // Thirty, for the Registro tab. The tape grows without bound and the
      // screen does not.
      tapeLength: 30,
      livePrices: async () => {
        const prices = new Map<string, number>()
        for (const [key, market] of await markets) prices.set(key, market.priceUsd)
        return prices
      },
    }),
  ])

  return { dashboard, universe, operations }
}

/**
 * The live MARKET for what is HELD — price, liquidity, volume, the price
 * changes and the transaction counts.
 *
 * It used to keep the price and throw the rest away, so the unrealised figure
 * moved between bars while every number explaining it sat at whatever the
 * hourly scan last saw. The response already carried all of it: widening this
 * costs not one extra request.
 *
 * One batched call per chain — DexScreener takes thirty addresses at a time and
 * allows three hundred a minute, against a page that polls every ten seconds.
 * One chain failing must not cost the others theirs, and a failure falls back
 * to the stored numbers with the screen saying which.
 */
async function liveMarkets(store: StatePort): Promise<ReadonlyMap<string, MarketSnapshot>> {
  const held = await store.loadPositions()
  const markets = new Map<string, MarketSnapshot>()
  const byChain = new Map<string, string[]>()
  for (const p of held) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.tokenAddress])

  const dex = new DexScreener(makeHttpGet({ timeoutMs: 6_000 }))
  for (const [chain, addresses] of byChain) {
    for (let i = 0; i < addresses.length; i += 30) {
      try {
        const pairs = await dex.tokens(chain as 'solana' | 'bsc', addresses.slice(i, i + 30))
        for (const m of dex.toMarketSnapshots(chain as 'solana' | 'bsc', pairs)) {
          // A zero price is not a price. Letting it through would value the
          // book at nothing and score the token as if its pool had vanished.
          if (m.priceUsd > 0) markets.set(`${chain}:${m.address}`, m)
        }
      } catch {
        // Falls back to the stored numbers, and the screen says which.
      }
    }
  }
  return markets
}
