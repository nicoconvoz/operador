import { type CascadeState } from '../domain/strategy/state.js'
import { type PersistedFill } from '../domain/persistence/store.js'

/**
 * Re-anchor a ladder that is measured from a price the position never paid.
 *
 * The state machine sets `ep1 := close` on the SIGNAL bar and the order fills
 * at the NEXT bar's open, exactly as `DCA.pine` does. On a liquid 1H chart
 * those two numbers are the same to within a tick, which is why the reference
 * can treat them as interchangeable — and for the life of this engine they were
 * not, because it decided on bars that had not finished. BinanceTown was
 * anchored at 0.0013161 and bought at 0.0010038: every rung, every separation
 * lock and every rebound was then measured from a number no close ever showed.
 *
 * **This is a repair, not a rule.** Within `tolerancePct` nothing happens, so
 * the reference's own gap survives untouched and the parity harness is not
 * affected — it replays a fixed series where the two agree. Past it, the fills
 * win, because the fills are the facts: `ep1` is the price this position
 * actually entered at, and `lastFill` the price the separation lock is supposed
 * to measure down from.
 *
 * It exists so a rule change does not mean a wipe. A book carrying anchors from
 * a bug is not evidence about the new rules, but throwing it away also throws
 * away every fill that DID happen — and those are the only real data this
 * system has. Re-deriving beats deleting.
 *
 * What it will not touch: `level`, `totalInv`, `decayCount`, `awaitReentry` or
 * any other counter. Those are a record of what happened, and rewriting a
 * counter is how a ladder fills the same rung twice.
 */
/**
 * How far the anchor may sit from the fill before it counts as WRONG.
 *
 * Not zero, because the reference's own execution model puts them apart: Pine
 * sets `ep1 := close` on the signal bar and fills at the next bar's open.
 * Measured across a live book those gaps ran from -5.1% to +2.8%, and every one
 * of them came from the engine reading unfinished bars — with that fixed, the
 * open of a bar IS the close of the one before it and the gap is nil.
 *
 * Ten leaves the reference untouched and still catches the corruption: the
 * worst anchor measured was 23.7% off what its position paid.
 */
export const RESYNC_TOLERANCE_PCT = 10

export interface Resynced {
  readonly cascade: CascadeState
  /** What was moved and why, in the interface's language, for the alert. */
  readonly reasons: readonly string[]
}

const off = (held: number | null, fact: number, tolerancePct: number): boolean =>
  held !== null && held > 0 && Math.abs(held / fact - 1) * 100 > tolerancePct

export function resyncCascade(
  cascade: CascadeState,
  fills: readonly PersistedFill[],
  tolerancePct: number,
): Resynced | null {
  // A reservation has nothing to reconcile against: its `ep1` is a decision
  // waiting to be executed, not a record of one.
  if (cascade.level < 1) return null
  const buys = fills.filter((fill) => fill.side === 'buy').sort((a, b) => a.time - b.time)
  if (buys.length === 0) return null

  // The FIRST buy, never the average: `ep1` is the fixed point the whole ladder
  // is measured from, and an average moves every time a rung fills — the rungs
  // would then chase the thing they are supposed to hang off.
  const anchor = buys[0]!.price
  const latest = buys.at(-1)!.price
  const reasons: string[] = []

  let next = cascade
  if (off(cascade.ep1, anchor, tolerancePct)) {
    reasons.push(`ancla movida de ${cascade.ep1!.toPrecision(4)} a ${anchor.toPrecision(4)}, que es lo que pagó`)
    next = { ...next, ep1: anchor }
  }
  if (off(cascade.lastFill, latest, tolerancePct)) {
    reasons.push(`separación medida desde ${latest.toPrecision(4)}, la última compra real`)
    next = { ...next, lastFill: latest }
  }

  return reasons.length === 0 ? null : { cascade: next, reasons }
}
