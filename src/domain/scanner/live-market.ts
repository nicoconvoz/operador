import { type TokenSnapshot } from './snapshot.js'

/** What a market feed can answer about a token: everything except its security. */
export type LiveMarket = Omit<TokenSnapshot, 'security'>

/**
 * A stored snapshot with its MARKET half refreshed, and nothing else touched.
 *
 * The expensive stage of a scan answers questions no market feed can: the
 * security report, how many bars the pool has, when it last traded, what the
 * candle provider thinks it costs. The cheap stage answers the rest, and that
 * rest moves by the minute — price, liquidity, volume, the changes, the counts.
 *
 * So a shelf can be kept current for one batched request while the expensive
 * half stands until the next full scan. Overlaying the response WHOLE would
 * blank the evidence the safety gates fire on, and those fail closed: a
 * position would turn red for the crime of being refreshed.
 *
 * **One definition, because three readers need it** — the universe view, the
 * recall a watch pass allocates from, and whatever comes next. Two
 * implementations of "which half is refreshable" would eventually disagree
 * about whether a token is safe.
 *
 * The PAIR is kept too, and that is not obvious: the engine trades the pool it
 * was examined on and takes its candles from there, so adopting whichever pool
 * the feed happens to name today would price one venue and trade another.
 */
export function withLiveMarket(stored: TokenSnapshot, live: LiveMarket | undefined): TokenSnapshot {
  if (live === undefined) return stored
  return {
    ...stored,
    priceUsd: live.priceUsd,
    liquidityUsd: live.liquidityUsd,
    fdvUsd: live.fdvUsd,
    volumeUsd: live.volumeUsd,
    priceChangePct: live.priceChangePct,
    txns: live.txns,
    ...(live.liquidityChangePct ? { liquidityChangePct: live.liquidityChangePct } : {}),
    observedAt: live.observedAt,
  }
}
