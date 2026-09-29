import { type MarketQuality } from '../market/market-quality.js'
import { evaluateGates, forgivableFailures, type GateFailure, type GatePolicy, type GateResult } from './gates.js'
import { risingAcrossWindows } from './momentum.js'
import { failedMinimums, scoreOpportunity, type ComponentFloors, type Opportunity, type OpportunityComponents, type OpportunityPolicy } from './opportunity.js'
import { type TokenSnapshot } from './snapshot.js'

/**
 * A token the scanner is handing to the executor: it passed every gate, it
 * has a score, and it carries the MarketQuality the executor will re-validate.
 */
export interface Candidate {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
  readonly marketQuality: MarketQuality
  /**
   * Present when this token is here only because nothing better was free, and
   * carrying the preferences it was forgiven. Absent means it qualified
   * outright.
   *
   * The evidence travels WITH the candidate rather than being recomputed, so
   * the screen, the allocator and the audit log cannot disagree about why a
   * token the gates rejected ended up holding money.
   */
  readonly forgiven?: readonly GateFailure[]
}

/** A token the scanner looked at and refused, with the reasons. Kept for the audit log. */
export interface Rejected {
  readonly snapshot: TokenSnapshot
  readonly gates: GateResult
  /**
   * The score it WOULD have had. Never a reason to buy it — the verdict is the
   * rejection — but a position we already hold keeps being scored, so the
   * score stop can see it fall: *cayó de puntaje y nunca vendió tampoco.*
   */
  readonly opportunity?: Opportunity
}

/**
 * A token that was scored and then refused by a component FLOOR.
 *
 * Kept apart from `rejected`, which means a GATE said no. The two are
 * different verdicts about different questions — "is this dangerous" versus
 * "is this worth trading" — and only this one can also mean "sell what we
 * already hold of it", so conflating them would let a honeypot verdict close a
 * healthy position and a floor verdict blacklist a healthy token.
 */
export interface SwitchedOff {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
  /**
   * Why the switch is off, so the evidence travels with the decision.
   *
   * Usually a component floor. `'rising'` when the momentum door refused it,
   * which is not a floor on a score but a condition on the token itself.
   */
  readonly failed: readonly (keyof OpportunityComponents | 'rising')[]
}

export interface ScanResult {
  readonly candidates: readonly Candidate[]
  readonly rejected: readonly Rejected[]
  /** Examined, scored, and refused by a floor. The switch, off. */
  readonly switchedOff: readonly SwitchedOff[]
}

export interface RankingPolicy {
  readonly gates: GatePolicy
  readonly opportunity: OpportunityPolicy
  /** How many tokens the executor can watch at once. */
  readonly watchSlots: number
  /** Below this score a token is safe but not interesting. */
  readonly minScore: number
  /**
   * Whether a token held back only by a preference gate may join as a reserve
   * behind every fully-qualified one. Absent means yes, which is how this
   * ranking has always worked; production turns it off — *sólo candidatas
   * las que ya cumplan todas las condiciones*.
   */
  readonly reserve?: boolean
  /**
   * Floors a token must clear on INDIVIDUAL components, whatever its total says.
   *
   * The score is a weighted average, so being ruinous at one thing can be
   * averaged away by being good at the rest. These cannot: a token below any
   * floor is not a candidate and not reserve either — the reserve forgives a
   * preference about the POOL, never a verdict about the opportunity.
   */
  readonly minComponents?: ComponentFloors
  /**
   * Require the token to be rising on every window the momentum rule reads.
   *
   * The operator's strategy: *sacá todos los filtros mientras haya liquidez;
   * vamos a operar con la única condición de que haya subido... mirá las
   * últimas 4 horas, que no haya bajado de 0% y que se haya incrementado en el
   * total del tiempo hasta los 5m.*
   *
   * A token that fails it lands on `switchedOff`, NOT on `rejected`, and that
   * placement is the design rather than a convenience. `switchedOff` feeds
   * `rotateOnSwitchOff`, so a token WE HOLD that stops rising is sold — which
   * is the exit this strategy needs. A rejection would only mean "do not buy
   * it" and would leave the book holding tokens that had stopped doing the one
   * thing they were bought for.
   *
   * Together with the stop it makes a complete pair: the switch takes the
   * profit when the climb ends, the stop takes the loss when it reverses.
   *
   * REQUIRED rather than optional, and that is the point. A mutation test
   * showed the composition root could stop passing it and no test would die —
   * which is the exact blind spot that hid a missing `discover`, a missing
   * `poolMarkets` and a capital trim that wrote over the tick. Optional fields
   * are where wiring bugs live in this codebase; `tsc` catches a required one.
   */
  readonly requireRising: boolean
  /**
   * The line between "fill the book with these" and "complete it with those".
   *
   * A token under it is ranked ahead of EVERY token above it, whatever the
   * scores say. Small caps are what the ladder is for — they move enough for a
   * 10% drop from a five-hour high to happen daily — and large ones are the
   * fallback that keeps capital working when there are not enough.
   *
   * Absent means no preference: everything competes on score alone.
   */
  readonly smallCapFdvUsd?: number
  /**
   * Who wins when there are more candidates than slots — applied BEFORE the
   * cut, so the tokens that win are never the ones cut.
   *
   * `'costEfficiency'`: the cheapest to trade first, ties by score. *Que de los
   * tokens candidatos elija los que tengan mejor eficiencia de costos.* The
   * operator, and production's.
   *
   * `'size'`: small caps first (`smallCapFdvUsd`), then score — the order this
   * ranking always had, one variable away (`OPERADOR_RANK_BY=size`).
   *
   * REQUIRED, like `requireRising`: an optional field is where a composition
   * root forgets to pass the operator's decision and nothing dies.
   */
  readonly order: CandidateOrder
  /**
   * Tokens we already HOLD, keyed `chain:address`. Ranked like any other, and
   * never counted against `watchSlots` — the slots are the FREE ones, and a
   * held token already has its own. Absent: nothing held.
   */
  readonly held?: ReadonlySet<string>
}

/** Who wins a slot. See `RankingPolicy.order`. */
export type CandidateOrder = 'costEfficiency' | 'size'

/** What the order reads: the token, and its score and components. */
export interface Rankable {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
}

/**
 * The ONE order candidates are served in — the ranking's cut, the scan's budget,
 * the allocator and the screen all read it, so none of them can cut a token
 * another one would have kept. The address breaks the last tie, so the order
 * is total and the same on every machine.
 */
export function candidateComparator(order: CandidateOrder, smallCapFdvUsd?: number): (a: Rankable, b: Rankable) => number {
  const byAddress = (a: Rankable, b: Rankable) => a.snapshot.address.localeCompare(b.snapshot.address)
  if (order === 'costEfficiency') {
    return (a, b) =>
      b.opportunity.components.costEfficiency - a.opportunity.components.costEfficiency ||
      b.opportunity.score - a.opportunity.score ||
      byAddress(a, b)
  }
  // SIZE first, then score. An unknown FDV counts as small: it is the normal
  // case on a young pool, and sorting it last would quietly demote exactly the
  // tokens this system exists to trade.
  const big = (s: TokenSnapshot) => (smallCapFdvUsd !== undefined && s.fdvUsd !== null && s.fdvUsd > smallCapFdvUsd ? 1 : 0)
  return (a, b) => big(a.snapshot) - big(b.snapshot) || b.opportunity.score - a.opportunity.score || byAddress(a, b)
}

/**
 * The first `slots` tokens we do not hold, and every one we do, in the order
 * given. The slots are the FREE ones: a held token already has its own.
 */
export function cutToFreeSlots<T extends Rankable>(ranked: readonly T[], slots: number, held?: ReadonlySet<string>): T[] {
  let taken = 0
  return ranked.filter((c) => {
    if (held?.has(tokenKey(c.snapshot))) return true
    if (taken >= slots) return false
    taken += 1
    return true
  })
}

/**
 * Market quality is measured by the adapters (a real sell quote for a
 * reference size); the domain only requires that it be provided per token.
 */
export type QualityLookup = (snapshot: TokenSnapshot) => MarketQuality

/**
 * Gates first, always. Then score, then rank, then cut to the watch slots.
 * Tokens already being watched are the caller's concern: the executor owns
 * its watchlist and decides what to swap out.
 */
export function rankUniverse(
  universe: readonly TokenSnapshot[],
  previous: ReadonlyMap<string, TokenSnapshot>,
  quality: QualityLookup,
  policy: RankingPolicy,
): ScanResult {
  const candidates: Candidate[] = []
  // Tokens that were EXAMINED and failed a floor — the switch, off.
  //
  // It used to `continue` in silence, which was fine while the only
  // consequence was "do not buy this". It stopped being fine the moment the
  // same verdict can SELL a live position: the caller could not distinguish
  // "our token's switch went off" from "the scanner did not find it", and
  // those two must never produce the same action. Silence is not evidence,
  // and the absence of a name here is silence.
  const switchedOff: SwitchedOff[] = []
  // Held back by taste alone. Kept apart rather than mixed in, because the
  // allocator must exhaust what qualifies before it reaches for a fallback.
  const reserve: Candidate[] = []
  const rejected: Rejected[] = []

  for (const snapshot of universe) {
    const gates = evaluateGates(snapshot, policy.gates)
    const forgiven = gates.passed || policy.reserve === false ? null : forgivableFailures(gates)
    if (!gates.passed && forgiven === null) {
      rejected.push({
        snapshot,
        gates,
        opportunity: scoreOpportunity(snapshot, policy.opportunity, previous.get(tokenKey(snapshot)) ?? null, quality(snapshot)),
      })
      continue
    }
    // Quality is measured before scoring, because what the chain will take is
    // part of how good the opportunity is — not a detail settled afterwards.
    const marketQuality = quality(snapshot)
    const opportunity = scoreOpportunity(snapshot, policy.opportunity, previous.get(tokenKey(snapshot)) ?? null, marketQuality)
    if (opportunity.score < policy.minScore) continue
    // Not a candidate and not reserve. The reserve exists to put idle capital
    // into something SAFE that the gates merely did not prefer; a token that
    // fails a floor is one the operator said outright is not worth trading.
    // The momentum door, ahead of the component floors and beside them in the
    // same verdict: both answer *is the switch on*, and a reader should not
    // have to know which kind of reason turned it off to find out that it did.
    //
    // It never reaches the RESERVE either, and that is deliberate. The reserve
    // exists to put idle capital into something SAFE that the gates merely did
    // not prefer; a token that is not rising is not a matter of taste under
    // this strategy, it is the whole condition.
    const failed: (keyof OpportunityComponents | 'rising')[] = [
      ...(policy.requireRising === true && !risingAcrossWindows(snapshot.priceChangePct) ? ['rising' as const] : []),
      ...failedMinimums(opportunity.components, policy.minComponents),
    ]
    if (failed.length > 0) {
      switchedOff.push({ snapshot, opportunity, failed })
      continue
    }
    if (forgiven === null) candidates.push({ snapshot, opportunity, marketQuality })
    else reserve.push({ snapshot, opportunity, marketQuality, forgiven })
  }

  // The operator's order — cost efficiency, or size then score — BEFORE the cut.
  const byRank = candidateComparator(policy.order, policy.smallCapFdvUsd)
  candidates.sort(byRank)
  reserve.sort(byRank)

  // The fallback goes BEHIND every token that qualified, whatever the scores
  // say, and is cut with them rather than in addition to them — a wider
  // shortlist is a wider candle bill, and the slots the reserve fills are the
  // ones nothing else could. A token we hold is never counted: the slots are
  // the free ones.
  return { candidates: cutToFreeSlots([...candidates, ...reserve], policy.watchSlots, policy.held), rejected, switchedOff }
}

export const tokenKey = (snapshot: TokenSnapshot): string => `${snapshot.chain}:${snapshot.address}`
