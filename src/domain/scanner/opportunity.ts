import { type MarketQuality } from '../market/market-quality.js'
import { type TokenSnapshot } from './snapshot.js'

/**
 * Opportunity score — is this token "breathing"?
 *
 * The scanner does NOT time entries; CASCADE DCA does that with its own
 * swing-high drop and lateral-zone gates. The scanner ranks which tokens are
 * worth running the strategy on: active, gaining attention, volatile enough
 * to produce the drops the ladder needs, and not bleeding liquidity.
 *
 * Every component is exposed, in [0, 1], so a score can always be explained.
 * The weights are policy, and the formula is deliberately simple — this is a
 * v1 heuristic to be tuned against recorded outcomes, not a claim of alpha.
 */

export interface OpportunityWeights {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
  /** Which WAY it has been going lately. `volatility` says only that it moved. */
  readonly momentum: number
  /** How much of the rise is still ahead. The higher it is, the further it can fall. */
  readonly headroom: number
  /**
   * How little of the move the chain will take. The first capital-floor run
   * measured 10% of gross on one token and 72% on another, same strategy and
   * same budget — so the venue's toll is a property OF THE TOKEN, and a
   * ranking that ignores it ranks a trap alongside a bargain.
   */
  readonly costEfficiency: number
}

export interface OpportunityPolicy {
  readonly weights: OpportunityWeights
  /** Hourly volume run-rate over the 24h average that counts as fully "expanding". */
  readonly fullExpansionRatio: number
  /**
   * The activity curve: where it bends, and where it counts as fully alive.
   *
   * It used to be a flat `txns / 60`, so a pool with sixty trades an hour and
   * one with five hundred scored IDENTICALLY — every difference above the cap
   * was invisible to the ranking, which is the opposite of "more activity is
   * worth more".
   *
   * Logarithmic now, like `headroom`: more is always worth more, with
   * diminishing returns, and no ceiling where the distinction simply stops.
   */
  readonly activityKneeTxnsPerHour: number
  readonly fullActivityTxnsPerHour: number
  /** Absolute 1h move (plus half the 6h move) that counts as fully volatile, percent. */
  readonly fullVolatilityPct: number
  /**
   * How far the last hour may have FALLEN before the token is refused.
   *
   * The operator's calibration: *ponele que no haya descendido más del -3%
   * en la última hora.* It asked for a RISE of more than 1% before, and that
   * was too strict by a measured margin: of 84 live Solana tokens only 37%
   * cleared it, so this floor — not the score door — was what held the book
   * at seven positions where it had once run thirty-one. Lowering minScore
   * from 50 to 25 could not compensate, because the score was never what was
   * cutting.
   *
   * At -3% the same sample keeps 75%, and 68% once momentum has its say. The
   * question changes with it: not "is it going up right now", which is a
   * snapshot of one instant and re-rolls every scan, but "is it not falling
   * out from under us", which is what a door is for.
   */
  /**
   * The rise, in percent, that counts as a rise at all.
   *
   * Asked of the DAY and of the HOUR, and either answering yes is enough.
   * Below it the move is drift — these pools make that much standing still.
   */
  readonly minRisePct: number
  readonly headroomMaxFallPct: number
  /**
   * Round-trip cost, in percent, at which cost efficiency scores zero.
   *
   * DERIVED from the strategy's own exit, not picked: the normal exit sells at
   * `avg_cost * (1 + minProfitPct)`, and `minProfitPct` is 2. A token whose
   * round trip costs TWO of those targets has to double its own exit before it
   * breaks even, and no entry gate can promise that.
   *
   * It read 6 — three targets — where a toll that had already made the cycle
   * unprofitable still scored two thirds.
   */
  readonly worstRoundTripPct: number
}

/**
 * Floors a token must clear on its own terms, whatever its total says.
 *
 * The operator's rule: *without cost, headroom AND trend all above thirty
 * percent, it is not a coin to trade.*
 *
 * A FLOOR, not another weight, and the distinction is the whole point. The
 * score is a weighted AVERAGE, so a token can be ruinous on one term and still
 * rank well by being good at the rest — PURR charged **15.55% a round trip**,
 * scored zero on cost, and was bought anyway because everything else carried
 * it. An average cannot say "this one thing disqualifies you". A floor can.
 *
 * The three are not arbitrary either; they are the three pillars. What it costs
 * to trade, how much of the rise is still ahead, and which way it has been
 * going — the operator argued for each of them separately over a day, and this
 * says that being hopeless at any ONE of them cannot be averaged away.
 *
 * A MISSING component fails. Everywhere else in this scanner silence means "no
 * verdict"; here the verdict was already asked for, and an absent number is not
 * a passing one.
 *
 * Measured against a live book of 29 tokens at 0.30: **8 survive** — headroom
 * rejects 16, cost 8, trend 5. That is the cost of the rule, and it is real:
 * fewer positions, better ones.
 */
export type ComponentFloors = Partial<Record<keyof OpportunityComponents, number>>

export function meetsMinimums(
  components: Partial<OpportunityComponents>,
  floors: ComponentFloors | undefined,
): boolean {
  return failedMinimums(components, floors).length === 0
}

/**
 * WHICH floors failed, not merely that one did.
 *
 * The boolean was enough while a failure only meant "do not buy this". It is
 * not enough now that it can also mean "sell what you hold of this": a
 * decision that moves money has to carry its own evidence, or the allocator,
 * the screen and the audit log end up with three different stories about why
 * a position was closed.
 *
 * Order follows the floors object, so the reason string is stable rather than
 * dependent on which check happened to run first.
 */
export function failedMinimums(
  components: Partial<OpportunityComponents>,
  floors: ComponentFloors | undefined,
): readonly (keyof OpportunityComponents)[] {
  if (floors === undefined) return []
  return (Object.entries(floors) as [keyof OpportunityComponents, number | undefined][])
    .filter(([name, floor]) => floor !== undefined && (components[name] ?? -1) < floor)
    .map(([name]) => name)
}

export const DEFAULT_OPPORTUNITY_POLICY: OpportunityPolicy = {
  // `momentum` takes its weight from `volatility`, which it complements rather
  // than replaces: volatility says the token is MOVING, momentum says which
  // way. Rewarding the first alone made a token down 40% on the day and one up
  // 40% look identical to the shortlist.
  // TWO PILLARS. `headroom` asks how much of the move is already spent and
  // `activity` asks whether anyone is trading it at all — and between them they
  // are most of the score, deliberately. The operator's thesis: a 70% fall is
  // ruinous while a 25% gain is simply cashed, and a pool nobody trades is one
  // nobody will buy from us either.
  //
  // The toll is NOT a third pillar, and it was one for a day. At 0.9 it took
  // the total from 3.08 to 3.78 and a weighted average has ONE denominator, so
  // every other component lost share and every score in the book fell — for a
  // change in our arithmetic rather than in the market. The operator caught it
  // from the outside ("teníamos más monedas arriba de 70 puntos, qué cambió?")
  // and named the fix: *un filtro aparte, que no modifique el puntaje total*.
  //
  // So the toll is a DOOR now — `minComponents` in the ranking policy, on/off
  // at 0.3 — and the weight is back to what it was: measurable, never
  // decisive. A door is also stricter than the weight ever was, because an
  // average can be carried by its other terms and a floor cannot.
  //
  // `headroom` weighs ZERO, and it was 1.14 — the largest weight in the score.
  // The operator retired it with the argument the whole book rests on: *una
  // moneda de estas puede subir 2000% y nos estamos perdiendo una
  // oportunidad.* It asked how much of the rise was still ahead, and on a
  // micro-cap that is a bet that the move is over.
  //
  // It is still COMPUTED and still drawn, because the detail sheet answers
  // "why is this ranked here" with the components as bars and a deleted
  // measurement answers it with silence. Zero weight contributes nothing to
  // the numerator and nothing to the denominator, so the score is a clean
  // average of the seven that remain.
  //
  // The 24h change did not stop mattering; it stopped cutting BOTH ways. It
  // still refuses a token through `maxDailyFallPct` (15), which fires on a
  // FALL — an exit in progress — and never on a rise, however violent.
  //
  // The cost, stated rather than discovered later: removing the largest weight
  // does not leave a neutral score, it hands the majority to whatever was
  // second. Total weights fall 3.08 -> 1.94 and `activity` goes from 32.5% to
  // 51.5%, so "is anyone trading it" is now more than half the answer.
  // THREE components, and the operator set them as shares: *tendencia
  // reciente alcista 50%, sube en una hora 30%, eficiencia de costos 30%.*
  // Everything else is still measured and still drawn — the detail sheet
  // answers "why is this ranked here" with bars — and decides nothing.
  weights: { volumeExpansion: 0, buyPressure: 0, liquidityGrowth: 0, activity: 0, volatility: 0, momentum: 0.5, headroom: 0.3, costEfficiency: 0.3 },
  fullExpansionRatio: 3,
  activityKneeTxnsPerHour: 15,
  fullActivityTxnsPerHour: 300,
  fullVolatilityPct: 20,
  // The rise over the last HOUR below which nothing is happening. Measured
  // across 72 live Solana pools over $50k of liquidity, the median riser moves
  // +1.45% in an hour and 36% are flat or falling — so one percent ignores the
  // drift without refusing the ordinary climbing token.
  minRisePct: 1,
  headroomMaxFallPct: 3,
  worstRoundTripPct: 4,
}

export interface OpportunityComponents {
  readonly volumeExpansion: number
  readonly buyPressure: number
  readonly liquidityGrowth: number
  readonly activity: number
  readonly volatility: number
  readonly momentum: number
  readonly headroom: number
  readonly costEfficiency: number
}

export interface Opportunity {
  /** 0..100 */
  readonly score: number
  readonly components: OpportunityComponents
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * @param previous the last snapshot of the same token, for liquidity growth;
 *        with none, growth is neutral.
 * @param quality the token's measured spread and impact; without it, cost
 *        efficiency is neutral rather than assumed good.
 */
export function scoreOpportunity(
  snapshot: TokenSnapshot,
  policy: OpportunityPolicy,
  previous: TokenSnapshot | null = null,
  quality: MarketQuality | null = null,
): Opportunity {
  const { volumeUsd, txns, priceChangePct } = snapshot

  // Hourly run-rate vs the 24h hourly average: 1 = steady, 3 = tripling.
  const hourlyAverage = volumeUsd.h24 / 24
  const expansionRatio = hourlyAverage > 0 ? volumeUsd.h1 / hourlyAverage : 0
  const volumeExpansion = clamp01(expansionRatio / policy.fullExpansionRatio)

  // Share of buys in the last hour. 0.5 is neutral; only the excess counts.
  const trades1h = txns.h1.buys + txns.h1.sells
  const buyShare = trades1h > 0 ? txns.h1.buys / trades1h : 0.5
  const buyPressure = clamp01((buyShare - 0.5) * 2)

  // Liquidity vs the previous look: 1 = flat, ≥ 1.5 = fully growing, ≤ 0.5 = gone.
  const growthRatio = previous && previous.liquidityUsd > 0 ? snapshot.liquidityUsd / previous.liquidityUsd : 1
  const liquidityGrowth = clamp01((growthRatio - 0.5) / 1)

  // The OTHER pillar, beside `headroom`, and for the operator's own reason: a
  // pool nobody is trading is one nobody will buy from us either. More is
  // always worth more here — the curve has diminishing returns but no ceiling
  // at which two pools stop being distinguishable.
  const activity = clamp01(
    Math.log(1 + trades1h / policy.activityKneeTxnsPerHour) /
      Math.log(1 + policy.fullActivityTxnsPerHour / policy.activityKneeTxnsPerHour),
  )

  const move = Math.abs(priceChangePct.h1 ?? 0) + Math.abs(priceChangePct.h6 ?? 0) / 2
  const volatility = clamp01(move / policy.fullVolatilityPct)

  // WHICH WAY it has been going lately.
  //
  // `volatility` above measures how much it moved and is blind to direction, so
  // a token down 40% on the day scored exactly like one up 40% — and the
  // shortlist was as happy to buy the falling knife as the climb.
  //
  // It asks only WHETHER each window is up, never by how much.
  //
  // A size threshold here would be an invented number pretending to be a
  // measurement: there is no percentage at which a rise becomes "a rise". What
  // the score needs from this component is the sign, and `volatility` above
  // already carries the magnitude — together they say "moving, and upward",
  // which is the whole point of having both.
  //
  // Weighted toward the RECENT, and the recent hour can outvote the other two
  // between them. Up on the day but falling this hour is a top rolling over;
  // down on the day but rising this hour is a bottom turning. The second is the
  // one worth buying, and only a weighting that lets the near window win can
  // tell them apart.
  //
  // A flat token scores 0.5, and so does an unreported window. Zero movement is
  // the absence of a reason either way, and silence is not evidence — the same
  // rule the gates run on. Scoring either as a FALL would push the book toward
  // whatever moved most in any direction, which is the bias this removes.
  // THE LAST HOUR, POSITIVE. Nothing else.
  //
  // The operator, after three measurements of the alternative: *vas a tener en
  // cuenta solo que en la ultima hora el % sea positivo, nada mas. No importa
  // si es 0.1 o 2000, el tema es que este positivo.*
  //
  // It weighed three windows before — 0.6 on the hour, 0.25 on six, 0.15 on
  // the day — and at a floor of 0.5 the hour already decided every case: the
  // hour alone reaches 0.6, and the other two together only reach 0.40, so
  // they could never rescue a falling hour and only ever padded a rising one.
  //
  // What they DID do was catch five tokens with no hourly data that had fallen
  // 95-99% over the windows that did report. Those are excluded anyway now,
  // because an unreported hour is not a POSITIVE one — the single place this
  // file departs from "silence is not evidence", and the operator's rule is
  // what departs. Measured: 29 of 305 live tokens.
  //
  // UP IN THE DAY OR UP IN THE HOUR, by at least a full percent in whichever
  // one it uses. The operator chose it from six measured readings of his own
  // phrase, over 174 tokens the machine could actually operate:
  //
  //   the hour > 0 (what this replaces)   64 = 37%
  //   the hour >= 1%                      34 = 20%
  //   the day >= 1%                      120 = 69%
  //   the day >= 1% AND the hour > 0      42 = 24%
  //   the day >= 1% AND the hour >= 1%    20 = 11%
  //   the day >= 1% OR the hour >= 1%    134 = 77%   <- this one
  //
  // Every reading with AND closes harder than the rule it replaces. Only the
  // OR opens, and it opens to more than double.
  //
  // A full percent because drift is not a rise: 0.9% either way is inside the
  // noise these pools make standing still.
  //
  // And it finally makes the two floors say different things. This asks
  // whether the token rose ANYWHERE; `headroom` asks whether it is not
  // collapsing RIGHT NOW. A token up 5% on the day and down 10% in the hour
  // passes the first and fails the second — the case neither could express
  // while both read the same window.
  const rose = (pct: number | null | undefined) => pct !== null && pct !== undefined && pct >= policy.minRisePct
  const momentum = rose(priceChangePct.h24) || rose(priceChangePct.h1) ? 1 : 0

  // HOW MUCH ROOM IS LEFT above it.
  //
  // Direction is not the whole question: the higher a token already is, the
  // further it can fall, so between two risers the one that has not run yet is
  // worth more than the one that has. The operator's rule.
  //
  // No threshold, and deliberately: a cut-off would be the same invented number
  // `momentum` was rewritten to remove. The curve is smooth, monotone at every
  // size, and never reaches zero — a token that has run is worth LESS, not
  // worthless. `headroomHalvingPct` is how fast it separates two risers, and
  // the gap widens the further either has run, which is the point.
  //
  // A FALLING token has no headroom at all — not a neutral half.
  //
  // It was 0.5 so as not to reward a knife for being far from its high, and
  // that was right while the weight was small. It became wrong the moment this
  // was the largest term: measured live, a token down 64% on the day with
  // momentum at zero still scored 52.5, because neutral on the biggest
  // component is a GIFT rather than an abstention.
  //
  // The question is "how much of the upside is left". A token going the wrong
  // way has none of it. That is not punishing the fall twice; it is the honest
  // answer to the question asked.
  //
  // An UNREPORTED window is still neutral, because silence is not evidence —
  // the rule the whole scanner runs on — and reading it as a crash would
  // condemn every token a provider was quiet about.
  // Measured over the HOUR, and it used to be measured over the day.
  //
  // The operator's argument, and it is the same class of error `dropInitPct`
  // already cost this project: *de qué me sirve una ventana tan grande de un
  // día en tokens que cambian en minutos... el día cuela todo.* A parameter
  // calibrated for one window stops meaning what it meant when the window
  // changes, and this engine trades 15-minute bars.
  //
  // What the daily version actually did: a token that moved at breakfast and
  // has been flat since read as fully spent, and one running right now read as
  // fresh because its day had not caught up. Both answers are about yesterday.
  //
  // A token going the WRONG WAY has none of the upside left — that is the
  // honest answer to the question asked, not a second punishment for the fall.
  // An UNREPORTED hour stays neutral, because silence is not evidence.
  const recent = priceChangePct.h1
  const headroom =
    recent === null || recent === undefined
      ? 0.5
      : recent < -policy.headroomMaxFallPct
        ? 0
        : 1

  // Round trip = pay to get in, pay to get out.
  //
  // LINEAR, deliberately, where `headroom` and `activity` are logarithmic.
  // Those two encode a judgement — a fall hurts more than a rise helps, dead
  // differs from alive more than busy differs from busier. This one encodes
  // arithmetic: every basis point of toll is a basis point off the result,
  // with no asymmetry to bend the curve around. Making it log because the
  // last two were would be a shape borrowed rather than argued.
  //
  // 0.5 (neutral) when unmeasured, so a token is never rewarded for a toll
  // nobody checked — and never condemned for one either. Silence is not
  // evidence, and the safety gates already refuse to trade an unexamined
  // token, so the neutral only ever affects where it sits on the screen.
  const costEfficiency = quality === null ? 0.5 : clamp01(1 - (2 * (quality.spreadPct + quality.slippagePct)) / policy.worstRoundTripPct)

  const components = { volumeExpansion, buyPressure, liquidityGrowth, activity, volatility, momentum, headroom, costEfficiency }
  const w = policy.weights
  const weightSum =
    w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.activity + w.volatility + w.momentum + w.headroom + w.costEfficiency
  const weighted =
    w.volumeExpansion * volumeExpansion +
    w.buyPressure * buyPressure +
    w.liquidityGrowth * liquidityGrowth +
    w.activity * activity +
    w.volatility * volatility +
    w.momentum * momentum +
    w.headroom * headroom +
    w.costEfficiency * costEfficiency

  return { score: (100 * weighted) / weightSum, components }
}
