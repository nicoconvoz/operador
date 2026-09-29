import { triggerPrice, usdForLevel } from '../domain/strategy/ladder.js'
import { usableScale } from '../domain/strategy/drop-ladder.js'
import { scaledDropPct, dropLabel } from '../domain/strategy/dca-scale.js'
import { deepRungArmed, deepRungLine, reboundLine, type DeepRungPolicy } from '../domain/strategy/deep-rung.js'
import { type CascadeParams, DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'
import { type CascadeState } from '../domain/strategy/state.js'
import { realisedBySell, commonFund, holdingBuys } from './ledger.js'
import { bookNetUsd, valuePosition } from './book-value.js'
import { type PersistedFill, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'

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
  readonly name: 'trigger' | 'separation' | 'confirmation' | 'rebound' | 'pressure' | 'drop' | 'deep'
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
  /**
   * Whether `lastPriceUsd` is the market price NOW or the last closed bar's.
   *
   * The distinction is shown rather than hidden: a figure computed from a stale
   * price while the provider is down is still the best number available, and a
   * reader deserves to know which one they are looking at.
   */
  readonly priceIsLive: boolean
}

export interface OperationsView {
  readonly generatedAt: number
  readonly positions: readonly PositionOperations[]
  /** Newest first, across every position. The tape. */
  readonly recentFills: readonly (PersistedFill & {
    readonly symbol: string
    /**
     * What this SALE made, against the basis it sold out of. Null on a buy,
     * which has made nothing yet.
     *
     * Costs are not subtracted: the tape shows what the chain took in its own
     * column, and taking it off twice would make every line disagree with the
     * total beside it.
     */
    readonly realisedUsd: number | null
  })[]
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
  /**
   * Current market prices, keyed `chain:tokenAddress`.
   *
   * The screen used to value everything at `lastPriceUsd` — the close of the
   * last processed bar, which on 15-minute candles moves four times an hour, so
   * the one number the system exists to produce sat still between bars.
   *
   * The engine is right to DECIDE on closed bars. The screen is not showing a
   * decision, it is showing what the position is worth, and that moves
   * continuously. Only the valuation uses it; the LADDER stays on the prices
   * the engine actually acted on, or the screen would disagree with the machine
   * about where the rungs are.
   *
   * Optional and never fatal: a provider having a bad minute falls back to the
   * bar close and says so.
   */
  readonly livePrices?: () => Promise<ReadonlyMap<string, number>>
  readonly params?: CascadeParams
  readonly tapeLength?: number
  /**
   * How many entries the venue holds open at once, when production wants fewer
   * than the reference's ten. Drawing the reference's cap would show rungs as
   * reachable that the broker is going to refuse.
   */
  readonly maxOpenEntries?: number
  /**
   * The ladder the ENGINE buys: a rung each time buy pressure crosses
   * `threshold` upward. Absent: the cascade's own ladder. `pressureOf` reads
   * the held token's buy pressure now, 0..1; null when nobody counted the hour.
   */
  /**
   * The ladder on price: rung `n` once the price has fallen `dropsPct[n-1]`
   * under the FIRST buy, buying `rungsUsd[n-1]` — the same lists the engine
   * buys on. Drawn instead of the pressure ladder when given. Without sizes,
   * each rung is drawn at the reference level's.
   */
  readonly dropLadder?: {
    readonly dropsPct: readonly number[]
    readonly rungsUsd?: readonly number[]
    /** What each drop is measured from, the way the engine buys it. Absent: the first buy. */
    readonly from?: 'first' | 'previous'
    /**
     * Whether each position's drops follow its own `dcaScale`, the way the
     * sweep buys them. Absent: the base drops, every caller that predates it.
     */
    readonly adaptive?: boolean
    /**
     * Whether the NEXT line follows the token's last hour — the real-time
     * scale the sweep measured and wrote onto the position — while that
     * reading is fresh. Only inside `adaptive`, as in the sweep. Absent: off.
     */
    readonly realtime?: boolean
  }
  readonly pressureLadder?: {
    readonly threshold: number
    readonly pressureOf?: (position: PersistedPosition) => Promise<number | null>
  }
  /**
   * The ONE rung the engine buys after the entry: armed once the holding's low
   * is more than `fallPct` under the first buy, bought on a `reboundPct`
   * rebound off that low, `usd` dollars. *Dos escalones solamente.* Read off
   * the low the sweep wrote onto the position. Drawn when given and no
   * `dropLadder` is.
   */
  readonly deepRung?: {
    readonly fallPct: number
    readonly reboundPct: number
    readonly usd: number
  }
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
  // Never fatal. The one number the system exists to produce must not blank
  // because a price provider had a bad minute.
  let livePrices: ReadonlyMap<string, number> = new Map()
  if (options.livePrices) {
    try {
      livePrices = await options.livePrices()
    } catch {
      livePrices = new Map()
    }
  }
  const symbolOf = new Map(positions.map((p) => [p.id, p.symbol]))

  const built: PositionOperations[] = []
  const made = realisedBySell(allFills)
  const tape: (PersistedFill & { symbol: string; realisedUsd: number | null })[] = allFills.map((fill) => ({
    realisedUsd: made.get(fill.idempotencyKey) ?? null,
    ...fill,
    // A departed position left no symbol behind. Its id is `chain:address:at`,
    // and the address is more use than a blank.
    symbol: symbolOf.get(fill.positionId) ?? fill.positionId.split(':')[1]?.slice(0, 6) ?? '—',
  }))

  for (const position of positions) {
    const fills = allFills.filter((fill) => fill.positionId === position.id)

    // The rungs of what it holds NOW. A cycle already sold is on the tape, not
    // on the ladder: KITTY was drawn with its previous cycle's DCA-1 filled.
    const buys = holdingBuys(fills)
    const costsUsd = fills.reduce((sum, f) => sum + f.costUsd, 0)
    // Valued by the SAME function the engine's day log uses, so a row in the
    // Log can never disagree with what this card drew.
    const { qty, deployedUsd, avgCostUsd, realisedUsd, priceUsd: price, priceIsLive, marketValueUsd, unrealisedUsd } =
      valuePosition(position, fills, livePrices)

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

    // As many rungs as the VENUE will hold, never as many as the machine
    // signals. The state machine advances to fifty levels and `PaperBroker`
    // refuses every entry past `maxOpenEntries` — so drawing the difference was
    // readable at ten fillable of fifty, and became eleven boxes of nothing the
    // day the operator cut the ladder to a single buy.
    //
    // It cost more than noise: one of those boxes was painted as the rung being
    // WAITED ON, with a line underneath explaining the price it had to reach.
    // Nothing was waiting for it. A screen describing a trade the engine has
    // already refused is this read model's own failure mode, with the sides
    // swapped — usually the engine refuses what the screen offers.
    const fillable = Math.min(params.maxLevels + 1, options.maxOpenEntries ?? PYRAMIDING, 12)
    const drop = options.dropLadder
    const deep = drop ? undefined : options.deepRung
    const pressure = options.pressureLadder
    // The position's own spacing, read exactly as the sweep reads it — the
    // same switches, the same stored scales — so each line is drawn where it
    // will be bought, and the lock says which volatility put it there.
    const { scale, why } = drop ? ladderScale(position, drop, generatedAt) : { scale: 1, why: '' }
    const ladder: LadderRung[] = drop
      ? dropRungs(filledByLevel, fillable, drop, scale, params, inFlight?.level ?? filledByLevel.size)
      : deep
      ? deepRungs(filledByLevel, fillable, deep, params, inFlight?.level ?? filledByLevel.size)
      : pressure
      ? pressureRungs(filledByLevel, fillable, params, inFlight?.level ?? filledByLevel.size)
      : Array.from({ length: fillable }, (_, level) => {
      const fill = filledByLevel.get(level)
      return {
        level,
        triggerPrice: level === 0 || position.cascade.ep1 === null ? null : triggerPrice(params, position.cascade.ep1, level),
        nominalUsd: usdForLevel(params, level),
        filled: fill !== undefined,
        fillPrice: fill?.price ?? null,
        fillUsd: fill ? fill.price * fill.qty : null,
        pending: level === waitingOn && !fill,
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
      locks: drop
        ? dropLocks(buys, price, fillable, drop, scale, why, params)
        : deep
        ? deepLocks(position, buys, price, fillable, deep)
        : pressure
        ? await pressureLocks(position, buys, fillable, pressure)
        : ladderLocks(position.cascade, params, position.lastPriceUsd),
      fills: [...fills].reverse(),
      openedAt: position.openedAt,
      updatedAt: position.updatedAt,
      hasPendingOrders: position.pendingOrders.length > 0,
      priceIsLive,
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
      //
      // `bookNetUsd`, never a sum written out here: the engine records this
      // same figure into the day log every cycle, and two implementations of
      // "how much are we up" is the drift this read model exists to prevent.
      netUsd: bookNetUsd(positions, allFills, livePrices),
      buys: tape.filter((f) => f.side === 'buy').length,
      sells: tape.filter((f) => f.side === 'sell').length,
    },
  }
}


const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

type DropLadderView = NonNullable<OperationsOptions['dropLadder']>

/**
 * How long the sweep's real-time reading still describes the line it is
 * waiting on: three 5-minute bars.
 *
 * The sweep measures the last hour only for a position at or under the
 * shallowest line any spacing could draw, and again on every new bar while it
 * stays there. So a reading older than this means the price moved away and the
 * sweep stopped asking — and a line drawn from a volatility three bars stale
 * is the present painted with the past. The at-buy scale is drawn instead,
 * named as such, until the price comes back and the sweep measures again.
 */
const REALTIME_SCALE_FRESH_MS = 15 * 60_000

/**
 * The scale the NEXT line is drawn at, and the words that say which: the last
 * hour's while fresh, else the one measured at the buy, else one — the sweep's
 * own order of preference, behind the sweep's own switches.
 */
function ladderScale(position: PersistedPosition, ladder: DropLadderView, now: number): { readonly scale: number; readonly why: string } {
  if (ladder.adaptive !== true) return { scale: 1, why: '' }
  const measuredAt = position.dcaScaleNowAt
  if (
    ladder.realtime === true &&
    position.dcaScaleNow !== null && position.dcaScaleNow !== undefined &&
    measuredAt !== null && measuredAt !== undefined && now - measuredAt < REALTIME_SCALE_FRESH_MS
  ) {
    return { scale: usableScale(position.dcaScaleNow), why: ' (volatilidad de la última hora)' }
  }
  const atBuy = usableScale(position.dcaScale)
  return { scale: atBuy, why: atBuy !== 1 ? ' (volatilidad al comprar)' : '' }
}

/**
 * What a price rung buys: its own size from the engine's list, the entry and
 * any rung the list does not size at the reference level's. Ladder A drew a
 * flat $10 box under a $35 DCA-5 until the sizes were passed in — the screen
 * disagreeing with the engine about the size of a trade.
 */
const dropRungUsd = (ladder: DropLadderView, params: CascadeParams, level: number): number =>
  (level > 0 ? ladder.rungsUsd?.[level - 1] : undefined) ?? usdForLevel(params, level)

/**
 * The price ladder's rungs: rung `n` at the FIRST buy's price less
 * `dropsPct[n-1]` — exactly where the engine buys it — at its own size.
 * Anchored to what was actually PAID for the entry, never to the plan: a line
 * drawn from a price the position never paid would put the rung somewhere the
 * sweep is not looking. A rung past the end of the list, or before any buy,
 * has no line.
 *
 * Each drop at the position's own scale when the ladder adapts: a token moving
 * 10% a bar is bought at −5.2% and drawn there, never at the base list's −10%
 * — the screen describing a line the sweep is not waiting on.
 */
function dropRungs(
  filledByLevel: ReadonlyMap<number, PersistedFill>,
  fillable: number,
  ladder: DropLadderView,
  /** The scale the sweep would space this position's next rung at — see `ladderScale`. */
  scale: number,
  params: CascadeParams,
  waitingOn: number,
): LadderRung[] {
  const first = filledByLevel.get(0)?.price ?? null
  // Measured from the previous buy, each line hangs off the rung before it:
  // what that rung actually paid once it has filled, and its own line until
  // then — where it would be if every rung filled exactly on its line.
  const lines: (number | null)[] = [null]
  let anchor = first
  for (let level = 1; level < fillable; level++) {
    const drop = ladder.dropsPct[level - 1]
    const base = ladder.from === 'previous' ? anchor : first
    const line = base === null || drop === undefined ? null : base * (1 - scaledDropPct(drop, scale) / 100)
    lines.push(line)
    anchor = filledByLevel.get(level)?.price ?? line
  }
  return Array.from({ length: fillable }, (_, level) => {
    const fill = filledByLevel.get(level)
    return {
      level,
      triggerPrice: lines[level] ?? null,
      nominalUsd: dropRungUsd(ladder, params, level),
      filled: fill !== undefined,
      fillPrice: fill?.price ?? null,
      fillUsd: fill ? fill.price * fill.qty : null,
      pending: level === waitingOn && !fill,
    }
  })
}

/**
 * What the NEXT price rung waits for — the first buy's price less its drop —
 * and what it will buy there. Null when flat, full, or past the end of the list.
 */
function dropLocks(
  buys: readonly PersistedFill[],
  price: number | null,
  fillable: number,
  ladder: DropLadderView,
  scale: number,
  /** Which volatility drew the line, in the operator's words; empty for the base drops. */
  why: string,
  params: CascadeParams,
): readonly LadderLock[] | null {
  if (buys.length === 0 || buys.length >= fillable) return null
  const base = ladder.dropsPct[buys.length - 1]
  if (base === undefined) return null
  // At this position's scale: the fall the sweep is actually waiting for.
  const drop = scaledDropPct(base, scale)
  const sorted = [...buys].sort((a, b) => a.time - b.time)
  const previous = ladder.from === 'previous'
  const anchor = previous ? sorted[sorted.length - 1]! : sorted[0]!
  const line = anchor.price * (1 - drop / 100)
  const id = `DCA-${buys.length}`
  const usd = `$${dropRungUsd(ladder, params, buys.length).toFixed(2)}`
  const reached = price !== null && price <= line
  const since = previous ? 'la compra anterior' : 'la primera compra'
  return [
    {
      name: 'drop',
      held: reached,
      detail: reached
        ? `el precio llegó a ${line.toPrecision(4)} — ${id} compra ${usd} en este barrido`
        : `${id} compra ${usd} si el precio cae a ${line.toPrecision(4)} — ${dropLabel(drop)}% bajo ${since}${why}; va en ${price === null ? '—' : price.toPrecision(4)}`,
    },
  ]
}

type DeepRungView = NonNullable<OperationsOptions['deepRung']>

/** The deep rung's policy as the domain reads it: the first buy and one rung. */
const deepPolicy = (rung: DeepRungView): DeepRungPolicy => ({ fallPct: rung.fallPct, reboundPct: rung.reboundPct, maxEntries: 2 })

/** Dollars as the operator says them: $20, not $20.00. */
const dollars = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`

/**
 * The deep rung's two boxes: the entry, and DCA-1 at the line that arms it — a
 * fifth of what the first buy actually PAID, at the production numbers. Never
 * more boxes than the deep rung can fill, whatever the venue holds: a box
 * nothing will ever buy is a trade the screen offers and the engine refuses.
 */
function deepRungs(
  filledByLevel: ReadonlyMap<number, PersistedFill>,
  fillable: number,
  rung: DeepRungView,
  params: CascadeParams,
  waitingOn: number,
): LadderRung[] {
  const first = filledByLevel.get(0)?.price ?? null
  return Array.from({ length: Math.min(fillable, 2) }, (_, level) => {
    const fill = filledByLevel.get(level)
    return {
      level,
      triggerPrice: level === 1 && first !== null ? deepRungLine(first, deepPolicy(rung)) : null,
      nominalUsd: level === 0 ? usdForLevel(params, 0) : rung.usd,
      filled: fill !== undefined,
      fillPrice: fill?.price ?? null,
      fillUsd: fill ? fill.price * fill.qty : null,
      pending: level === waitingOn && !fill,
    }
  })
}

/**
 * What the deep rung waits for, in the order it happens: the line that arms it
 * — *DCA-1 $20: se activa bajo $P (−80%)* — and, once the holding's low is
 * under that line, the low and the price a 10% rebound buys at. Null when flat,
 * once the rung is bought, or when the venue holds the entry alone.
 *
 * The low is the one the sweep persisted, and only THIS holding's: a low left
 * by the holding before a sale and a buy back is not this one's crash.
 */
function deepLocks(
  position: PersistedPosition,
  buys: readonly PersistedFill[],
  price: number | null,
  fillable: number,
  rung: DeepRungView,
): readonly LadderLock[] | null {
  if (buys.length !== 1 || fillable < 2) return null
  const first = buys[0]!
  const policy = deepPolicy(rung)
  const stored = position.priceLow ?? null
  const low = stored !== null && stored.holdingSince === first.time ? stored.price : null
  if (low === null || !deepRungArmed(first.price, low, policy)) {
    const line = deepRungLine(first.price, policy)
    return [{ name: 'deep', held: false, detail: `DCA-1 ${dollars(rung.usd)}: se activa bajo $${line.toPrecision(4)} (−${rung.fallPct}%)` }]
  }
  const rebound = reboundLine(low, policy)
  return [
    {
      name: 'deep',
      held: price !== null && price >= rebound,
      detail: `mínimo $${low.toPrecision(4)} — compra al rebotar ${rung.reboundPct}%, en $${rebound.toPrecision(4)}`,
    },
  ]
}

/**
 * The pressure ladder's rungs. No trigger PRICE on any of them: a rung waits
 * on buyers crossing 1%, not on the price, and drawing a price would describe
 * a trade the engine is not waiting for.
 */
function pressureRungs(
  filledByLevel: ReadonlyMap<number, PersistedFill>,
  fillable: number,
  params: CascadeParams,
  waitingOn: number,
): LadderRung[] {
  return Array.from({ length: fillable }, (_, level) => {
    const fill = filledByLevel.get(level)
    return {
      level,
      triggerPrice: null,
      nominalUsd: usdForLevel(params, level),
      filled: fill !== undefined,
      fillPrice: fill?.price ?? null,
      fillUsd: fill ? fill.price * fill.qty : null,
      pending: level === waitingOn && !fill,
    }
  })
}

/**
 * What the next rung waits for: buy pressure crossing the threshold upward —
 * the engine buys the CROSSING, so a pressure already above it has to dip and
 * cross again. Null when flat or the ladder is full.
 */
async function pressureLocks(
  position: PersistedPosition,
  buys: readonly PersistedFill[],
  fillable: number,
  ladder: NonNullable<OperationsOptions['pressureLadder']>,
): Promise<readonly LadderLock[] | null> {
  if (buys.length === 0 || buys.length >= fillable) return null
  let now: number | null = null
  try {
    now = ladder.pressureOf ? await ladder.pressureOf(position) : null
  } catch {
    now = null
  }
  const line = `${(ladder.threshold * 100).toFixed(0)}%`
  return [
    {
      name: 'pressure',
      held: false,
      detail:
        now === null
          ? `sin conteo de la última hora para medir la presión compradora — el próximo escalón compra cuando cruce el ${line}`
          : now > ladder.threshold
            ? `la presión compradora va en ${(now * 100).toFixed(1)}% — el próximo escalón compra cuando baje del ${line} y vuelva a cruzarlo`
            : `el próximo escalón compra cuando la presión compradora cruce el ${line} — ahora va ${(now * 100).toFixed(1)}%`,
    },
  ]
}

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
