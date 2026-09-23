import { type Chain } from '../scanner/snapshot.js'
import { type OpportunityComponents } from '../scanner/opportunity.js'

/**
 * The switch went off on a position holding money, so the money leaves.
 *
 * The operator's rule, and it is the largest departure from the reference in
 * this file: *si el interruptor on/off se desactiva en vivo y en directo,
 * vender todo y redistribuir en un token nuevo, aunque se pierda.*
 *
 * ## Why this is NOT the death watch, and must never be folded into it
 *
 * `AssetHealthObservation` is typed so that no price-shaped field can exist on
 * it (`price?: never` and friends — a leak fails `tsc`). That typing is the
 * one structural guarantee keeping the death exit from silently degrading
 * into a stop loss, which would kill the strategy's premise: the ladder only
 * works if a fall is something to average INTO.
 *
 * The switch reads the opportunity floors, and one of them — `momentum` — is
 * price direction. Routing this through the death watch would therefore put
 * price into the one path that is typed to refuse it. So it lives here, as an
 * ALLOCATOR decision, with its own comment, and the two can never be confused
 * in the audit trail.
 *
 * ## What it costs, stated rather than discovered later
 *
 * A DCA rung fires AFTER a fall, and a fall is what turns `momentum` down. So
 * this switch and the ladder pull against each other: on a token that dips
 * enough to arm rung 2, the switch may sell before the rung fills. The
 * operator was told and decided — the reason he gave is that with the doors
 * this strict the tokens reaching a slot are not the ones that die, and he
 * would rather rotate capital than hold it through a turn.
 *
 * ## Why it is not `idle-slots.ts`
 *
 * That function has one invariant, argued at length: it releases only slots
 * that hold NOTHING, because a position with fills is a commitment whose slot
 * cannot come back without selling. This is the case where the operator
 * decided the allocator MAY sell, and mixing it in would make that file's
 * invariant false. Two decisions, two functions.
 */

/** Its own comment, so the no-loss guard and the tape can tell it from a death exit. */
export const ROTATION_EXIT_COMMENT = '🔁 Rotación' as const

/**
 * A slot handed to a better token, paying a small loss for the move.
 *
 * Its OWN comment rather than the rotation's, because the rule is different
 * and the tape has to be able to tell them apart. The rotation switch takes a
 * profit and refuses a loss of any size; this one accepts a bounded one — and
 * a reader looking at a red line under `🔁` would have no way to know which
 * rule allowed it.
 */
export const SWAP_EXIT_COMMENT = '🔄 Cambio' as const

/**
 * The SELLERS lead the hour: sold AS IT IS.
 *
 * *Cuando la presión vendedora aumente más del 1%, venta — se vende como
 * esté.* The operator, mirroring the buy door. The one allocator exit that may close in the red, and
 * so it has a name of its own — the no-loss guard tells exits apart by their
 * comment, and the tape must say why a position left at a loss.
 *
 * It sells on ORDER FLOW, never on price: buy pressure is who is trading, not
 * where the price went, so the death exit's guardrail is untouched. What it
 * costs, stated: the reading moves hour to hour, so a position can be sold at
 * a loss and bought back the next cycle, paying its round trip each time.
 */
export const BUYERS_GONE_COMMENT = '📉 Presión vendedora' as const

export interface RotationHolder {
  readonly id: string
  readonly symbol: string
  readonly chain: Chain
  readonly tokenAddress: string
  /** What the position actually holds, read from the FILLS and never from the cascade level. */
  readonly openQty: number
  /**
   * The switch, as the last scan measured it.
   *
   * `true` — examined, and at least one floor failed.
   * `false` — examined, all floors clear.
   * `null` — NOT examined. Nothing happens.
   *
   * That third state is load-bearing and is the rule the whole scanner runs
   * on: silence is not evidence. A rate limit once turned 26 of 29 live
   * positions red because an unanswered request was read as a verdict; read
   * that way here it would not colour a screen, it would liquidate the book at
   * market for a provider having a bad minute.
   */
  readonly switchOff: boolean | null
  /** Which floors failed, so the evidence travels with the decision. */
  readonly failed: readonly (keyof OpportunityComponents | 'rising')[]
  /** How far the position stands above its average cost, in percent, at the live price. */
  readonly unrealisedPct?: number | null
  /**
   * What its whole round trip costs, in percent of what it deployed — fees
   * already paid plus the cost of selling now. See `positionTollPct`.
   */
  readonly tollPct?: number | null
  /** Buys and sells in the last hour behind the buy-pressure reading. Null: not reported. */
  readonly hourBuys?: number | null
  readonly hourSells?: number | null
}

export interface RotationDecision {
  readonly holder: RotationHolder
  /** Human-readable, for the alert and the audit trail. */
  readonly reason: string
  /** Which exit sells it: the toll-bound rotation, or the buyers-gone sale as it is. */
  readonly comment: typeof ROTATION_EXIT_COMMENT | typeof BUYERS_GONE_COMMENT
}

/**
 * How far the SELLERS must lead the hour before a position is sold as it is,
 * on the same 0..1 scale as buy pressure: 0.01 is sells above 50.5% of the
 * hour's trades — the mirror of the buy door's own 1%.
 */
export const SELL_PRESSURE_EXIT = 0.01

export function rotateOnSwitchOff(
  holders: readonly RotationHolder[],
  sellPressureExit: number = SELL_PRESSURE_EXIT,
): readonly RotationDecision[] {
  const decisions: RotationDecision[] = []
  for (const holder of holders) {
    // Nothing held: there is nothing to sell, and `idle-slots` already owns
    // this case. Two functions releasing the same slot is how a book counts
    // the same capital twice.
    if (holder.openQty <= 0) continue
    // The SELLERS lead, MEASURED: sold as it is, whatever the switch says. Only on an hour that had
    // trades — a count nobody reported reads as zero, and selling at a loss on
    // a number nobody measured is the one mistake this must not make. An even
    // hour, where neither side leads by 1%, falls through to the toll rule.
    const buys = holder.hourBuys ?? 0
    const trades = buys + (holder.hourSells ?? 0)
    const sellPressure = trades > 0 ? ((trades - buys) / trades - 0.5) * 2 : 0
    if (trades > 0 && sellPressure > sellPressureExit) {
      decisions.push({
        holder,
        comment: BUYERS_GONE_COMMENT,
        reason: `la presión vendedora pasó el ${(sellPressureExit * 100).toFixed(0)}% (${trades - buys} ventas de ${trades} en la última hora) — se vende como esté`,
      })
      continue
    }
    // Everything below is the FILTER's rotation, and silence is not evidence:
    // only a token examined and refused by a floor has its switch off. The
    // sellers' sale above does not wait for it — it reads who is trading now,
    // not why the token was bought.
    if (holder.switchOff !== true) continue
    // *Hacé lo mismo en la rotación por filtro.* Out only when the position is
    // up by MORE than its whole round trip costs; below that the filter going
    // off is not a reason to close in the red. Unmeasured is not a verdict.
    const standing = holder.unrealisedPct
    const toll = holder.tollPct
    if (standing === null || standing === undefined || toll === null || toll === undefined) continue
    if (standing <= toll) continue
    decisions.push({
      holder,
      comment: ROTATION_EXIT_COMMENT,
      reason: `el interruptor se apagó (${holder.failed.join(', ')} por debajo del piso) y va +${standing.toFixed(2)}%, más que el ${toll.toFixed(2)}% que cuesta el viaje`,
    })
  }
  return decisions
}
