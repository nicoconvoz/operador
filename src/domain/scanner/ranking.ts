import { type MarketQuality } from '../market/market-quality.js'
import { evaluateGates, forgivableFailures, type GateFailure, type GatePolicy, type GateResult } from './gates.js'
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
  /** Which floors it failed, so the evidence travels with the decision. */
  readonly failed: readonly (keyof OpportunityComponents)[]
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
   * Floors a token must clear on INDIVIDUAL components, whatever its total says.
   *
   * The score is a weighted average, so being ruinous at one thing can be
   * averaged away by being good at the rest. These cannot: a token below any
   * floor is not a candidate and not reserve either — the reserve forgives a
   * preference about the POOL, never a verdict about the opportunity.
   */
  readonly minComponents?: ComponentFloors
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
    const forgiven = gates.passed ? null : forgivableFailures(gates)
    if (!gates.passed && forgiven === null) {
      rejected.push({ snapshot, gates })
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
    const failed = failedMinimums(opportunity.components, policy.minComponents)
    if (failed.length > 0) {
      switchedOff.push({ snapshot, opportunity, failed })
      continue
    }
    if (forgiven === null) candidates.push({ snapshot, opportunity, marketQuality })
    else reserve.push({ snapshot, opportunity, marketQuality, forgiven })
  }

  // SIZE first, then score. An unknown FDV counts as small: it is the normal
  // case on a young pool, and sorting it last would quietly demote exactly the
  // tokens this system exists to trade.
  const big = (s: TokenSnapshot) =>
    policy.smallCapFdvUsd !== undefined && s.fdvUsd !== null && s.fdvUsd > policy.smallCapFdvUsd ? 1 : 0
  const byRank = (a: Candidate, b: Candidate) =>
    big(a.snapshot) - big(b.snapshot) ||
    b.opportunity.score - a.opportunity.score ||
    a.snapshot.address.localeCompare(b.snapshot.address)
  candidates.sort(byRank)
  reserve.sort(byRank)

  // The fallback goes BEHIND every token that qualified, whatever the scores
  // say, and is cut with them rather than in addition to them — a wider
  // shortlist is a wider candle bill, and the slots the reserve fills are the
  // ones nothing else could.
  return { candidates: [...candidates, ...reserve].slice(0, policy.watchSlots), rejected, switchedOff }
}

export const tokenKey = (snapshot: TokenSnapshot): string => `${snapshot.chain}:${snapshot.address}`
