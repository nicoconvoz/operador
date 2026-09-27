import { type CloseAllOrder } from '../strategy/state.js'

/**
 * The stepped GAIN LOCK: a floor under a winner that only ever rises.
 *
 * *Si pasás el 20% de ganancia, break-even en el 10%; con cada aumento de 20%,
 * aumentar el break-even 10% — por si algo es muy volátil y vuela para arriba,
 * lo podemos atrapar si baja a toda velocidad.* The operator.
 *
 * | Gain reached over the average cost | The position may not close under |
 * |---|---|
 * | under +20% | — no floor |
 * | +20% | **+10%** |
 * | +40% | +20% |
 * | +60% | +30% |
 * | +100% | +50% |
 *
 * ## Why a staircase, and not the break-even again
 *
 * The strategy's own exit wants the impulse to be SEEN to stall, and on these
 * tokens a rocket often does not stall — it turns and falls through its whole
 * gain between two sweeps of a bar-driven rule. The old break-even answered a
 * smaller version of that: one line at +7.5%, the same for a token that barely
 * cleared it and for one that doubled. This one keeps HALF of every twenty
 * points of run as a floor, so the further a token flies the more of the flight
 * is kept when it comes down "a toda velocidad".
 *
 * ## What it is not
 *
 * **Not a stop loss.** It is measured from the gain, it never exists under
 * +20%, and every floor it can set is above the average cost — so by
 * construction it only ever sells a WINNER. It is not exempt from the no-loss
 * guard either: a crash that gaps straight through the floor and under cost is
 * refused, and the position is held like any other.
 *
 * **Not a take-profit.** Nothing here sells a position that keeps climbing. It
 * sells only on the way DOWN, at a floor the position already cleared.
 *
 * Pure; the caller brings the gain and keeps the lock.
 */
export interface GainLockPolicy {
  /** The gain, in percent over the average cost, at which the first floor is set. */
  readonly startPct: number
  /** Every this many points of gain past the start raises the floor once more. */
  readonly stepPct: number
  /** The first floor, in percent over the average cost. */
  readonly firstFloorPct: number
  /** How much each further step raises the floor, in points. */
  readonly floorStepPct: number
}

/** The operator's numbers: from +20%, a floor of +10%, then ten more per twenty. */
export const DEFAULT_GAIN_LOCK_POLICY: GainLockPolicy = {
  startPct: 20,
  stepPct: 20,
  firstFloorPct: 10,
  floorStepPct: 10,
}

/**
 * A lock as it is kept: the floor, and WHICH HOLDING earned it.
 *
 * `since` is the time of the holding's first buy. A position that sells and
 * buys back keeps its id and its tape, and a floor earned by the old holding
 * says nothing about the new one — read against it, a re-entry up 5% would be
 * sold at once under a floor of +20% it never reached.
 */
export interface GainLock {
  readonly pct: number
  readonly since: number
}

/**
 * Its own name on the tape. Not `🔒 Break-even`, which is a single line that
 * arms and sells at the same place; not `🏁 Exit`, which is the strategy's and
 * parity-tested evidence. `tools/loss-by-exit.ts` groups by comment, and three
 * rules sharing one name would hide which of them earned what.
 */
export const GAIN_LOCK_COMMENT = '🔐 Piso de ganancia' as CloseAllOrder['comment']

/**
 * The floor a gain has earned, in percent over the average cost — or null
 * under the first step.
 *
 * A gain nobody could measure earns nothing: silence is not a rise.
 */
export function gainLockFloorPct(gainPct: number, policy: GainLockPolicy): number | null {
  if (!Number.isFinite(gainPct) || gainPct < policy.startPct) return null
  const steps = policy.stepPct > 0 ? Math.floor((gainPct - policy.startPct) / policy.stepPct) : 0
  return policy.firstFloorPct + policy.floorStepPct * steps
}

/**
 * The gain that set a floor — the inverse of the staircase, so the alert can
 * say how far the position flew without anything storing the peak.
 */
export function gainLockStepPct(floorPct: number, policy: GainLockPolicy): number {
  const steps = policy.floorStepPct > 0 ? Math.round((floorPct - policy.firstFloorPct) / policy.floorStepPct) : 0
  return policy.startPct + policy.stepPct * steps
}

/**
 * What a store keeps when a lock is written over the one it holds.
 *
 * A RATCHET, and only the store can make one. Every step of the cycle writes
 * the whole row — the tick, the trim, a rung that raises the capital — from a
 * snapshot taken before the sweep raised the floor. This project has already
 * paid once for a step writing a stale snapshot over what another had just
 * decided, so the rule lives where no caller can forget it:
 *
 * - the same holding → the greater floor;
 * - a NEWER holding → its lock whole, even when lower: the old one is history;
 * - an older holding, or no lock in the write → what is stored.
 *
 * Both stores run exactly this: `MemoryStore` calls it, and the Postgres upsert
 * spells it out in a CASE.
 */
export function keepGainLock(
  stored: GainLock | null | undefined,
  written: GainLock | null | undefined,
): GainLock | null {
  if (!written) return stored ?? null
  if (!stored || written.since > stored.since) return written
  if (written.since < stored.since) return stored
  return written.pct > stored.pct ? written : stored
}
