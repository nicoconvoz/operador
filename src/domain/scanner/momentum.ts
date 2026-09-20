import { type WindowedChangePct } from './snapshot.js'

/**
 * The rule: is it moving up RIGHT NOW.
 *
 * The operator's words: *no mira el día, mira los últimos 15 minutos: si
 * aumentó 1% para arriba queda, si no no.*
 *
 * ## Five minutes, and why that is not a substitution
 *
 * There is no fifteen-minute window in the market feed. DexScreener reports
 * m5, h1, h6 and h24, so his window sits between two of them, and the only
 * exact source is the CANDLES — one throttled request per token, and up to
 * fifteen minutes stale by the time it is read, because the bar still being
 * built is discarded.
 *
 * `m5` is free, batched thirty at a time, current to the minute, and STRICTER
 * rather than looser: a token that moves 1% inside five minutes is moving
 * harder than one that takes fifteen to do it. For an entry that exists to
 * catch a move already under way, fresher is the whole point. Shown both, the
 * operator chose it.
 *
 * ## One window, and the day is gone on purpose
 *
 * The rule before this read the DAY (up more than 5%) and the HOUR (still
 * positive). Both are gone, and the trade is explicit: a token that ran 40%
 * yesterday morning and has sat still since passes a daily test while not
 * moving at all, and one that started moving four minutes ago fails it and is
 * exactly what this exists for.
 *
 * What the day bought was protection against noise — 1% over five minutes on a
 * dead pool can be a single trade. That job now belongs entirely to the
 * LIQUIDITY floor, which is $100,000. A pool that deep does not move one
 * percent on one trade.
 *
 * ## Silence fails, and this is the one place where that is right
 *
 * Everywhere else in this scanner a missing measurement leaves a gate silent,
 * because the gate looks for DANGER and absence of evidence is not evidence of
 * danger. Here the question is inverted — not *is there a reason to refuse*
 * but *is there a reason to BUY* — and there is no such thing as an unmeasured
 * reason to buy. Measured live, 36 of 239 liquid tokens carried no `m5` at
 * all, mostly priced through GeckoTerminal, which does not report it.
 * Admitting those would be buying on a provider's silence.
 */
export function risingAcrossWindows(
  change: WindowedChangePct,
  policy: MomentumPolicy = DEFAULT_MOMENTUM_POLICY,
): boolean {
  const recent = change.m5
  return recent !== null && recent !== undefined && recent >= policy.minRisePct
}

export interface MomentumPolicy {
  /**
   * How far the token must be up over the freshest window, in percent.
   *
   * The operator's number, and the only threshold in the rule. At or above,
   * not strictly above: *si aumentó 1% para arriba queda*.
   */
  readonly minRisePct: number
}

export const DEFAULT_MOMENTUM_POLICY: MomentumPolicy = { minRisePct: 1 }

/**
 * Which window the rule reads was not reported, for the reader rather than the
 * engine.
 *
 * A token refused because it FELL and one refused because a provider was quiet
 * are the same verdict and completely different facts, and the screen has to be
 * able to tell them apart — this project has paid for that confusion more than
 * once.
 */
export function unreportedWindows(change: WindowedChangePct): readonly string[] {
  return change.m5 === null || change.m5 === undefined ? ['m5'] : []
}
