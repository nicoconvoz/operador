import { describe, it, expect } from 'vitest'
import { portfolioRun, type PortfolioRunConfig } from './portfolio-run.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type AllocationCandidate } from '../domain/risk/portfolio.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candles } from './replay.js'

const quality = (over: Partial<MarketQuality> = {}): MarketQuality => ({
  liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0, ...over,
})

const candidate = (address: string, score: number, q: MarketQuality = quality()): AllocationCandidate => ({
  snapshot: { address, symbol: address, chain: 'solana' } as TokenSnapshot,
  quality: q,
  score,
})

/** A cycle the ladder can work with: rise, 25% drop, recovery. */
const wave = (bars: number, phase = 0): Candles => {
  const time: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = []
  for (let i = 0; i < bars; i++) {
    const price = 1 + Math.sin(((i + phase) / 120) * Math.PI * 2) * 0.25
    time.push(i * 3_600_000)
    open.push(price); high.push(price * 1.01); low.push(price * 0.99); close.push(price)
    volume.push(10_000)
  }
  return { time, open, high, low, close, volume }
}

const config: PortfolioRunConfig = {
  params: DEFAULT_PARAMS,
  portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: 2_000, maxPositions: 4 },
  gasUsdPerSwap: 0.05,
  maxOpenEntriesPerPosition: 10,
}

const four = [candidate('a', 90), candidate('b', 80), candidate('c', 70), candidate('d', 60)]
const candlesFor = () => wave(600)

describe('portfolioRun — many positions, one wallet', () => {
  const run = portfolioRun(four, candlesFor, config)

  it('runs every funded position independently', () => {
    expect(run.positions.length).toBeGreaterThan(1)
    expect(run.summary.positions).toBe(run.positions.filter((p) => p.summary !== null).length)
  })

  it('accounts for the WHOLE wallet: deployed, idle and reserve', () => {
    const s = run.summary
    expect(s.deployedUsd + s.idleUsd).toBeCloseTo(s.capitalUsd - s.reserveUsd, 6)
    expect(s.equityUsd).toBeGreaterThan(0)
  })

  it('reports breadth: winners, losers, best and worst', () => {
    const s = run.summary
    expect(s.winners + s.losers).toBeLessThanOrEqual(s.positions)
    expect(s.bestUsd).toBeGreaterThanOrEqual(s.worstUsd)
  })

  it('each position gets its own capital and never spends another’s', () => {
    for (const position of run.positions) {
      if (!position.summary) continue
      expect(position.summary.endingCashUsd).toBeLessThanOrEqual(position.capitalUsd + 1e-9)
    }
  })
})

describe('portfolioRun — the scaling thesis, measured', () => {
  it('more capital adds POSITIONS, and total P&L grows with them', () => {
    const many = [candidate('a', 90), candidate('b', 80), candidate('c', 70), candidate('d', 60), candidate('e', 50), candidate('f', 40)]
    const narrow = portfolioRun(many, candlesFor, { ...config, portfolio: { ...config.portfolio, totalCapitalUsd: 500, maxPositions: 10 } })
    const wide = portfolioRun(many, candlesFor, { ...config, portfolio: { ...config.portfolio, totalCapitalUsd: 3_000, maxPositions: 10 } })
    expect(wide.summary.positions).toBeGreaterThan(narrow.summary.positions)
    expect(wide.summary.netPnlUsd).toBeGreaterThan(narrow.summary.netPnlUsd)
  })

  it('but a wallet with nowhere to put capital just idles it', () => {
    // One candidate, lots of money: concentration cap leaves the rest unused.
    const run = portfolioRun([candidate('solo', 90)], candlesFor, {
      ...config,
      portfolio: { ...config.portfolio, totalCapitalUsd: 50_000, maxPositions: 10, maxPositionPct: 30 },
    })
    expect(run.summary.positions).toBe(1)
    expect(run.summary.idleUsd).toBeGreaterThan(run.summary.deployedUsd)
  })
})

describe('portfolioRun — isolation', () => {
  it('a token with no candles is skipped without touching the others', () => {
    const only = (c: { snapshot: TokenSnapshot }) => (c.snapshot.address === 'b' ? null : wave(600))
    const run = portfolioRun(four, only, config)
    expect(run.positions.map((p) => p.token)).not.toContain('b')
    expect(run.positions.length).toBeGreaterThan(0)
  })

  it('a pool-refused token costs its slot, not the portfolio', () => {
    const thin = candidate('hev', 99, quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    const run = portfolioRun([thin, ...four], candlesFor, config)
    expect(run.plan.skipped.find((s) => s.snapshot.address === 'hev')?.reason).toBe('pool-refused')
    expect(run.summary.positions).toBeGreaterThan(0)
  })

  it('nothing funded means nothing lost: equity equals the wallet', () => {
    const run = portfolioRun([], candlesFor, config)
    expect(run.summary.positions).toBe(0)
    expect(run.summary.equityUsd).toBeCloseTo(config.portfolio.totalCapitalUsd, 6)
    expect(run.summary.returnPct).toBeCloseTo(0, 9)
  })
})
