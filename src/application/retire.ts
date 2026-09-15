import { type AlertPort, alert } from '../domain/notifications/alerts.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'

/**
 * Taking one token off the board, on purpose, because a human said so.
 *
 * The dashboard is read-only and the control endpoint is one-way safe, so
 * nothing outside the engine can close a position — deliberately. But an
 * operator does sometimes need to, and the first real case arrived fast: a
 * fifteen-day-old memecoin was scanned, ranked and allocated capital under the
 * symbol "BTC", because the impersonation gate knew WBTC and not BTC. The gate
 * is fixed; the gate only stops NEW positions.
 *
 * This is not a death exit. A death exit is a VERDICT — the asset stopped being
 * an asset, and the evidence chain is part of the record. Retiring is a
 * DECISION, made by a person for a reason the system could not compute, and
 * calling it a death would put a diagnosis in the log that nothing diagnosed.
 *
 * It is one-way safe in the same sense the kill switch is: it can only ever
 * leave the system holding less. It cannot open a position, size one, or move
 * capital toward anything.
 *
 * **Blacklisting alone would be worse than doing nothing.** `planRecovery`
 * SKIPS a blacklisted position, so the position stops being ticked while its
 * tokens stay bought — and it drops out of the committed total, which is how
 * the portfolio quietly hands the same dollars to somebody else. Leaving means
 * leaving the token: sell, close, then blacklist.
 */

export interface RetireDeps {
  readonly store: StatePort
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  readonly alerts: AlertPort
  readonly now: () => number
}

export interface RetireRequest {
  readonly chain: Chain
  readonly tokenAddress: string
  /** Why. It goes in the blacklist row and in the alert, and it is not optional. */
  readonly reason: string
}

export interface RetireResult {
  readonly retired: boolean
  /** The symbol as the position knew it, or null when nothing was held. */
  readonly symbol: string | null
  readonly soldQty: number
  readonly proceedsUsd: number
  /** Orders that were decided and never filled. They simply stop existing. */
  readonly cancelledOrders: number
  /** Set only when nothing was done, saying what stopped it. */
  readonly refusal?: string
}

export async function retireToken(deps: RetireDeps, request: RetireRequest): Promise<RetireResult> {
  const at = deps.now()
  const key = `${request.chain}:${request.tokenAddress}`
  const positions = await deps.store.loadPositions()
  const position = positions.find((p) => `${p.chain}:${p.tokenAddress}` === key)

  // Nothing open: the blacklist is the whole job, and it is what stops the
  // scanner offering this token again on the next cycle.
  if (!position) {
    await deps.store.blacklist(request.chain, request.tokenAddress, request.reason, at)
    return { retired: true, symbol: null, soldQty: 0, proceedsUsd: 0, cancelledOrders: 0 }
  }

  const broker = await deps.brokerFor(position)
  // Size does not depend on the mark, so it can be read without a price — and
  // it must be, because "holds tokens but has no measured price" is exactly
  // the case that has to be refused below.
  const holding = broker.snapshot(position.lastPriceUsd ?? 0).size

  // A sale needs a price, and the only honest one is the price somebody
  // measured. Inventing it would put a fiction in the ledger every other number
  // in this system is derived from, so the position stays whole and a human
  // gets told why.
  if (holding > 0 && position.lastPriceUsd === null) {
    return {
      retired: false,
      symbol: position.symbol,
      soldQty: 0,
      proceedsUsd: 0,
      cancelledOrders: 0,
      refusal: `${position.symbol} tiene tokens y no hay precio medido para venderlos. No se inventa un precio: la posición queda intacta.`,
    }
  }

  let soldQty = 0
  let proceedsUsd = 0
  if (holding > 0) {
    const fills = broker.execute([{ kind: 'closeAll', comment: '🏁 Exit' }], position.lastPriceUsd!, at)
    for (const [index, fill] of fills.entries()) {
      soldQty += fill.qty
      proceedsUsd += fill.price * fill.qty
      await deps.store.recordFill({
        positionId: position.id,
        orderId: fill.id,
        side: fill.side,
        time: fill.time,
        price: fill.price,
        qty: fill.qty,
        costUsd: fill.commission,
        comment: fill.comment,
        // Keyed by the retirement instant, not by a bar: this sale was not
        // decided by any bar, and pretending otherwise would collide with a
        // real order the engine might key the same way.
        idempotencyKey: `retire:${position.id}:${at}:${index}`,
      })
    }
  }

  // Ordered so a crash is survivable in the direction that costs least.
  // Closing before blacklisting can leave the token eligible for a new
  // position — annoying, and fixed by running this again. Blacklisting first
  // would leave an ABANDONED bag: skipped by recovery, still held, its capital
  // counted as free. One is a retry; the other is a silent hole.
  await deps.store.closePosition(position.id)
  await deps.store.blacklist(request.chain, request.tokenAddress, request.reason, at)

  await deps.alerts.send(alert(
    'token-retired',
    `🚫 ${position.symbol} retirada a mano`,
    [
      request.reason,
      soldQty > 0
        ? `Vendidos ${soldQty.toPrecision(6)} por $${proceedsUsd.toFixed(2)}.`
        : 'No había nada comprado todavía.',
      position.pendingOrders.length > 0 ? `${position.pendingOrders.length} orden(es) sin ejecutar canceladas.` : null,
      'El token queda en la lista negra y el escáner no lo vuelve a ofrecer.',
    ].filter((line) => line !== null).join('\n'),
    at,
    { position: position.id, token: request.tokenAddress },
  ))

  return {
    retired: true,
    symbol: position.symbol,
    soldQty,
    proceedsUsd,
    cancelledOrders: position.pendingOrders.length,
  }
}
