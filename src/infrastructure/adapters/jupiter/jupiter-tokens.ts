import { type HttpGet } from '../../http.js'
import { type Chain } from '../../../domain/scanner/snapshot.js'
import { type DecimalsPort } from '../../../application/scan.js'
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
  readonly audit?: {
    readonly mintAuthorityDisabled?: boolean
    readonly freezeAuthorityDisabled?: boolean
    readonly topHoldersPercentage?: number
  }
}

export class JupiterTokens implements DecimalsPort {
  private readonly cache = new Map<string, JupiterTokenInfo | null>()

  constructor(
    private readonly http: HttpGet,
    private readonly base: string = JUPITER_LITE_BASE,
  ) {}

  async info(mint: string): Promise<JupiterTokenInfo | null> {
    const cached = this.cache.get(mint)
    if (cached !== undefined) return cached

    const response = await this.http(`${this.base}/tokens/v2/search?query=${encodeURIComponent(mint)}`)
    if (response.status !== 200) return null
    const body = (await response.json()) as unknown
    const list = Array.isArray(body) ? (body as JupiterTokenInfo[]) : []
    // Search is fuzzy; only an exact mint match is the token we asked about.
    const match = list.find((t) => t.id === mint) ?? null
    this.cache.set(mint, match)
    return match
  }

  async decimals(chain: Chain, address: string): Promise<number | null> {
    if (chain !== 'solana') return null
    const info = await this.info(address)
    return info && Number.isInteger(info.decimals) ? info.decimals : null
  }
}
