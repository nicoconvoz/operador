import { type ComponentFloors } from '../domain/scanner/opportunity.js'

/**
 * The two doors between a scored token and a slot holding money.
 *
 * They live here, alone, for the same reason `production-ladder.ts` exists:
 * TWO things need them and neither may own them. The engine ranks with them
 * and the dashboard draws with them, and they were three literal copies —
 * `main.ts` twice and `dashboard/lib/view.ts` once. A screen that draws a
 * token as buyable while the engine refuses it is the exact drift the single
 * read model exists to prevent, and this project has paid for it more than
 * once: eighteen of twenty-seven Solana tokens once sat in that state.
 *
 * Both are DOORS on an already-computed score, never terms inside it. That is
 * the operator's own framing — *un filtro aparte, que no modifique el puntaje
 * total* — and it is a correction of how the same preference was expressed
 * first. Raising `costEfficiency` from 0.2 to 0.9 worked and cost too much: a
 * weighted average has ONE denominator, so weight added anywhere is share
 * taken everywhere, every score in the book fell, and every threshold ever
 * read against the old scale became quietly wrong. A door has none of those
 * side effects — it reads the number and changes nothing about it.
 *
 * No database, no clock, no network, so the web app imports it without
 * dragging the runtime into its build.
 */

/**
 * The binary key: below any one of these the token is not traded, whatever
 * its total says.
 *
 * The operator's words are the specification — *o está on o está off. Si
 * alguno de los pedidos del 30% está por debajo, sale off. Si están los 3 más
 * de 30%, la moneda pasa y el puntaje se calcula como antes.*
 *
 * Why a floor and not a weight: a weighted average can always be carried by
 * its other terms, which is exactly how PURR was bought while charging 15.55%
 * a round trip. No amount of volume, activity or freshness can talk a floor
 * round, and that is the entire point of having one.
 *
 * The three are the three the operator argued for, one at a time:
 *
 * | | asks |
 * |---|---|
 * | `costEfficiency` | what the token charges to trade it — 0.3 is a 2.8% round trip, past which the exit's own +2% target is already spent |
 * | `momentum` | which WAY it has been going |
 *
 * `headroom` was the third and is RETIRED, floor and weight together. At 0.3
 * it refused every token up more than about 95% on the day — which is exactly
 * the shape of the runner this book exists to catch. The operator's words:
 * *una moneda de estas puede subir 2000% y nos estamos perdiendo una
 * oportunidad; quitá esa traba.*
 *
 * The 24h change still refuses a token, in ONE direction: `maxDailyFallPct`
 * (15) fires on a fall, which is an exit in progress. A rise is the trade.
 *
 * A MISSING component fails. Everywhere else in this scanner silence means "no
 * verdict"; here the verdict was already asked for, and an absent number is
 * not a passing one.
 */
export const DEFAULT_COMPONENT_FLOORS: ComponentFloors = {
  // `momentum` and `headroom` are GONE, and the reason is measured rather than
  // preferred. The operator relaunched with the momentum rule on and the engine
  // opened THREE positions where the rule had thirty-seven candidates.
  //
  // Both floors ask the question the rule now asks, and ask it worse:
  //
  //   momentum = (h24 >= 1% || h1 >= 1%) ? 1 : 0, floored at 0.5
  //
  // Binary, so a floor of 0.5 means "must be 1" — h1 at least ONE percent. The
  // rule requires h1 above ZERO. So a token up 0.4% in the hour passed the
  // operator's rule and was killed by a floor that had been set for a different
  // strategy. It was not a stricter version of his decision; it was silently
  // overriding it.
  //
  //   headroom = h1 < -3% ? 0 : 1, floored at 0.3
  //
  // Worse: anything the rule admits is rising, so headroom is always 1 and the
  // floor can never cut. A dead knob, and a dead knob is worse than a wrong one
  // because the next reader tunes it and nothing happens.
  //
  // The rule replaces both, across THREE windows instead of two, and it reads
  // the five minutes that neither of them could see.
  //
  // `costEfficiency` STAYS, and it is not an oversight against *sacá todos los
  // filtros*. It answers a different question — what the token charges to trade
  // it, not whether it is moving — and it matters MORE under this strategy, not
  // less: positions turn over in minutes and every round trip pays the toll in
  // full. At 0.3 it admits anything under about a 2.8% round trip, and PURR
  // charged 15.55%.
  costEfficiency: 0.3,
  // *Sólo vas a operar las monedas que tengan más del 1% de presión
  // compradora.* Buy pressure is the share of buys in the last hour above the
  // neutral half, 0..1 — so 1% is buys above 50.5% of the hour's trades. An
  // even or silent hour scores zero and is refused. Like the toll, it also
  // turns the switch on a position already held: a winner whose buyers left
  // may rotate, and only above what its round trip costs.
  buyPressure: 0.01,

}

/**
 * The lowest total score the book will open a position on.
 *
 * The operator's number, and it is deliberately read against the RESTORED
 * scale — the one every figure in CLAUDE.md was measured on, total weights
 * 3.08. That matters more than the fifty: a threshold is only meaningful
 * beside the scale it is read against, and this one was chosen while looking
 * at a live book on exactly this scale.
 *
 * It is deliberately read against the scale as it stands AFTER `headroom` was
 * retired — total weights 1.94, not the 3.08 of an hour earlier and not the
 * 3.78 of the hour before that. A threshold only means something beside the
 * scale it was chosen on, and this one was chosen while looking at a live
 * book on exactly this one.
 *
 * Measured on that book: USELESS scored 47.1 while the run was being punished
 * and 74.8 once it was not; PAID went 42.7 -> 67.7 and POT 61.5 -> 67.6. The
 * operator's argument for seventy is that removing the penalty is what makes
 * seventy reachable, and the shelf understates it — every token on it was
 * chosen by the OLD rules, so the ones that had already run were rejected
 * before they were ever stored. The sample is biased against exactly what
 * this scale now rewards.
 */
// ZERO, because the floors ARE the rule now. *Esa va a ser la única regla.*
// A score door on top of three floors that already carry the whole score
// would be a fourth rule doing the same job twice — and it was the wrong one
// to reach for anyway: at 50 it was blamed for a narrow book while the real
// cut was `momentum`, which only a third of tokens clear in any given hour.
export const DEFAULT_MIN_SCORE = 75

export interface ProductionDoors {
  /** The binary key. Below any floor the token is neither candidate nor reserve. */
  readonly minComponents: ComponentFloors
  /** The score door, read after the score is computed and never folded into it. */
  readonly minScore: number
  /**
   * Whether a token held back only by a preference gate may still be bought
   * when nothing better is free. OFF: *hacé que sólo sean candidatas las que ya
   * cumplan todas las condiciones.* `OPERADOR_RESERVE=1` brings it back.
   */
  readonly reserve: boolean
}

/** Reads the overrides, falling back to the decisions above. */
export function productionDoors(env: Readonly<Record<string, string | undefined>>): ProductionDoors {
  // Zero is a REAL value here — "let everything through", not "unset". A
  // number that means one thing in one file and its opposite next door is not
  // a sentinel, it is a trap, and `maxPositions: 0` cost this engine every
  // position it could have opened.
  const raw = env.OPERADOR_MIN_SCORE?.trim()
  const parsed = Number(raw)
  const minScore = raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_SCORE

  return { minComponents: DEFAULT_COMPONENT_FLOORS, minScore, reserve: env.OPERADOR_RESERVE?.trim() === '1' }
}
