/**
 * How far apart a token's DCA rungs are, from how much the token MOVES: the
 * more it moves, the WIDER its rungs.
 *
 * *Confío más en mi criterio que en tus cálculos: hacé que el piso de los DCA
 * sea más largo y más separado para las volátiles, según detecte volatilidad, y
 * más cortos y rápidos para las tranquilas.* The operator, overruling the
 * replay below on purpose and with the number in front of him: the wider
 * direction priced at $131–263 against $394. This is the square-root form, the
 * least costly of his direction, and the live run is what will settle it.
 *
 * It shipped the other way first — *aplicá el de en la línea, la propuesta* —
 * on this replay of the
 * 336 real entries (2026-09-23 → 09-27, 5-minute Jupiter closes, 0.66% a fill,
 * the real freezes applied, split in time at 09-25 05:30), the exit modelled
 * at +10%, every ladder chained from the previous buy:
 *
 * | Ladder | Result | train / test | frozen | worst token | peak capital | per $100 |
 * |---|---|---|---|---|---|---|
 * | fixed 10/15/20/25/30 (what ran) | $312 | 110 / 214 | −$37 | −$23 | $1,550 | 20.1 |
 * | more volatile → WIDER rungs | $131–263 | | −$52…−$81 | | | 7–15 |
 * | **more volatile → CLOSER rungs** | **$394** | 178 / 230 | −$48 | −$30 | $1,405 | **28.0** |
 *
 * Better in both halves of the split and on LESS peak capital, so it is not
 * more money at risk earning more money. The intuition that lost — a wild
 * token needs room, so space its rungs out — reads the fall as a trend. On
 * these tokens it mostly is not: a volatile token falls in a V and comes back,
 * and close rungs buy the wick that the rebound then carries to the take
 * profit. A calm token that falls is usually a slow bleed, and there the wider
 * rungs wait deeper before putting more in.
 *
 * What was tried and NOT taken, so nobody tries it again blind: adapting the
 * NUMBER of rungs as well added $4, which is noise; waiting for a lateral base
 * before each rung lost in all nine definitions tried ($39–$155).
 *
 * NOW: `scale = clamp(sqrt(volPct / 2.7), 0.5, 3)`, and each rung's drop is
 * `min(90, dropsPct[n-1] × scale)`. 2.7% is the median volatility of the
 * entries replayed, so a median token keeps the base ladder exactly; a calm
 * one (1% a bar) buys at 6.1/9.1/12.2/15.2/18.3 and a wild one (10% a bar)
 * waits at 19.2/28.9/38.5/48.1/57.7 under the previous buy.
 *
 * Pure: the caller brings the closes.
 */
export interface DcaScalePolicy {
  /** The volatility at which the base drops apply unchanged, in percent a bar. */
  readonly medianVolPct: number
  /** The tightest the ladder may get — a calm token: half the base drops. */
  readonly minScale: number
  /** The widest — a wild token: three times the base drops. */
  readonly maxScale: number
  /** No rung ever waits for more than this fall, in percent. */
  readonly maxDropPct: number
  /** Returns needed before a volatility is a measurement rather than a guess. */
  readonly minReturns: number
  /** How far back of the first buy the volatility is read. */
  readonly windowMs: number
}

/** The median volatility of the 336 entries replayed, in percent per 15-minute bar. */
export const MEDIAN_VOL_PCT = 2.7

export const DEFAULT_DCA_SCALE_POLICY: DcaScalePolicy = {
  medianVolPct: MEDIAN_VOL_PCT,
  minScale: 0.5,
  maxScale: 3,
  maxDropPct: 90,
  minReturns: 5,
  windowMs: 24 * 60 * 60_000,
}

/**
 * The factor every drop of this token's ladder is multiplied by.
 *
 * ONE when nothing was measured — silence is not evidence, the rule the whole
 * scanner runs on. Reading an unmeasured token as calm would spread its ladder
 * three times wider on no information, and as wild would bunch it; the base
 * ladder is the one the operator chose without knowing anything about it.
 *
 * Zero counts as unmeasured too. A day of identical closes is a feed repeating
 * the last price over empty bars far more often than a token that did not
 * move — and the activity floor at the door means no traded token gets here.
 */
export function dcaScale(volPct: number | null, policy: DcaScalePolicy = DEFAULT_DCA_SCALE_POLICY): number {
  return measuredDcaScale(volPct, policy) ?? 1
}

/**
 * The scale when there was something to measure it from, or null — so a
 * caller that STORES it can tell "measured, and ordinary" from "nobody knows",
 * and keep asking instead of writing a one down on no evidence.
 */
export function measuredDcaScale(volPct: number | null, policy: DcaScalePolicy = DEFAULT_DCA_SCALE_POLICY): number | null {
  if (volPct === null || !Number.isFinite(volPct) || !(volPct > 0)) return null
  const raw = Math.sqrt(volPct / policy.medianVolPct)
  return Math.min(policy.maxScale, Math.max(policy.minScale, raw))
}

/** One rung's drop at this token's scale, never past `maxDropPct`. */
export const scaledDropPct = (dropPct: number, scale: number, policy: DcaScalePolicy = DEFAULT_DCA_SCALE_POLICY): number =>
  Math.min(policy.maxDropPct, dropPct * scale)

/**
 * A drop as the operator reads it: a whole number as it is (`10`), anything
 * else to one decimal (`5.2`). ONE definition for the alert and the screen, so
 * the phone and the dashboard cannot name two different lines for one rung.
 */
export const dropLabel = (dropPct: number): string =>
  Number.isInteger(dropPct) ? String(dropPct) : dropPct.toFixed(1)

/**
 * How much the token moves a bar, in percent: the root mean square of the log
 * returns between consecutive closes, times a hundred. Null with fewer than
 * `minReturns` returns, or a close that is not a positive number.
 *
 * Around ZERO, not around the mean return, because that is what the replay
 * measured and the replay is the evidence. Over a day of 15-minute bars the
 * two barely differ — a token up 50% on the day drifts 0.4% a bar against
 * swings several times that — and the drift is movement too.
 */
export function volatilityPct(closes: readonly number[], policy: DcaScalePolicy = DEFAULT_DCA_SCALE_POLICY): number | null {
  const returns = closes.length - 1
  if (returns < policy.minReturns) return null
  let sumSq = 0
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i]! / closes[i - 1]!)
    sumSq += r * r
  }
  const vol = Math.sqrt(sumSq / returns) * 100
  return Number.isFinite(vol) ? vol : null
}

/**
 * The volatility over the bars that had CLOSED in the window before `at`.
 *
 * `time` is each bar's OPEN, as every candle adapter here returns it, so a bar
 * counts once `time + barMs <= at`: the bar the price was moving in when the
 * position bought is not yet a fact about the token, and a spike that happened
 * after the buy must not decide how its ladder was drawn.
 */
export function volatilityBefore(
  candles: { readonly time: readonly number[]; readonly close: readonly number[] },
  at: number,
  barMs: number,
  policy: DcaScalePolicy = DEFAULT_DCA_SCALE_POLICY,
): number | null {
  const closes: number[] = []
  for (let i = 0; i < candles.time.length; i++) {
    const t = candles.time[i]!
    if (t >= at - policy.windowMs && t + barMs <= at) closes.push(candles.close[i]!)
  }
  return volatilityPct(closes, policy)
}
