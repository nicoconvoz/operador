import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { paperRun } from './paper-run.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candles } from './replay.js'

/**
 * THE CAPITAL FLOOR — the question this project exists to answer.
 *
 * Paper-trades recorded Solana candidates at several starting capitals, with
 * spread, impact and gas charged honestly. It does not promise returns; it
 * says below what capital the strategy cannot work at all, because the chain
 * takes more than the edge produces.
 *
 * Reads the dataset written by collect-dataset.smoke.test.ts. Skipped when
 * there is none, so the suite never depends on the network.
 */

const DATASET = 'tools/golden/solana-dataset.json'
const CAPITALS = [1, 50, 200, 1_000, 5_000, 20_000]
const GAS_USD_PER_SWAP = 0.05

interface DatasetToken {
  readonly snapshot: TokenSnapshot
  readonly quality: MarketQuality
  readonly candles: Candles
}

const dataset = existsSync(DATASET)
  ? (JSON.parse(readFileSync(DATASET, 'utf8')) as { tokens: DatasetToken[]; collectedAt: number; scanned: number })
  : null

describe.skipIf(!dataset)('capital floor — recorded Solana market', () => {
  const tokens = (dataset?.tokens ?? []).filter((t) => t.candles.time.length >= 250)

  it('has usable tokens', () => {
    expect(tokens.length).toBeGreaterThan(0)
  })

  it('reports the floor per token and overall', () => {
    const rows: Record<string, unknown>[] = []
    const viable = new Map<string, number>()

    for (const token of tokens) {
      for (const initialCapital of CAPITALS) {
        const run = paperRun(token.snapshot, token.quality, token.candles, {
          params: DEFAULT_PARAMS, gasUsdPerSwap: GAS_USD_PER_SWAP, initialCapital, maxOpenEntries: 10,
        })
        if (!run.tradeable) {
          rows.push({ token: token.snapshot.symbol, capital: initialCapital, verdict: 'POOL REFUSED', why: run.reason?.slice(0, 46) })
          continue
        }
        const s = run.summary!
        const costShare = s.grossPnlUsd !== 0 ? (s.closedCostsUsd / Math.abs(s.grossPnlUsd)) * 100 : Infinity
        if (s.netPnlUsd > 0 && !viable.has(token.snapshot.symbol)) viable.set(token.snapshot.symbol, initialCapital)
        rows.push({
          token: token.snapshot.symbol,
          capital: initialCapital,
          cycles: s.cycles,
          trades: `${s.wins}/${s.closedTrades}`,
          gross: +s.grossPnlUsd.toFixed(2),
          costs: +s.closedCostsUsd.toFixed(2),
          'costs/gross%': Number.isFinite(costShare) ? +costShare.toFixed(0) : '—',
          net: +s.netPnlUsd.toFixed(2),
          'return%': +s.returnPct.toFixed(2),
        })
      }
    }

    console.log(`\ndataset: ${tokens.length} tokens, collected ${new Date(dataset!.collectedAt).toISOString().slice(0, 16)}`)
    console.table(rows)
    console.log('\nlowest capital with positive realised P&L, per token:')
    console.table([...viable.entries()].map(([token, capital]) => ({ token, capital: `$${capital}` })))

    expect(rows.length).toBeGreaterThan(0)
  })

  it('at $1 the chain takes more than the strategy can produce', () => {
    // Not an opinion: with gas at $0.05 a swap, a dollar cannot fund a cycle.
    for (const token of tokens) {
      const run = paperRun(token.snapshot, token.quality, token.candles, {
        params: DEFAULT_PARAMS, gasUsdPerSwap: GAS_USD_PER_SWAP, initialCapital: 1, maxOpenEntries: 10,
      })
      if (!run.tradeable) continue
      expect(run.summary!.netPnlUsd, `${token.snapshot.symbol} @ $1`).toBeLessThanOrEqual(0)
    }
  })

  /**
   * Cost share is a U, not a slope — and that is the most useful thing this
   * experiment found.
   *
   * Two costs pull in opposite directions as a position grows:
   *   gas is FIXED, so its share falls with size
   *   impact is SUPERLINEAR, so its share rises with size
   *
   * Tiny positions are eaten by gas; large ones are eaten by their own price
   * impact. Somewhere between is the size where the chain takes the least, and
   * it is a property of the token's pool, not of the wallet.
   */
  const costShare = (token: DatasetToken, capital: number): number | null => {
    const run = paperRun(token.snapshot, token.quality, token.candles, {
      params: DEFAULT_PARAMS, gasUsdPerSwap: GAS_USD_PER_SWAP, initialCapital: capital, maxOpenEntries: 10,
    })
    if (!run.tradeable || run.summary!.closedTrades === 0 || run.summary!.grossPnlUsd === 0) return null
    return run.summary!.closedCostsUsd / Math.abs(run.summary!.grossPnlUsd)
  }

  it('cost share is a U: gas dominates when small, impact when large', () => {
    const rows: Record<string, unknown>[] = []
    for (const token of tokens) {
      const points = CAPITALS.map((capital) => ({ capital, share: costShare(token, capital) }))
        .filter((p): p is { capital: number; share: number } => p.share !== null)
      if (points.length < 3) continue

      const best = points.reduce((a, b) => (b.share < a.share ? b : a))
      rows.push({
        token: token.snapshot.symbol,
        ...Object.fromEntries(points.map((p) => [`$${p.capital}`, `${(p.share * 100).toFixed(0)}%`])),
        'cheapest at': `$${best.capital}`,
      })

      // Past the cheapest point, more capital costs more per dollar earned.
      const after = points.filter((p) => p.capital > best.capital)
      for (const p of after) expect(p.share, `${token.snapshot.symbol} @ $${p.capital}`).toBeGreaterThanOrEqual(best.share - 1e-9)
    }
    console.log('\ncost as a share of gross, by capital — and where the chain takes least:')
    console.table(rows)
    expect(rows.length).toBeGreaterThan(0)
  })
})
