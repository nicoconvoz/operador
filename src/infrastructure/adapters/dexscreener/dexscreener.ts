import { HttpError, type HttpGet } from '../../http.js'
import { type Chain, type TokenSnapshot } from '../../../domain/scanner/snapshot.js'

/**
 * DexScreener — the universe and the market numbers.
 *
 * Public REST API, no key. Rate limits (Sept 2026): 300 req/min for pair,
 * token and search endpoints; 60 req/min for profiles and boosts.
 * Base: https://api.dexscreener.com
 *
 * Response shapes below were confirmed live against the API, not copied from
 * docs (see git history for the probe).
 */

export const DEXSCREENER_BASE = 'https://api.dexscreener.com'

/** The subset of a DexScreener pair object this adapter reads. */
export interface DexPair {
  readonly chainId: string
  readonly dexId: string
  readonly pairAddress: string
  readonly baseToken: { readonly address: string; readonly name: string; readonly symbol: string }
  readonly quoteToken: { readonly address: string | null; readonly symbol: string | null }
  readonly priceUsd: string | null
  readonly liquidity?: { readonly usd: number | null; readonly base: number; readonly quote: number } | null
  readonly fdv?: number | null
  readonly volume: Record<string, number>
  readonly priceChange?: Record<string, number> | null
  readonly txns: Record<string, { readonly buys: number; readonly sells: number }>
  readonly pairCreatedAt?: number | null
}

interface TokenProfile {
  readonly chainId: string
  readonly tokenAddress: string
}

/** Market half of a TokenSnapshot — security is filled in by another adapter. */
export type MarketSnapshot = Omit<TokenSnapshot, 'security'>

const chainIdOf: Record<Chain, string> = { solana: 'solana', bsc: 'bsc' }

export class DexScreener {
  constructor(
    private readonly http: HttpGet,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every pair for a token on a chain. */
  async tokenPairs(chain: Chain, tokenAddress: string): Promise<DexPair[]> {
    return (await this.getJson(`${DEXSCREENER_BASE}/token-pairs/v1/${chainIdOf[chain]}/${tokenAddress}`)) as DexPair[]
  }

  /** Pairs for up to 30 token addresses in one call. */
  async tokens(chain: Chain, tokenAddresses: readonly string[]): Promise<DexPair[]> {
    if (tokenAddresses.length === 0) return []
    if (tokenAddresses.length > 30) throw new Error('DexScreener.tokens: max 30 addresses per call')
    return (await this.getJson(`${DEXSCREENER_BASE}/tokens/v1/${chainIdOf[chain]}/${tokenAddresses.join(',')}`)) as DexPair[]
  }

  async search(query: string): Promise<DexPair[]> {
    const body = (await this.getJson(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`)) as { pairs?: DexPair[] }
    return body.pairs ?? []
  }

  /**
   * Universe discovery: tokens currently getting attention on the chain —
   * latest profiles plus latest and top boosts. There is no "all pairs"
   * endpoint; this is the free, public view of what is moving. Small caps
   * live here by definition.
   */
  async discoverTokens(chain: Chain): Promise<string[]> {
    const sources = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1']
    const seen = new Set<string>()
    for (const path of sources) {
      const list = (await this.getJson(`${DEXSCREENER_BASE}${path}`)) as TokenProfile[]
      for (const item of list) if (item.chainId === chainIdOf[chain]) seen.add(item.tokenAddress)
    }
    return [...seen]
  }

  /**
   * One market snapshot per token from a list of pairs: the deepest pool wins,
   * because that is where the executor would trade and where liquidity-based
   * gates should look.
   */
  toMarketSnapshots(chain: Chain, pairs: readonly DexPair[]): MarketSnapshot[] {
    const best = new Map<string, DexPair>()
    for (const pair of pairs) {
      if (pair.chainId !== chainIdOf[chain]) continue
      if (pair.priceUsd === null || pair.liquidity?.usd == null) continue
      const current = best.get(pair.baseToken.address)
      if (!current || (pair.liquidity.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(pair.baseToken.address, pair)
    }
    return [...best.values()].map((pair) => this.toMarketSnapshot(chain, pair))
  }

  toMarketSnapshot(chain: Chain, pair: DexPair): MarketSnapshot {
    const pc = pair.priceChange ?? {}
    const tx = (window: string) => pair.txns[window] ?? { buys: 0, sells: 0 }
    return {
      chain,
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      observedAt: this.now(),
      priceUsd: Number(pair.priceUsd),
      liquidityUsd: pair.liquidity?.usd ?? 0,
      fdvUsd: pair.fdv ?? null,
      volumeUsd: { h1: pair.volume.h1 ?? 0, h6: pair.volume.h6 ?? 0, h24: pair.volume.h24 ?? 0 },
      priceChangePct: { h1: pc.h1 ?? null, h6: pc.h6 ?? null, h24: pc.h24 ?? null },
      txns: { h1: tx('h1'), h24: tx('h24') },
      pairCreatedAt: pair.pairCreatedAt ?? null,
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.http(url)
    if (response.status !== 200) throw new HttpError(url, response.status)
    return response.json()
  }
}
