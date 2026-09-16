import { type Chain } from '../../../domain/scanner/snapshot.js'

/**
 * Remembers which pools exist, so we stop asking every hour.
 *
 * Discovery is ten throttled GeckoTerminal calls per chain, paged, and after
 * `CachedHistory` took the candle downloads out it is most of what remains of a
 * scan — about thirty minutes, during which the engine is not watching the
 * positions that already have money in them.
 *
 * Unlike a candle count, a discovery list genuinely CHANGES: new pools appear.
 * So this expires, and the window is not a guess about how fast the market
 * moves. It is an argument about what the gates would do with the answer:
 *
 *   **A pool younger than the window cannot clear the history gate anyway.**
 *   The strategy needs 250 bars, which is 2.6 days at 15m, so a token that
 *   first appeared six hours ago would be rejected on arrival. Caching for six
 *   hours cannot lose a single token the scanner would have accepted.
 *
 * Two failure rules, both learned the same way as `CachedHistory`:
 *
 *  - **A failure is never cached.** Writing an empty list would turn one rate
 *    limit into a chain that does not exist for six hours.
 *  - **A failure falls back to a stale shelf.** An old universe beats no
 *    universe: the alternative is a scan that sees nothing and a book that
 *    stops growing for as long as the provider is unhappy.
 */

export interface DiscoveredPool {
  readonly tokenAddress: string
  readonly poolAddress: string
}

export interface PoolDiscoverySource {
  discoverPools(chain: Chain, pages?: number): Promise<DiscoveredPool[]>
}

export interface PoolDiscoveryCache {
  discoveredPools(chain: Chain): Promise<{ pools: readonly DiscoveredPool[]; discoveredAt: number } | null>
  recordDiscoveredPools(chain: Chain, pools: readonly DiscoveredPool[], at: number): Promise<void>
}

export interface CachedDiscoveryOptions {
  readonly now: () => number
  /** How long a list stays believable. Below the history gate's own window. */
  readonly staleAfterMs?: number
}

/** Six hours — a quarter of the 2.6 days the history gate demands. */
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * Pages to request when there is NOTHING on the shelf.
 *
 * Ten is GeckoTerminal's own ceiling for a list endpoint, so this is not a
 * tuned number — it is "everything they will give us". The argument for
 * spending it exactly once is that a cold start is the only pass with no
 * alternative: a warm refresh is looking for what APPEARED, and what appeared
 * is on page one. The tail is old pools, and old pools do not move.
 */
export const DEEP_SWEEP_PAGES = 10

export class CachedDiscovery implements PoolDiscoverySource {
  private readonly staleAfterMs: number

  constructor(
    private readonly source: PoolDiscoverySource,
    private readonly cache: PoolDiscoveryCache,
    private readonly options: CachedDiscoveryOptions,
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  async discoverPools(chain: Chain, pages?: number): Promise<DiscoveredPool[]> {
    const remembered = await this.cache.discoveredPools(chain)
    if (remembered && this.options.now() - remembered.discoveredAt < this.staleAfterMs) {
      return [...remembered.pools]
    }

    try {
      // Nothing on the shelf at all is the one pass that gets the deep sweep.
      // `remembered` distinguishes it from a REFRESH, where an old list exists
      // and expired — and those are different questions. A refresh asks what
      // appeared since, which is page one. A cold start asks what EXISTS, and
      // answering that with five pages of trending is answering a different
      // question quietly.
      const found = await this.source.discoverPools(chain, remembered ? pages : (pages ?? DEEP_SWEEP_PAGES))
      // An empty answer is not evidence that a chain has no pools; it is far
      // more likely to be a provider having a bad minute. Remembering it would
      // blind the chain for the whole window.
      if (found.length > 0) await this.cache.recordDiscoveredPools(chain, found, this.options.now())
      return found
    } catch (error) {
      // An old universe beats no universe. Only when there is nothing at all to
      // fall back on does the caller get to see the failure.
      if (remembered) return [...remembered.pools]
      throw error
    }
  }
}
