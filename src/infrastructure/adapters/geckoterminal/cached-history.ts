import { type Chain } from '../../../domain/scanner/snapshot.js'

/**
 * Remembers how much history a pool has, so we stop asking.
 *
 * Counting the bars of a pool costs a full candle download — a thousand rows,
 * fetched to learn one integer — and it is the single heaviest user of
 * GeckoTerminal in a cycle. Measured on the first real cloud run: 45 rate-limit
 * rejections and 276 seconds of backoff, 80% of the entire scan, against zero
 * from every other provider. GeckoTerminal limits by IP, and CI runners share
 * their address with thousands of unrelated jobs, so the quota is not ours to
 * budget — the only winning move is to ask less.
 *
 * What makes caching correct here rather than merely convenient: **a pool
 * cannot lose candles.** Once it has enough history for the strategy, it has
 * enough forever, and re-measuring can only ever return the same verdict.
 *
 * The short answer is the one that changes, so that is the only one that
 * expires.
 */

export interface HistoryBarsCache {
  historyBarsFor(chain: Chain, poolAddress: string): Promise<{ bars: number; measuredAt: number } | null>
  recordHistoryBars(chain: Chain, poolAddress: string, bars: number, measuredAt: number): Promise<void>
}

export interface HistoryBarsSource {
  historyBars(chain: Chain, poolAddress: string): Promise<number | null>
}

export interface CachedHistoryOptions {
  readonly now: () => number
  /** The gate's threshold. At or above it, the answer is final. */
  readonly minBars: number
  /** How long a SHORT count stays believable. A young pool grows. */
  readonly shortLivedMs?: number
}

const DEFAULT_SHORT_LIVED_MS = 6 * 60 * 60 * 1000

export class CachedHistory {
  private readonly shortLivedMs: number

  constructor(
    private readonly source: HistoryBarsSource,
    private readonly cache: HistoryBarsCache,
    private readonly options: CachedHistoryOptions,
  ) {
    this.shortLivedMs = options.shortLivedMs ?? DEFAULT_SHORT_LIVED_MS
  }

  async historyBars(chain: Chain, poolAddress: string): Promise<number | null> {
    const known = await this.cache.historyBarsFor(chain, poolAddress)
    if (known !== null && !this.stale(known)) return known.bars

    const measured = await this.source.historyBars(chain, poolAddress)
    // A failed call is not a measurement. Writing null here would turn one
    // rate-limited request into a permanent "this pool has no history".
    if (measured === null) return known?.bars ?? null

    await this.cache.recordHistoryBars(chain, poolAddress, measured, this.options.now())
    return measured
  }

  private stale(known: { bars: number; measuredAt: number }): boolean {
    if (known.bars >= this.options.minBars) return false // Settled forever.
    return this.options.now() - known.measuredAt >= this.shortLivedMs
  }
}
