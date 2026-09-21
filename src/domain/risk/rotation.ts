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
}

export interface RotationDecision {
  readonly holder: RotationHolder
  /** Human-readable, for the alert and the audit trail. */
  readonly reason: string
}

export function rotateOnSwitchOff(holders: readonly RotationHolder[]): readonly RotationDecision[] {
  const decisions: RotationDecision[] = []
  for (const holder of holders) {
    // Silence is not evidence.
    if (holder.switchOff !== true) continue
    // Nothing held: there is nothing to sell, and `idle-slots` already owns
    // this case. Two functions releasing the same slot is how a book counts
    // the same capital twice.
    if (holder.openQty <= 0) continue
    decisions.push({
      holder,
      reason: `el interruptor se apagó: ${holder.failed.join(', ')} por debajo del piso`,
    })
  }
  return decisions
}
