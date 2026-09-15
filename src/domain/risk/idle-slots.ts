/**
 * Slots reserved and never used.
 *
 * The portfolio allocates a slot and its capital to a token BEFORE the strategy
 * enters it: the scanner says "this one is worth running the machine on", and
 * CASCADE DCA then waits for its own gates — a drop from the swing high, a
 * lateral zone. If those never line up, the position sits at level 0 forever,
 * holding a slot and its capital against nothing.
 *
 * Found live: a token open five hours and twenty minutes with zero fills,
 * holding $285 and one of five slots, while candidates scoring 76 and 72 waited
 * outside. `slotsLeft` and `committed` counted it exactly as they counted a
 * position three DCA levels deep.
 *
 * The distinction they were missing is the whole of this file:
 *
 *   A position with fills is a COMMITMENT. The slot cannot come back without
 *   selling, and selling is the strategy's decision, never the allocator's.
 *
 *   A position with no fills is a RESERVATION. Cancelling it costs nothing,
 *   because nothing was ever spent.
 *
 * So this only ever releases the second kind, and only when something is
 * actually waiting to use what it gives up.
 */

export interface IdleSlotPolicy {
  /**
   * How long a reservation may sit unused before the slot can go to someone
   * else. Long enough that the entry gates had a fair chance to fire, short
   * enough that a dead reservation is not a permanent tax on the book.
   */
  readonly idleAfterMs: number
}

/** Three hours: twelve bars at 15m, most of the 20-bar swing-high window. */
export const DEFAULT_IDLE_SLOT_POLICY: IdleSlotPolicy = { idleAfterMs: 3 * 3_600_000 }

export interface SlotHolder {
  readonly id: string
  readonly chain: string
  readonly tokenAddress: string
  readonly symbol: string
  readonly openedAt: number
  /**
   * Whether this position has ever filled anything.
   *
   * From the FILLS, never from the cascade level: a machine can sit at level 1
   * believing it holds something the broker refused, and a reservation that
   * looks like a position is exactly the case this has to get right.
   */
  readonly hasFills: boolean
}

/**
 * Which reservations should give up their slot, longest-waiting first.
 *
 * `waiting` caps the answer because freeing a slot into an empty queue is pure
 * loss: the incumbent might still enter, and nothing else can use what it gave
 * up. A slot is only worth taking back when somebody is there to take it.
 */
export function releasableSlots(
  holders: readonly SlotHolder[],
  waiting: number,
  now: number,
  policy: IdleSlotPolicy = DEFAULT_IDLE_SLOT_POLICY,
): readonly SlotHolder[] {
  if (waiting <= 0) return []

  return holders
    .filter((holder) => !holder.hasFills)
    .filter((holder) => now - holder.openedAt >= policy.idleAfterMs)
    .sort((a, b) => a.openedAt - b.openedAt)
    .slice(0, waiting)
}
