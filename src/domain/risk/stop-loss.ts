import { type CloseAllOrder } from '../strategy/state.js'

/**
 * The stop loss — named one, deliberately — sized to what the token has
 * already done.
 *
 * The operator asked for it in plain words: *el SL que sea proporcional al %
 * de crecimiento. Si es de 1000% entonces nos vamos a arriesgar a que caiga
 * 50% del valor de lo invertido, ese es el techo; de ahí capturamos para
 * abajo. Si es 500%, 25% de lo invertido, y así.*
 *
 * ## This is a different strategy, not a new rule on the old one
 *
 * CASCADE DCA's premise is that a drop is something to average into, and
 * "never exit at a loss on price" follows from it. The momentum entry has the
 * opposite premise: ride a move that is already happening and leave the moment
 * it turns. Both are coherent; they are not compatible, and pretending this is
 * a refinement of the first would hide that.
 *
 * So it is named a stop loss, it lives in its own file, and it is nowhere near
 * the death watch. `AssetHealthObservation` is typed so no price-shaped field
 * can exist on it, and that typing is the single structural guarantee keeping
 * the death exit from silently degrading into this. Routing a price rule
 * through it would break the exact thing that type was built to protect.
 *
 * ## Why PROPORTIONAL, which is the part worth keeping
 *
 * A fixed percentage assumes every token is equally jumpy, and these are not.
 * Measured live in the same sweep the entry rule was measured on: HOJAK was up
 * **1248% in five minutes**, TIPPED **4814% over six hours** — a token moving
 * like that covers five percent in seconds, in both directions. A 5% stop
 * there is not risk control, it is a coin flip that exits on noise.
 *
 * So the stop scales with what the token has ALREADY done, which is the
 * cheapest volatility proxy available and costs no extra request. One
 * twentieth of the run, floored and capped:
 *
 * | Already up | Stop |
 * |---|---|
 * | 1000% or more | **50%** — the ceiling the operator named |
 * | 500% | 25% |
 * | 200% | 10% |
 * | 100% or less | **5%** — the floor |
 *
 * The floor matters as much as the ceiling. Without it a calm token would get
 * a stop of a fraction of a percent and be sold by the spread itself; without
 * the ceiling a token up 4814% would get a stop so wide the rule would never
 * fire at all, which is the same as having none.
 *
 * ## Measured against the entry price, not the average cost
 *
 * *Con respecto al valor invertido.* With one buy per token they are the same
 * number, but the difference matters the day a ladder comes back: an average
 * cost falls as rungs fill, so a stop measured against it CHASES the position
 * down and can never be reached. Measuring against what was actually put in is
 * what makes "we are down X percent" mean the same thing on every bar.
 *
 * ## What it costs, stated rather than discovered later
 *
 * The widest stops go to the tokens that have run furthest — which are also
 * the ones with the least room left above them. A token up 1000% that turns is
 * allowed to take half the position with it. That is the operator's trade and
 * its arithmetic is honest: it buys the position enough room to survive the
 * ordinary swings of something that volatile, and pays for it with a larger
 * loss when the turn is real.
 *
 * Whether it works is a question about the win rate, and the only way to learn
 * that is to run it and count — which `tools/loss-by-exit.ts` already does, by
 * exit.
 */

export const STOP_LOSS_COMMENT = '🛑 Stop' as CloseAllOrder['comment']

/**
 * A winner giving its gain back, stopped at zero.
 *
 * Its own name rather than the stop's, because the tape has to tell them apart:
 * one is a position that never worked, the other is one that DID and was about
 * to be turned into a loss. Counting them together would hide exactly the
 * number the operator asked about. Not `⚖️ BE Exit` either — that is the
 * reference's rescue breakeven, which arms on DCA depth and is parity-tested
 * evidence, not a name to borrow.
 */
export const BREAK_EVEN_COMMENT = '🔒 Break-even' as CloseAllOrder['comment']

export interface StopLossPolicy {
  /**
   * Share of the token's own run that we are willing to give back, as a
   * fraction. 0.05 is the operator's rule: 1000% up buys a 50% stop.
   */
  readonly shareOfRun: number
  /**
   * The narrowest the stop ever gets, in percent.
   *
   * Without it a calm token would be sold by its own spread. Five is the
   * operator's original number, and it is where the proportional rule lands a
   * token that has risen 100%.
   */
  readonly minStopPct: number
  /**
   * The widest it ever gets, in percent. The operator named it: *ese es el
   * techo.* Without it a token up 4814% would get a stop so wide that having
   * the rule and not having it would be the same thing.
   */
  readonly maxStopPct: number
  /**
   * A loss in DOLLARS that ends the position, and when it is set it is the
   * WHOLE rule.
   *
   * *Ponele un SL de 0.10 centavos, todo lo que caiga a partir de ahí salte,
   * inmediatamente.* And when the first version kept a percentage beside it:
   * *no quiero que mires el porcentaje cuando detecte 0.10 SL.* So no flat
   * percent, no 1:4 derivation, no ceiling — the position has lost this many
   * dollars or it has not.
   *
   * Price only, never the toll. A position is born about ten cents under water
   * — the buy's own cost — so a limit that counted costs would sell every
   * position the instant it was bought and pay the round trip for nothing.
   */
  readonly maxLossUsd?: number
}

/**
 * OFF, and it is the default the orchestrator falls back to.
 *
 * A stop is a real departure from the reference — the only path in this engine
 * where a PRICE causes a sale — so it is composed in production beside the
 * ladder cap and the entry drop rather than smuggled into the port. A caller
 * that says nothing gets the reference behaviour, and the parity harness keeps
 * meaning what it meant.
 */
export const NO_STOP_LOSS: StopLossPolicy = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0 }

/**
 * FLAT one percent — what production runs, and the operator's current
 * experiment rather than a settled rule.
 *
 * *Si alguno llega a bajar 1% SL, revisá tick a tick, no quiero quedarme con
 * ninguna posición que baje eso, y rotás a otra moneda.*
 *
 * ## Flat, which contradicts this file's own argument — on purpose
 *
 * Everything above argues that a fixed percentage assumes every token is
 * equally jumpy and that these are not. That argument is not withdrawn. What
 * changed is the QUESTION: the proportional stop asks *how much of this run am
 * I willing to give back*, and this one asks *is this token going the wrong
 * way at all.* At one percent there is no run to be proportional to — the
 * position is barely older than its own spread.
 *
 * **Floor and ceiling are EQUAL, and that is what makes it flat** —
 * `stopLossPctFor` clamps into `[minStopPct, maxStopPct]`, so the interval
 * collapses to a point and no run, however large, can widen it.
 * `shareOfRun: 0` short-circuits the proportional arithmetic before that,
 * which is the clearer statement of intent but not the guarantee. Both were
 * mutated: raising either bound kills a test, so neither can drift.
 *
 * ## What it costs, stated before it ran rather than after
 *
 * A round trip on a $15 fill costs about **1.29%** — which is why
 * `minProfitPctFor` derives a 3.90% exit target from it. So this stop cuts
 * BELOW the cost of the trade that opened it:
 *
 * | | Net of costs |
 * |---|---|
 * | a winner reaching the derived target | **+2.6%** |
 * | a position stopped out here | **−2.29%** |
 *
 * That is roughly symmetric, not the 1:4 the raw numbers suggest, so the rule
 * needs a win rate near half just to break even — and a micro-cap on 15m bars
 * dips one percent as ordinary noise. It is shipped anyway because the engine
 * is in PAPER and the operator said so plainly: *no hay plata de por medio,
 * estas son pruebas.* Running it and counting is the only way to learn the
 * win rate, and `tools/loss-by-exit.ts` already groups the answer by exit.
 */
export const FLAT_ONE_PCT_STOP: StopLossPolicy = { shareOfRun: 0, minStopPct: 1, maxStopPct: 1 }

/** The operator rule: one twentieth of the run, floored at 5%, capped at 50%. */
export const DEFAULT_STOP_LOSS_POLICY: StopLossPolicy = {
  shareOfRun: 0.05,
  minStopPct: 5,
  maxStopPct: 50,
}

/**
 * How far this particular token is allowed to fall, given how far it has run.
 *
 * An UNMEASURED run takes the floor rather than the ceiling. Silence is not
 * evidence of volatility, and the narrow stop is the conservative answer: it
 * risks an exit that was not necessary, never a loss that was not bounded.
 */
export function stopLossPctFor(runPct: number | null | undefined, policy: StopLossPolicy): number {
  if (policy.shareOfRun <= 0) return policy.minStopPct
  // No clamp at zero, and its absence is deliberate: a mutation test proved
  // one redundant. A FALL computes a negative product and `Math.max` with the
  // floor already swallows it, so guarding twice would be a line that looks
  // like protection and protects nothing — the kind of thing the next reader
  // trusts and the one after that has to re-derive.
  const run = runPct ?? 0
  return Math.min(policy.maxStopPct, Math.max(policy.minStopPct, run * policy.shareOfRun))
}

export interface StopLossInput {
  /** What the position actually paid, per unit. */
  readonly entryPriceUsd: number
  /** What it would fill at NOW — the live market price, never the candle. */
  readonly marketPriceUsd: number | null
  /** Units held. Nothing held is nothing to stop out of. */
  readonly openQty: number
  /**
   * How far the token had already run when we bought it, in percent, over the
   * window the entry rule reads. It sizes the stop and nothing else.
   */
  readonly runAtEntryPct: number | null
}

/**
 * Should this position be closed at a loss right now?
 *
 * Silence is not a fall: with no live price there is no verdict, because the
 * one thing worse than holding a loser is selling a healthy position on a
 * number no second source confirmed. That is not hypothetical — a $15.06
 * position once left at a tenth of a cent because two feeds disagreed about
 * the unit, so this returns false wherever the price is missing or absurd.
 */
export function shouldStopOut(input: StopLossInput, policy: StopLossPolicy): boolean {
  if (input.openQty <= 0) return false
  if (input.marketPriceUsd === null || !(input.marketPriceUsd > 0)) return false
  if (!(input.entryPriceUsd > 0)) return false
  // Dollars decide ALONE when they are set. Returning here, before any
  // percentage is computed, is the operator's instruction made structural.
  if (policy.maxLossUsd !== undefined && policy.maxLossUsd > 0) {
    return lossUsd(input) >= policy.maxLossUsd
  }
  const stopPct = stopLossPctFor(input.runAtEntryPct, policy)
  if (stopPct <= 0) return false
  return input.marketPriceUsd <= input.entryPriceUsd * (1 - stopPct / 100)
}

/** What the position has lost on PRICE, in dollars — never the toll. */
export function lossUsd(input: StopLossInput): number {
  if (input.marketPriceUsd === null || !(input.marketPriceUsd > 0)) return 0
  return input.openQty * (input.entryPriceUsd - input.marketPriceUsd)
}

/** How far under water it is, for the alert and the audit trail. */
export function drawdownPct(input: StopLossInput): number | null {
  if (input.marketPriceUsd === null || !(input.marketPriceUsd > 0) || !(input.entryPriceUsd > 0)) return null
  return (input.marketPriceUsd / input.entryPriceUsd - 1) * 100
}
