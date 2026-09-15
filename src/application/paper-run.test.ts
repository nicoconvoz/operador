import { describe, it, expect } from 'vitest'
import { deployableCapital, ladderCapitalUsd, paperRun, scaledParams, slotFloorUsd, type PaperRunConfig } from './paper-run.js'
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
    // 50% impact on $100 → $400 of depth: a 1% fill is worth less than gas.
    const run = paperRun(snapshot, quality({ slippagePct: 50 }), sawtooth(400), config)
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

// ── What a ladder actually needs ────────────────────────────────────────────
//
// `deployableCapital` answers "given this wallet, how much may the ladder
// spend". Allocation needs the INVERSE: "given this ladder, how much wallet does
// it need", because a slot handed more than its ladder can ever spend has
// locked the surplus up for nothing.
//
// Measured live: five positions holding $285 each while a flat $15 ladder of six
// rungs can only ever deploy about $95. Nine hundred and fifty dollars reserved
// against rungs that do not exist.

describe('ladderCapitalUsd — the wallet a ladder needs, and not a dollar more', () => {
  const flat15 = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }

  it('is the exact inverse of deployableCapital', () => {
    const needed = ladderCapitalUsd(flat15, 6, 0.05)
    const deployable = deployableCapital({ initialCapital: needed, gasUsdPerSwap: 0.05, maxOpenEntries: 6, params: flat15 })

    // Six rungs at $15 is $90 of nominal ladder, and that is exactly what the
    // capital must leave deployable once gas and headroom are taken out.
    expect(deployable).toBeCloseTo(90, 6)
  })

  it('a six-rung $15 ladder needs about ninety-five dollars', () => {
    expect(ladderCapitalUsd(flat15, 6, 0.05)).toBeCloseTo(95.1, 1)
  })

  it('a shorter ladder needs less — which is the point of capping the rungs', () => {
    expect(ladderCapitalUsd(flat15, 6, 0.05)).toBeLessThan(ladderCapitalUsd(flat15, 10, 0.05))
  })

  it('reserves gas for every swap of a full cycle, buys and the one sell', () => {
    const cheap = ladderCapitalUsd(flat15, 6, 0)
    const dear = ladderCapitalUsd(flat15, 6, 1)
    // Six entries plus one exit is seven swaps.
    expect(dear - cheap).toBeCloseTo(7, 6)
  })

  it('never asks for more rungs than the machine signals', () => {
    const short = { ...flat15, maxLevels: 2 }
    // maxLevels 2 means the entry plus two rungs, whatever the venue allows.
    expect(ladderCapitalUsd(short, 10, 0)).toBeCloseTo(ladderCapitalUsd(short, 3, 0), 6)
  })
})

// ── The floor below which a slot places no orders at all ────────────────────
//
// `minPositionUsd` was 200 from a real measurement — the first run placed no
// orders below it — and that measurement was superseded when sizing began
// reserving gas and 5% of price headroom. The number stayed, and it capped the
// book at four slots however much capital was free.
//
// Deriving it is the fix, and the derivation is NOT the nominal ladder: the
// ladder SCALES to the capital, so a slot with less simply trades smaller
// rungs. What it cannot do is trade rungs under the gas floor.

describe('slotFloorUsd — the least a slot can do anything with', () => {
  const flat15 = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }

  it('is far below what the nominal ladder wants, because the ladder shrinks', () => {
    expect(slotFloorUsd(flat15, 6, 0.05, 5)).toBeLessThan(ladderCapitalUsd(flat15, 6, 0.05))
  })

  it('is six rungs at the gas floor, plus gas for the whole cycle', () => {
    // 6 × $5 of nominal, grossed up for headroom, plus seven swaps of gas.
    expect(slotFloorUsd(flat15, 6, 0.05, 5)).toBeCloseTo(31.93, 2)
  })

  it('matches what the capital-floor experiment measured after the sizing fixes', () => {
    // CLAUDE.md: the floor where the system trades at all dropped from ~$200
    // to under $50 once orders stopped being sized to the last cent.
    expect(slotFloorUsd(flat15, 6, 0.05, 5)).toBeLessThan(50)
  })

  it('rises with gas, because the gas floor does', () => {
    expect(slotFloorUsd(flat15, 6, 0.2, 20)).toBeGreaterThan(slotFloorUsd(flat15, 6, 0.05, 5))
  })

  it('does not depend on the ladder being flat — only on its rung count', () => {
    // The reference ladder is far larger nominally, and scales down to the same
    // smallest fill. The floor is a property of the gas, not of the ambition.
    expect(slotFloorUsd(DEFAULT_PARAMS, 6, 0.05, 5)).toBeCloseTo(slotFloorUsd(flat15, 6, 0.05, 5), 6)
  })
})
