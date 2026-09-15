import { triggerPrice, usdForLevel } from '../domain/strategy/ladder.js'
import { type CascadeParams, DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'
import { type PersistedFill, type StatePort } from '../domain/persistence/store.js'

/**
 * What the broker is actually DOING — as opposed to where it might act.
 *
 * The universe view answers "what is out there". This answers "what happened,
 * what is open, and what is it worth". They are different questions and a
 * screen that only answers the first looks busy while telling you nothing.
 *
 * Read-only, and computed from fills rather than from any running total. A
 * counter that drifts from its own transactions is the classic way a trading
 * dashboard starts lying: the fills are the facts, everything else is derived
 * from them on demand.
 */

export interface LadderRung {
  readonly level: number
  /** Price at which this level arms, from the position's own anchor. */
  readonly triggerPrice: number | null
  readonly nominalUsd: number
  readonly filled: boolean
  /** What it actually cost, when filled. */
  readonly fillPrice: number | null
  readonly fillUsd: number | null
  /** True for the level the strategy is currently waiting on. */
  readonly pending: boolean
  /** Beyond what the venue will fill: signalled, never executed. */
  readonly beyondPyramiding: boolean
}

export interface PositionOperations {
  readonly id: string
  readonly symbol: string
  readonly chain: string
  readonly deathStage: 'healthy' | 'frozen' | 'dead'

  readonly capitalUsd: number
  /** Cash actually committed by fills, not the nominal ladder. */
  readonly deployedUsd: number
  readonly qty: number
  readonly avgCostUsd: number | null
  readonly lastPriceUsd: number | null
  readonly marketValueUsd: number | null
  readonly unrealisedUsd: number | null
  readonly unrealisedPct: number | null
  /** Spread, impact and gas charged on the fills so far. */
  readonly costsUsd: number

  readonly ladder: readonly LadderRung[]
  readonly fills: readonly PersistedFill[]
  readonly openedAt: number
  readonly updatedAt: number
  readonly hasPendingOrders: boolean
}

export interface OperationsView {
  readonly generatedAt: number
  readonly positions: readonly PositionOperations[]
  /** Newest first, across every position. The tape. */
  readonly recentFills: readonly (PersistedFill & { readonly symbol: string })[]
  readonly totals: {
    readonly deployedUsd: number
    readonly marketValueUsd: number
    readonly unrealisedUsd: number
    readonly costsUsd: number
    readonly buys: number
    readonly sells: number
  }
}

export interface OperationsOptions {
  readonly now: () => number
  readonly params?: CascadeParams
  readonly tapeLength?: number
}

export async function buildOperations(store: StatePort, options: OperationsOptions): Promise<OperationsView> {
  const generatedAt = options.now()
  const params = options.params ?? DEFAULT_PARAMS
  const positions = await store.loadPositions()

  const built: PositionOperations[] = []
  const tape: (PersistedFill & { symbol: string })[] = []

  for (const position of positions) {
    const fills = await store.fillsFor(position.id)
    for (const fill of fills) tape.push({ ...fill, symbol: position.symbol })

    const buys = fills.filter((f) => f.side === 'buy')
    const qty = buys.reduce((sum, f) => sum + f.qty, 0) - fills.filter((f) => f.side === 'sell').reduce((s, f) => s + f.qty, 0)
    const deployedUsd = buys.reduce((sum, f) => sum + f.price * f.qty, 0)
    const costsUsd = fills.reduce((sum, f) => sum + f.costUsd, 0)
    const avgCostUsd = qty > 0 ? deployedUsd / buys.reduce((s, f) => s + f.qty, 0) : null

    const price = position.lastPriceUsd
    const marketValueUsd = price !== null && qty > 0 ? qty * price : null
    const unrealisedUsd = marketValueUsd !== null && avgCostUsd !== null ? (price! - avgCostUsd) * qty : null

    // The ladder: what the strategy planned, against what actually filled.
    const filledByLevel = new Map<number, PersistedFill>()
    for (const fill of buys) {
      const level = fill.orderId === 'Entry' ? 0 : Number.parseInt(fill.orderId.replace('DCA-', ''), 10)
      if (Number.isFinite(level)) filledByLevel.set(level, fill)
    }

    // The rung whose ORDER is in flight, when there is one.
    //
    // The machine advances to level N the moment it SIGNALS that level, but
    // the order does not fill until the next bar's open. Pointing at the
    // machine's level during that window says "waiting for DCA-1" while the
    // Entry — the order actually in flight — sits unmarked, and a reader would
    // conclude the entry had already happened.
    const inFlight = position.pendingOrders.find((order) => order.kind === 'entry')
    const waitingOn = inFlight?.level ?? position.cascade.level

    const ladder: LadderRung[] = Array.from({ length: Math.min(params.maxLevels + 1, 12) }, (_, level) => {
      const fill = filledByLevel.get(level)
      return {
        level,
        triggerPrice: level === 0 || position.cascade.ep1 === null ? null : triggerPrice(params, position.cascade.ep1, level),
        nominalUsd: usdForLevel(params, level),
        filled: fill !== undefined,
        fillPrice: fill?.price ?? null,
        fillUsd: fill ? fill.price * fill.qty : null,
        pending: level === waitingOn && !fill,
        // The venue fills ten entries; the machine keeps signalling past that.
        beyondPyramiding: level >= PYRAMIDING,
      }
    })

    built.push({
      id: position.id,
      symbol: position.symbol,
      chain: position.chain,
      deathStage: position.deathWatch.stage,
      capitalUsd: position.capitalUsd,
      deployedUsd,
      qty,
      avgCostUsd,
      lastPriceUsd: price,
      marketValueUsd,
      unrealisedUsd,
      unrealisedPct: unrealisedUsd !== null && deployedUsd > 0 ? (unrealisedUsd / deployedUsd) * 100 : null,
      costsUsd,
      ladder,
      fills: [...fills].reverse(),
      openedAt: position.openedAt,
      updatedAt: position.updatedAt,
      hasPendingOrders: position.pendingOrders.length > 0,
    })
  }

  tape.sort((a, b) => b.time - a.time)

  return {
    generatedAt,
    positions: built,
    recentFills: tape.slice(0, options.tapeLength ?? 40),
    totals: {
      deployedUsd: built.reduce((s, p) => s + p.deployedUsd, 0),
      marketValueUsd: built.reduce((s, p) => s + (p.marketValueUsd ?? 0), 0),
      unrealisedUsd: built.reduce((s, p) => s + (p.unrealisedUsd ?? 0), 0),
      costsUsd: built.reduce((s, p) => s + p.costsUsd, 0),
      buys: tape.filter((f) => f.side === 'buy').length,
      sells: tape.filter((f) => f.side === 'sell').length,
    },
  }
}
