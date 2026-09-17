import { evaluateSafetyGates, type GateFailure, type GatePolicy } from '../domain/scanner/gates.js'
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
  | { readonly ok: false; readonly reason: 'stale-bars'; readonly detail: string }

/**
 * Whether the CANDLE feed can actually see this pool trading, right now.
 *
 * Measured live, the same pool asked of both providers at the same moment:
 *
 * |        | GeckoTerminal | DexScreener |
 * |--------|---------------|-------------|
 * | DREGG  | 0 txns / 1h   | 35 txns / 1h |
 * | HEV    | 0 txns / 1h   | 96 txns / 1h |
 *
 * Not a lag: GeckoTerminal's own top pools were current to the minute in the
 * same run, and its 24h volume for these pools was HALF what DexScreener
 * reported — it is missing trades on them, not trailing behind.
 *
 * The engine was caught between the two. The gate admits on DexScreener's
 * activity; the death watch condemns on GeckoTerminal's silence; and the
 * strategy is bar-driven, so a pool with no bars cannot be traded at all — the
 * entry decided at a close waits forever for an open that never comes. Six
 * positions sat at "$0.00 dentro", ladders frozen, capital stuck.
 *
 * Whoever is right about the market, the engine's answer is the same: **do not
 * buy what you cannot watch.**
 *
 * The threshold is argued, not picked. `abandonmentFreezeHours` is 3, so
 * admitting a token whose newest bar is already two hours old is admitting one
 * that freezes within the hour. One hour matches `minHourlyTxns`'s own window
 * and leaves the freeze threshold clear room.
 */
export interface BarFreshness {
  /** Hours since the newest bar carrying volume, or null when nothing answered. */
  readonly barAgeHours: (snapshot: TokenSnapshot) => Promise<number | null>
  readonly maxBarAgeHours: number
}

export interface FreshLook {
  /** The token as it is RIGHT NOW: market, security and history, all re-fetched. */
  (address: string): Promise<TokenSnapshot | null>
}

export async function confirmEntry(
  address: string,
  look: FreshLook,
  policy: GatePolicy,
  bars?: BarFreshness,
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

  // The SAFETY half, and deliberately not the whole set.
  //
  // The reason to look again is "did this become dangerous" — an authority
  // back, an LP unlocked, a pool drained, a sell path closed. It is not "is
  // this still the most attractive entry": the scanner answered that against a
  // universe of nine hundred, minutes ago.
  //
  // Re-arguing the opportunity here refused entries for the ordinary motion the
  // ladder exists to harvest. On a DEX the price moves WHILE the order is
  // placed — somebody else's buy moves it, ours moves it too — so a token that
  // slipped past the freefall threshold since being chosen has not become
  // dangerous, it has become cheaper. Reported live: an alert log full of
  // "cambió antes de comprar" while eight positions traded and hundreds of
  // candidates waited outside.
  const verdict = evaluateSafetyGates(fresh, policy)
  if (!verdict.passed) return { ok: false, reason: 'gates', failures: verdict.failures }

  // AFTER the gates, never before: a token that already fails is not worth a
  // candle download, and this runs on every position about to be opened.
  if (bars) {
    let age: number | null
    try {
      age = await bars.barAgeHours(fresh)
    } catch (error) {
      return { ok: false, reason: 'stale-bars', detail: `sin velas: ${String(error).slice(0, 120)}` }
    }
    // No bars is not fresh bars. Fail closed, like every other reading here.
    if (age === null) {
      return { ok: false, reason: 'stale-bars', detail: 'el proveedor de velas no devolvió ninguna operación' }
    }
    if (age > bars.maxBarAgeHours) {
      return {
        ok: false,
        reason: 'stale-bars',
        detail: `última vela hace ${age.toFixed(1)}h — sin barras no se puede operar, por más que el mercado diga que hay actividad`,
      }
    }
  }

  return { ok: true, snapshot: fresh }
}
