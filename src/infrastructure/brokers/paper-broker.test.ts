import { describe, it, expect } from 'vitest'
import { PaperBroker, type PaperBrokerConfig } from './paper-broker.js'
import { type MarketQuality } from '../../domain/market/market-quality.js'
import { type Order } from '../../domain/strategy/state.js'

/** 0.1% measured on $100 → $200k of usable depth. */
const quality: MarketQuality = { liquidityUsd: 500_000, spreadPct: 0.25, slippagePct: 0.1, referenceUsd: 100, observedAt: 0 }

const broker = (over: Partial<PaperBrokerConfig> = {}, q: MarketQuality = quality) =>
  new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 10_000, maxOpenEntries: 10, quality: () => q, ...over })

const entry = (id: string, qty: number, level = 0): Order => ({ kind: 'entry', id, level, usd: qty, qty, comment: id })
const closeAll: Order = { kind: 'closeAll', comment: '🏁 Exit' }

describe('PaperBroker — a buy pays spread, its own impact, and gas', () => {
  it('fills above the open by spread + impact and deducts gas separately', () => {
    const b = broker()
    // 100 units at $1 = $100 notional. Impact = 100 / (200k/2) × 100 = 0.1%.
    const fills = b.execute([entry('Entry', 100)], 1, 0)
    expect(fills[0]!.price).toBeCloseTo(1 * (1 + 0.35 / 100), 12)
    expect(b.equityCash).toBeCloseTo(10_000 - 100.35 - 0.05, 9)
    expect(b.totalCosts.gasUsd).toBeCloseTo(0.05, 12)
    expect(b.totalCosts.spreadUsd).toBeCloseTo(0.25, 12)
    expect(b.totalCosts.impactUsd).toBeCloseTo(0.1, 9)
  })

  it('impact grows with size — cost per dollar rises, it is not a flat fee', () => {
    const small = broker({ initialCapital: 1_000_000 })
    small.execute([entry('a', 100)], 1, 0)
    const big = broker({ initialCapital: 1_000_000 })
    big.execute([entry('a', 10_000)], 1, 0)
    // 100x the size pays 100x the rate, so 10,000x the impact in dollars.
    expect(big.totalCosts.impactUsd / 10_000).toBeCloseTo(100 * (small.totalCosts.impactUsd / 100), 6)
    expect(big.totalCosts.impactUsd).toBeGreaterThan(small.totalCosts.impactUsd)
  })

  it('charges impact against MEASURED depth, not reported liquidity', () => {
    // Same $500k reported, but the quote says the pool is thin.
    const thin = broker({}, { ...quality, slippagePct: 5 }) // $4k of real depth
    thin.execute([entry('a', 100)], 1, 0)
    const deep = broker({}, { ...quality, slippagePct: 0.01 }) // $2M
    deep.execute([entry('a', 100)], 1, 0)
    expect(thin.totalCosts.impactUsd).toBeGreaterThan(deep.totalCosts.impactUsd * 100)
  })

  it('refuses an entry the cash cannot cover, gas included', () => {
    const b = broker({ initialCapital: 100 })
    expect(b.execute([entry('Entry', 100)], 1, 0)).toEqual([])
    expect(b.rejections[0]?.reason).toBe('capital')
  })

  it('caps simultaneous entries', () => {
    const b = broker({ maxOpenEntries: 2 })
    b.execute([entry('a', 1)], 1, 0)
    b.execute([entry('b', 1, 1)], 1, 1)
    expect(b.execute([entry('c', 1, 2)], 1, 2)).toEqual([])
    expect(b.rejections[0]?.reason).toBe('pyramiding')
  })
})

describe('PaperBroker — the exit pays impact on the WHOLE position', () => {
  it('sells below the open by spread + impact of the total, in one swap', () => {
    const b = broker()
    b.execute([entry('Entry', 1_000)], 1, 0)
    b.execute([entry('DCA-1', 1_000, 1)], 1, 1)
    const fills = b.execute([closeAll], 1, 2)
    // 2,000 units at $1 → impact = 2000 / 100k × 100 = 2%, plus 0.25% spread.
    expect(fills[0]!.price).toBeCloseTo(1 * (1 - 2.25 / 100), 12)
    expect(fills).toHaveLength(2) // one closed trade per entry
    expect(b.closedTrades).toHaveLength(2)
  })

  it('charges gas ONCE for the exit, split across the closed trades', () => {
    const b = broker()
    b.execute([entry('Entry', 100)], 1, 0)
    b.execute([entry('DCA-1', 300, 1)], 1, 1)
    const gasBefore = b.totalCosts.gasUsd
    b.execute([closeAll], 1, 2)
    expect(b.totalCosts.gasUsd - gasBefore).toBeCloseTo(0.05, 12)
  })

  it('a flat close_all is a rejection, not a crash', () => {
    const b = broker()
    expect(b.execute([closeAll], 1, 0)).toEqual([])
    expect(b.rejections[0]?.reason).toBe('flat')
  })
})

describe('PaperBroker — round trip at a flat price LOSES money', () => {
  it('buying and selling at the same price costs spread twice, impact twice and two gas', () => {
    const b = broker()
    b.execute([entry('Entry', 1_000)], 1, 0)
    b.execute([closeAll], 1, 1)
    const trade = b.closedTrades[0]!
    expect(trade.profit).toBeLessThan(0)
    expect(b.equityCash).toBeLessThan(10_000)
    // The whole point of an honest simulator: nothing is free.
    expect(b.totalCosts.spreadUsd).toBeGreaterThan(0)
    expect(b.totalCosts.impactUsd).toBeGreaterThan(0)
    expect(b.totalCosts.gasUsd).toBeCloseTo(0.1, 12)
  })

  it('a tiny position is eaten by gas, and the simulator shows it', () => {
    const b = broker({ gasUsdPerSwap: 0.2, initialCapital: 10 })
    b.execute([entry('Entry', 1)], 1, 0) // $1 of token
    b.execute([closeAll], 1, 1)
    const trade = b.closedTrades[0]!
    // Two swaps of gas against a $1 position: a loss larger than the position's
    // own move could plausibly cover. This is the capital-floor argument, in a test.
    expect(Math.abs(trade.profit)).toBeGreaterThan(0.3)
  })
})

describe('PaperBroker — position snapshot', () => {
  it('reports size, average fill price and open profit at the close', () => {
    const b = broker()
    b.execute([entry('Entry', 100)], 1, 0)
    b.execute([entry('DCA-1', 300, 1)], 0.9, 1)
    const snap = b.snapshot(1.1)
    expect(snap.size).toBe(400)
    expect(snap.avgPrice).toBeGreaterThan(0.9)
    expect(snap.avgPrice).toBeLessThan(1.01)
    expect(snap.openProfit).toBeGreaterThan(0)
  })

  it('is flat before any fill', () => {
    expect(broker().snapshot(1)).toEqual({ size: 0, avgPrice: null, openProfit: 0 })
  })
})
