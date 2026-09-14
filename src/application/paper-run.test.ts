import { describe, it, expect } from 'vitest'
import { paperRun, scaledParams, type PaperRunConfig } from './paper-run.js'
import { sizeLadder, DEFAULT_SIZING_POLICY } from '../domain/economics/sizing.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { usdForLevel } from '../domain/strategy/ladder.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candles } from './replay.js'

const quality = (over: Partial<MarketQuality> = {}): MarketQuality => ({
  liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0, ...over,
})

const snapshot = { symbol: 'TEST', address: 'T', chain: 'solana' } as TokenSnapshot

/** A sawtooth: rises, drops 25%, recovers. Exactly what a DCA ladder feeds on. */
const sawtooth = (bars: number): Candles => {
  const time: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = []
  for (let i = 0; i < bars; i++) {
    const cycle = Math.sin((i / 120) * Math.PI * 2)
    const price = 1 + cycle * 0.25
    time.push(i * 3_600_000)
    open.push(price)
    high.push(price * 1.01)
    low.push(price * 0.99)
    close.push(price)
    volume.push(10_000 + Math.abs(cycle) * 5_000)
  }
  return { time, open, high, low, close, volume }
}

const config: PaperRunConfig = {
  params: DEFAULT_PARAMS,
  gasUsdPerSwap: 0.05,
  initialCapital: 10_000,
  maxOpenEntries: 10,
}

describe('scaledParams — the ladder keeps its shape, loses its scale', () => {
  it('scales base and cap by what the pool allows at level 0', () => {
    const q = quality({ slippagePct: 1 }) // $20k of depth
    const sizing = sizeLadder(DEFAULT_PARAMS, q)
    const scaled = scaledParams(DEFAULT_PARAMS, sizing)
    expect(scaled.baseUsd).toBeLessThan(DEFAULT_PARAMS.baseUsd)
    expect(scaled.baseUsd).toBeCloseTo(sizing.levels[0]!.sizedUsd, 9)
    // The growth shape is untouched: increments and drops are the same.
    expect(scaled.amountIncrement).toBe(DEFAULT_PARAMS.amountIncrement)
    expect(scaled.dcaBasePct).toBe(DEFAULT_PARAMS.dcaBasePct)
    expect(scaled.maxLevels).toBe(DEFAULT_PARAMS.maxLevels)
  })

  it('leaves a deep pool untouched', () => {
    const sizing = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 0.001 }))
    const scaled = scaledParams(DEFAULT_PARAMS, sizing)
    expect(scaled.baseUsd).toBeCloseTo(DEFAULT_PARAMS.baseUsd, 9)
  })

  it('every scaled level stays within the sized budget', () => {
    const sizing = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 0.5 }))
    const scaled = scaledParams(DEFAULT_PARAMS, sizing)
    const worst = sizing.levels.reduce((m, l) => Math.max(m, l.sizedUsd), 0)
    for (let level = 0; level <= scaled.maxLevels; level++) {
      expect(usdForLevel(scaled, level)).toBeLessThanOrEqual(Math.max(worst, scaled.baseUsd) + 1e-6)
    }
  })
})

describe('paperRun — a token the pool cannot carry', () => {
  it('refuses before placing a single order, with the reason', () => {
    // 8% impact on $100 → $2.5k of depth.
    const run = paperRun(snapshot, quality({ slippagePct: 8 }), sawtooth(400), config)
    expect(run.tradeable).toBe(false)
    expect(run.reason).toMatch(/floor/)
    expect(run.broker).toBeNull()
    expect(run.summary).toBeNull()
    // The sizing is still reported, for the audit log.
    expect(run.sizing.nominalTotalUsd).toBe(41_200)
  })
})

describe('paperRun — a token the pool can carry', () => {
  const run = paperRun(snapshot, quality(), sawtooth(600), config)

  it('runs the strategy over the candles and reports a summary', () => {
    expect(run.tradeable).toBe(true)
    expect(run.summary!.bars).toBe(600)
    expect(run.replay!.states).toHaveLength(600)
  })

  it('accounts for every dollar: gross minus the costs of CLOSED trades is net', () => {
    const s = run.summary!
    expect(s.netPnlUsd).toBeCloseTo(s.grossPnlUsd - s.closedCostsUsd, 6)
  })

  it('total costs include the open position, so they exceed the closed-trade share', () => {
    const s = run.summary!
    expect(s.costsUsd).toBeGreaterThanOrEqual(s.closedCostsUsd - 1e-9)
  })

  it('equity is cash plus what is still held', () => {
    const s = run.summary!
    expect(s.equityUsd).toBeCloseTo(s.endingCashUsd + s.openPositionUsd, 9)
  })

  it('costs are never zero — this is the honest simulator', () => {
    expect(run.broker!.totalCosts.gasUsd).toBeGreaterThan(0)
    expect(run.summary!.costsUsd).toBeGreaterThan(0)
  })

  it('never deploys more than the sizing allowed', () => {
    const cap = run.sizing.levels.reduce((m, l) => Math.max(m, l.sizedUsd), 0)
    for (const fill of run.replay!.fills) {
      if (fill.side === 'buy') expect(fill.price * fill.qty).toBeLessThanOrEqual(cap * 1.05)
    }
  })
})
