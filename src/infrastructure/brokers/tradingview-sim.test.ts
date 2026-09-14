import { describe, it, expect } from 'vitest'
import { TradingViewSim, DCA_PINE_SIM_CONFIG } from './tradingview-sim.js'
import { type Order } from '../../domain/strategy/state.js'

const cfg = { ...DCA_PINE_SIM_CONFIG, mintick: 0.01 }
const entry = (id: string, qty: number, level = 0): Order => ({
  kind: 'entry', id, level, usd: qty * 100, qty, comment: id,
})
const closeAll: Order = { kind: 'closeAll', comment: '🏁 Exit' }

describe('TradingViewSim — fills', () => {
  it('buys at open plus one tick and charges 0.1% of notional', () => {
    const sim = new TradingViewSim(cfg)
    const fills = sim.execute([entry('Entry', 10)], 100, 1_000)
    expect(fills).toEqual([
      { time: 1_000, id: 'Entry', side: 'buy', price: 100.01, qty: 10, commission: 100.01 * 10 * 0.001, comment: 'Entry' },
    ])
    expect(sim.openTrades).toHaveLength(1)
    expect(sim.equityCash).toBeCloseTo(10_000 - 1000.1 - 1.0001, 9)
  })

  it('close_all sells every open trade at open minus one tick, one closed trade each', () => {
    const sim = new TradingViewSim(cfg)
    sim.execute([entry('Entry', 10)], 100, 1)
    sim.execute([entry('DCA-1', 20, 1)], 90, 2)
    const fills = sim.execute([closeAll], 110, 3)

    expect(fills.map((f) => [f.id, f.side, f.price])).toEqual([
      ['Entry', 'sell', 109.99],
      ['DCA-1', 'sell', 109.99],
    ])
    expect(sim.openTrades).toHaveLength(0)
    expect(sim.closedTrades).toHaveLength(2)

    const first = sim.closedTrades[0]!
    const entryComm = 100.01 * 10 * 0.001
    const exitComm = 109.99 * 10 * 0.001
    expect(first.profit).toBeCloseTo((109.99 - 100.01) * 10 - entryComm - exitComm, 9)
    expect(first.exitComment).toBe('🏁 Exit')
  })

  it('rejects the eleventh entry: pyramiding = 10', () => {
    const sim = new TradingViewSim(cfg)
    sim.execute([entry('Entry', 1)], 100, 0)
    for (let n = 1; n <= 9; n++) sim.execute([entry(`DCA-${n}`, 1, n)], 100, n)
    expect(sim.openTrades).toHaveLength(10)

    const fills = sim.execute([entry('DCA-10', 1, 10)], 100, 10)
    expect(fills).toEqual([])
    expect(sim.openTrades).toHaveLength(10)
    expect(sim.rejections.map((r) => r.reason)).toEqual(['pyramiding'])
  })

  it('records a close_all while flat as a rejection, not a crash', () => {
    const sim = new TradingViewSim(cfg)
    expect(sim.execute([closeAll], 100, 0)).toEqual([])
    expect(sim.rejections[0]?.reason).toBe('flat')
  })

  it('optionally rejects entries the cash cannot cover', () => {
    const strict = new TradingViewSim({ ...cfg, enforceCapital: true, initialCapital: 500 })
    expect(strict.execute([entry('Entry', 10)], 100, 0)).toEqual([])
    expect(strict.rejections[0]?.reason).toBe('capital')

    const lax = new TradingViewSim({ ...cfg, enforceCapital: false, initialCapital: 500 })
    expect(lax.execute([entry('Entry', 10)], 100, 0)).toHaveLength(1)
  })

  it('processes orders in emission order within one bar', () => {
    const sim = new TradingViewSim(cfg)
    sim.execute([entry('Entry', 1)], 100, 0)
    const fills = sim.execute([entry('DCA-1', 1, 1), closeAll], 100, 1)
    expect(fills.map((f) => f.side)).toEqual(['buy', 'sell', 'sell'])
    expect(sim.openTrades).toHaveLength(0)
  })
})

describe('TradingViewSim — position snapshot', () => {
  it('is flat with null average before any fill', () => {
    expect(new TradingViewSim(cfg).snapshot(123)).toEqual({ size: 0, avgPrice: null, openProfit: 0 })
  })

  it('reports size, qty-weighted average fill price and open profit at the close', () => {
    const sim = new TradingViewSim(cfg)
    sim.execute([entry('Entry', 10)], 100, 0)  // 100.01
    sim.execute([entry('DCA-1', 30, 1)], 90, 1)  // 90.01
    const snap = sim.snapshot(95)
    expect(snap.size).toBe(40)
    expect(snap.avgPrice).toBeCloseTo((100.01 * 10 + 90.01 * 30) / 40, 12)
    // Marked at close, commission excluded — as strategy.openprofit reads.
    expect(snap.openProfit).toBeCloseTo((95 - 100.01) * 10 + (95 - 90.01) * 30, 9)
  })
})
