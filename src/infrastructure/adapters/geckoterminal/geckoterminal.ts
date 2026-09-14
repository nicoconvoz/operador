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

/**
 * A bar size, as GeckoTerminal expresses it: a base timeframe plus how many of
 * them to aggregate. 15-minute bars are `minute` aggregated by 15.
 *
 * Confirmed live: one page of 1000 bars reaches ~10.4 days at 15m, against ~41
 * days at 1H. Shorter bars buy resolution and spend history, and the strategy
 * needs 250 bars before its indicators exist at all.
 */
export interface BarSize {
  readonly timeframe: Timeframe
  readonly aggregate?: number
}

export const ONE_HOUR: BarSize = { timeframe: 'hour' }
export const FIFTEEN_MINUTES: BarSize = { timeframe: 'minute', aggregate: 15 }

export const barSizeMs = (size: BarSize): number =>
  ({ minute: 60_000, hour: 3_600_000, day: 86_400_000 })[size.timeframe] * (size.aggregate ?? 1)

interface OhlcvResponse {
  readonly data?: { readonly attributes?: { readonly ohlcv_list?: readonly (readonly number[])[] } }
}

interface PoolsResponse {
  readonly data?: readonly {
    readonly attributes?: { readonly address?: string; readonly name?: string }
    readonly relationships?: { readonly base_token?: { readonly data?: { readonly id?: string } } }
  }[]
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
  async candles(chain: Chain, poolAddress: string, size: BarSize = ONE_HOUR, limit = 1000, beforeSeconds?: number): Promise<Candles> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (size.aggregate !== undefined) query.set('aggregate', String(size.aggregate))
    if (beforeSeconds !== undefined) query.set('before_timestamp', String(beforeSeconds))
    const url = `${this.base}/networks/${NETWORK[chain]}/pools/${poolAddress}/ohlcv/${size.timeframe}?${query}`

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
   * A universe for ANY chain: the pools GeckoTerminal ranks as trending, top
   * by liquidity, and newest.
   *
   * This is what Jupiter's token lists are for Solana, except it works on BSC
   * too — where the alternative was DexScreener's boosts, which are PAID
   * PROMOTIONS and returned nine tokens. A universe built from who paid to be
   * seen is not a universe; it is an advertising slot.
   *
   * Returns base token addresses paired with the pool they were found in, so
   * the caller does not have to look the pair up again.
   */
  async discoverPools(chain: Chain, pages = 5): Promise<{ tokenAddress: string; poolAddress: string }[]> {
    const lists = ['trending_pools', 'pools']
    const found = new Map<string, string>()

    for (const list of lists) {
      for (let page = 1; page <= pages; page++) {
        let body: PoolsResponse
        try {
          body = (await this.getWithBackoff(`${this.base}/networks/${NETWORK[chain]}/${list}?page=${page}`)) as PoolsResponse
        } catch {
          break
        }
        const items = body.data ?? []
        if (items.length === 0) break
        for (const item of items) {
          // "base_token" relationship id looks like "bsc_0xabc…"; the address
          // is whatever follows the network prefix.
          const raw = item.relationships?.base_token?.data?.id
          const address = raw?.includes('_') ? raw.slice(raw.indexOf('_') + 1) : raw
          const pool = item.attributes?.address
          if (address && pool && !found.has(address)) found.set(address, pool)
        }
      }
    }

    return [...found.entries()].map(([tokenAddress, poolAddress]) => ({ tokenAddress, poolAddress }))
  }

  /**
   * How many 1H candles this pool has, capped at one page (1000).
   *
   * The scanner only needs to know whether there is ENOUGH — a few hundred
   * bars — not the exact depth of history, so one request answers it and the
   * result doubles as the candles the executor will run on.
   */
  async historyBars(chain: Chain, poolAddress: string, size: BarSize = ONE_HOUR): Promise<number | null> {
    try {
      return (await this.candles(chain, poolAddress, size, 1000)).time.length
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
  async history(chain: Chain, poolAddress: string, wanted: number, size: BarSize = ONE_HOUR): Promise<Candles> {
    let all = await this.candles(chain, poolAddress, size, 1000)
    while (all.time.length < wanted && all.time.length > 0) {
      const oldestSeconds = Math.floor(all.time[0]! / 1000)
      const older = await this.candles(chain, poolAddress, size, 1000, oldestSeconds)
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
