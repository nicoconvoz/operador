import { type MarketQuality } from '../market/market-quality.js'
import { evaluateGates, type GatePolicy, type GateResult } from './gates.js'
import { scoreOpportunity, type Opportunity, type OpportunityPolicy } from './opportunity.js'
import { type TokenSnapshot } from './snapshot.js'

/**
 * A token the scanner is handing to the executor: it passed every gate, it
 * has a score, and it carries the MarketQuality the executor will re-validate.
 */
export interface Candidate {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
  readonly marketQuality: MarketQuality
}

/** A token the scanner looked at and refused, with the reasons. Kept for the audit log. */
export interface Rejected {
  readonly snapshot: TokenSnapshot
  readonly gates: GateResult
}

export interface ScanResult {
  readonly candidates: readonly Candidate[]
  readonly rejected: readonly Rejected[]
}

export interface RankingPolicy {
  readonly gates: GatePolicy
  readonly opportunity: OpportunityPolicy
  /** How many tokens the executor can watch at once. */
  readonly watchSlots: number
  /** Below this score a token is safe but not interesting. */
  readonly minScore: number
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
  const rejected: Rejected[] = []

  for (const snapshot of universe) {
    const gates = evaluateGates(snapshot, policy.gates)
    if (!gates.passed) {
      rejected.push({ snapshot, gates })
      continue
    }
    // Quality is measured before scoring, because what the chain will take is
    // part of how good the opportunity is — not a detail settled afterwards.
    const marketQuality = quality(snapshot)
    const opportunity = scoreOpportunity(snapshot, policy.opportunity, previous.get(tokenKey(snapshot)) ?? null, marketQuality)
    if (opportunity.score < policy.minScore) continue
    candidates.push({ snapshot, opportunity, marketQuality })
  }

  // SIZE first, then score. An unknown FDV counts as small: it is the normal
  // case on a young pool, and sorting it last would quietly demote exactly the
  // tokens this system exists to trade.
  const big = (s: TokenSnapshot) =>
    policy.smallCapFdvUsd !== undefined && s.fdvUsd !== null && s.fdvUsd > policy.smallCapFdvUsd ? 1 : 0
  candidates.sort(
    (a, b) =>
      big(a.snapshot) - big(b.snapshot) ||
      b.opportunity.score - a.opportunity.score ||
      a.snapshot.address.localeCompare(b.snapshot.address),
  )

  return { candidates: candidates.slice(0, policy.watchSlots), rejected }
}

export const tokenKey = (snapshot: TokenSnapshot): string => `${snapshot.chain}:${snapshot.address}`
