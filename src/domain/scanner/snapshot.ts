/**
 * A chain-agnostic look at one token at one moment, assembled by the
 * infrastructure adapters (DexScreener for the market, GoPlus / RPC for
 * security). The scanner's domain never sees an API response — only this.
 *
 * `null` means "the source could not tell us". For security fields that is
 * not neutral: the gates fail closed on unknown critical facts.
 */

export type Chain = 'solana' | 'bsc'

export interface WindowedVolume {
  readonly h1: number
  readonly h6: number
  readonly h24: number
}

export interface WindowedChangePct {
  readonly h1: number | null
  readonly h6: number | null
  readonly h24: number | null
}

export interface TxnCounts {
  readonly buys: number
  readonly sells: number
}

export interface SecurityReport {
  /** Sell simulation failed — the canonical honeypot test. */
  readonly honeypot: boolean | null
  readonly mintAuthorityActive: boolean | null
  readonly freezeAuthorityActive: boolean | null
  /** Buy or sell tax, whichever is higher, in percent. */
  readonly transferTaxPct: number | null
  readonly hasBlacklist: boolean | null
  /** Share of LP tokens locked or burned, in percent. */
  readonly lpLockedPct: number | null
  /** Share of supply held by the top 10 wallets, in percent. */
  readonly topHoldersPct: number | null
  /** Share of supply still held by the creator, in percent. */
  readonly creatorPct: number | null
  /** EVM only: verified source and proxy pattern. null on Solana. */
  readonly verifiedSource: boolean | null
  readonly isProxy: boolean | null
}

export interface TokenSnapshot {
  readonly chain: Chain
  readonly address: string
  readonly symbol: string
  readonly pairAddress: string
  /** Venue of the deepest pool, e.g. 'raydium', 'pumpswap', 'orca'. */
  readonly dexId?: string
  readonly observedAt: number

  readonly priceUsd: number
  readonly liquidityUsd: number
  readonly fdvUsd: number | null
  readonly volumeUsd: WindowedVolume
  readonly priceChangePct: WindowedChangePct
  readonly txns: { readonly h1: TxnCounts; readonly h24: TxnCounts }
  /** When the pair was created, or null when the source does not know. */
  readonly pairCreatedAt: number | null

  readonly security: SecurityReport
}

export const hoursOld = (snapshot: TokenSnapshot): number | null =>
  snapshot.pairCreatedAt === null ? null : (snapshot.observedAt - snapshot.pairCreatedAt) / 3_600_000
