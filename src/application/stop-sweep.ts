import { alert, type AlertPort, type AlertThrottle } from '../domain/notifications/alerts.js'
import { positionLedger } from './ledger.js'
import { settle } from './engine.js'
import type { BrokerPort } from '../domain/execution/broker.js'
import type { PersistedPosition, StatePort } from '../domain/persistence/store.js'
import {
  shouldStopOut,
  stopLossPctFor,
  drawdownPct,
  STOP_LOSS_COMMENT,
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
export interface StopSweepDeps {
  readonly store: StatePort
  readonly alerts: AlertPort
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  readonly now: () => number
}

export async function sweepStops(
  deps: StopSweepDeps,
  policy: StopLossPolicy,
  throttle: AlertThrottle,
  positions: readonly PersistedPosition[],
  prices: ReadonlyMap<string, number>,
  at: number,
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
    const cut = alert(
      'token-stopped',
      `🛑 ${position.symbol} cortada por stop`,
      `Cayó ${down === null ? '' : down.toFixed(1) + '% '}bajo el precio de compra, y su stop estaba en ${stopLossPctFor(input.runAtEntryPct, policy).toFixed(0)}%. Se vendió todo a ${price}. El token NO queda vetado.`,
      at,
      { position: position.id, token: position.tokenAddress },
    )
    if (throttle.shouldSend(cut, `stopped:${position.id}`)) await deps.alerts.send(cut)
  }

  return stopped
}
