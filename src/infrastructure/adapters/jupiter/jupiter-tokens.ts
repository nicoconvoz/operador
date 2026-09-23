import { NO_THROTTLE, type HttpGet, type Throttle } from '../../http.js'
import { type Chain, type SecurityReport } from '../../../domain/scanner/snapshot.js'
import { type DecimalsPort } from '../../../application/scan.js'
import { type MarketSnapshot } from '../dexscreener/dexscreener.js'
import { JUPITER_LITE_BASE } from './jupiter.js'

/**
 * Jupiter token API v2 — token metadata on Solana, one call per mint.
 *
 * Primary use: decimals, to size a reference sell in base units. It also
 * carries an audit block, holder count, organic score and liquidity, which
 * are kept on the record for cross-checking GoPlus later.
 *
 * Shape confirmed live (Sept 2026): GET /tokens/v2/search?query=<mint>
 * returns an array of token objects.
 */

export interface JupiterTokenInfo {
  readonly id: string
  readonly name: string
  readonly symbol: string
  readonly decimals: number
  readonly isVerified?: boolean
  readonly organicScore?: number
  readonly holderCount?: number
  readonly liquidity?: number
  readonly mcap?: number
  readonly tokenProgram?: string
  readonly usdPrice?: number
  readonly fdv?: number
  readonly firstPool?: { readonly id?: string; readonly createdAt?: string }
  readonly stats5m?: JupiterWindow
  readonly stats1h?: JupiterWindow
  readonly stats6h?: JupiterWindow
  readonly stats24h?: JupiterWindow
  readonly audit?: {
    readonly mintAuthorityDisabled?: boolean
    readonly freezeAuthorityDisabled?: boolean
    readonly topHoldersPercentage?: number
    readonly devBalancePercentage?: number
    readonly devMints?: number
  }
}

/** One of Jupiter's rolling windows, as its token API reports it. */
export interface JupiterWindow {
  readonly priceChange?: number
  readonly buyVolume?: number
  readonly sellVolume?: number
  readonly numBuys?: number
  /** Percent change of the pool's liquidity over the window. */
  readonly liquidityChange?: number
  readonly numSells?: number
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const change = (w: JupiterWindow | undefined): number | null =>
  typeof w?.priceChange === 'number' && Number.isFinite(w.priceChange) ? w.priceChange : null

/**
 * The market half of a snapshot, from Jupiter — the same shape DexScreener's
 * pair produced, so every gate and the death watch read it unchanged.
 *
 * It moved with the candles, which are Jupiter's and per MINT now. Two things
 * had to agree with them, measured on 183 tokens: the death watch compares
 * LIVE liquidity against the liquidity recorded at entry, and Jupiter (every
 * pool of the mint) and DexScreener (one pair) differ by 0.48x at p10 and 5.11x
 * at p90 — a ratio across the two would detect nothing; and the idle gate asks
 * whether anyone trades the token, which the candles now answer for the mint.
 * Prices agree: median 0.9999, 80% within 2%.
 *
 * A token with no price has no market — not a zero, which would read as a
 * collapse. An unreported window is UNKNOWN, never flat: zero is a measurement
 * and silence is not. Transaction counts cannot be null in the type, so a
 * missing one is zero, exactly as DexScreener's mapper always did — which makes
 * the idle gate refuse it, the conservative answer for an entry.
 *
 * `pairAddress` is the mint's first pool. Nothing trades by it any more on
 * Solana — candles and prices are per mint — and it is only the address the
 * GeckoTerminal fallback asks when Jupiter's chart cannot answer.
 */
export function jupiterMarket(info: JupiterTokenInfo, observedAt: number): MarketSnapshot | null {
  if (!(typeof info.usdPrice === 'number' && info.usdPrice > 0)) return null
  const volume = (w: JupiterWindow | undefined) => num(w?.buyVolume) + num(w?.sellVolume)
  const created = info.firstPool?.createdAt ? Date.parse(info.firstPool.createdAt) : NaN
  return {
    chain: 'solana',
    address: info.id,
    symbol: info.symbol,
    pairAddress: info.firstPool?.id ?? info.id,
    observedAt,
    priceUsd: info.usdPrice,
    liquidityUsd: num(info.liquidity),
    fdvUsd: typeof info.fdv === 'number' && Number.isFinite(info.fdv) ? info.fdv : null,
    volumeUsd: { h1: volume(info.stats1h), h6: volume(info.stats6h), h24: volume(info.stats24h) },
    priceChangePct: { m5: change(info.stats5m), h1: change(info.stats1h), h6: change(info.stats6h), h24: change(info.stats24h) },
    txns: {
      h1: { buys: num(info.stats1h?.numBuys), sells: num(info.stats1h?.numSells) },
      h24: { buys: num(info.stats24h?.numBuys), sells: num(info.stats24h?.numSells) },
    },
    // Measured by Jupiter over the hour. Unreported is null, never zero: a flat
    // hour and a silent one are different answers.
    liquidityChangePct: {
      h1: typeof info.stats1h?.liquidityChange === 'number' && Number.isFinite(info.stats1h.liquidityChange) ? info.stats1h.liquidityChange : null,
    },
    pairCreatedAt: Number.isFinite(created) ? created : null,
  }
}

export class JupiterTokens implements DecimalsPort {
  private readonly cache = new Map<string, { info: JupiterTokenInfo | null; at: number }>()
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(
    private readonly http: HttpGet,
    private readonly throttle: Throttle = NO_THROTTLE,
    private readonly base: string = JUPITER_LITE_BASE,
    options: { readonly now?: () => number; readonly maxAgeMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    // A minute. Holder concentration and the authorities are SAFETY gates, and
    // the door re-asks them before money moves; an answer that never expired
    // would let it approve on one from the previous pass.
    this.maxAgeMs = options.maxAgeMs ?? 60_000
  }

  private fresh(mint: string): { info: JupiterTokenInfo | null } | undefined {
    const hit = this.cache.get(mint)
    return hit && this.now() - hit.at <= this.maxAgeMs ? hit : undefined
  }

  private remember(mint: string, info: JupiterTokenInfo | null): void {
    this.cache.set(mint, { info, at: this.now() })
  }

  /**
   * Ask for many mints at once, a hundred per request.
   *
   * *Hagamos todo con Jupiter.* The search endpoint takes a comma-separated
   * list — a hundred mints answered in 0.49s, measured — and the scan was
   * asking one at a time. What `discover` already brought is skipped: the
   * universe's own lists arrive with everything this would fetch.
   */
  async prefetch(mints: readonly string[], options: { readonly refresh?: boolean } = {}): Promise<void> {
    const unique = [...new Set(mints)]
    const missing = options.refresh === true ? unique : unique.filter((m) => this.fresh(m) === undefined)
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100)
      await this.throttle.wait()
      const response = await this.http(`${this.base}/tokens/v2/search?query=${batch.map(encodeURIComponent).join(',')}`)
      // A refused request is not an answer about any mint: nothing cached.
      if (response.status !== 200) continue
      const body = (await response.json()) as unknown
      const found = new Map<string, JupiterTokenInfo>()
      for (const token of Array.isArray(body) ? (body as JupiterTokenInfo[]) : []) {
        if (typeof token.id === 'string') found.set(token.id, token)
      }
      // Search is fuzzy, so only an exact id counts — and a mint it did not
      // return is remembered as unknown rather than re-asked one by one.
      for (const mint of batch) this.remember(mint, found.get(mint) ?? null)
    }
  }

  /**
   * The market half for many mints, a hundred per request — the scan's market
   * pass and the engine's live prices both read it, so the price the book is
   * valued at and the liquidity its death watch compares come from one place.
   */
  async markets(
    chain: Chain,
    addresses: readonly string[],
    /**
     * `refresh` asks again whatever the cache holds. The ENGINE's live prices
     * need it: the stop re-prices the book every thirty seconds, and a price
     * served from a minute-old cache would cut a position on where it was.
     */
    options: { readonly refresh?: boolean } = {},
  ): Promise<MarketSnapshot[]> {
    if (chain !== 'solana') return []
    await this.prefetch(addresses, options)
    const at = this.now()
    const out: MarketSnapshot[] = []
    for (const address of new Set(addresses)) {
      const info = this.fresh(address)?.info
      const market = info ? jupiterMarket(info, at) : null
      if (market) out.push(market)
    }
    return out
  }

  async info(mint: string): Promise<JupiterTokenInfo | null> {
    const cached = this.fresh(mint)
    if (cached !== undefined) return cached.info

    await this.throttle.wait()
    const response = await this.http(`${this.base}/tokens/v2/search?query=${encodeURIComponent(mint)}`)
    if (response.status !== 200) return null
    const body = (await response.json()) as unknown
    const list = Array.isArray(body) ? (body as JupiterTokenInfo[]) : []
    // Search is fuzzy; only an exact mint match is the token we asked about.
    const match = list.find((t) => t.id === mint) ?? null
    this.remember(mint, match)
    return match
  }

  /**
   * A Solana universe: the tokens Jupiter ranks as trending, most traded and
   * most organically active over 24h. Confirmed live (Sept 2026): each list
   * returns up to `limit` tokens with liquidity, holders, stats and audit —
   * and unlike DexScreener's boosts, most of them have real liquidity.
   *
   * ONE HUNDRED, which is the provider's own ceiling — measured, not assumed:
   * asking for 200 or 500 returns 100 either way. It asked for 50 and the
   * scanner called it with no argument, so half of Jupiter's universe was
   * being left on the table for no reason at all.
   *
   * It matters more than it looks. Measured across all three discovery sources
   * on one sweep: Jupiter 195 tokens, GeckoTerminal 145, DexScreener 44, and
   * 314 unique between them — with 128 that ONLY Jupiter has. It is the
   * largest single source and it was running at half.
   */
  async discover(limit = 100): Promise<string[]> {
    const lists = ['toptrending/24h', 'toptraded/24h', 'toporganicscore/24h']
    const seen = new Set<string>()
    for (const list of lists) {
      await this.throttle.wait()
      const response = await this.http(`${this.base}/tokens/v2/${list}?limit=${limit}`)
      if (response.status !== 200) continue
      const body = (await response.json()) as unknown
      if (!Array.isArray(body)) continue
      for (const token of body as JupiterTokenInfo[]) {
        if (typeof token.id === 'string') {
          seen.add(token.id)
          this.remember(token.id, token) // free metadata for the security pass
        }
      }
    }
    return [...seen]
  }

  async decimals(chain: Chain, address: string): Promise<number | null> {
    if (chain !== 'solana') return null
    const info = await this.info(address)
    return info && Number.isInteger(info.decimals) ? info.decimals : null
  }

  /**
   * The audit block as a partial SecurityReport — a second opinion on mint
   * and freeze authorities and on holder concentration, which GoPlus often
   * leaves blank for Solana tokens. Confirmed live: BONK reports
   * mintAuthorityDisabled, freezeAuthorityDisabled and topHoldersPercentage.
   */
  async security(chain: Chain, address: string): Promise<Partial<SecurityReport> | null> {
    if (chain !== 'solana') return null
    const info = await this.info(address)
    if (!info?.audit) return null
    const a = info.audit
    return {
      mintAuthorityActive: a.mintAuthorityDisabled === undefined ? null : !a.mintAuthorityDisabled,
      freezeAuthorityActive: a.freezeAuthorityDisabled === undefined ? null : !a.freezeAuthorityDisabled,
      topHoldersPct: typeof a.topHoldersPercentage === 'number' ? a.topHoldersPercentage : null,
      creatorPct: typeof a.devBalancePercentage === 'number' ? a.devBalancePercentage : null,
    }
  }
}
