import { describe, it, expect } from 'vitest'
import { commonFund, positionLedger } from './ledger.js'
import { type PersistedFill } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000

const fill = (positionId: string, side: 'buy' | 'sell', price: number, qty: number, at: number, costUsd = 0): PersistedFill => ({
  positionId, orderId: side, side, time: at, price, qty, costUsd, comment: side, idempotencyKey: `${positionId}:${side}:${at}`,
})

describe('positionLedger — what a position holds and what it made', () => {
  it('reports nothing for a position that never traded', () => {
    expect(positionLedger([])).toMatchObject({ qty: 0, realisedUsd: 0, hasFills: false })
  })

  it('separates what was banked from what is still at risk', () => {
    const ledger = positionLedger([
      fill('p', 'buy', 0.01, 1_000, NOW - 300),
      fill('p', 'sell', 0.012, 1_000, NOW - 200),
      fill('p', 'buy', 0.011, 1_000, NOW - 100),
    ])
    expect(ledger.realisedUsd).toBeCloseTo(2, 9)
    expect(ledger.deployedUsd).toBeCloseTo(11, 9)
    expect(ledger.avgCostUsd).toBeCloseTo(0.011, 9)
  })

  it('knows it traded even when it is flat now', () => {
    const ledger = positionLedger([fill('p', 'buy', 1, 10, NOW - 2), fill('p', 'sell', 2, 10, NOW - 1)])
    expect(ledger.qty).toBe(0)
    expect(ledger.hasFills).toBe(true)
  })
})

describe('commonFund — what the system has made and can spend', () => {
  it('is empty before anything has traded', () => {
    expect(commonFund([])).toEqual({ realisedUsd: 0, costsUsd: 0, netUsd: 0 })
  })

  it('adds up every position, including ones that have closed and left', () => {
    // 'gone' is not in the working set any more; its fills are, and most of the
    // fund belongs to positions exactly like it.
    const fund = commonFund([
      fill('gone', 'buy', 1, 100, NOW - 400),
      fill('gone', 'sell', 1.1, 100, NOW - 300),
      fill('open', 'buy', 2, 50, NOW - 200),
      fill('open', 'sell', 2.2, 50, NOW - 100),
    ])
    expect(fund.realisedUsd).toBeCloseTo(20, 9) // 10 + 10
  })

  it('subtracts what the chain took, because that cash is gone', () => {
    const fund = commonFund([
      fill('p', 'buy', 1, 100, NOW - 200, 0.6),
      fill('p', 'sell', 1.1, 100, NOW - 100, 0.7),
    ])
    expect(fund.realisedUsd).toBeCloseTo(10, 9)
    expect(fund.costsUsd).toBeCloseTo(1.3, 9)
    expect(fund.netUsd).toBeCloseTo(8.7, 9)
  })

  it('does not let one position’s basis leak into another’s profit', () => {
    // Two positions bought at wildly different prices. Pooling the fills would
    // compute a basis neither of them ever paid.
    const fund = commonFund([
      fill('cheap', 'buy', 1, 100, NOW - 400),
      fill('dear', 'buy', 100, 1, NOW - 300),
      fill('cheap', 'sell', 2, 100, NOW - 200),
    ])
    expect(fund.realisedUsd).toBeCloseTo(100, 9)
  })

  it('goes negative honestly when the costs outrun the gains', () => {
    const fund = commonFund([
      fill('p', 'buy', 1, 10, NOW - 200, 0.5),
      fill('p', 'sell', 1.01, 10, NOW - 100, 0.5),
    ])
    expect(fund.netUsd).toBeLessThan(0)
  })
})
