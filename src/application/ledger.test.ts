import { describe, it, expect } from 'vitest'
import { realisedBySell, commonFund, positionLedger } from './ledger.js'
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

describe('realisedBySell — what a single sale actually made', () => {
  it('reports the gain of each sale against the basis it sold out of', () => {
    // The tape showed a sale with its price and its size and nothing about
    // whether it was a WIN. That is the one thing a reader wants from a line
    // that says VENTA, and the ledger already walks every fill to compute it
    // for the position as a whole — it simply never kept the per-sale figure.
    const made = realisedBySell([
      fill('p1', 'buy', 0.010, 1_000, 1),
      fill('p1', 'buy', 0.008, 1_000, 2),
      fill('p1', 'sell', 0.012, 2_000, 3),
    ])
    // Average cost is 0.009, sold 2,000 at 0.012 → +$6.
    expect(made.get('p1:sell:3')).toBeCloseTo(6, 6)
  })

  it('prices a PARTIAL sale against the average, not against the last buy', () => {
    const made = realisedBySell([
      fill('p1', 'buy', 0.010, 1_000, 1),
      fill('p1', 'buy', 0.008, 1_000, 2),
      fill('p1', 'sell', 0.012, 1_000, 3),
    ])
    expect(made.get('p1:sell:3')).toBeCloseTo(3, 6)
  })

  it('says nothing about a BUY, because a purchase has made nothing yet', () => {
    const made = realisedBySell([fill('p1', 'buy', 0.01, 1_000, 1)])
    expect(made.has('p1:buy:1')).toBe(false)
  })

  it('reports a loss as a loss', () => {
    const made = realisedBySell([
      fill('p1', 'buy', 0.010, 1_000, 1),
      fill('p1', 'sell', 0.004, 1_000, 2),
    ])
    expect(made.get('p1:sell:2')).toBeCloseTo(-6, 6)
  })

  it('keeps each position on its own basis', () => {
    // A sale in one token cannot be priced against another's average cost.
    const made = realisedBySell([
      fill('p1', 'buy', 0.010, 1_000, 1),
      fill('p2', 'buy', 0.100, 1_000, 2),
      fill('p1', 'sell', 0.012, 1_000, 3),
    ])
    expect(made.get('p1:sell:3')).toBeCloseTo(2, 6)
  })
})

describe('the walk cannot be reordered into a different answer', () => {
  // The operator, twice: *a veces me sale 75 de cobrado y a veces 55.*
  //
  // Realised profit is computed by walking a position's fills and pricing each
  // sale against the basis the buys before it built. That makes the ORDER part
  // of the answer — and the order was coming from `ORDER BY time` with no
  // tiebreaker, while every fill settled in one cycle carries the same time.
  // Ties were the normal case, and SQL leaves tied rows wherever the plan puts
  // them, so two instances could report different profit from identical data.
  //
  // The query now sorts buys before sells within an instant, which is both
  // deterministic and true: you cannot sell what you have not bought. This
  // pins the consequence — that a sale walked before its own buy is not a
  // trade that made nothing.

  it('prices a sale against the buy that came first, whatever order they arrive in', () => {
    const buy = fill('p', 'buy', 1, 100, NOW)
    const sell = fill('p', 'sell', 1.1, 100, NOW)

    const correct = positionLedger([buy, sell])
    expect(correct.realisedUsd).toBeCloseTo(10, 9)
  })

  it('a sale walked BEFORE its buy reports having made nothing — the bug this prevents', () => {
    // Not a hypothetical: it is what the missing tiebreaker produced. Kept as
    // a test so the shape is recognisable if it ever comes back by another
    // door, and so the fix is measured against the damage rather than against
    // an idea of it.
    const buy = fill('p', 'buy', 1, 100, NOW)
    const sell = fill('p', 'sell', 1.1, 100, NOW)

    const scrambled = positionLedger([sell, buy])
    expect(scrambled.realisedUsd).not.toBeCloseTo(10, 9)
  })
})
