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
  /** Venue labels from the source, e.g. ['CLMM'] or ['DLMM']. */
  readonly dexLabels?: readonly string[]
  readonly observedAt: number

  readonly priceUsd: number
  readonly liquidityUsd: number
  readonly fdvUsd: number | null
  readonly volumeUsd: WindowedVolume
  readonly priceChangePct: WindowedChangePct
  readonly txns: { readonly h1: TxnCounts; readonly h24: TxnCounts }
  /** When the pair was created, or null when the source does not know. */
  readonly pairCreatedAt: number | null
  /**
   * Whether the expensive security pass actually ran on this token.
   *
   * The gates fail closed, so an unknown honeypot result is a REJECTION — and
   * without this flag a token nobody has looked at yet is indistinguishable
   * from one that was examined and found dangerous. Those are not the same
   * claim, and a screen that shows them identically is lying about which
   * bullets it dodged.
   *
   * Absent means the scan did not say; treat it as checked, since every
   * snapshot written before this existed had been.
   */
  readonly securityChecked?: boolean
  /**
   * Price impact of a real reference sell, MEASURED by quoting it. Null when
   * no quote was taken.
   *
   * Not the same thing as `liquidityUsd`, and the gap between them is the
   * point: CREPE reported $718,000 of liquidity and moved 98% on a $285 sell.
   * Reported depth is a claim made by an aggregator; this is what the venue
   * said when asked to buy.
   */
  readonly measuredImpactPct?: number | null
  /**
   * Closed 1H candles available for this pool, or null when not checked.
   *
   * The strategy needs EMA-200 and a 50-bar Bollinger basis; a pool with 38
   * bars of history cannot produce either. The first capital-floor run found
   * two of five candidates in exactly that state.
   */
  readonly historyBars?: number | null

  readonly security: SecurityReport
}

export const hoursOld = (snapshot: TokenSnapshot): number | null =>
  snapshot.pairCreatedAt === null ? null : (snapshot.observedAt - snapshot.pairCreatedAt) / 3_600_000
