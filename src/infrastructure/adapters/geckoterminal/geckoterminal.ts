import { HttpError, NO_THROTTLE, type HttpGet, type Throttle } from '../../http.js'
import { type Chain } from '../../../domain/scanner/snapshot.js'
import { type Candles } from '../../../application/replay.js'

/**
 * GeckoTerminal — OHLCV for a DEX pool. The candles the executor runs on.
 *
 * Public API, no key. Confirmed live (Sept 2026):
 *   GET /api/v2/networks/{network}/pools/{pool}/ohlcv/{timeframe}?limit=1000
 *   → data.attributes.ohlcv_list = [[unixSeconds, o, h, l, c, volumeUsd], …]
 *
 * Two shapes that will bite anyone who assumes otherwise:
 *  - rows come NEWEST FIRST, so they are reversed here
 *  - timestamps are in SECONDS, while the rest of this codebase uses ms
 *
 * Up to 1000 candles per call (~41 days of 1H); `before_timestamp` pages
 * further back. Docs put the free limit near 30 requests/minute, so callers
 * share a Throttle.
 */

export const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2'

const NETWORK: Record<Chain, string> = { solana: 'solana', bsc: 'bsc' }

export type Timeframe = 'minute' | 'hour' | 'day'

interface OhlcvResponse {
  readonly data?: { readonly attributes?: { readonly ohlcv_list?: readonly (readonly number[])[] } }
}

export interface GeckoTerminalOptions {
  /** Retries on HTTP 429, with doubling backoff from `backoffMs`. */
  readonly maxRetries?: number
  readonly backoffMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export class GeckoTerminal {
  private readonly maxRetries: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly http: HttpGet,
    private readonly throttle: Throttle = NO_THROTTLE,
    private readonly base: string = GECKOTERMINAL_BASE,
    options: GeckoTerminalOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3
    this.backoffMs = options.backoffMs ?? 4_000
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Candles for a pool, OLDEST FIRST, timestamps in milliseconds.
   *
   * @param beforeSeconds page further back: returns candles before this time.
   */
  async candles(chain: Chain, poolAddress: string, timeframe: Timeframe = 'hour', limit = 1000, beforeSeconds?: number): Promise<Candles> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (beforeSeconds !== undefined) query.set('before_timestamp', String(beforeSeconds))
    const url = `${this.base}/networks/${NETWORK[chain]}/pools/${poolAddress}/ohlcv/${timeframe}?${query}`

    const body = (await this.getWithBackoff(url)) as OhlcvResponse
    const rows = body.data?.attributes?.ohlcv_list ?? []

    const time: number[] = []
    const open: number[] = []
    const high: number[] = []
    const low: number[] = []
    const close: number[] = []
    const volume: number[] = []

    // Newest first from the API; the engine walks time forward.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.length < 6) continue
      const [seconds, o, h, l, c, v] = row as [number, number, number, number, number, number]
      // A candle with no price is not a candle; dropping it beats poisoning
      // every windowed indicator downstream.
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
      time.push(seconds * 1000)
      open.push(o)
      high.push(h)
      low.push(l)
      close.push(c)
      volume.push(v ?? 0)
    }

    return { time, open, high, low, close, volume }
  }

  /**
   * How many 1H candles this pool has, capped at one page (1000).
   *
   * The scanner only needs to know whether there is ENOUGH — a few hundred
   * bars — not the exact depth of history, so one request answers it and the
   * result doubles as the candles the executor will run on.
   */
  async historyBars(chain: Chain, poolAddress: string): Promise<number | null> {
    try {
      return (await this.candles(chain, poolAddress, 'hour', 1000)).time.length
    } catch {
      return null
    }
  }

  /** GET with a doubling backoff on 429 — the free tier limits around 30/min. */
  private async getWithBackoff(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle.wait()
      const response = await this.http(url)
      if (response.status === 200) return response.json()
      if (response.status === 429 && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs * 2 ** attempt)
        continue
      }
      throw new HttpError(url, response.status)
    }
  }

  /**
   * Candles going back at least `wanted` bars, paging as needed.
   * The strategy's EMA-200 needs history; one page is often not enough.
   */
  async history(chain: Chain, poolAddress: string, wanted: number, timeframe: Timeframe = 'hour'): Promise<Candles> {
    let all = await this.candles(chain, poolAddress, timeframe, 1000)
    while (all.time.length < wanted && all.time.length > 0) {
      const oldestSeconds = Math.floor(all.time[0]! / 1000)
      const older = await this.candles(chain, poolAddress, timeframe, 1000, oldestSeconds)
      if (older.time.length === 0) break
      all = {
        time: [...older.time, ...all.time],
        open: [...older.open, ...all.open],
        high: [...older.high, ...all.high],
        low: [...older.low, ...all.low],
        close: [...older.close, ...all.close],
        volume: [...older.volume, ...all.volume],
      }
    }
    return all
  }
}
