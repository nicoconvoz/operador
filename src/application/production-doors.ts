import { type ComponentFloors } from '../domain/scanner/opportunity.js'
import { type CandidateOrder } from '../domain/scanner/ranking.js'

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
 * The buy-pressure door, in percent: STRICTLY more than this.
 *
 * *Como puerta de entrada, todos los tokens que tengan más de 10% de presión
 * compradora.* The operator, replacing activity above half and liquidity
 * growth in the hour — both still scored and drawn, neither asked.
 *
 * Buy pressure is `(buys − sells) / trades` over the last hour, so more than
 * 10% is buyers holding more than 55% of the hour's trades. A silent hour is
 * no pressure, and fails. The SAFETY gates, and the opportunity gates still on
 * in `DEFAULT_GATE_POLICY`, are not conditions of this kind and stay.
 */
export const DEFAULT_MIN_BUY_PRESSURE_PCT = 10

/**
 * *La única puerta de entrada para los tokens es que la eficiencia de los
 * costos esté arriba del 60%.* The operator, replacing buy pressure above 10%
 * outright — it is still scored and drawn, no longer asked, and its variable
 * no longer moves anything.
 *
 * `costEfficiency` is linear in the measured round trip: 1 at no toll, 0 at
 * `worstRoundTripPct` (4%). Above 0.6 is a round trip under 1.6% — spread,
 * impact and gas of buying and leaving. An UNMEASURED toll is the neutral 0.5,
 * so a token nobody priced stays out. The SAFETY gates, and the opportunity
 * gates still on in `DEFAULT_GATE_POLICY`, are not conditions of this kind and
 * stay.
 */
export const DEFAULT_MIN_COST_EFFICIENCY_PCT = 60

/** The door as a floor: `{ above }`, because the operator said ABOVE. */
const costEfficiencyDoor = (pct: number): ComponentFloors => ({ costEfficiency: { above: pct / 100 } })

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
 *
 * It was none — *puerta de entrada ninguna: todo es bienvenido* — replacing
 * cost efficiency over 60%, and before it buy pressure over 10%. The table is
 * the history of how the key got here; `OPERADOR_MIN_COST_EFFICIENCY_PCT`
 * brings the cost floor back, BESIDE the one below.
 *
 * TODAY it is ONE: the token is rising in the last hour. *Hacé que la barrera
 * de entrada sea solamente que los tokens suban, como marca la barra de
 * estudio de los 49 tokens.* The operator. See `DEFAULT_ENTRY_RISING`.
 */
export const DEFAULT_COMPONENT_FLOORS: ComponentFloors = { risingHour: 1 }

/** The rising door as a floor: `risingHour` is 1 or 0, so at least 1 means rising. */
const risingDoor: ComponentFloors = { risingHour: 1 }

/**
 * Whether the ONE opportunity condition is on: the token's last hour is up by
 * anything at all — the Universo breadth bar's own "suben", through the same
 * predicate (`risingInTheHour`), so the bar and the door count the same tokens.
 * Exactly zero fails; an unreported hour fails, because at a door silence is
 * refused.
 *
 * A FLOOR on `risingHour`, a component that weighs nothing — not `headroom`,
 * which reads the same hour but asks "not collapsing past −3%" and carries 0.3
 * of the score. As a floor it rides everywhere the floors already go: the
 * scan's door before anything is paid for, the ranking BEFORE its
 * cost-efficiency order and its free-slot cut, the shelf a watch pass
 * allocates from, and the screen, which says why: *no sube en la última hora
 * (−1.2%)*.
 *
 * The SAFETY gates are not conditions of this kind and are untouched, as
 * always. `OPERADOR_ENTRY_RISING=0` takes the door off; only an explicit off
 * does, so a mistyped value keeps the operator's rule.
 */
export const DEFAULT_ENTRY_RISING = true

/**
 * Who wins when there are more candidates than free slots.
 *
 * *Que de los tokens candidatos elija los que tengan mejor eficiencia de
 * costos.* The operator. Cost efficiency, highest first, ties broken by score —
 * applied before EVERY cut: the ranking's, the scan's candle budget and the
 * allocator's, so the cheapest tokens to trade are never cut before the
 * allocator sees them. An unmeasured toll sorts by its neutral 0.5, like any
 * other number.
 *
 * It replaces "small caps first, then score" (`smallCapFdvUsd`), which
 * `OPERADOR_RANK_BY=size` brings back.
 */
export const DEFAULT_CANDIDATE_ORDER: CandidateOrder = 'costEfficiency'

/**
 * How much better, in points of cost efficiency, a waiting candidate must be
 * to take a reservation's slot — the reservation having bought nothing. Ten:
 * the same margin the score edge has always asked (`OPERADOR_MIN_SCORE_EDGE`),
 * read as 0.10 of efficiency. `OPERADOR_MIN_COST_EDGE_PCT` moves it.
 */
export const DEFAULT_MIN_COST_EDGE_PCT = 10

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
/**
 * The door for a FIRST buy, and only for it.
 *
 * *Para la primera compra vamos a basarnos en otra cosa: en la expansión del
 * volumen más del 50% y tendencia más del 50%.* The operator. Volume expansion
 * above half is the last hour trading more than 1.5× the day's hourly average;
 * trend (`momentum`) is 1 for a token rising in the hour or the day and 0
 * otherwise, so above half means rising.
 *
 * NOT a floor. The floors also turn the switch on a position already held, and
 * a volume burst cools off in minutes — as a floor it would rotate positions
 * out for the way they were bought. What a held position answers to is who is
 * trading it now: buy pressure adds, sell pressure sells.
 *
 * EMPTY now: the one condition — trend at 100% — became a floor, so every
 * candidate already meets it. The doors below it were, in order: expansion and
 * trend above half; then a second way in, *si
 * superan el 25% de expansión del volumen y tendencia más del 70% positiva,
 * entonces inicia.* Stated rather than discovered later: trend is binary
 * today — rising or not — so above 70% and above half mean the same thing,
 * and the second door covers the first. They stay separate so each keeps its
 * meaning the day trend is measured by degree.
 */
export const DEFAULT_ENTRY_DOORS: readonly ComponentFloors[] = []

// OPEN: trend at 100% is the one condition for a candidate. It was 75.
export const DEFAULT_MIN_SCORE = 0

export interface ProductionDoors {
  /** The binary key. Below any floor the token is neither candidate nor reserve. */
  readonly minComponents: ComponentFloors
  /** The score door, read after the score is computed and never folded into it. */
  readonly minScore: number
  /** The ways a token may be OPENED, any one enough, on top of the floors. See `DEFAULT_ENTRY_DOORS`. */
  readonly entryDoors: readonly ComponentFloors[]
  /**
   * Whether a token held back only by a preference gate may still be bought
   * when nothing better is free. OFF: *hacé que sólo sean candidatas las que ya
   * cumplan todas las condiciones.* `OPERADOR_RESERVE=1` brings it back.
   */
  readonly reserve: boolean
  /** Who wins when there are more candidates than free slots. See `DEFAULT_CANDIDATE_ORDER`. */
  readonly order: CandidateOrder
  /** Points of cost efficiency a waiting candidate must beat a reservation by. See `DEFAULT_MIN_COST_EDGE_PCT`. */
  readonly minCostEdgePct: number
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

  // Zero is a real value here too — "any toll under the worst" — and a door at 100
  // or past it is one no token can clear, so it is nonsense, not a setting.
  // Unset or nonsense: no cost door, the operator's decision.
  const costRaw = env.OPERADOR_MIN_COST_EFFICIENCY_PCT?.trim()
  const cost = Number(costRaw)
  const costDoor = costRaw && Number.isFinite(cost) && cost >= 0 && cost < 100 ? costEfficiencyDoor(cost) : {}
  // Only an explicit off or on moves it: a misspelt value must not quietly
  // open the door.
  const risingRaw = env.OPERADOR_ENTRY_RISING?.trim().toLowerCase() ?? ''
  const risingOn = ['0', 'false', 'no'].includes(risingRaw)
    ? false
    : ['1', 'true', 'yes'].includes(risingRaw) || DEFAULT_ENTRY_RISING
  const minComponents: ComponentFloors = { ...costDoor, ...(risingOn ? risingDoor : {}) }

  // Only `size` brings the old order back; anything else keeps the operator's.
  const order: CandidateOrder = env.OPERADOR_RANK_BY?.trim().toLowerCase() === 'size' ? 'size' : DEFAULT_CANDIDATE_ORDER

  // Zero is a real value: any better token takes an idle reservation's slot.
  const edgeRaw = env.OPERADOR_MIN_COST_EDGE_PCT?.trim()
  const edge = Number(edgeRaw)
  const minCostEdgePct = edgeRaw && Number.isFinite(edge) && edge >= 0 && edge < 100 ? edge : DEFAULT_MIN_COST_EDGE_PCT

  return {
    minComponents,
    entryDoors: DEFAULT_ENTRY_DOORS,
    minScore,
    reserve: env.OPERADOR_RESERVE?.trim() === '1',
    order,
    minCostEdgePct,
  }
}
