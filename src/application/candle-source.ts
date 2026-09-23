import { type Candles } from './replay.js'
import { type Chain } from '../domain/scanner/snapshot.js'

/**
 * Ask each source in turn and take the first that ANSWERS.
 *
 * Jupiter's chart endpoint is undocumented — what jup.ag's own site reads —
 * fast, and able to change without notice. Every position's tick depends on
 * candles, so an outage there must not become a blind book; GeckoTerminal
 * stands behind it. When Jupiter answers the fallback is never called, so it
 * costs nothing on a good day.
 *
 * It falls back on a REFUSAL, never on an answer it does not like. An empty
 * series is a fact about the token — nobody traded — and asking another source
 * until one says otherwise would be shopping for a verdict.
 *
 * Null when nobody could answer: silence, which the tick skips, and never an
 * empty series, which the death watch would read as abandonment.
 */
export async function firstThatAnswers(sources: readonly (() => Promise<Candles>)[]): Promise<Candles | null> {
  for (const source of sources) {
    try {
      return await source()
    } catch {
      // Not an answer. The next source is asked.
    }
  }
  return null
}

/** The two ways this engine can ask for a token's bars. */
export interface CandleFeeds<Size> {
  /** Jupiter, by MINT — Solana only. */
  readonly byMint: (chain: Chain, mint: string, size: Size, limit: number) => Promise<Candles>
  /** GeckoTerminal, by POOL — any chain it indexes. */
  readonly byPool: (chain: Chain, pool: string, size: Size, limit: number) => Promise<Candles>
}

/**
 * ONE route to a token's candles, for every reader: the tick, the door, and
 * whatever asks next.
 *
 * The tick moved to Jupiter by mint and the door did not. It went on asking
 * GeckoTerminal by POOL — and on Solana the pool is now Jupiter's own id, which
 * GeckoTerminal answers with a 404 or with the bars of a pool that died months
 * ago. Measured live the morning after: 25 of 26 prime tokens refused at the
 * door, *sin velas: HTTP 404* and *última vela hace 12109.5h*, while the book
 * bought nothing. Two readers with two routes to the same candles is the drift
 * this project keeps paying for; one function is the cure.
 *
 * The pool route stays behind the mint route, and it is the only route on BSC.
 */
export function tokenCandles<Size>(feeds: CandleFeeds<Size>) {
  return (chain: Chain, mint: string, pool: string, size: Size, limit: number): Promise<Candles | null> =>
    firstThatAnswers([
      ...(chain === 'solana' ? [() => feeds.byMint(chain, mint, size, limit)] : []),
      () => feeds.byPool(chain, pool, size, limit),
    ])
}
