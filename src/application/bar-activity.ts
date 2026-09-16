import { type Chain } from '../domain/scanner/snapshot.js'

/**
 * Remembers which pools this engine cannot see trading, so it stops paying to
 * find out again.
 *
 * The check itself is a candle download against the provider that rate-limits
 * hardest, and it runs once per CANDIDATE — about thirty a scan, a minute of
 * wall time. Most of that minute is spent re-learning something that has not
 * changed: a pool whose newest bar was five hours old ten minutes ago is still
 * five hours old.
 *
 * **Only the STALE verdict is remembered, and the asymmetry is the safety.**
 * Caching "this pool is alive" would cache the one answer that can turn against
 * us between the scan and the moment capital moves. Caching "it is dead" risks
 * only a missed opportunity — and `confirmEntry` asks again, live, at the door,
 * so nothing is ever bought on a remembered verdict.
 *
 * A null answer is remembered too: no bars at all is the strongest form of
 * "this engine cannot watch it".
 */

export interface BarAgeSource {
  barAgeHours(chain: Chain, poolAddress: string): Promise<number | null>
}

export interface BarActivityCache {
  quietPoolSince(chain: Chain, poolAddress: string): Promise<number | null>
  recordQuietPool(chain: Chain, poolAddress: string, at: number): Promise<void>
}

export interface CachedBarActivityOptions {
  readonly now: () => number
  /** How long a "cannot see it trade" verdict stands before it is re-measured. */
  readonly staleVerdictMs?: number
}

/** One hour — the scan interval, so an hourly scan pays for a dead pool once. */
const DEFAULT_STALE_VERDICT_MS = 60 * 60 * 1000

export class CachedBarActivity implements BarAgeSource {
  private readonly staleVerdictMs: number

  constructor(
    private readonly source: BarAgeSource,
    private readonly cache: BarActivityCache,
    private readonly options: CachedBarActivityOptions,
  ) {
    this.staleVerdictMs = options.staleVerdictMs ?? DEFAULT_STALE_VERDICT_MS
  }

  async barAgeHours(chain: Chain, poolAddress: string): Promise<number | null> {
    const quietSince = await this.cache.quietPoolSince(chain, poolAddress)
    if (quietSince !== null && this.options.now() - quietSince < this.staleVerdictMs) {
      // Null, not the remembered age: reporting a number would let it drift
      // into looking like a live measurement, and the only thing this shelf
      // knows is "we could not see it trade".
      return null
    }

    const age = await this.source.barAgeHours(chain, poolAddress)
    // Anything that is not a fresh sighting is worth remembering. The caller's
    // own threshold decides what counts, and it is the same hour.
    if (age === null || age * 3_600_000 >= this.staleVerdictMs) {
      await this.cache.recordQuietPool(chain, poolAddress, this.options.now())
    }
    return age
  }
}
