import { HttpError, NO_THROTTLE, type HttpGet, type Throttle } from '../../http.js'
import { type Chain } from '../../../domain/scanner/snapshot.js'
import { type Candles } from '../../../application/replay.js'
import { type MarketSnapshot } from '../dexscreener/dexscreener.js'

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
export const ONE_MINUTE: BarSize = { timeframe: 'minute', aggregate: 1 }

/** How many minutes one bar covers. Lets a caller turn a bar count into an age. */
export const barMinutes = (size: BarSize): number =>
  size.timeframe === 'hour' ? 60 * (size.aggregate ?? 1) : size.timeframe === 'day' ? 1440 * (size.aggregate ?? 1) : (size.aggregate ?? 1)

export const barSizeMs = (size: BarSize): number =>
  ({ minute: 60_000, hour: 3_600_000, day: 86_400_000 })[size.timeframe] * (size.aggregate ?? 1)

interface OhlcvResponse {
  readonly data?: { readonly attributes?: { readonly ohlcv_list?: readonly (readonly number[])[] } }
}

/** One pool as `pools/multi` returns it: every market field, already ours. */
interface PoolRow {
  readonly attributes?: {
    readonly address?: string
    readonly base_token_price_usd?: string | null
    readonly reserve_in_usd?: string | null
    readonly fdv_usd?: string | null
    readonly pool_created_at?: string | null
    readonly volume_usd?: { readonly h1?: string; readonly h6?: string; readonly h24?: string }
    readonly price_change_percentage?: { readonly h1?: string; readonly h6?: string; readonly h24?: string }
    readonly transactions?: {
      readonly h1?: { readonly buys?: number; readonly sells?: number }
      readonly h24?: { readonly buys?: number; readonly sells?: number }
    }
  }
  readonly relationships?: { readonly base_token?: { readonly data?: { readonly id?: string } } }
}

interface PoolsResponse {
  readonly data?: readonly {
    readonly attributes?: { readonly address?: string; readonly name?: string }
    readonly relationships?: { readonly base_token?: { readonly data?: { readonly id?: string } } }
  }[]
}

export interface GeckoTerminalOptions {
  /**
   * The most time one request may spend WAITING on 429s before it gives up.
   *
   * A ceiling, not a quota: a request that gets its answer in three seconds
   * costs three seconds. Defaults to sixty.
   */
  readonly waitBudgetMs?: number
  /** First backoff; each retry doubles it until the budget is spent. */
  readonly backoffMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Injected so "has this bar closed yet?" is testable without the wall clock. */
  readonly now?: () => number
}

export class GeckoTerminal {
  private readonly waitBudgetMs: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(
    private readonly http: HttpGet,
    private readonly throttle: Throttle & { pushedBack?(): void; wentThrough?(): void } = NO_THROTTLE,
    private readonly base: string = GECKOTERMINAL_BASE,
    options: GeckoTerminalOptions = {},
  ) {
    this.waitBudgetMs = options.waitBudgetMs ?? 60_000
    this.backoffMs = options.backoffMs ?? 2_000
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => Date.now())
  }

  /** Time lost to 429s, and how many. See the note on GoPlus.rateLimit. */
  readonly rateLimit = { hits: 0, waitedMs: 0 }

  /**
   * Candles for a pool, OLDEST FIRST, timestamps in milliseconds.
   *
   * **The bar still being BUILT is not returned.** GeckoTerminal's newest row
   * is the current interval, and its close is simply wherever the price sits
   * at the instant of the request — ask again a minute later and the same bar
   * answers differently. It is a quote wearing a candle's clothes.
   *
   * Handing it to the engine breaks the project's seventh constraint at its
   * source, and it did: `tickPosition` takes the last row as the newest CLOSED
   * bar, decides on it, and stamps `lastBarTime`, so the bar is never looked
   * at again once it really closes. Every decision the engine has ever made
   * was taken on partial data, and no offline test could see it — the parity
   * harness replays a fixed series, where a forming bar does not exist.
   *
   * What it cost, measured: BinanceTown's entry was sized against 0.0013161
   * while its 15m bar was mid-pump; the bar ENDED at 0.00100069 and the fill
   * (the next bar's open) landed there. A $15 order bought $11.44 — 23.7%
   * less token than the ladder asked for, at a price no close ever showed.
   * Across the whole open book the same gap ran from -5.1% to +2.8%, which is
   * exactly the shape of "how far does a 15m micro-cap move between mid-bar
   * and the bell".
   *
   * It costs one bar of latency and that is the correct price: a decision on a
   * bar that has closed is late by construction, and the alternative is not
   * being early, it is being wrong.
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

    // A bar opening at `t` is closed once `now` has passed t + its own width.
    // Measured against the size that was ASKED for: the same timestamp is a
    // settled 15-minute bar and an hour-long one that has barely started.
    const closedBy = this.now() - barSizeMs(size)

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
      if (seconds * 1000 > closedBy) continue
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
  /**
   * Market data for pools DexScreener cannot see.
   *
   * Measured on one sweep: of the addresses this adapter discovers, DexScreener
   * prices only 65% — 46 of 132 are simply not in its index, too new or too
   * small. Jupiter's addresses price at 97%, so the loss is specific to the
   * pools, and it was most of the difference between a book of ninety and a
   * book of eleven.
   *
   * The data was in our hands the whole time. Every pool response already
   * carries `base_token_price_usd`, `reserve_in_usd`, `volume_usd`, the price
   * changes and the transaction counts by window — the complete snapshot — and
   * the scanner discarded it and then asked a provider that had never heard of
   * the token.
   *
   * It cannot come from the discovery CACHE, which stands for six hours and
   * whose market half would be six hours stale. `pools/multi` takes thirty
   * pool addresses per call, so the ones DexScreener missed cost two requests
   * rather than forty-six.
   *
   * NEVER throws. This is a fallback: a bad minute costs the tokens it would
   * have recovered, never the cycle.
   */
  async poolMarkets(chain: Chain, poolAddresses: readonly string[]): Promise<MarketSnapshot[]> {
    const out: MarketSnapshot[] = []
    for (let i = 0; i < poolAddresses.length; i += 30) {
      const batch = poolAddresses.slice(i, i + 30)
      try {
        const body = (await this.getWithBackoff(
          `${this.base}/networks/${NETWORK[chain]}/pools/multi/${batch.join(',')}`,
        )) as { data?: PoolRow[] }
        for (const row of body.data ?? []) {
          const market = this.toPoolMarket(chain, row)
          if (market) out.push(market)
        }
      } catch {
        // A refused batch is tokens not recovered, not a cycle lost.
      }
    }
    return out
  }

  /** One pool row into the shape every other source produces. */
  private toPoolMarket(chain: Chain, row: PoolRow): MarketSnapshot | null {
    const a = row.attributes
    const token = row.relationships?.base_token?.data?.id?.replace(`${NETWORK[chain]}_`, '')
    const price = Number(a?.base_token_price_usd)
    const reserve = Number(a?.reserve_in_usd)
    // The same rule DexScreener's mapping follows: a pool nobody can price is
    // an unanswered question, not a cheap token, and the gates fail closed on
    // those for a reason.
    if (!token || !a?.address) return null
    if (a.base_token_price_usd === null || a.base_token_price_usd === undefined || !Number.isFinite(price)) return null
    if (a.reserve_in_usd === null || a.reserve_in_usd === undefined || !Number.isFinite(reserve)) return null

    const num = (value: string | number | null | undefined): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    const pct = (value: string | number | null | undefined): number | null => {
      if (value === null || value === undefined) return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const fdv = Number(a.fdv_usd)

    return {
      chain,
      address: token,
      symbol: token,
      pairAddress: a.address,
      observedAt: this.now(),
      priceUsd: price,
      liquidityUsd: reserve,
      fdvUsd: Number.isFinite(fdv) && a.fdv_usd !== null && a.fdv_usd !== undefined ? fdv : null,
      volumeUsd: { h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) },
      priceChangePct: {
        h1: pct(a.price_change_percentage?.h1),
        h6: pct(a.price_change_percentage?.h6),
        h24: pct(a.price_change_percentage?.h24),
      },
      txns: {
        h1: { buys: a.transactions?.h1?.buys ?? 0, sells: a.transactions?.h1?.sells ?? 0 },
        h24: { buys: a.transactions?.h24?.buys ?? 0, sells: a.transactions?.h24?.sells ?? 0 },
      },
      pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    }
  }

  async discoverPools(chain: Chain, pages = 5): Promise<{ tokenAddress: string; poolAddress: string }[]> {
    // 'new_pools' was missing while this function's own comment claimed it,
    // and it is the only source in the whole universe that is not ranked by
    // popularity NOW. Without it "newest" was a word in a doc string.
    //
    // Expect most of what it returns to be REJECTED, and that is fine rather
    // than wasteful: the history gate wants 250 bars, which is 2.6 days at 15m,
    // so a pool born this morning cannot pass. What it catches is the token
    // that is old but whose POOL is new — a migration, a redeploy, a second
    // venue — which every popularity list misses until it trends, and by then
    // the move is over.
    // FIVE lists, and the last two are the same endpoint asked a different
    // question. `pools` sorted by volume and by transaction count enumerates
    // by WHO IS BEING TRADED rather than by who is popular, which is a
    // different set — measured, 125 unique from the three popularity lists and
    // 204 from all five, a 63% lift for two more list sweeps.
    //
    // The tx-count ordering adds the most (47 of the 79 new), which is the
    // shape of the finding: trending and volume both concentrate on the same
    // large pools, while "most traded" reaches pools that are busy without
    // being big.
    //
    // Ten pages is the free tier's hard ceiling and it is not negotiable —
    // page eleven answers 401 on every list. More BREADTH is the only lever
    // this provider still has.
    const lists = [
      { path: 'trending_pools', sort: null },
      { path: 'pools', sort: null },
      { path: 'new_pools', sort: null },
      { path: 'pools', sort: 'h24_volume_usd_desc' },
      { path: 'pools', sort: 'h24_tx_count_desc' },
    ]
    const found = new Map<string, string>()

    for (const list of lists) {
      for (let page = 1; page <= pages; page++) {
        let body: PoolsResponse
        try {
          // NO budget here, and it is the sell probe's own distinction rather
          // than an opinion about importance: a failure that would be read as a
          // VERDICT deserves patience, one that says nothing and has a fallback
          // does not.
          //
          // A refused sell quote leaves `honeypot` unknown and throws a good
          // token out as unsellable — worth waiting for. A refused pool page
          // costs a few names on a list that `CachedDiscovery` already backs
          // with the previous one, because an old universe beats no universe.
          // There is nothing a wait could buy.
          //
          // It cost nine minutes of a log printing nothing but `[boot]`: thirty
          // pages a chain, each spending the full sixty-second budget on an
          // answer that did not matter, before the first progress line exists.
          body = (await this.getWithBackoff(
            `${this.base}/networks/${NETWORK[chain]}/${list.path}?page=${page}${list.sort ? `&sort=${list.sort}` : ''}`,
            0,
          )) as PoolsResponse
        } catch {
          // The PAGE, not the list. A 429 on page three says nothing about page
          // four, and breaking out threw away the rest of a list because one
          // request arrived at a bad moment.
          continue
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
   * The gate asks a THRESHOLD — "at least `enough`?" — not a depth, so the
   * request asks for exactly that many. It used to ask for a thousand rows and
   * return `.time.length`, which is four times the payload for a boolean, once
   * per examined token, against the provider that rate-limits hardest.
   *
   * A saturated count is therefore "enough or more", and that is all any caller
   * can use. A SHORT count is still exact, which is what `CachedHistory` needs:
   * it expires a short count after six hours because a young pool grows, and
   * keeps a settled one forever because a pool cannot lose candles.
   *
   * The default stays 1000 so nothing that did not ask changes behaviour.
   */

  /**
   * GET, retrying a 429 until the data arrives or the TIME budget is spent.
   *
   * The operator's rule: do not put a fixed number on it. Wait until it answers
   * and stop the instant it does — sometimes three seconds, sometimes forty —
   * and give up only after a maximum of sixty with nothing.
   *
   * A retry COUNT prices the wrong thing. Three tries is cheap against a
   * provider that answers and ruinous against one that does not, and the number
   * that actually matters — how long a scan takes — appears nowhere in it. A
   * deadline states it outright, and the average of the real waits then becomes
   * a measurement of the provider rather than an artefact of the cap.
   *
   * Two properties the counting version did not have:
   *
   *  - **It stops the moment it HAS the data.** The budget is a ceiling, never
   *    a quota to spend.
   *  - **It uses the whole budget when it must.** A doubling backoff that
   *    refuses to start a wait it cannot finish leaves half of it unspent — and
   *    the unspent half is exactly where a slow provider would have answered.
   *    The last wait is trimmed to what remains instead.
   *
   * The doubling itself stays. It is the polite shape for a rate limit: ask
   * again soon in case it was a blip, and back off hard if it was not.
   */
  private async getWithBackoff(url: string, budgetMs = this.waitBudgetMs): Promise<unknown> {
    let waited = 0
    for (let attempt = 0; ; attempt++) {
      await this.throttle.wait()
      const response = await this.http(url)
      if (response.status === 200) {
        // The provider answered: it has room. Told so the pace can relax again,
        // or one bad minute costs the rest of the hour.
        this.throttle.wentThrough?.()
        return response.json()
      }
      if (response.status === 429) this.throttle.pushedBack?.()

      const remaining = budgetMs - waited
      if (response.status === 429 && remaining > 0) {
        const wait = Math.min(this.backoffMs * 2 ** attempt, remaining)
        waited += wait
        this.rateLimit.hits += 1
        this.rateLimit.waitedMs += wait
        await this.sleep(wait)
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
