import { evaluateGates, type GateFailure, type GatePolicy } from '../domain/scanner/gates.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

/**
 * The last look before the money moves.
 *
 * A candidate is chosen from a scan that is deliberately not fresh. The
 * security cache holds an examination for `securityTtlMs`, and a WATCH pass
 * allocates from `recall` — the last scan re-ranked offline — which accepts a
 * shelf up to twice the scan interval old. Both are right for RANKING, where
 * the alternative is spending the budget on the same twenty tokens forever.
 *
 * They are wrong at the moment capital is committed. Between the scan and the
 * buy, a mint authority can come back, an LP can be unlocked, a pool can be
 * drained and the trading can stop — and the engine would open the position on
 * a verdict that predates all of it.
 *
 * Only the sell path was re-asked. That is the answer that ages worst, but it
 * is one of eight: a token that became mintable an hour ago still quotes a
 * perfectly good sell, and would have been bought.
 *
 * So the whole gate set runs again, on a freshly fetched snapshot, for the
 * handful about to be opened. It costs one market call, one security call and
 * one quote per position — seconds, for the only check taken while the decision
 * can still be changed.
 *
 * **It fails closed, and the asymmetry is the point.** An entry refused on an
 * unreadable provider is an opportunity missed; an entry taken on an unreadable
 * provider is money placed into something nobody could see. That is the
 * opposite of the death exit, where fail-closed would liquidate a healthy
 * position — the same word, the cheap direction each time.
 */

export type EntryConfirmation =
  | { readonly ok: true; readonly snapshot: TokenSnapshot }
  | { readonly ok: false; readonly reason: 'gates'; readonly failures: readonly GateFailure[] }
  | { readonly ok: false; readonly reason: 'unreadable'; readonly detail: string }

export interface FreshLook {
  /** The token as it is RIGHT NOW: market, security and history, all re-fetched. */
  (address: string): Promise<TokenSnapshot | null>
}

export async function confirmEntry(
  address: string,
  look: FreshLook,
  policy: GatePolicy,
): Promise<EntryConfirmation> {
  let fresh: TokenSnapshot | null
  try {
    fresh = await look(address)
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: String(error).slice(0, 200) }
  }

  // Not found is not "fine". A token the provider cannot price a minute before
  // we buy it is one we cannot size a ladder against either.
  if (!fresh) return { ok: false, reason: 'unreadable', detail: 'no market data' }

  // The FULL set, not the market half. The whole reason for looking again is
  // the security answers, which are the ones the cache was holding.
  const verdict = evaluateGates(fresh, policy)
  return verdict.passed ? { ok: true, snapshot: fresh } : { ok: false, reason: 'gates', failures: verdict.failures }
}
