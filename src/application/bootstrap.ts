import { type Chain } from '../domain/scanner/snapshot.js'

/**
 * The very first run — nothing in the database at all — is not a cycle.
 *
 * `maxSecurityChecks` (20 per chain) exists for a good reason: each examined
 * token costs a throttled GoPlus call, a sell quote and a candle download, and
 * a RECURRING cycle has to finish well inside a 15-minute bar. What it cannot
 * reach is reported as unchecked, the cache remembers what was looked at, and
 * the next cycle's budget reaches further down the list. Over hours it covers
 * the universe.
 *
 * On the first run there are no hours. There is one pass, against an empty
 * Neon, with a deep sweep discovering up to seven hundred pools per chain — and
 * a budget of twenty would examine **under three percent of them**. Every other
 * token comes back `securityChecked: false`, and the safety gates FAIL CLOSED,
 * so the entire remainder is ineligible. The engine would then open its first
 * positions from that 2.8% sample, and a slot handed out is a commitment: it
 * does not come back without selling.
 *
 * The rest of the universe would arrive at twenty per chain per scan. At a
 * two-hour scan interval that is **roughly three days** before everything has
 * been looked at once — by which time the book was filled on day one, from the
 * first twenty tokens that happened to clear the free gates.
 *
 * So on that one pass the budget is LIFTED. Every argument for it is absent:
 *
 *  - No position is open, so no money is unwatched while it runs.
 *  - No bar has to be kept up with, because there is nothing to advance.
 *  - Nothing downstream is waiting — the allocation it feeds is the first one,
 *    and it is better late than made on a sample.
 *
 * **It is self-terminating**, which is what makes it safe to leave in. One
 * recorded examination and this is no longer the beginning of anything; there
 * is no flag to forget to clear and no way for neglect to turn it into a
 * permanently unbounded scan.
 *
 * Per chain, deliberately. Solana having been swept says nothing about BSC:
 * they are discovered, gated and cached separately, so a chain added months
 * later gets the same cold sweep the first one got instead of inheriting its
 * neighbour's warmth.
 */

export interface ExaminationCountPort {
  /** How many tokens of this chain have ever been examined. */
  examinedCount(chain: Chain): Promise<number>
}

export async function securityBudgetFor(
  store: ExaminationCountPort,
  chain: Chain,
  budget: number,
): Promise<number | undefined> {
  // `undefined` is not "no opinion" here — it is `ScanConfig`'s documented way
  // of saying "every token that cleared the free gates", which is exactly the
  // request. The free gates still run first and still decide most of it: this
  // lifts the cap on the paid stage, it does not scan the universe blind.
  return (await store.examinedCount(chain)) === 0 ? undefined : budget
}
