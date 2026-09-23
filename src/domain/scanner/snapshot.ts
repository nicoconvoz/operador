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
  /**
   * The last FIVE minutes, and the freshest thing any free provider reports.
   *
   * Every other window in this type is a lagging average: a token that ran at
   * breakfast still shows it in `h24` long after it stopped, and `h1` keeps
   * quoting a move that ended forty minutes ago. This one answers *is it
   * moving RIGHT NOW*, which is the only question a momentum entry asks.
   *
   * DexScreener has reported it all along — for price, volume and the trade
   * counts — and the adapter read h1/h6/h24 and dropped it on the floor.
   *
   * Optional, because GeckoTerminal's pool endpoint does not carry it and a
   * snapshot built from that source genuinely does not know. Absent is not
   * zero: a gate reading this must stay silent where nobody measured, the same
   * rule the rest of the scanner runs on.
   */
  readonly m5?: number | null
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
  /**
   * How the pool's liquidity changed over the last hour, in percent, as the
   * feed measured it. Null: not reported. Absent: a feed that has no such
   * number (DexScreener). *Crecimiento de liquidez de la última hora.*
   */
  readonly liquidityChangePct?: { readonly h1: number | null }
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
   * Hours since the newest bar CARRYING VOLUME in this pool, or null when the
   * candle feed answered nothing at all.
   *
   * Absent means nobody measured it — the gate then stays silent, exactly like
   * `historyBars`. It fires on evidence, never on absence.
   *
   * It exists because two providers disagree about the same pool: GeckoTerminal
   * reported 0 trades in an hour where DexScreener reported 35. The strategy is
   * bar-driven, so whichever is right about the market, a pool this engine
   * cannot see trading is one it cannot trade.
   */
  readonly lastTradeAgoHours?: number | null

  /**
   * The newest candle's close, from the CANDLE provider.
   *
   * It exists to be compared against `priceUsd`, which comes from the MARKET
   * provider. They should agree within the gap a bar's age explains — and when
   * they do not, neither can be trusted.
   *
   * Absent means nobody measured it; the gate then stays silent.
   */
  readonly lastCandlePriceUsd?: number | null
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
