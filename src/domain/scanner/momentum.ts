import { type WindowedChangePct } from './snapshot.js'

/**
 * The momentum entry: green all the way down, from six hours to five minutes.
 *
 * The operator's rule, in his words: *mirá las últimas 4 horas, que no haya
 * bajado de 0% y que se haya incrementado en el total del tiempo hasta los 5m.*
 *
 * Four hours is not a window any provider reports — they give m5, h1, h6 and
 * h24 — so the rule reads the two that bracket it, exactly as the freefall gate
 * does. Reading the windows that exist beats inventing the one you want.
 *
 * ## Why every window and not just the freshest
 *
 * Each one answers a different question, and the conjunction is the whole idea:
 *
 * - `h6`  — has this been going UP for hours, or is it a dead cat bouncing?
 * - `h1`  — is the climb still on, or did it top out forty minutes ago?
 * - `m5`  — is it moving RIGHT NOW, which is the only thing an entry can act on.
 *
 * Measured live on 239 liquid Solana tokens: 119 were green over six hours, 85
 * over the hour, 100 over five minutes — and only **37** were green on all
 * three. The conjunction is doing real work; any single window admits three
 * times as many.
 *
 * ## Silence is not a rise
 *
 * An unreported window FAILS, and this is the one place in the scanner where
 * that is the right answer rather than the safe one. Everywhere else a missing
 * measurement leaves a gate silent, because the gate is looking for DANGER and
 * absence of evidence is not evidence of danger.
 *
 * Here the question is inverted. This is not asking *is there a reason to
 * refuse?* — it is asking *is there a reason to BUY?*, and there is no such
 * thing as an unmeasured reason to buy. A token whose five-minute window nobody
 * reported has not shown us a rise; it has shown us nothing.
 *
 * Measured: 36 of 239 carried no `m5` at all, most of them from pools priced
 * through GeckoTerminal, which does not report the window. Admitting those
 * would have meant buying on a provider's silence.
 *
 * ## What it deliberately does NOT ask
 *
 * How big the rise was. The operator's earlier instinct, and it has already
 * been argued once for `momentum`: there is no percentage at which a rise
 * becomes "a rise", so a threshold there is a guess wearing the clothes of a
 * measurement. Zero is not a guess — it is the line between up and down.
 *
 * It also does not ask how far the token has ALREADY run, and that is a real
 * cost stated rather than hidden. Measured in the same sweep, the strongest
 * candidate was up **1248% in five minutes**; this rule buys the top of a
 * vertical as happily as the start of a climb. What is supposed to answer that
 * is the exit, not the door.
 */
export function risingAcrossWindows(change: WindowedChangePct): boolean {
  return up(change.h6) && up(change.h1) && up(change.m5)
}

/** Measured, and above zero. An unreported window is neither. */
const up = (pct: number | null | undefined): boolean => pct !== null && pct !== undefined && pct > 0

/**
 * Which of the three windows is missing, for the reader rather than the engine.
 *
 * A token refused because nobody reported its five minutes and one refused
 * because it fell are the same verdict and completely different facts, and the
 * screen has to be able to tell them apart — this project has paid for that
 * confusion more than once.
 */
export function unreportedWindows(change: WindowedChangePct): readonly string[] {
  const missing: string[] = []
  if (change.h6 === null || change.h6 === undefined) missing.push('h6')
  if (change.h1 === null || change.h1 === undefined) missing.push('h1')
  if (change.m5 === null || change.m5 === undefined) missing.push('m5')
  return missing
}
