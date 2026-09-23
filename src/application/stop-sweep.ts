import { alert, type AlertPort, type AlertThrottle } from '../domain/notifications/alerts.js'
import { positionLedger } from './ledger.js'
import { pricesDisagree } from '../domain/market/price-agreement.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { minProfitPctFor, roundTripCostForFill, stopForRatio } from '../domain/economics/sizing.js'
import { settle } from './engine.js'
import type { BrokerPort } from '../domain/execution/broker.js'
import type { PersistedPosition, StatePort } from '../domain/persistence/store.js'
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
}

/** The three lines a position lives between, in percent of its average cost. */
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
  if (!dollarsDecide && target !== null && sizing.rewardRiskRatio !== undefined && sizing.rewardRiskRatio > 0) {
    const pct = stopForRatio(target, roundTrip, sizing.rewardRiskRatio)
    // Zero means the pair is impossible on this pool. Fall back rather than
    // invent: the base policy is the operator's own number.
    if (pct > 0) {
      const capped = sizing.maxStopPct !== undefined && sizing.maxStopPct > 0 ? Math.min(pct, sizing.maxStopPct) : pct
      stop = { shareOfRun: 0, minStopPct: capped, maxStopPct: capped }
    }
  }

  return {
    stop,
    armAtPct: sizing.breakEven && target !== null ? target : null,
    breakEvenPct: roundTrip,
  }
}

export interface StopSweepDeps {
  readonly store: StatePort
  readonly alerts: AlertPort
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  readonly now: () => number
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

  for (const position of positions) {
    // In flight means unresolved means halted. Never guess on top of it.
    if (position.pendingOrders.length > 0) continue

    // Read per position and per pass, deliberately. The fills move underneath
    // this as it sells, so one read at the top would let a later pass act on a
    // position it had already closed.
    const ledger = positionLedger(await deps.store.fillsFor(position.id))
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
      await settle(
        [{ kind: 'closeAll', comment: BREAK_EVEN_COMMENT }],
        position.lastBarTime,
        price!,
        at,
        position,
        broker,
        deps.store,
      )
      await deps.store.closePosition(position.id)
      // In the same list as the stops, on purpose: the caller locks the token
      // out of the same cycle's allocation, and buying straight back what was
      // just sold is a round trip, not a rotation.
      stopped.push(position.id)
      const kept = alert(
        'position-closed',
        `🔒 ${position.symbol} salió en break-even`,
        `Había llegado al objetivo y volvió hasta el precio de compra. Se vendió a ${price} en vez de esperar al stop: una posición que ganó no cierra en pérdida.`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
      if (throttle.shouldSend(kept, `break-even:${position.id}`)) await deps.alerts.send(kept)
      continue
    }

    if (!shouldStopOut(input, policy)) continue

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
    const cut = alert(
      'token-stopped',
      `🛑 ${position.symbol} cortada por stop`,
      `${why} Se vendió todo a ${price}. El token NO queda vetado.`,
      at,
      { position: position.id, token: position.tokenAddress },
    )
    if (throttle.shouldSend(cut, `stopped:${position.id}`)) await deps.alerts.send(cut)
  }

  return stopped
}
