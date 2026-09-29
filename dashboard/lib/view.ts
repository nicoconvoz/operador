import { lastFillsReadAt } from './store.js'
import { buildDashboard } from '../../src/application/dashboard.js'
import { buildUniverse } from '../../src/application/universe-view.js'
import { buildOperations } from '../../src/application/operations-view.js'
import { buildDailyLog } from '../../src/application/daily-log.js'
import { productionLadder } from '../../src/application/production-ladder.js'
import { productionDoors } from '../../src/application/production-doors.js'
import { bookCapital, freeSlots } from '../../src/application/free-capital.js'
import { DEFAULT_PARAMS } from '../../src/domain/strategy/params.js'
import { DexScreener, type MarketSnapshot } from '../../src/infrastructure/adapters/dexscreener/dexscreener.js'
import { JupiterTokens } from '../../src/infrastructure/adapters/jupiter/jupiter-tokens.js'
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
  /**
   * The Log tab and the "funcionando hace…" counter. Built HERE, beside the
   * rest, so the first frame and the poll cannot disagree about it either.
   */
  readonly log: Awaited<ReturnType<typeof buildDailyLog>>
  /** When the fills behind the money figures were read, or null before the first read. */
  readonly moneyReadAt: number | null
}

export async function buildView(store: StatePort): Promise<ViewData> {
  const now = () => Date.now()
  const ladder = productionLadder(process.env)
  // The same doors the ENGINE ranks with, from the same module. Three literal
  // copies of these numbers lived in three files until now.
  const doors = productionDoors(process.env)

  // ONE request for both readers.
  //
  // The universe wants the whole market to re-score what we hold; the
  // operations view wants the price to value it. Fetching twice would double a
  // bill that is already paid, and — worse — let the two views disagree about
  // the same token in the same frame, which is the exact failure this single
  // builder exists to prevent.
  const markets = liveMarkets(store)

  // How many more tokens the free capital can take — the engine's own count,
  // from the same function — so the canvas never draws more candidates than
  // the engine would open. Only when the capital is known here: without
  // OPERADOR_CAPITAL_USD the screen draws what the scan stored, which the
  // engine already cut, and says nothing about free slots.
  const capital = Number(process.env.OPERADOR_CAPITAL_USD?.trim())
  const slots = Number.isFinite(capital) && capital > 0
    ? freeSlots(bookCapital(capital, await store.allFills(), await store.loadPositions()), ladder.slotUsd)
    : undefined

  const [dashboard, universe, operations, log] = await Promise.all([
    buildDashboard(store, { now }),
    // The same floors the engine ranks on. A screen that drew a token as
    // eligible while the book would refuse it is the exact drift this single
    // builder exists to prevent.
    buildUniverse(store, {
      now,
      liveMarkets: () => markets,
      minComponents: doors.minComponents,
      // And the first-buy door, so the canvas never offers what the engine
      // will not open.
      entryDoors: doors.entryDoors,
      // And the engine's own SCORE door. Without it the canvas draws as
      // buyable everything the floors let through, the book's own threshold
      // included — the screen-versus-engine disagreement this single builder
      // exists to prevent.
      minScore: doors.minScore,
      // And its reserve switch: a token the engine will not buy is not drawn
      // as a fallback it might.
      reserve: doors.reserve,
      // And its ORDER and its cut: the cheapest to trade first, and never more
      // candidates than the capital can take.
      order: doors.order,
      ...(slots !== undefined ? { freeSlots: slots } : {}),
    }),
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
      // The ladder the engine BUYS: every buy, the first included, $1 on a 3%
      // dip and a 2% bounce, twenty at most — ONE box with the count and the
      // watch in words, read off the watch the sweep wrote down. From the same
      // module the engine reads — the 20% collapse ceiling included, so a
      // collapsed watch is drawn as the line it waits to be back over.
      // Each DCA's own dip, bounce and ceiling are drawn from the steps.
      dipBounce: {
        dipPct: ladder.dipPct, bouncePct: ladder.bouncePct, maxSteps: ladder.maxSteps, maxDipPct: ladder.maxDipPct,
        dipStepPct: ladder.dipStepPct, bounceStepPct: ladder.bounceStepPct, stepUsd: ladder.stepUsd,
      },
      // The deep rung, drawn only when it is switched back on.
      ...(ladder.deepRung
        ? { deepRung: { fallPct: ladder.deepRungFallPct, reboundPct: ladder.deepRungReboundPct, usd: ladder.deepRungUsd } }
        : {}),
      // Ladder A, drawn instead only when it is switched back on — the screen
      // never offers rungs the engine will not buy. At each position's own
      // spacing, behind the same switches the sweep reads.
      ...(ladder.dropLadder
        ? {
            dropLadder: {
              dropsPct: ladder.dcaDropsPct, rungsUsd: ladder.dcaRungsUsd, from: ladder.dcaFrom,
              adaptive: ladder.dcaAdaptive, realtime: ladder.dcaRealtime,
            },
          }
        : {}),
      // A hundred, of which the Registro DRAWS thirty. The tape grows without
      // bound and the screen does not — but the search box filters before the
      // cut, so the rows it can reach are the rows shipped here. About twelve
      // hours of fills at the current pace, and a few kilobytes compressed per
      // poll; no extra database read, because every fill is read anyway. Open
      // positions need none of it: each carries its whole history already.
      tapeLength: 100,
      livePrices: async () => {
        const prices = new Map<string, number>()
        for (const [key, market] of await markets) prices.set(key, market.priceUsd)
        return prices
      },
    }),
    // What the ENGINE wrote, day by day — never recomputed here. The rows are
    // the headline's own figure as the engine sampled it; recomputing them on
    // the screen would be a second implementation of "how much are we up".
    buildDailyLog(store, { now }),
  ])

  // How old the money is, read AFTER the builders so it reflects the value
  // they actually walked rather than a refetch they triggered.
  return { dashboard, universe, operations, log, moneyReadAt: lastFillsReadAt() }
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

  const http = makeHttpGet({ timeoutMs: 6_000 })
  const dex = new DexScreener(http)
  for (const [chain, addresses] of byChain) {
    // Solana from JUPITER, per mint, exactly as the engine prices it — the one
    // screen the operator reads must show the number the engine decides on. A
    // screen valuing the book from DexScreener while the stop cuts on Jupiter
    // would disagree about the only figure that matters, which is the drift
    // this read model exists to prevent.
    if (chain === 'solana') {
      try {
        for (const m of await new JupiterTokens(http).markets('solana', addresses, { refresh: true })) {
          markets.set(`${chain}:${m.address}`, m)
        }
      } catch {
        // Falls back to the stored numbers, and the screen says which.
      }
      continue
    }
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
