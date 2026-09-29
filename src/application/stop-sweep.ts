import { alert, type AlertPort, type AlertThrottle } from '../domain/notifications/alerts.js'
import { positionLedger, tokenNetUsd, openLotCostsUsd, holdingBuys } from './ledger.js'
import { nextPressureRung, pressureOf, buyersFellThrough, BUYERS_GONE_COMMENT, type PressureLadderPolicy } from '../domain/strategy/pressure-ladder.js'
import { nextDropRung, usableScale, type DropLadderPolicy } from '../domain/strategy/drop-ladder.js'
import { nextDeepRung, nextPriceLow, priceLowWorthWriting, type DeepRungPolicy, type PriceLow } from '../domain/strategy/deep-rung.js'
import {
  nextDipBounce,
  watchAfterBuy,
  dipWatchWorthWriting,
  dipBounceThresholds,
  crashLine,
  type DipBouncePolicy,
  type DipBounceStep,
  type DipWatch,
} from '../domain/strategy/dip-bounce.js'
import { liquidityBelowFreeze, type DeathExitPolicy } from '../domain/risk/death-exit.js'
import { scaledDropPct, dropLabel, realtimeDcaScale, REALTIME_DCA_SCALE_POLICY } from '../domain/strategy/dca-scale.js'
import { type RecentVolatility } from './recent-volatility.js'
import {
  liquidityFell,
  liquidityWatchMoved,
  nextLiquidityWatch,
  DEFAULT_LIQUIDITY_BRAKE_PCT,
  DEFAULT_LIQUIDITY_WATCH_POLICY,
  type LiquidityReading,
} from '../domain/strategy/liquidity-brake.js'
import { pricesDisagree } from '../domain/market/price-agreement.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { minProfitPctFor, roundTripCostForFill, stopForRatio, positionTollPct, buyCostUsd } from '../domain/economics/sizing.js'
import { settle } from './engine.js'
import {
  gainLockFloorPct,
  gainLockStepPct,
  GAIN_LOCK_COMMENT,
  type GainLockPolicy,
} from '../domain/risk/gain-lock.js'
import { FIXED_TP_COMMENT, reachedFixedTp } from '../domain/strategy/fixed-tp.js'
import type { BrokerPort } from '../domain/execution/broker.js'
import type { PersistedFill, PersistedPosition, StatePort } from '../domain/persistence/store.js'
import {
  shouldStopOut,
  stopLossPctFor,
  drawdownPct,
  lossUsd,
  STOP_LOSS_COMMENT,
  BREAK_EVEN_COMMENT,
  type StopLossPolicy,
} from '../domain/risk/stop-loss.js'

/**
 * How often the stop may re-ask while something long is running — a scan, or
 * the sleep between cycles.
 *
 * Bounded by the provider rather than chosen: one batched DexScreener request
 * covers the whole book (thirty addresses a call) against three hundred a
 * minute, so twice a minute spends under one percent of the allowance. The
 * ceiling is what makes this safe to call from a loop that runs hundreds of
 * times.
 */
export const STOP_SWEEP_MS = 30_000


/**
 * One pass of the stop over a book, at the prices given.
 *
 * ## Why this is a module and not a block inside the cycle
 *
 * The stop was written inside `runCycle`, and everything that went wrong with
 * it since followed from that. It fired once per cycle, so its cadence was the
 * cycle's — and a cold cycle is forty minutes. Three commits moved it earlier
 * and it kept arriving late, because being first in a slow loop is still once
 * per loop.
 *
 * Then the scan learned to hand the thread back and it could finally run
 * DURING the long stage. That left one gap, and it is the worst one:
 *
 * > **A position opened in cycle N cannot be seen by cycle N's stop.**
 *
 * Positions are opened in step 3, after the scan, near the end of the pass —
 * so there is no sweep left in that cycle to catch them, and they wait out the
 * inter-cycle sleep plus the next pass's recovery before anything looks. From
 * the tape: twenty-three positions opened at the end of one cold cycle, six of
 * them already past the line, and not one stop alert in forty-three minutes.
 *
 * That window is not an unlucky corner. It is the FIRST HALF HOUR of every
 * position's life, which on these tokens is when they move most.
 *
 * Fixing it inside `runCycle` was impossible by construction: the cycle cannot
 * protect a book after it has stopped running. So the rule moves out here,
 * where `runLoop` can also call it — between cycles, on the same cadence — and
 * both callers run one implementation. Two copies of "should this be sold"
 * would eventually disagree, and one of them would be holding money.
 *
 * ## What it refuses to touch
 *
 * - **A position with orders in flight.** That is the shape of a HALT: recovery
 *   could not answer whether a fill happened, and an unattended system is
 *   allowed to stop but never to guess. Selling on top of an unresolved order
 *   is how a book goes short on a spot engine.
 * - **A position with no live price.** Silence is not a fall. A $15.06 position
 *   once left at a tenth of a cent because two feeds disagreed about the unit.
 * - **A position holding nothing.** There is nothing to stop out of.
 *
 * The last two live in `shouldStopOut`, in the domain, where they are tested
 * without a store. Only the first is a fact about persistence, so only the
 * first is here.
 */
/** What the cycle and the loop both hand the sweep. ONE shape, so they cannot drift. */
export interface ExitSizing {
  readonly stop: StopLossPolicy
  readonly rewardRiskRatio: number | undefined
  readonly maxCostSharePct: number | undefined
  readonly gasUsdPerSwap: number
  readonly floorPct: number
  readonly breakEven: boolean
  /**
   * The widest the DERIVED stop may ever be, in percent. Undefined: no ceiling.
   *
   * The 1:4 has none of its own — it multiplies the toll by about seven — so a
   * thin pool derives 14.7% and a high-fee one 20.1% even with the toll right.
   * The formula is honest about the pool; it is not what the operator asked
   * for, which was a stop near nine. Above the ceiling the rule is reacting to
   * an expensive pool rather than to him.
   */
  readonly maxStopPct: number | undefined
  /**
   * Where the break-even ARMS and where an armed position SELLS, in percent
   * over its average cost. Undefined: derived — the arm at the exit target,
   * the floor at the round trip, which is what the ratchet ran on first.
   *
   * *Poné el break-even en 7.5.* The operator, in place of a fixed take-profit
   * that would have cut the runners: fifteen real TP cycles made $5–$21 each —
   * $133.60 of the $439.87 the strategy's own exit earned — at +32% to +120%.
   * Both lines at 7.5: it arms at +7.5% and, once armed, sells when the price
   * falls back to +7.5%, so the gain it reached is locked while everything
   * above it is left to the strategy's exit.
   */
  readonly breakEvenArmPct: number | undefined
  readonly breakEvenFloorPct: number | undefined
  /**
   * The stepped gain lock, or null when it is off. *Si pasás el 20% de
   * ganancia, break-even en el 10%; con cada aumento de 20%, aumentar el
   * break-even 10%.* See `domain/risk/gain-lock.ts`.
   */
  readonly gainLock: GainLockPolicy | null
  /**
   * The FIXED take-profit, in percent over the average cost, or null when it
   * is off. *Poné un TP fijo al 12.5% del promedio.* See
   * `domain/strategy/fixed-tp.ts`.
   */
  readonly fixedTpPct: number | null
}

/** The lines a position lives between, in percent of its average cost. */
export interface ExitLevels {
  /** How far it may fall before it is cut. */
  readonly stop: StopLossPolicy
  /** How far it must rise for the break-even ratchet to arm; null means never. */
  readonly armAtPct: number | null
  /**
   * Where an ARMED position leaves: its average cost plus the round trip, so
   * the sale nets about zero rather than about minus the toll.
   */
  readonly breakEvenPct: number
  /**
   * The staircase of floors a winner earns as it rises; null means off.
   * Required, not optional: a field a caller could leave out is a rule a caller
   * could switch off without saying so.
   */
  readonly gainLock: GainLockPolicy | null
  /**
   * Where the whole holding sells, in percent over its average cost; null
   * means off. Required for the gain lock's reason: a field a caller could
   * leave out is a rule a caller could switch off without saying so.
   */
  readonly fixedTpPct: number | null
}

/**
 * Every line a position lives between, sized from THIS pool.
 *
 * Per position, because every term is: the toll depends on the pool's spread
 * and depth and on how much the slot deploys, the target is derived from the
 * toll, and both the stop and the ratchet are derived from the target. One
 * number composed at boot would be right for the average pool and wrong for
 * every actual one.
 *
 * The ratchet arms at the TARGET — the same number the strategy exit wants —
 * because "it could have taken the profit" means exactly that: it was where
 * the exit would have been happy to sell.
 */
export const exitLevelsFor = (position: PersistedPosition, sizing: ExitSizing): ExitLevels => {
  // The toll at the size actually traded, scaled the way the broker charges
  // it. It was the raw $100 reading on a $15 fill, and the 1:4 multiplied that
  // by seven: fomopay was cut with a 24% stop the sweep printed itself.
  const roundTrip = roundTripCostForFill(position.capitalUsd, position.quality, sizing.gasUsdPerSwap)
  const target =
    sizing.maxCostSharePct === undefined ? null : minProfitPctFor(roundTrip, sizing.maxCostSharePct, sizing.floorPct)

  let stop = sizing.stop
  // A dollar limit is the WHOLE rule — *no quiero que mires el porcentaje* —
  // so nothing is derived over it. Building a fresh percent policy here would
  // also drop the limit on the floor: the operator's rule deleted by the very
  // arithmetic he said not to run.
  const dollarsDecide = sizing.stop.maxLossUsd !== undefined && sizing.stop.maxLossUsd > 0
  // The ratio RESHAPES a stop that is on; it never switches one on. Zeroing the
  // dollars once handed the decision straight to it, and six positions were
  // cut at a loss the morning after the operator had turned the stop off —
  // *quedó la parte de corte por venta en negativo, justo lo que habíamos
  // corregido.*
  const percentOn = sizing.stop.minStopPct > 0 || sizing.stop.maxStopPct > 0
  if (!dollarsDecide && percentOn && target !== null && sizing.rewardRiskRatio !== undefined && sizing.rewardRiskRatio > 0) {
    const pct = stopForRatio(target, roundTrip, sizing.rewardRiskRatio)
    // Zero means the pair is impossible on this pool. Fall back rather than
    // invent: the base policy is the operator's own number.
    if (pct > 0) {
      const capped = sizing.maxStopPct !== undefined && sizing.maxStopPct > 0 ? Math.min(pct, sizing.maxStopPct) : pct
      stop = { shareOfRun: 0, minStopPct: capped, maxStopPct: capped }
    }
  }

  // Configured lines win; absent, the ratchet derives them as it always did.
  const armAt = sizing.breakEvenArmPct ?? target
  const floor = sizing.breakEvenFloorPct ?? roundTrip
  return {
    stop,
    armAtPct: sizing.breakEven && armAt !== null ? armAt : null,
    // Never above the arm. A floor over the arm would sell the position on the
    // very sweep that armed it — a take-profit wearing the ratchet's name,
    // which is the thing the operator declined.
    breakEvenPct: armAt === null ? floor : Math.min(floor, armAt),
    // Not derived from the pool: the operator's staircase is in points of GAIN,
    // and every floor on it is far above any round trip these pools charge.
    gainLock: sizing.gainLock,
    // Not derived either: *al 12.5% del promedio* is the operator's number, and
    // the no-loss guard at the fill is what answers for an expensive pool.
    fixedTpPct: sizing.fixedTpPct !== null && sizing.fixedTpPct > 0 ? sizing.fixedTpPct : null,
  }
}

/**
 * The DCA ladder on order flow: a rung each time buyers push through 1%.
 *
 * *Aplicalo para el DCA también — nada de escalones, esa regla.* Here because
 * this sweep already runs every thirty seconds in all three places the book is
 * watched, so the ladder rides on it rather than on a fourth loop.
 */
export interface PressureLadder {
  readonly policy: PressureLadderPolicy
  /** What each rung buys, in dollars. *Cada escalón de 15 dólares.* */
  readonly rungUsd: number
  /** The last hour's buys and sells for the token; null when nobody could answer. */
  readonly hourCounts: (position: PersistedPosition) => Promise<{ readonly buys: number; readonly sells: number } | null>
  /**
   * The last buy pressure read per position — the "before" of a crossing.
   * Owned by the caller, so the cycle's sweeps and the loop's share one memory.
   */
  readonly previous: Map<string, number>
  /**
   * Positions whose buyers fell through 1% and have not come back: MARKED to
   * leave, and sold the first sweep their gain clears the whole round trip.
   * Owned by the caller, like `previous`.
   */
  readonly gone: Set<string>
  /** Gas per swap, for what leaving would cost. */
  readonly gasUsdPerSwap: number
  /**
   * Gives the position the capital of `entries` entries out of the book's free
   * capital — the same as `DropLadder.fund`, and for the same reason: a slot
   * is allocated its first buy only, and a rung bought out of what is left of
   * it would be refused by the broker for funds, silently. Absent: the rung is
   * bought out of what the position holds.
   */
  readonly fund?: (position: PersistedPosition, entries: number) => Promise<PersistedPosition | null>
}

/**
 * The DCA ladder on the PRICE alone: rung `n` once the price has fallen
 * `dropsPct[n-1]` under the FIRST buy, buying `rungsUsd[n-1]` — ladder A:
 * $15, $20, $25, $30 and $35 at −10, −15, −20, −25 and −30%. See
 * `drop-ladder.ts` and `production-ladder.ts` for the replays that chose it.
 *
 * OFF in production — only the deep rung (`DeepRung`) buys after the entry —
 * and absent from the deps when off, so nothing it carries runs: no spacing
 * asked, no pool watched, no bounce bought. `OPERADOR_DROP_LADDER=1`.
 */
export interface DropLadder {
  readonly policy: DropLadderPolicy
  /**
   * What each rung buys, in dollars, DCA-1 first — paired one to one with
   * `policy.dropsPct`. It was ONE size for every rung; ladder A grows them as
   * the price falls. A rung with no size here is never bought: the ladder ends
   * where the shorter of the two lists ends.
   */
  readonly rungsUsd: readonly number[]
  /**
   * Gives the position the capital of `entries` entries out of the book's free
   * capital, and returns it as saved — or null when nothing is free.
   *
   * A position is allocated its FIRST buy only, so a rung has to pay for
   * itself when it fires: the broker refuses an entry the position's capital
   * cannot cover. Absent: the rung is bought out of whatever the position
   * already holds, which is every caller that predates it.
   */
  readonly fund?: (position: PersistedPosition, entries: number) => Promise<PersistedPosition | null>
  /**
   * Whether each position's drops are multiplied by its own `dcaScale` — the
   * more the token moved in the day before its first buy, the closer its
   * rungs. *Aplicá el de en la línea, la propuesta.* See
   * `domain/strategy/dca-scale.ts`.
   *
   * On this shape, not per caller, because the cycle's sweeps and the loop's
   * both read it: a switch that only one of them saw would buy a rung at
   * −5.2% between cycles and wait for −10% during one. Absent: off, every
   * position on the base drops — every caller that predates it.
   */
  readonly adaptive?: boolean
  /**
   * The token's volatility over the LAST HOUR of closed 5-minute bars, which
   * spaces the NEXT rung at the moment the sweep looks at it. *Que el próximo
   * escalón DCA lo calcule por la cantidad de volatilidad que tenga en ese
   * preciso momento la moneda.* See `realtimeDcaScale` in
   * `domain/strategy/dca-scale.ts` for the replay that chose it.
   *
   * Asked only when `adaptive` is on, and only for a position already at or
   * under the shallowest line any spacing could draw — never for the book at
   * large, which is nearly all of it on nearly every sweep. Null, or a throw,
   * when the hour cannot be measured: the rung falls back to the position's
   * at-buy `dcaScale`, then to one.
   *
   * Absent: the real-time switch is off, and every rung is spaced by the scale
   * measured at the buy — every caller that predates it.
   */
  readonly recentVolatility?: (position: PersistedPosition) => Promise<RecentVolatility | null>
  /**
   * The book's pools, read for the LIQUIDITY WATCH: the change over the last
   * five minutes and the last hour, and the depth in dollars, keyed
   * `chain:token` like the prices. *Freno en tiempo real por cambio de liquidez
   * inmediata que supere el 5% — 5 minutos o 1 hora*, and *siempre esperar la
   * recuperación del 5% de liquidez a partir del mínimo.* See
   * `nextLiquidityWatch` in `domain/strategy/liquidity-brake.ts`.
   *
   * Asked ONCE per sweep, for the whole book, and folded into every held
   * position's watch — not only the ones near a line, because the bounce that
   * buys a rung does not wait for the price. A token missing from the answer,
   * or a throw, is silence: the watch changes nothing on it.
   *
   * On this shape for the reason `adaptive` is: the cycle's sweeps and the
   * loop's both read it. Absent: no watch — every caller that predates it.
   */
  readonly liquidityChange?: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>
  /**
   * How far, in percent, the pool may drain in either window before the ladder
   * brakes. Zero: the whole watch off — nothing asked, nothing held, nothing
   * bought on a bounce. Absent with `liquidityChange` present: the operator's
   * five, `DEFAULT_LIQUIDITY_BRAKE_PCT`.
   */
  readonly liquidityBrakePct?: number
}

/**
 * The ONE rung a holding may buy after its first: more than 80% under the
 * first buy, then a 10% rebound off the lowest price seen since, while still
 * at a loss — $20. *Dos escalones solamente: uno con $15; si el precio cae más
 * de 80% y hay un rebote de 10%, nueva compra DCA de $20.* See
 * `domain/strategy/deep-rung.ts`.
 *
 * On the sweep for the reason every ladder is: it runs every thirty seconds, in
 * all three places the book is watched, with the live price.
 */
export interface DeepRung {
  readonly policy: DeepRungPolicy
  /** What the rung buys, in dollars. */
  readonly usd: number
  /**
   * Gives the position the capital of `entries` entries out of the book's free
   * capital — the same as `DropLadder.fund`, and for the same reason: a slot is
   * allocated its first buy only. Absent: the rung is bought out of what the
   * position holds.
   */
  readonly fund?: (position: PersistedPosition, entries: number) => Promise<PersistedPosition | null>
}

/**
 * EVERY buy of a holding, the first one included, on one rule: a 3% dip under
 * the reference and a 2% bounce off the low since — $1 a step, twenty at most —
 * each DCA asking 2 more points of dip and of ceiling and 1 more of bounce.
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla* — *3% suma 2%, el 2% suma 2% por cada
 * DCA* — *el rebote dejalo que aumente de 1%.* See `domain/strategy/dip-bounce.ts`.
 *
 * On the sweep for the reason every ladder is: it runs every thirty seconds, in
 * all three places the book is watched, with the live price. It is the only
 * path that buys in production — nothing is bought when a token becomes a
 * candidate, and the cascade's own doors are off — so a new position is a
 * RESERVATION the sweep watches until its first dip and bounce.
 */
export interface DipBounce {
  readonly policy: DipBouncePolicy
  /** What each step buys, in dollars. *Comprá 1 USD.* */
  readonly stepUsd: number
  /** Gas per swap, for what a step costs beyond its dollar. */
  readonly gasUsdPerSwap: number
  /**
   * Raises the position's capital by what the next step costs beyond the cash
   * it has left — the fees the slot's exact $20 does not hold — out of the
   * book's FREE capital, and returns it as saved; null when nothing is free
   * (`fundStepFromFreeCapital`). Absent: the step is bought out of what the
   * position holds.
   */
  readonly fund?: (position: PersistedPosition, costUsd: number) => Promise<PersistedPosition | null>
  /**
   * The pool, asked LIVE before every step. Absent: no check — every caller
   * that predates it.
   *
   * YAP froze with "sell quote implausible · liquidity $52,380 = 26.6% of
   * entry", but the death watch is assessed by the tick, once a 15-minute bar,
   * and this sweep runs every thirty seconds: it bought four more steps into
   * the draining pool, 14:05 to 14:12, before the freeze landed. So the sweep
   * reads the pool itself and refuses the step the next tick would freeze.
   */
  readonly pool?: DipBouncePool
  /**
   * Whether the FIRST step of a slot is bought the moment the cycle opens it,
   * at the live price, instead of waiting for a dip and a bounce. *Y además
   * que la primera compra entre automáticamente.* The operator. See
   * `buyFirstStepOnSelection`. Absent: off — every caller that predates it.
   */
  readonly onSelection?: boolean
}

export interface DipBouncePool {
  /**
   * The book's pools, keyed `chain:token` — the runtime's ONE minute-cached
   * Jupiter reader, the liquidity watch's own, asked once a sweep for the
   * whole book and only when a step fires. A token missing from the answer, a
   * depth unreported, or a throw is silence: the step is NOT refused.
   */
  readonly liquidity: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>
  /**
   * The death watch's policy — the SAME object the tick assesses with — whose
   * freeze line refuses the step. Never a number of this sweep's own: two
   * lines for one pool would disagree about which one is draining.
   */
  readonly deathPolicy: Pick<DeathExitPolicy, 'liquidityFreezeRatio'>
  /**
   * Positions whose step a drained pool is refusing right now, so the refusal
   * is said once when it starts, never once a sweep. Owned by the caller, so
   * the cycle's sweeps and the loop's share one memory.
   */
  readonly refusing: Set<string>
}

/** What the liquidity watch said about one position on this sweep. */
interface LiquidityVerdict {
  /** Rungs on the price line are held back. */
  readonly braked: boolean
  /** The pool just bounced 5% off its minimum: the next rung, if still at a loss. */
  readonly bounced: boolean
  /** On a bounce, how far the pool had fallen from its peak, in percent. */
  readonly fellPct: number | null
}

export interface StopSweepDeps {
  readonly store: StatePort
  readonly alerts: AlertPort
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  readonly now: () => number
  /** Absent: no ladder, which is every caller that predates it. */
  readonly pressureLadder?: PressureLadder
  /** Absent: no price ladder. */
  readonly dropLadder?: DropLadder
  /** Absent: no deep rung, and no low followed. */
  readonly deepRung?: DeepRung
  /** Absent: no dip-bounce steps, and no watch kept. */
  readonly dipBounce?: DipBounce
}

export async function sweepStops(
  deps: StopSweepDeps,
  /** Per POSITION, because every line is derived from that pool's own toll. */
  levelsFor: (position: PersistedPosition) => ExitLevels,
  throttle: AlertThrottle,
  positions: readonly PersistedPosition[],
  prices: ReadonlyMap<string, number>,
  at: number,
  /** The gate's own band, so the screen and the machine cannot drift apart. */
  maxPriceRatio: number = DEFAULT_GATE_POLICY.maxPriceRatio,
): Promise<readonly string[]> {
  const stopped: string[] = []
  // The whole tape, read only when a stop would fire and the rule needs the
  // token's history — never on a quiet sweep, which is nearly all of them.
  let tape: readonly PersistedFill[] | null = null
  // The book's pools, in one call for every position this sweep may touch.
  const pools = await readPools(deps.dropLadder, positions.filter((p) => p.pendingOrders.length === 0))
  // The same book's pools for the dip-bounce's last check — asked only when a
  // step fires, and then once for every position this sweep may touch.
  const stepPools = deps.dipBounce?.pool
    ? oncePerSweep(deps.dipBounce.pool, positions.filter((p) => p.pendingOrders.length === 0))
    : null

  for (const position of positions) {
    // In flight means unresolved means halted. Never guess on top of it.
    if (position.pendingOrders.length > 0) continue

    // Read per position and per pass, deliberately. The fills move underneath
    // this as it sells, so one read at the top would let a later pass act on a
    // position it had already closed.
    const fills = await deps.store.fillsFor(position.id)
    const ledger = positionLedger(fills)
    const price = prices.get(`${position.chain}:${position.tokenAddress}`) ?? null
    const input = {
      // With `maxOpenEntries: 1` the average cost IS the entry price. The day a
      // ladder comes back these diverge, and the domain takes the entry
      // deliberately: an average falls as rungs fill, so a stop measured
      // against it chases the position down and can never be reached.
      entryPriceUsd: ledger?.avgCostUsd ?? 0,
      marketPriceUsd: price,
      openQty: ledger?.qty ?? 0,
      runAtEntryPct: position.runAtEntryPct ?? null,
    }
    /**
     * A SECOND SOURCE, or no sale.
     *
     * CWZ6Bs was bought at 0.016621382749584405 and sold here at
     * 0.000000092202559947 — **180,270×** — for one hundredth of a cent, the
     * whole $14.49 position. The token was fine: trading at 0.01556 minutes
     * later, sixteen point eight million dollars deep, UP 37.9% on the day.
     * Not a rug and not a crash, a unit nobody agreed on — the third time
     * after ZCAT (10,846×) and USDF (14,426×).
     *
     * Every other path already refused it and this one did not. `tickPosition`
     * compares the market price against the candle close and does nothing at
     * all until they agree; the rotation will not sell without a live price.
     * This sweep compared against nothing and sold into the first absurd
     * number it was handed, which is a defect I introduced when I moved the
     * stop out of the cycle and left its guards behind.
     *
     * `lastPriceUsd` is the close the engine last ACTED on, and it comes from
     * the candle feed — a different provider from the batched market call.
     * That is exactly the independence this check wants, and it costs no
     * request because it is already on the position.
     *
     * **Silence refuses here, where everywhere else it permits.** The tick
     * keeps trading through a quiet provider because halting on silence would
     * stop the whole book; the only act on offer here is an irreversible sale.
     * A stop that waits one more sweep costs thirty seconds. A stop that sells
     * at an unconfirmed number costs the position.
     */
    if (position.lastPriceUsd === null || position.lastPriceUsd === undefined) continue
    if (pricesDisagree(price, position.lastPriceUsd, maxPriceRatio)) {
      const clash = alert(
        // The SAME kind the tick uses for the same fact. Two names for one
        // condition is how a screen and a machine start disagreeing about
        // which tokens are safe.
        'position-halted',
        `⚠️ ${position.symbol} cotiza a dos precios distintos`,
        `El mercado dice ${price} y la última vela ${position.lastPriceUsd}. No se toca la posición hasta que coincidan: una venta a un número que nadie confirma es cómo se pierde una posición entera por una unidad mal leída.`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
      // Never throttled, by its own level: only a person can tell a broken
      // feed from a real collapse, and until they do, real money is still.
      await deps.alerts.send(clash)
      continue
    }

    const levels = levelsFor(position)
    const policy = levels.stop
    const avg = input.entryPriceUsd
    const held = input.openQty > 0 && avg > 0 && price !== null && price > 0

    /**
     * THE FIXED TP. *Poné un TP fijo al 12.5% del promedio* — the whole
     * holding, the first sweep the live price is at or over its average cost
     * plus the line, the big runs given up.
     *
     * First of everything a held position does here: a position at its TP is
     * leaving, and nothing that watches, locks or buys for it has anything
     * left to do. After the price guard above, like every sale here — a line
     * is only as good as the price it is compared with.
     *
     * Only on a HEALTHY death watch. A frozen position is sold by the freeze
     * exit and a condemned one by the death exit, each under its own name,
     * with its own evidence, and the freeze with its ban on release — a TP
     * sale here would close the slot out from under both and file a freeze or
     * a death on the tape as a take-profit.
     *
     * A refused sale — a fill the no-loss guard saw landing under cost —
     * changes nothing: the rest of the sweep runs as if the TP had not spoken,
     * and the position is held.
     */
    if (
      held && levels.fixedTpPct !== null && position.deathWatch.stage === 'healthy' &&
      (await takeFixedProfit(deps, levels.fixedTpPct, position, fills, avg, price!, at, throttle)) === 'sold'
    ) {
      // In the same list as the stops: the caller keeps the token out of this
      // cycle's allocation, and buying straight back what was just sold is a
      // round trip, not a rotation.
      stopped.push(position.id)
      continue
    }

    /**
     * THE LIQUIDITY WATCH, on every held position, every sweep — braked or
     * not, near a line or not — because the bounce that buys a rung does not
     * wait for the price. After the price guard: a bounce acts at the live
     * price, and a price nobody confirms is one no rung is bought at. What it
     * decides is read by the price ladder below, on whichever path reaches it.
     */
    const liquidity = held && pools !== null ? await watchLiquidity(deps, pools, position, fills, at, throttle) : null

    /**
     * THE LOW, on every held position, every sweep — the deep rung's rebound is
     * measured from it, and a low missed while the price was elsewhere is a
     * rebound measured from the wrong place. After the price guard, like the
     * watch: a price nobody confirms would set a low no real price ever
     * touched, and every price after it would read as a rebound.
     */
    const low = held && deps.deepRung ? await watchLow(deps, deps.deepRung, position, fills, price!, at) : null

    /**
     * THE GAIN LOCK. *Por si algo es muy volátil y vuela para arriba, lo
     * podemos atrapar si baja a toda velocidad.*
     *
     * First, before the break-even and before either ladder: a position at its
     * floor is leaving, and a rung bought into it on the way out would be the
     * ladder spending capital on a sale already decided. After the price guard
     * above, like every sale here — a floor is only as good as the price it is
     * compared with.
     *
     * A refused sale — a crash that gapped through the floor and under cost —
     * changes nothing: the rest of the sweep runs as if the lock had not
     * spoken, so the position is held, never closed with tokens in it, and the
     * ladder may average it down.
     */
    if (held && levels.gainLock && (await lockGains(deps, levels.gainLock, position, fills, avg, price!, at, throttle)) === 'sold') {
      // In the same list as the stops, for the same reason as the break-even:
      // the caller keeps the token out of this cycle's allocation.
      stopped.push(position.id)
      continue
    }

    /**
     * THE RATCHET. *Estaban ganando un montón, retrocedieron hasta perder, y
     * cerraron en pérdida porque no tomaron la ganancia cuando pudieron.*
     *
     * Measured against real candles: four losers had been above the target
     * first, two on a bar CLOSE — GTBxUiw peaked at +27.58% and left at
     * −12.50%. The strategy exit wants the impulse to be seen to STALL, and a
     * violent reversal goes straight through the target without producing
     * that signal while still above it.
     *
     * So once a position has been at its target it may never close at a loss.
     * Here, on the live price every thirty seconds — the same cadence as the
     * stop, which is the point: the asymmetry was a stop that looked twice a
     * minute and an exit that looked four times an hour.
     *
     * Arming is SAVED, and the store keeps it with OR. Every step of the cycle
     * writes the whole row, so a flag held anywhere weaker would be cleared by
     * the first stale snapshot written over it.
     */
    let armed = levels.armAtPct !== null && position.breakEvenArmed === true
    if (!armed && levels.armAtPct !== null && held && price! >= avg * (1 + levels.armAtPct / 100)) {
      await deps.store.savePosition({ ...position, breakEvenArmed: true })
      armed = true
    }
    if (armed && held && price! <= avg * (1 + levels.breakEvenPct / 100)) {
      const broker = await deps.brokerFor(position)
      const refused = await settle(
        [{ kind: 'closeAll', comment: BREAK_EVEN_COMMENT }],
        position.lastBarTime,
        price!,
        at,
        position,
        broker,
        deps.store,
      )
      // Refused means it would have closed in the red: the position is HELD,
      // with its tokens, and the ladder may average it down. Closing it here
      // anyway would orphan the quantity — neither realised nor unrealised,
      // and gone from the screen that was watching it.
      //
      // BOTH ladders, not only the pressure one. The ratchet is on by default
      // now, and an armed position stays armed for life — so a winner that
      // turned and fell through its first buy came here on every sweep, and
      // the price ladder below never got a look: a rung at −10% of the first
      // buy that could never fire on exactly the positions that had fallen.
      if (refused) {
        if (deps.pressureLadder && (await actOnPressure(deps, deps.pressureLadder, position, fills, price!, at, throttle)) === 'sold') {
          stopped.push(position.id)
          continue
        }
        await buyRungs(deps, position, fills, price!, at, throttle, liquidity, low, stepPools)
        continue
      }
      await deps.store.closePosition(position.id)
      // In the same list as the stops, on purpose: the caller locks the token
      // out of the same cycle's allocation, and buying straight back what was
      // just sold is a round trip, not a rotation.
      stopped.push(position.id)
      // In the lines it actually ran on. With both at +7.5% the story is no
      // longer "back to cost": it reached +7.5%, came back to +7.5%, and the
      // gain was locked instead of handed back.
      const kept = alert(
        'position-closed',
        `🔒 ${position.symbol} aseguró la ganancia`,
        `Había llegado a +${levels.armAtPct!.toFixed(1)}% sobre el costo promedio y volvió a +${levels.breakEvenPct.toFixed(1)}%. Se vendió todo a ${price} (${((price! / avg - 1) * 100).toFixed(2)}% sobre el costo) en vez de devolver la ganancia: una posición que ganó no cierra en pérdida.`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
      if (throttle.shouldSend(kept, `break-even:${position.id}`)) await deps.alerts.send(kept)
      continue
    }

    let cut = shouldStopOut(input, policy)
    // *Si la ganancia es mayor a la pérdida también SL y rotar; si no, no salir
    // en pérdida.* A loss the token has already paid for leaves it still
    // ahead; one it has not is held, and the ladder averages it down.
    if (cut && policy.onlyWhenHistoryCovers === true) {
      tape ??= await deps.store.allFills()
      cut = tokenNetUsd(tape, position.chain, position.tokenAddress) > lossUsd(input)
    }
    if (!cut) {
      if (held && deps.pressureLadder && (await actOnPressure(deps, deps.pressureLadder, position, fills, price!, at, throttle)) === 'sold') {
        stopped.push(position.id)
        continue
      }
      // A RESERVATION buys too: its first dollar is a dip-bounce step like
      // every other, so the sweep watches a position that holds nothing yet.
      if (held || (deps.dipBounce && price !== null && price > 0)) await buyRungs(deps, position, fills, price!, at, throttle, liquidity, low, stepPools)
      continue
    }

    const broker = await deps.brokerFor(position)
    // The SAME `settle` as every other exit — one idempotency key, one per-fill
    // suffix. A second copy of that is how a retry sells twice. The no-loss
    // guard lets this one through by design: a stop that cannot sell at a loss
    // is not a stop.
    await settle(
      [{ kind: 'closeAll', comment: STOP_LOSS_COMMENT }],
      position.lastBarTime,
      price!,
      at,
      position,
      broker,
      deps.store,
    )
    await deps.store.closePosition(position.id)
    stopped.push(position.id)

    const down = drawdownPct(input)
    // In the unit of the rule that fired. Explaining a dollar cut in
    // percentages would be the screen describing a rule the engine is not
    // running.
    const why =
      policy.maxLossUsd !== undefined && policy.maxLossUsd > 0
        ? `Perdía $${lossUsd(input).toFixed(2)} y el stop es de $${policy.maxLossUsd.toFixed(2)}.`
        : `Cayó ${down === null ? '' : down.toFixed(1) + '% '}bajo el precio de compra, y su stop estaba en ${stopLossPctFor(input.runAtEntryPct, policy).toFixed(0)}%.`
    const cutAlert = alert(
      'token-stopped',
      `🛑 ${position.symbol} cortada por stop`,
      `${why} Se vendió todo a ${price}. El token NO queda vetado.`,
      at,
      { position: position.id, token: position.tokenAddress },
    )
    if (throttle.shouldSend(cutAlert, `stopped:${position.id}`)) await deps.alerts.send(cutAlert)
  }

  return stopped
}

/**
 * The fixed TP on one held position: the whole holding, at the live price,
 * once that price is at or over its average cost plus `pct` percent — over the
 * same average the gain lock, the strategy's exit and the screen read.
 *
 * Returns 'sold' when the position was closed; null when it holds — under the
 * line, a sale the no-loss guard refused, or a sale that recorded nothing. The
 * last one is not closed: a position closed with tokens still on its ledger
 * orphans them, neither realised nor unrealised, and gone from the screen.
 */
async function takeFixedProfit(
  deps: StopSweepDeps,
  pct: number,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  avgCostUsd: number,
  price: number,
  at: number,
  throttle: AlertThrottle,
): Promise<'sold' | null> {
  if (!reachedFixedTp(price, avgCostUsd, pct)) return null

  const broker = await deps.brokerFor(position)
  // The SAME `settle` as every other exit — one idempotency key, the no-loss
  // guard, the per-fill suffix. A second copy of that is how a retry sells
  // twice. NOT exempt from the guard: it is a strategy exit, and its line is
  // above cost, so a refusal means the fill would land under it.
  const refused = await settle(
    [{ kind: 'closeAll', comment: FIXED_TP_COMMENT }],
    position.lastBarTime,
    price,
    at,
    position,
    broker,
    deps.store,
  )
  if (refused) return null
  const after = await deps.store.fillsFor(position.id)
  if (after.length === fills.length) return null
  // What THIS sale made, against the basis it sold out of — the same walk the
  // tape's per-sale figure uses, so the alert and the Registro line agree.
  // Costs are not subtracted, for the tape's reason: they have their own column.
  const made = positionLedger(after).realisedUsd - positionLedger(fills).realisedUsd
  await deps.store.closePosition(position.id)

  const gain = (price / avgCostUsd - 1) * 100
  const sold = alert(
    'position-closed',
    `🎯 ${position.symbol} vendida en su TP fijo: +${asked(pct)}% sobre el promedio — ganó $${made.toFixed(2)}`,
    `Llegó a +${gain.toFixed(2)}% sobre el costo promedio (${avgCostUsd}) y se vendió todo a ${price}, sin esperar el impulso ni el cierre de la vela. El TP fijo está en +${asked(pct)}%.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(sold, `fixed-tp:${position.id}`)) await deps.alerts.send(sold)
  return 'sold'
}

/**
 * The stepped gain lock on one held position: raise its floor to the step the
 * gain has reached, and sell the whole position once the price is back at it.
 *
 * The floor belongs to the HOLDING, not to the position id. A position that
 * sold and bought back keeps its id and its tape, and a floor of +20% earned by
 * the old holding would sell a re-entry up 5% at once. So a stored lock counts
 * only when its `since` is this holding's first buy; any other is history, and
 * the store replaces it the moment the new holding earns one of its own.
 *
 * Saved only when it RISES. The store ratchets the pair, so the snapshots the
 * rest of the cycle writes back — the tick's, the trim's, a funded rung's —
 * cannot lower it; saving an unchanged floor every thirty seconds would only
 * be a write.
 *
 * Returns 'sold' when the position was closed; null when it holds — no floor
 * yet, above its floor, or a sale the no-loss guard refused.
 */
async function lockGains(
  deps: StopSweepDeps,
  policy: GainLockPolicy,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  avgCostUsd: number,
  price: number,
  at: number,
  throttle: AlertThrottle,
): Promise<'sold' | null> {
  const first = holdingBuys(fills)[0]
  if (!first) return null
  const since = first.time
  // Over the average cost of what is held NOW — the same basis the strategy's
  // exit and the no-loss guard read, so the three cannot disagree about
  // whether a position is winning.
  const gainPct = (price / avgCostUsd - 1) * 100
  const stored = position.gainLock !== null && position.gainLock !== undefined && position.gainLock.since === since ? position.gainLock.pct : null
  const reached = gainLockFloorPct(gainPct, policy)
  const lock = reached !== null && (stored === null || reached > stored) ? reached : stored
  if (lock === null) return null
  if (lock !== stored) await deps.store.savePosition({ ...position, gainLock: { pct: lock, since } })
  // On the operator's numbers every floor is half the gain that set it, so a
  // floor just raised is always under the price that raised it: this never
  // sells on the sweep that set the line, which would be a take-profit wearing
  // the lock's name.
  if (gainPct > lock) return null

  const broker = await deps.brokerFor(position)
  // The SAME `settle` as every other exit, and NOT exempt from the no-loss
  // guard: every floor is above cost, so a refusal means the price gapped
  // under cost between two sweeps — and then the position is held.
  const refused = await settle(
    [{ kind: 'closeAll', comment: GAIN_LOCK_COMMENT }],
    position.lastBarTime,
    price,
    at,
    position,
    broker,
    deps.store,
  )
  if (refused) return null
  await deps.store.closePosition(position.id)
  // In the lines it ran on: how far it flew, the floor that left it, and where
  // it actually sold — so the reader can see what was kept, not only that
  // something sold.
  const kept = alert(
    'position-closed',
    `🔐 ${position.symbol} vendida en su piso de ganancia`,
    `Llegó a +${gainLockStepPct(lock, policy)}% sobre el costo promedio y su piso subió a +${lock}%. Volvió a +${gainPct.toFixed(2)}% y se vendió todo a ${price}: lo que ya había ganado no se devuelve.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(kept, `gain-lock:${position.id}`)) await deps.alerts.send(kept)
  return 'sold'
}

/**
 * What buy pressure says now, acted on: a rung when buyers push through 1%,
 * the whole position when they fall through it — *se vende como esté*.
 *
 * ONE reading and ONE memory for both, so a buy and a sale can never be
 * decided on two different views of the same hour. A rung is never bought
 * into a position the death watch froze or condemned; the sale is allowed in
 * any stage, because leaving is never new risk.
 */
async function actOnPressure(
  deps: StopSweepDeps,
  ladder: PressureLadder,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  at: number,
  throttle: AlertThrottle,
): Promise<'bought' | 'sold' | null> {
  const entries = holdingBuys(fills).length
  if (entries < 1) return null

  let counts: Awaited<ReturnType<PressureLadder['hourCounts']>>
  try {
    counts = await ladder.hourCounts(position)
  } catch {
    return null
  }
  const now = counts === null ? null : pressureOf(counts.buys, counts.sells, 'buy')
  const previous = ladder.previous.get(position.id) ?? null
  // A silent hour keeps the last reading: it is not a fall to zero, and
  // recording it as one would fake a crossing the moment trades come back.
  if (now !== null) ladder.previous.set(position.id, now)
  if (counts === null) return null
  const trades = counts.buys + counts.sells
  const line = `${(ladder.policy.threshold * 100).toFixed(0)}%`

  // *La venta se va a realizar si la presión compradora cae 1%* — and then
  // *asegurate que haya margen positivo, para que no tengamos pérdidas ni
  // comisiones innecesarias.* The first eight all closed in the red: buyers
  // leave as the price turns. So their leaving MARKS the position, and it is
  // sold the first sweep it is up by more than its whole round trip — the
  // fees paid entering plus the cost of leaving now. Buyers coming back clear
  // the mark: they did not leave after all.
  if (buyersFellThrough({ previous, now }, ladder.policy.threshold)) ladder.gone.add(position.id)
  if (now !== null && now > ladder.policy.threshold) ladder.gone.delete(position.id)
  if (ladder.gone.has(position.id)) {
    const ledger = positionLedger(fills)
    if (ledger.avgCostUsd === null || !(ledger.qty > 0)) return null
    const standing = (price / ledger.avgCostUsd - 1) * 100
    const toll = positionTollPct(openLotCostsUsd(fills), ledger.deployedUsd, ledger.qty * price, position.quality, ladder.gasUsdPerSwap)
    // Marked and not yet clear: held, and no rung is bought into a token its
    // buyers just left.
    if (!(standing > toll)) return null
    const broker = await deps.brokerFor(position)
    const refused = await settle(
      [{ kind: 'closeAll', comment: BUYERS_GONE_COMMENT }],
      position.lastBarTime,
      price,
      at,
      position,
      broker,
      deps.store,
    )
    if (refused) return null
    await deps.store.closePosition(position.id)
    ladder.previous.delete(position.id)
    ladder.gone.delete(position.id)
    const gone = alert(
      'token-rotated',
      `📉 ${position.symbol} sin compradores: salió con ganancia`,
      `Los compradores se fueron — la presión compradora cayó del ${line} (${counts.buys} compras de ${trades} en la última hora) — y va +${standing.toFixed(2)}%, más que el ${toll.toFixed(2)}% que cuesta el viaje. Se vendió todo a ${price}. El token NO queda vetado.`,
      at,
      { position: position.id, token: position.tokenAddress },
    )
    if (throttle.shouldSend(gone, `gone:${position.id}`)) await deps.alerts.send(gone)
    return 'sold'
  }

  if (position.deathWatch.stage !== 'healthy') return null
  const rung = nextPressureRung({ entries, previous, now }, ladder.policy)
  if (rung === null) return null

  const id = `DCA-${rung}`
  const funded = ladder.fund ? await ladder.fund(position, entries + 1) : position
  if (funded === null) {
    // The crossing is spent either way — the ladder buys ONE rung per crossing
    // — so it says when it will look again, not that it will retry.
    await sayUnfunded(deps, position, id, `La presión compradora cruzó el ${line}`, 'Se compra en el próximo cruce, si para entonces hay capital libre.', at, throttle)
    return null
  }
  const broker = await deps.brokerFor(funded)
  const before = fills.length
  await settle(
    [{ kind: 'entry', id, level: rung, usd: ladder.rungUsd, qty: ladder.rungUsd / price, comment: id }],
    funded.lastBarTime,
    price,
    at,
    funded,
    broker,
    deps.store,
  )
  if ((await deps.store.fillsFor(position.id)).length === before) return null
  const bought = alert(
    'dca-filled',
    `🪜 ${position.symbol} promedió — ${id}`,
    `La presión compradora cruzó el ${line} (${counts.buys} compras de ${trades} en la última hora). Compró $${ladder.rungUsd.toFixed(2)} a ${price}.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(bought, `dca:${position.id}:${rung}`)) await deps.alerts.send(bought)
  return 'bought'
}

/**
 * A rung that fired and found nothing free to pay for it.
 *
 * INFO, and throttled per position: nothing was bought and nothing is at risk,
 * and the rung is asked for again on the next sweep. A phone that buzzes every
 * thirty seconds for a rung it cannot afford is a phone whose notifications get
 * turned off, after which the death exit does not arrive either.
 */
async function sayUnfunded(
  deps: StopSweepDeps,
  position: PersistedPosition,
  id: string,
  /** What fired the rung, and — in its own words — when it is asked for again. */
  why: string,
  then: string,
  at: number,
  throttle: AlertThrottle,
): Promise<void> {
  const unfunded = alert(
    'entry-refused',
    `💤 ${position.symbol} sin capital libre para el escalón ${id}`,
    `${why}, pero todo el capital está asignado. ${then}`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(unfunded, `unfunded:${position.id}`)) await deps.alerts.send(unfunded)
}

/**
 * What the next rung's drops are multiplied by, and — in the operator's words,
 * for the alert — which volatility said so. Null when no spacing at all could
 * put a rung under this price, so nothing is worth asking.
 *
 * Three answers, in order, and each one only when the one before is silent:
 *
 * 1. **The last hour, now** (`recentVolatility`). *Tiempo real.* While a token
 *    is crashing its last hour explodes and the rung waits far deeper; calm,
 *    it sits close and buys the small dips.
 * 2. **The day before the first buy** (`position.dcaScale`), measured once by
 *    the tick. What ran before, and the fallback when the hour cannot be read.
 * 3. **One** — the base drops. Silence is not evidence.
 *
 * With `adaptive` off it is one, always, and nothing is asked: a switch that
 * turns the spacing off has to turn every spacing off.
 */
async function spacingFor(
  deps: StopSweepDeps,
  ladder: DropLadder,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  where: Omit<Parameters<typeof nextDropRung>[0], 'scale'>,
): Promise<{ readonly scale: number; readonly why: string } | null> {
  if (ladder.adaptive !== true) return { scale: 1, why: '' }
  // Read off the position the sweep was handed, which the store keeps
  // write-once, so no stale row can move it mid-ladder.
  const atBuy = usableScale(position.dcaScale)
  const fallback = { scale: atBuy, why: atBuy !== 1 ? ' (volatilidad al comprar)' : '' }
  if (!ladder.recentVolatility) return fallback

  // The cheapest question first. Half the base drop — or less, for a stored
  // scale under that — is as close as any spacing can put this rung; a price
  // above that line cannot buy whatever the hour says, so the hour is not
  // fetched. That is nearly the whole book on nearly every sweep.
  const shallowest = Math.min(REALTIME_DCA_SCALE_POLICY.minScale, atBuy)
  if (nextDropRung({ ...where, scale: shallowest }, ladder.policy) === null) return null

  let measured: RecentVolatility | null
  try {
    measured = await ladder.recentVolatility(position)
  } catch {
    // A refusal is not a reading.
    measured = null
  }
  const now = measured === null ? null : realtimeDcaScale(measured.volPct)
  if (measured === null || now === null) return fallback

  await rememberReading(deps, position, fills, now, measured.measuredAt)
  return { scale: now, why: ` (volatilidad de la última hora: ${measured.volPct.toFixed(1)}%)` }
}

/**
 * Writes the real-time scale onto the position, so the screen draws the line
 * the sweep is actually waiting on — once per reading, never once per sweep:
 * a reading the position already carries is not written again.
 *
 * The whole row goes back, from the snapshot this sweep was handed, and two
 * things keep that safe. The store keeps the NEWER reading, so no later stale
 * write can put an older one over it. And the write waits when this pass has
 * already bought for this position — a pressure rung earlier in the same
 * sweep raised the row's capital in the store, and the snapshot would lower it
 * again. The next sweep reads the row fresh and writes it then.
 */
async function rememberReading(
  deps: StopSweepDeps,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  scale: number,
  measuredAt: number,
): Promise<void> {
  if (position.dcaScaleNowAt !== null && position.dcaScaleNowAt !== undefined && position.dcaScaleNowAt >= measuredAt) return
  if ((await deps.store.fillsFor(position.id)).length !== fills.length) return
  await deps.store.savePosition({ ...position, dcaScaleNow: scale, dcaScaleNowAt: measuredAt })
}

/** The book's pool readings for one sweep, and the switch they were read under. */
interface PoolReadings {
  readonly ladder: DropLadder
  readonly brakePct: number
  readonly readings: ReadonlyMap<string, LiquidityReading>
}

/**
 * The whole book's pools, in ONE call per sweep — or null when there is no
 * watch: no reader wired, or the switch at zero. Off asks nothing: a switch
 * that still spends a request is half off.
 *
 * A throw is silence for every token: the watches change nothing on it, and a
 * braked one stays braked. One refused request neither brakes a pool nor
 * counts as its bounce.
 */
async function readPools(ladder: DropLadder | undefined, positions: readonly PersistedPosition[]): Promise<PoolReadings | null> {
  if (!ladder?.liquidityChange) return null
  const brakePct = ladder.liquidityBrakePct ?? DEFAULT_LIQUIDITY_BRAKE_PCT
  if (!(brakePct > 0)) return null
  if (positions.length === 0) return { ladder, brakePct, readings: new Map() }
  try {
    return { ladder, brakePct, readings: await ladder.liquidityChange(positions) }
  } catch {
    return { ladder, brakePct, readings: new Map() }
  }
}

/**
 * One held position's liquidity watch, moved by this sweep's reading and
 * written down when it matters. *Freno en tiempo real por cambio de liquidez
 * inmediata que supere el 5%* — then *siempre esperar la recuperación del 5% de
 * liquidez a partir del mínimo.*
 *
 * PAID froze with its pool at 41% of its entry liquidity after the ladder had
 * bought DCA-2 and DCA-3 into it: the price fell because the pool was
 * emptying, and a ladder that reads only the price bought the emptying. So a
 * drain BRAKES the ladder, the brake is a state that survives the sweep and
 * the process, and only a 5% bounce off the minimum lifts it.
 *
 * Written from the snapshot this sweep was handed — the first write any step
 * of this pass makes for the position — and only when `liquidityWatchMoved`
 * says so. Every later write in the pass, and every stale snapshot the cycle
 * saves, carries an older watch or none, and the store keeps the newer one.
 */
async function watchLiquidity(
  deps: StopSweepDeps,
  pools: PoolReadings,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  at: number,
  throttle: AlertThrottle,
): Promise<LiquidityVerdict | null> {
  const buys = holdingBuys(fills)
  const first = buys[0]
  if (!first) return null
  const stored = position.liquidityWatch ?? null
  const reading = pools.readings.get(`${position.chain}:${position.tokenAddress}`) ?? null
  const policy = { ...DEFAULT_LIQUIDITY_WATCH_POLICY, brakePct: pools.brakePct }
  const step = nextLiquidityWatch(stored, reading, policy, { since: first.time, at })
  if (step.watch !== null && liquidityWatchMoved(stored, step.watch)) {
    await deps.store.savePosition({ ...position, liquidityWatch: step.watch })
  }
  if (step.action === 'brake' && reading !== null) await sayBraked(deps, pools, position, buys.length, reading, at, throttle)
  return { braked: step.watch?.braked === true, bounced: step.action === 'buy', fellPct: step.fellPct }
}

/**
 * The brake engaged: which rung it holds, and why. Said ONCE, on the sweep
 * that braked — the state is written down, so the next sweeps know it is
 * already on — and only when there is a next rung to hold.
 *
 * INFO, like a rung with no capital: nothing was bought and nothing is at
 * risk. A buzz for a rung on hold is how the phone gets muted.
 */
async function sayBraked(
  deps: StopSweepDeps,
  pools: PoolReadings,
  position: PersistedPosition,
  entries: number,
  reading: LiquidityReading,
  at: number,
  throttle: AlertThrottle,
): Promise<void> {
  const { ladder, brakePct } = pools
  // A frozen or condemned position buys no rung anyway: saying the brake holds
  // one back would name the wrong reason.
  if (position.deathWatch.stage !== 'healthy') return
  if (entries >= ladder.policy.maxEntries || ladder.rungsUsd[entries - 1] === undefined) return
  const id = `DCA-${entries}`
  // Every window that fell, in the order a reader thinks of them: the sudden
  // pull first, then the slow one.
  const fell = [
    ...(liquidityFell(reading.m5, brakePct) ? [`${Math.abs(reading.m5!).toFixed(1)}% en los últimos 5 minutos`] : []),
    ...(liquidityFell(reading.h1, brakePct) ? [`${Math.abs(reading.h1!).toFixed(1)}% en la última hora`] : []),
  ].join(' y ')
  const recover = DEFAULT_LIQUIDITY_WATCH_POLICY.recoverPct
  const braked = alert(
    'entry-refused',
    `🧊 ${position.symbol}: escalón frenado`,
    `La liquidez del pool cayó ${fell}; ${id} no se compra hasta que deje de caer y rebote ${recover}% desde el mínimo.`,
    at,
    { position: position.id, token: position.tokenAddress, liquidity: reading },
  )
  if (throttle.shouldSend(braked, `brake:${position.id}:${id}`)) await deps.alerts.send(braked)
}

/**
 * The rung the bounce buys. *Activar la compra del escalón si está en negativo
 * todavía.* The NEXT rung, at its own size, at the live price — whatever its
 * price line says, because the signal here is the pool, not the chart.
 *
 * Only while the position is still at a LOSS: a bounce that finds it in
 * profit has nothing to average, and it is only the brake lifting
 * ('released'), after which the price line buys as it always did. Likewise
 * when the ladder is full or the rung has no size. Anything else is this
 * sweep's one rung: bought, or waiting on capital — the bounce is spent either
 * way, like a crossing of the pressure ladder.
 */
async function buyOnBounce(
  deps: StopSweepDeps,
  ladder: DropLadder,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  entries: number,
  price: number,
  fellPct: number | null,
  at: number,
  throttle: AlertThrottle,
): Promise<'bought' | 'released'> {
  const avgCost = positionLedger(fills).avgCostUsd
  if (avgCost === null || !(price < avgCost)) return 'released'
  if (entries >= ladder.policy.maxEntries) return 'released'
  const rung = entries
  const usd = ladder.rungsUsd[rung - 1]
  if (usd === undefined || !(usd > 0)) return 'released'
  const id = `DCA-${rung}`
  const recover = DEFAULT_LIQUIDITY_WATCH_POLICY.recoverPct
  const fell = (fellPct ?? 0).toFixed(1)

  const funded = ladder.fund ? await ladder.fund(position, entries + 1) : position
  if (funded === null) {
    await sayUnfunded(
      deps, position, id,
      `La liquidez se recuperó ${recover}% desde el mínimo (había caído ${fell}%) y la posición sigue en pérdida`,
      'El escalón vuelve a esperar su línea de precio.', at, throttle,
    )
    return 'bought'
  }
  const broker = await deps.brokerFor(funded)
  const before = fills.length
  await settle(
    [{ kind: 'entry', id, level: rung, usd, qty: usd / price, comment: id }],
    funded.lastBarTime,
    price,
    at,
    funded,
    broker,
    deps.store,
  )
  if ((await deps.store.fillsFor(position.id)).length === before) return 'bought'
  const under = ((1 - price / avgCost) * 100).toFixed(1)
  const bought = alert(
    'dca-filled',
    `🌱 ${position.symbol}: la liquidez se recuperó ${recover}% desde el mínimo (había caído ${fell}%) — compra ${id}`,
    `Sigue ${under}% bajo el costo promedio (${avgCost}). Compró $${usd.toFixed(2)} a ${price}, sin esperar la línea de precio del escalón.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(bought, `dca:${position.id}:${rung}`)) await deps.alerts.send(bought)
  return 'bought'
}

/**
 * One rung, if the price has fallen far enough under the FIRST buy, at that
 * rung's own size. Never into a position the death watch has frozen or
 * condemned, and never while the liquidity watch holds the ladder braked —
 * whose bounce, instead, buys the next rung on its own terms.
 *
 * The rung pays for itself: its capital is asked of the book's free capital
 * first (`DropLadder.fund`), and the broker is built from the position AS
 * FUNDED. A broker built from the old one refuses the entry for funds — the
 * first buy already spent what the position was given — which would be a rung
 * decided into a void.
 */
async function buyOnDrop(
  deps: StopSweepDeps,
  ladder: DropLadder,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  at: number,
  throttle: AlertThrottle,
  /** What the liquidity watch said this sweep; null when there is no watch. */
  liquidity: LiquidityVerdict | null = null,
): Promise<void> {
  if (position.deathWatch.stage !== 'healthy') return
  // The HOLDING's buys, never the tape's: a position that sold and bought back
  // starts its ladder again from the new entry.
  const buys = holdingBuys(fills)
  const first = buys[0]
  const last = buys[buys.length - 1]
  if (!first || !last) return
  // The bounce first: it is this sweep's one rung when it buys, and when it
  // only releases the brake, the price line below runs as it always did.
  if (liquidity?.bounced === true
    && (await buyOnBounce(deps, ladder, position, fills, buys.length, price, liquidity.fellPct, at, throttle)) === 'bought') return
  // Braked: no rung on the price line, however far it fell — and nothing
  // asked of the hour's volatility or of the free capital on the way.
  if (liquidity?.braked === true) return
  const where = { entries: buys.length, firstBuyPrice: first.price, lastBuyPrice: last.price, priceUsd: price }
  const spacing = await spacingFor(deps, ladder, position, fills, where)
  if (spacing === null) return
  const { scale, why } = spacing
  const rung = nextDropRung({ ...where, scale }, ladder.policy)
  if (rung === null) return
  // Said against the anchor the rule measured from, so the alert explains the
  // rule that fired rather than another one.
  const anchor = ladder.policy.from === 'previous' ? last : first
  const since = ladder.policy.from === 'previous' ? 'la compra anterior' : 'la primera compra'
  // Its OWN size. A rung the list has no size for is not bought at some other
  // rung's: that would be a trade nobody priced.
  const usd = ladder.rungsUsd[rung - 1]
  if (usd === undefined || !(usd > 0)) return
  const id = `DCA-${rung}`
  const fell = ((1 - price / anchor.price) * 100).toFixed(1)
  // The fall THIS rung waited for, at this token's scale — the line the
  // engine bought on, not the base list's, or a rung bought at −5.2% would be
  // explained with a −10% nobody was waiting for.
  const asked = dropLabel(scaledDropPct(ladder.policy.dropsPct[rung - 1]!, scale))

  const funded = ladder.fund ? await ladder.fund(position, buys.length + 1) : position
  if (funded === null) {
    await sayUnfunded(deps, position, id, `El precio cayó ${fell}% desde ${since}, y este escalón pedía ${asked}%${why}`, 'Se vuelve a intentar en el próximo barrido.', at, throttle)
    return
  }

  const broker = await deps.brokerFor(funded)
  const before = fills.length
  await settle(
    [{ kind: 'entry', id, level: rung, usd, qty: usd / price, comment: id }],
    funded.lastBarTime,
    price,
    at,
    funded,
    broker,
    deps.store,
  )
  if ((await deps.store.fillsFor(position.id)).length === before) return
  const bought = alert(
    'dca-filled',
    `🪜 ${position.symbol} promedió — ${id}`,
    `El precio cayó ${fell}% desde ${since} (${anchor.price}), y este escalón pedía ${asked}%${why}. Compró $${usd.toFixed(2)} a ${price}.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(bought, `dca:${position.id}:${rung}`)) await deps.alerts.send(bought)
}

/**
 * This sweep's buy, if any: the dip-bounce step first, then the deep rung, then
 * the chained drop ladder when they are switched on. ONE a sweep — a step or a
 * rung that bought, that fired and found no capital, or that fired into a
 * drained pool, leaves the rest for the next sweep, so the same fall is never
 * bought twice off one stale read of the fills, and a pool refused for one
 * ladder is not bought into by another.
 */
async function buyRungs(
  deps: StopSweepDeps,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  at: number,
  throttle: AlertThrottle,
  liquidity: LiquidityVerdict | null,
  low: PriceLow | null,
  stepPools: StepPools | null,
): Promise<void> {
  if (deps.dipBounce && (await buyOnDipBounce(deps, deps.dipBounce, position, fills, price, at, throttle, stepPools)) !== null) return
  const deep = deps.deepRung ? await buyOnDeepRung(deps, deps.deepRung, position, fills, price, low, at, throttle) : null
  if (deep === null && deps.dropLadder) await buyOnDrop(deps, deps.dropLadder, position, fills, price, at, throttle, liquidity)
}

/**
 * One held position's low, moved by this sweep's live price and written down
 * when it matters. The low of THIS holding — the time of its first buy — so a
 * position that sold and bought back starts a new one.
 *
 * Written only once it is under the arming line, and there every time it
 * falls (`priceLowWorthWriting`): above the line no decision reads it, and a
 * whole-row write every time a falling token ticks lower is network this
 * project cannot spare. Written from the snapshot this sweep was handed; every
 * later write in the pass, and every stale snapshot the cycle saves, carries an
 * older low or none, and the store keeps the lower (`keepPriceLow`).
 */
async function watchLow(
  deps: StopSweepDeps,
  rung: DeepRung,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  at: number,
): Promise<PriceLow | null> {
  const first = holdingBuys(fills)[0]
  if (!first) return null
  const stored = position.priceLow ?? null
  const next = nextPriceLow(stored, price, { since: first.time, at })
  if (priceLowWorthWriting(stored, next, first.price, rung.policy)) await deps.store.savePosition({ ...position, priceLow: next })
  return next
}

/** Dollars as the operator says them: $20, not $20.00. */
const dollars = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`

/** A line a step asks for, as the operator says it: 7, not 7.00 — and 4.5 when a step is fractional. */
const asked = (pct: number): string => String(Number(pct.toFixed(2)))

/** Which buy a ceiling belongs to, in the operator's words: the first, or the DCA it is. */
const ceilingOf = (step: number): string => (step <= 1 ? 'techo de la primera compra' : `techo del DCA ${step - 1}`)

/** The book's pools for one sweep's dip-bounce steps, and the check they are read for. */
interface StepPools {
  readonly pool: DipBouncePool
  /** The readings, asked on the first call and shared by every later one in the sweep. */
  readonly read: () => Promise<ReadonlyMap<string, LiquidityReading>>
}

/**
 * The book's pools for one sweep, asked on the FIRST step that fires and never
 * again in that sweep — and never at all on a sweep where no step fires, which
 * is nearly all of them. One request for the whole book, not one per step.
 *
 * A throw is silence for every token: no step is refused on a request nobody
 * answered.
 */
function oncePerSweep(pool: DipBouncePool, positions: readonly PersistedPosition[]): StepPools {
  let asked: Promise<ReadonlyMap<string, LiquidityReading>> | null = null
  const read = () => {
    asked ??= pool.liquidity(positions).catch(() => new Map<string, LiquidityReading>())
    return asked
  }
  return { pool, read }
}

/**
 * Whether the pool refuses this step, and — the first sweep it does — says so.
 *
 * Refused when the pool's live depth is under the line the death watch
 * FREEZES on, measured against the liquidity the watch recorded at opening:
 * the step the next tick would freeze is never bought in the thirty seconds
 * before it. A reading nobody gave refuses nothing.
 *
 * INFO, once per refusal: the position is remembered as refusing until a
 * later step finds the pool above the line, so a pool that stays drained is
 * said once, and one that drains again is said again.
 */
async function poolRefuses(
  deps: StopSweepDeps,
  pools: StepPools,
  position: PersistedPosition,
  stepIndex: number,
  max: number,
  at: number,
  throttle: AlertThrottle,
): Promise<boolean> {
  const { pool } = pools
  const reading = (await pools.read()).get(`${position.chain}:${position.tokenAddress}`) ?? null
  const entry = position.deathWatch.entryLiquidityUsd
  if (!liquidityBelowFreeze(reading?.usd, entry, pool.deathPolicy)) {
    pool.refusing.delete(position.id)
    return false
  }
  if (pool.refusing.has(position.id)) return true
  pool.refusing.add(position.id)
  const usd = reading!.usd!
  const left = ((usd / entry) * 100).toFixed(1)
  const line = (pool.deathPolicy.liquidityFreezeRatio * 100).toFixed(0)
  const refused = alert(
    'entry-refused',
    `🧊 ${position.symbol}: el pool perdió liquidez (queda ${left}% de la entrada) — no compra`,
    `La liquidez del pool es $${usd.toFixed(0)} y al abrir la posición era $${entry.toFixed(0)}. Bajo el ${line}% de la entrada el vigilante congela la posición en el próximo tick, así que la compra ${stepIndex} de ${max} no se hace mientras siga así.`,
    at,
    { position: position.id, token: position.tokenAddress, liquidityUsd: usd, entryLiquidityUsd: entry },
  )
  if (throttle.shouldSend(refused, `drained:${position.id}`)) await deps.alerts.send(refused)
  return true
}

/**
 * A step's watch just COLLAPSED: the low went more than the step's ceiling
 * under the reference — the first buy's and DCA 1's 20%, and 2 points more for
 * every DCA after, so the alert names whose ceiling it is. Said on the look it
 * happened — the domain signals it once, and the watch carries it from then
 * on — never once a sweep. INFO: nothing was bought and nothing is at risk.
 */
async function sayCollapsed(
  deps: StopSweepDeps,
  ladder: DipBounce,
  position: PersistedPosition,
  step: DipBounceStep,
  firstBuy: boolean,
  at: number,
  throttle: AlertThrottle,
): Promise<void> {
  const watch = step.watch
  if (step.crashedPct === null || watch === null) return
  const ceiling = asked(step.thresholds.maxDipPct)
  const fell = step.crashedPct.toFixed(1)
  const from = firstBuy ? 'el máximo visto' : 'la compra anterior'
  const said = alert(
    'entry-refused',
    `🧊 ${position.symbol}: cayó ${fell}% — más de ${ceiling}% (${ceilingOf(step.step)}) es un derrumbe; no compra hasta que vuelva a estar a menos de ${ceiling}% de $${watch.reference}`,
    `El mínimo ${watch.low} quedó ${fell}% bajo ${from} (${watch.reference}). Una caída de más de ${ceiling}% no es una baja: no se compra hasta que el precio vuelva sobre ${crashLine(watch.reference, ladder.policy, step.step)}, y desde ahí la compra espera un rebote de ${asked(step.thresholds.bouncePct)}%.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(said, `collapse:${position.id}`)) await deps.alerts.send(said)
}

/**
 * One dip-bounce step, if the watch says so — the first dollar of a holding or
 * any later one, on the same rule. The watch is moved by this sweep's live
 * price and written down only when it matters (`dipWatchWorthWriting`): armed
 * or disarmed, a new reference, or the high or the low moving 0.1% or more —
 * finer than both lines, so no decision changes, and a whole-row write every
 * time a price ticks is network this project cannot spare.
 *
 * Every guard a buy has, kept:
 *
 * - never into a position the death watch has frozen or condemned — and then
 *   nothing is watched either, because nothing is going to be bought;
 * - never into one with no CANDLE CLOSE on record — the price guard above
 *   compares the live price with the last close, and a reservation the tick
 *   has not priced yet has none, only the scanner's own number;
 * - the live price and that close agree within the band, and there is no order
 *   in flight: both answered by the sweep before it gets here;
 * - never on a fall past the step's ceiling — `maxDipPct`, grown with every
 *   DCA — a collapse, which the watch itself refuses and says once (see
 *   `domain/strategy/dip-bounce.ts`);
 * - never into a pool under the line the death watch freezes on, read LIVE
 *   (`DipBounce.pool`) — the tick would freeze it at the next bar;
 * - the fees are FUNDED out of the free capital first, and a step with nothing
 *   free is said and not bought — never shrunk;
 * - the fill is keyed by the sweep's clock and the step, and a step that did
 *   not fill leaves the watch armed for the next sweep.
 *
 * No "at a loss" check, and none is needed: every step buys strictly under
 * the one before it, so the average of what was paid is always above the next
 * buy (see `domain/strategy/dip-bounce.ts`).
 *
 * Returns 'bought' when it bought, 'unfunded' when it fired and found nothing
 * free, 'refused' when it fired into a drained pool — each of them this
 * sweep's buy — and null when it did not fire.
 */
async function buyOnDipBounce(
  deps: StopSweepDeps,
  ladder: DipBounce,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  at: number,
  throttle: AlertThrottle,
  stepPools: StepPools | null,
): Promise<'bought' | 'unfunded' | 'refused' | null> {
  if (position.deathWatch.stage !== 'healthy') return null
  if (position.lastBarTime < 0) return null
  const buys = holdingBuys(fills)
  const stored = position.dipWatch ?? null
  const step = nextDipBounce(stored, { priceUsd: price, at, buys }, ladder.policy)
  if (step.watch !== null && dipWatchWorthWriting(stored, step.watch, buys[buys.length - 1]?.time ?? null)) {
    await deps.store.savePosition({ ...position, dipWatch: step.watch })
  }
  await sayCollapsed(deps, ladder, position, step, buys.length === 0, at, throttle)
  if (step.action !== 'buy' || step.watch === null) return null

  // The pool last, right before the money: only a step that fired costs the
  // book's one request, and the watch stays armed for the sweep it recovers.
  if (stepPools !== null && (await poolRefuses(deps, stepPools, position, buys.length + 1, ladder.policy.maxSteps, at, throttle))) return 'refused'
  return buyStep(deps, ladder, position, buys, price, at, throttle, { kind: 'dip', step, watch: step.watch })
}

/** Why a step is bought: a dip and its bounce, or the slot having just been opened. */
type StepCause =
  | { readonly kind: 'dip'; readonly step: DipBounceStep; readonly watch: DipWatch }
  | { readonly kind: 'selection' }

/**
 * One step, bought: funded, settled, the watch moved to it, and said. ONE body
 * for both causes, so the step bought on selection and every step bought on a
 * bounce share the funding, the idempotency key, the order ids and the watch —
 * a second copy of any of those is how a retry buys twice.
 *
 * Returns 'bought', 'unfunded' when nothing free would pay its fees — said,
 * and never shrunk — or null when the fill did not happen.
 */
async function buyStep(
  deps: StopSweepDeps,
  ladder: DipBounce,
  position: PersistedPosition,
  buys: readonly PersistedFill[],
  price: number,
  at: number,
  throttle: AlertThrottle,
  cause: StepCause,
): Promise<'bought' | 'unfunded' | null> {
  const n = buys.length
  const max = ladder.policy.maxSteps
  const step = ladder.stepUsd
  // The buy AFTER this one — its own lines, grown with every DCA.
  const following = dipBounceThresholds(n + 2, ladder.policy)
  const next = `La próxima compra espera una caída de ${asked(following.dipPct)}% bajo este precio y un rebote de ${asked(following.bouncePct)}%.`
  // What THIS buy asked, when a dip bought it: said beside what it got.
  const lines = cause.kind === 'dip' ? cause.step.thresholds : dipBounceThresholds(n + 1, ladder.policy)
  const fell = cause.kind === 'dip' ? (cause.step.fellPct ?? 0).toFixed(1) : null
  const rose = cause.kind === 'dip' ? (cause.step.bouncedPct ?? 0).toFixed(1) : null
  const cost = buyCostUsd(step, position.quality, ladder.gasUsdPerSwap)
  const funded = ladder.fund ? await ladder.fund(position, cost) : position
  if (funded === null) {
    const unfunded = alert(
      'entry-refused',
      `💤 ${position.symbol} sin capital libre para la compra ${n + 1} de ${max}`,
      cause.kind === 'dip'
        ? `Cayó ${fell}% y rebotó ${rose}%, pero no hay capital libre para las comisiones de la compra de ${dollars(step)}. Se vuelve a intentar en el próximo barrido; la compra no se achica.`
        : `Entró como candidata, pero no hay capital libre para las comisiones de la compra de ${dollars(step)}. La primera compra espera entonces una caída de ${asked(lines.dipPct)}% y un rebote de ${asked(lines.bouncePct)}%; la compra no se achica.`,
      at,
      { position: position.id, token: position.tokenAddress },
    )
    if (throttle.shouldSend(unfunded, `unfunded:${position.id}`)) await deps.alerts.send(unfunded)
    return 'unfunded'
  }

  // The first dollar opens the holding under the entry's own id; every later
  // one is the next rung. Keyed by the sweep's clock, so a sweep run again
  // collides with itself instead of buying twice.
  const order = n === 0
    ? { kind: 'entry' as const, id: 'Entry', level: 0, usd: step, qty: step / price, comment: '🟢 Entry' }
    : { kind: 'entry' as const, id: `DCA-${n}`, level: n, usd: step, qty: step / price, comment: `DCA-${n}` }
  const broker = await deps.brokerFor(funded)
  await settle([order], at, price, at, funded, broker, deps.store)
  const after = holdingBuys(await deps.store.fillsFor(position.id))
  if (after.length === buys.length) return null
  const bought = after[after.length - 1]!
  // The reference is now what this step bought at, unarmed — and the watch is
  // never older than the fill it describes.
  const watched = cause.kind === 'dip' ? cause.watch : position.dipWatch
  await deps.store.savePosition({ ...funded, dipWatch: watchAfterBuy(price, bought.time, after[0]!.time, watched) })

  const said = cause.kind === 'selection'
    ? alert(
        'position-opened',
        `🟢 ${position.symbol} compró ${dollars(step)} al entrar como candidata (compra 1 de ${max})`,
        `Compró ${dollars(step)} a ${price}, sin esperar caída ni rebote: la primera compra entra al abrir la posición. ${next}`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
    : n === 0
    ? alert(
        'position-opened',
        `🟢 ${position.symbol} compró ${dollars(step)} — cayó ${fell}% y rebotó ${rose}% (compra 1 de ${max})`,
        `El máximo visto fue ${cause.watch.reference} y el mínimo ${cause.watch.low ?? price}. Compró ${dollars(step)} a ${price}. ${next}`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
    : alert(
        'dca-filled',
        `🪜 ${position.symbol} promedió — compra ${n + 1} de ${max}: cayó ${fell}% (pedía ${asked(lines.dipPct)}%) y rebotó ${rose}% (pedía ${asked(lines.bouncePct)}%) — DCA ${n}`,
        `La compra anterior fue a ${cause.watch.reference} y el mínimo ${cause.watch.low ?? price}. Compró ${dollars(step)} a ${price}; costo promedio ${positionLedger(await deps.store.fillsFor(position.id)).avgCostUsd}.`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
  if (throttle.shouldSend(said, `dip:${position.id}:${after[0]!.time}:${n + 1}`)) await deps.alerts.send(said)
  return 'bought'
}

/**
 * The FIRST step of a slot the cycle has just opened, bought NOW at the live
 * price — not on a dip and a bounce. *Y además que la primera compra entre
 * automáticamente.* The operator.
 *
 * The cycle calls it in the pass that opened the slot, after the door's
 * safety re-check (`confirmEntry`) and after the tick that put a candle close
 * on record. It is a dip-bounce step in every way but its cause — the same
 * `buyStep`, so the same funding, id, key and watch — and every later step is
 * the dip-bounce rule with this one as its reference: a 3% dip under it and a
 * 2% bounce for DCA 1, more for each DCA after, the step's ceiling and the live
 * pool check. This one has neither:
 * there is no reference to fall from yet, and the door re-checked the pool.
 *
 * Only for a slot that has NEVER held anything. A holding after a sale is not
 * a selection — the token was chosen long ago, and rebuying it the moment it
 * sold would skip the entry door entirely — so it waits for its dip and
 * bounce, as it always did. And once bought, never again: a second call, in
 * this pass or the next, finds a fill and buys nothing.
 *
 * Every guard a step has, kept: a candle close on record and a live price that
 * agrees with it within the band, a healthy death watch, and nothing in
 * flight. Returns 'bought', 'unfunded' — said, never shrunk — or null.
 */
export async function buyFirstStepOnSelection(
  deps: StopSweepDeps,
  position: PersistedPosition,
  price: number | null,
  at: number,
  throttle: AlertThrottle,
  /** The gate's own band, as in the sweep. */
  maxPriceRatio: number = DEFAULT_GATE_POLICY.maxPriceRatio,
): Promise<'bought' | 'unfunded' | null> {
  const ladder = deps.dipBounce
  if (!ladder || ladder.onSelection !== true) return null
  if (position.pendingOrders.length > 0) return null
  if (position.deathWatch.stage !== 'healthy') return null
  if (position.lastBarTime < 0 || position.lastPriceUsd === null || position.lastPriceUsd === undefined) return null
  if (price === null || !(price > 0) || pricesDisagree(price, position.lastPriceUsd, maxPriceRatio)) return null
  const fills = await deps.store.fillsFor(position.id)
  if (fills.length > 0) return null
  return buyStep(deps, ladder, position, [], price, at, throttle, { kind: 'selection' })
}

/**
 * The deep rung, if its three conditions hold now: the low more than 80% under
 * the first buy, the live price 10% over the low, and the position still at a
 * loss. Never into a position the death watch has frozen or condemned — the
 * same guard every rung has — and never twice for one holding: it fires only
 * while the holding holds its first buy alone.
 *
 * The rung pays for itself: its capital is asked of the book's free capital
 * (`DeepRung.fund`), and the broker is built from the position AS FUNDED, or
 * it would refuse the entry for funds.
 *
 * Returns 'bought' when it bought, 'unfunded' when it fired and found nothing
 * free — either way this sweep's rung — and null when it did not fire.
 */
async function buyOnDeepRung(
  deps: StopSweepDeps,
  rung: DeepRung,
  position: PersistedPosition,
  fills: readonly PersistedFill[],
  price: number,
  low: PriceLow | null,
  at: number,
  throttle: AlertThrottle,
): Promise<'bought' | 'unfunded' | null> {
  if (position.deathWatch.stage !== 'healthy') return null
  const buys = holdingBuys(fills)
  const first = buys[0]
  if (!first) return null
  // Only THIS holding's low. `watchLow` already answers for it; the check is
  // here so a caller can never hand the rung another holding's crash.
  const lowPrice = low !== null && low.holdingSince === first.time ? low.price : null
  const n = nextDeepRung(
    { entries: buys.length, firstBuyPrice: first.price, lowPrice, priceUsd: price, avgCostUsd: positionLedger(fills).avgCostUsd },
    rung.policy,
  )
  if (n === null || lowPrice === null) return null
  const id = `DCA-${n}`
  const fell = ((1 - lowPrice / first.price) * 100).toFixed(1)
  const rose = ((price / lowPrice - 1) * 100).toFixed(1)
  const why = `cayó ${fell}% desde la primera compra y rebotó ${rose}% desde el mínimo`

  const funded = rung.fund ? await rung.fund(position, buys.length + 1) : position
  if (funded === null) {
    await sayUnfunded(deps, position, id, `El precio ${why}`, 'Se vuelve a intentar en el próximo barrido.', at, throttle)
    return 'unfunded'
  }
  const broker = await deps.brokerFor(funded)
  const before = fills.length
  await settle(
    [{ kind: 'entry', id, level: n, usd: rung.usd, qty: rung.usd / price, comment: id }],
    funded.lastBarTime,
    price,
    at,
    funded,
    broker,
    deps.store,
  )
  if ((await deps.store.fillsFor(position.id)).length === before) return null
  const bought = alert(
    'dca-filled',
    `🪜 ${position.symbol} promedió — ${id} ${dollars(rung.usd)}: ${why}`,
    `Primera compra a ${first.price}, mínimo ${lowPrice}. Compró $${rung.usd.toFixed(2)} a ${price}. Es el único escalón: no se compra nada más en esta posición.`,
    at,
    { position: position.id, token: position.tokenAddress },
  )
  if (throttle.shouldSend(bought, `dca:${position.id}:${n}`)) await deps.alerts.send(bought)
  return 'bought'
}
