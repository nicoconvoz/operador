import { triggerPrice, usdForLevel } from '../domain/strategy/ladder.js'
import { type CascadeParams, DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'
import { type CascadeState } from '../domain/strategy/state.js'
import { commonFund, positionLedger } from './ledger.js'
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

/**
 * One of the rebound locks standing between the ladder and its next rung.
 *
 * All of them must hold for a DCA to fill — that is the anti-stacking rule from
 * DCA.pine, and it is what stops the ladder buying into a falling knife.
 *
 * It is here because a token fell 28% below its entry, no rung fired, and the
 * screen could not say why: answering took reading the cascade state out of the
 * database by hand. A ladder that is correctly waiting and a ladder that is
 * broken looked exactly alike, which makes the correct one impossible to trust.
 */
export interface LadderLock {
  readonly name: 'trigger' | 'separation' | 'confirmation' | 'rebound'
  readonly held: boolean
  /** What it is waiting for, in the numbers it is waiting on. */
  readonly detail: string
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
  /** Profit already banked by sales, at the cost basis those sales left behind. */
  readonly realisedUsd: number
  readonly lastPriceUsd: number | null
  readonly marketValueUsd: number | null
  readonly unrealisedUsd: number | null
  readonly unrealisedPct: number | null
  /** Spread, impact and gas charged on the fills so far. */
  readonly costsUsd: number

  readonly ladder: readonly LadderRung[]
  /**
   * What the next rung is waiting for, or null when flat.
   *
   * The fifth lock of the reference — `close > open` — is not here: it is a
   * property of the bar being evaluated, and nothing durable records the open.
   * Four locks that are certain beat five where one is invented.
   */
  readonly locks: readonly LadderLock[] | null
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
    readonly realisedUsd: number
    readonly unrealisedUsd: number
    readonly costsUsd: number
    /** realised + unrealised − costs. The answer to "are we ahead". */
    readonly netUsd: number
    readonly buys: number
    readonly sells: number
  }
}

export interface OperationsOptions {
  readonly now: () => number
  readonly params?: CascadeParams
  readonly tapeLength?: number
  /**
   * How many entries the venue holds open at once, when production wants fewer
   * than the reference's ten. Drawing the reference's cap would show rungs as
   * reachable that the broker is going to refuse.
   */
  readonly maxOpenEntries?: number
}

export async function buildOperations(store: StatePort, options: OperationsOptions): Promise<OperationsView> {
  const generatedAt = options.now()
  const params = options.params ?? DEFAULT_PARAMS
  const positions = await store.loadPositions()
  // EVERY fill, not just the open book's. A position that closes — released,
  // retired or dead — leaves the working set, and its realised profit used to
  // leave the screen with it: a token that had made the most money ceded its
  // slot and its gain simply vanished, as if it had never won.
  //
  // `fills` has no foreign key to `positions` precisely so they survive that,
  // and nothing was reading them. Worse than cosmetic: the allocator counts
  // this money through `commonFund`, so the screen and the allocator were
  // giving different answers to "how much have we made".
  const allFills = await store.allFills()
  const symbolOf = new Map(positions.map((p) => [p.id, p.symbol]))

  const built: PositionOperations[] = []
  const tape: (PersistedFill & { symbol: string })[] = allFills.map((fill) => ({
    ...fill,
    // A departed position left no symbol behind. Its id is `chain:address:at`,
    // and the address is more use than a blank.
    symbol: symbolOf.get(fill.positionId) ?? fill.positionId.split(':')[1]?.slice(0, 6) ?? '—',
  }))

  for (const position of positions) {
    const fills = allFills.filter((fill) => fill.positionId === position.id)

    const buys = fills.filter((f) => f.side === 'buy')
    const costsUsd = fills.reduce((sum, f) => sum + f.costUsd, 0)
    const { qty, deployedUsd, avgCostUsd, realisedUsd } = positionLedger(fills)

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
        // The machine keeps signalling past whatever the venue will hold.
        beyondPyramiding: level >= (options.maxOpenEntries ?? PYRAMIDING),
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
      realisedUsd,
      lastPriceUsd: price,
      marketValueUsd,
      unrealisedUsd,
      unrealisedPct: unrealisedUsd !== null && deployedUsd > 0 ? (unrealisedUsd / deployedUsd) * 100 : null,
      costsUsd,
      ladder,
      locks: ladderLocks(position.cascade, params, position.lastPriceUsd),
      fills: [...fills].reverse(),
      openedAt: position.openedAt,
      updatedAt: position.updatedAt,
      hasPendingOrders: position.pendingOrders.length > 0,
    })
  }

  tape.sort((a, b) => b.time - a.time)
  const fund = commonFund(allFills)

  return {
    generatedAt,
    positions: built,
    recentFills: tape.slice(0, options.tapeLength ?? 40),
    totals: {
      deployedUsd: built.reduce((s, p) => s + p.deployedUsd, 0),
      marketValueUsd: built.reduce((s, p) => s + (p.marketValueUsd ?? 0), 0),
      // From every fill, so money made by a position that has since closed is
      // still money made. The same walk the allocator's common fund uses —
      // one implementation, because two would eventually disagree and the one
      // on the screen is the one you would believe.
      realisedUsd: fund.realisedUsd,
      unrealisedUsd: built.reduce((s, p) => s + (p.unrealisedUsd ?? 0), 0),
      costsUsd: fund.costsUsd,
      // The one number that answers "are we ahead". Costs are subtracted here
      // and ALSO reported on their own: netting them silently would hide the
      // single largest reason a small-cap strategy fails, which is that the
      // chain takes more than the edge.
      netUsd: fund.netUsd + built.reduce((s, p) => s + (p.unrealisedUsd ?? 0), 0),
      buys: tape.filter((f) => f.side === 'buy').length,
      sells: tape.filter((f) => f.side === 'sell').length,
    },
  }
}


const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

/**
 * The rebound locks, evaluated against the state the position actually carries.
 *
 * Derived, never stored: these are four readings of `cascade`, and a second
 * copy of them would be a second thing to keep in step with the strategy.
 */
function ladderLocks(
  cascade: CascadeState,
  params: CascadeParams,
  close: number | null,
): readonly LadderLock[] | null {
  if (cascade.level < 1 || cascade.ep1 === null) return null

  const low = cascade.cycleLow
  const trigger = cascade.level <= params.maxLevels ? triggerPrice(params, cascade.ep1, cascade.level) : null
  const separation = cascade.lastFill === null ? null : cascade.lastFill * (1 - params.minGapPct / 100)

  return [
    {
      name: 'trigger',
      held: low !== null && trigger !== null && low <= trigger,
      detail:
        low === null || trigger === null
          ? 'todavía no hay un mínimo de ciclo que medir'
          : low <= trigger
            ? `el mínimo ${low.toPrecision(4)} tocó el disparador ${trigger.toPrecision(4)}`
            : `falta que caiga a ${trigger.toPrecision(4)}; el mínimo va en ${low.toPrecision(4)}`,
    },
    {
      // The hard separation lock: two rungs cannot sit on top of each other,
      // however far the price has fallen since the last one.
      name: 'separation',
      held: low !== null && separation !== null && low <= separation,
      detail:
        low === null || separation === null
          ? 'todavía no hay un mínimo de ciclo que medir'
          : low <= separation
            ? `separada ${pct((low / cascade.lastFill! - 1) * 100)} de la compra anterior`
            : `hace falta ${params.minGapPct}% bajo la compra anterior (${separation.toPrecision(4)})`,
    },
    {
      // The one that holds a falling token back, and the one people misread as
      // a fault: a new low resets the count, so a token making new lows every
      // bar never confirms a bottom at all. That is the rule working.
      name: 'confirmation',
      held: cascade.barsSinceLow >= params.confirmBars,
      detail:
        cascade.barsSinceLow >= params.confirmBars
          ? `el piso aguantó ${cascade.barsSinceLow} barras`
          : `${cascade.barsSinceLow} de ${params.confirmBars} barras sin un mínimo nuevo — cada mínimo nuevo reinicia la cuenta`,
    },
    {
      name: 'rebound',
      held: low !== null && close !== null && close >= low * (1 + params.reboundPct / 100),
      detail:
        low === null || close === null
          ? 'todavía no hay un mínimo de ciclo que medir'
          : close >= low * (1 + params.reboundPct / 100)
            ? `rebotó ${pct((close / low - 1) * 100)} desde el piso`
            : `hace falta un rebote de ${params.reboundPct}% sobre ${low.toPrecision(4)}; va ${pct((close / low - 1) * 100)}`,
    },
  ]
}
