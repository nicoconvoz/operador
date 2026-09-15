import { rankUniverse, tokenKey, type Candidate, type RankingPolicy } from '../domain/scanner/ranking.js'
import { estimatePriceImpactPct } from '../domain/market/market-quality.js'
import { type StatePort } from '../domain/persistence/store.js'

/**
 * The last scan, re-ranked from the shelf. No network at all.
 *
 * Opening a position was fused to RUNNING a scan, so a free slot had to wait
 * out half an hour of throttled discovery before anything could be put in it —
 * even with candidates already examined, already stored, already good.
 *
 * The fusion was never necessary, and the reason is that the expensive half of
 * a scan is FETCHING, not deciding. Gates, scoring and ranking are pure domain
 * functions: given the snapshots the last scan wrote down, they reproduce its
 * verdict offline, for free, in milliseconds.
 *
 * Two things keep it honest:
 *
 *  - **Measured impact, never reported TVL.** The security cache holds the
 *    slippage that was actually quoted for each token, and that is what sizes
 *    the ladder. The model is a fallback for tokens nothing ever quoted, which
 *    is exactly what the live scan does with the same value.
 *  - **Staleness is refused, not ignored.** Past `maxAgeMs` the shelf is not
 *    evidence any more and this returns nothing rather than something old.
 *
 * The caller still re-confirms the sell path before capital moves. CLAUDE.md
 * already states the premise this leans on: the scanner's verdict can be hours
 * old by design, and the sell path is the one answer that must be current at
 * the moment capital moves.
 */

export interface RecallOptions {
  readonly now: () => number
  readonly ranking: RankingPolicy
  /** Assumed venue fee, as the live scan assumes it. */
  readonly spreadPct: number
  /** Order size the impact was measured at. */
  readonly referenceUsd: number
  /** Older than this and the shelf stops counting as evidence. */
  readonly maxAgeMs: number
}

export interface RecalledScan {
  readonly candidates: readonly Candidate[]
  /** The OLDEST chain's scan time — a universe is as fresh as its stalest half. */
  readonly scannedAt: number
}

export async function recallCandidates(store: StatePort, options: RecallOptions): Promise<RecalledScan | null> {
  const scans = await store.latestScansByChain()
  if (scans.length === 0) return null

  const scannedAt = Math.min(...scans.map((scan) => scan.scannedAt))
  if (options.now() - scannedAt > options.maxAgeMs) return null

  const snapshots = scans.flatMap((scan) => scan.snapshots)
  if (snapshots.length === 0) return null

  // The impact each token actually quoted, when something quoted it. Read once
  // rather than per lookup, because `rankUniverse` is synchronous and the cache
  // is not.
  const measured = new Map<string, number | null>()
  for (const snapshot of snapshots) {
    const known = await store.cachedSecurity(snapshot.chain, snapshot.address)
    measured.set(tokenKey(snapshot), known?.slippagePct ?? null)
  }

  const ranked = rankUniverse(
    snapshots,
    // No previous scan to compare against: volume expansion and liquidity
    // growth score on their neutral values. Understating a token's momentum is
    // the safe direction to be wrong in when spending from a shelf.
    new Map(),
    (snapshot) => ({
      liquidityUsd: snapshot.liquidityUsd,
      spreadPct: options.spreadPct,
      // Measured first, modelled only when nothing ever quoted it — the same
      // order the live scan uses, because sizing a ladder against reported
      // liquidity is the one thing the executor refuses to do.
      slippagePct:
        measured.get(tokenKey(snapshot)) ??
        (snapshot.liquidityUsd > 0 ? estimatePriceImpactPct(options.referenceUsd, snapshot.liquidityUsd) : 100),
      referenceUsd: options.referenceUsd,
      observedAt: snapshot.observedAt,
    }),
    options.ranking,
  )

  return { candidates: ranked.candidates, scannedAt }
}
