import { type CloseAllOrder } from '../strategy/state.js'

/**
 * The crash stop: sell everything when the live price falls more than
 * `dropPct` below the highest price seen in the last `windowMs`.
 *
 * *Si una moneda baja más de 5% del precio en menos de un minuto, SL.* The
 * operator. A stop on PRICE, exempt from the no-loss guard like every stop —
 * a stop that cannot sell at a loss is not a stop.
 *
 * The readings are the sweep's own, every thirty seconds, so "under a minute"
 * is measured on two or three of them. Strictly MORE than the drop, and
 * strictly younger than the window. The first reading never sells: a fall
 * needs a before.
 *
 * Pure; the caller keeps the marks.
 */

/** Its own name on the tape. */
export const CRASH_STOP_COMMENT = '⚡ Caída rápida' as CloseAllOrder['comment']

export interface PriceMark {
  readonly at: number
  readonly price: number
}

export interface CrashStopRule {
  readonly windowMs: number
  readonly dropPct: number
}

export function stepCrashStop(
  marks: readonly PriceMark[],
  at: number,
  price: number,
  rule: CrashStopRule,
): { readonly marks: readonly PriceMark[]; readonly crashed: boolean; readonly peak: number | null } {
  const recent = marks.filter((m) => at - m.at < rule.windowMs)
  const peak = recent.length === 0 ? null : Math.max(...recent.map((m) => m.price))
  const crashed = rule.dropPct > 0 && peak !== null && price < peak * (1 - rule.dropPct / 100)
  return { marks: [...recent, { at, price }], crashed, peak }
}
