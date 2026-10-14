import { describe, expect, it } from 'vitest'
import { mergeSales } from './merged-sales.js'

const row = (over: Partial<{ positionId: string; time: number; side: 'buy' | 'sell'; price: number; qty: number; costUsd: number; idempotencyKey: string; orderId: string; realisedUsd: number | null }>) => ({
  positionId: 'p', time: 100, side: 'sell' as 'buy' | 'sell', price: 2, qty: 1, costUsd: 0.01, idempotencyKey: 'k', orderId: 'Entry', realisedUsd: 0.5 as number | null, ...over,
})

describe('mergeSales — one sale is one line, however many buys it closed', () => {
  // *Cuando hagas la venta de cada DCA no lo vendas todo por separado: una sola
  // venta que los englobe a todos los de ese token* (2026-10-14). The broker
  // already sells in ONE swap with ONE gas charge; the tape listed a line per
  // buy it closed — thirty lines for one sale on a thirty-buy ladder.
  it('folds the fills of one sale into one row: quantities, costs and results added up, the price weighted', () => {
    const merged = mergeSales([
      row({ idempotencyKey: 'k', orderId: 'Entry', qty: 1, price: 2, costUsd: 0.02, realisedUsd: 0.5 }),
      row({ idempotencyKey: 'k#1', orderId: 'DCA-1', qty: 3, price: 2, costUsd: 0.06, realisedUsd: 1.5 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ idempotencyKey: 'k', qty: 4, price: 2, side: 'sell', orderId: 'Venta' })
    expect(merged[0]!.costUsd).toBeCloseTo(0.08, 9)
    expect(merged[0]!.realisedUsd).toBeCloseTo(2, 9)
  })

  it('leaves buys alone, and keeps two sales of the same token at different moments apart', () => {
    const merged = mergeSales([
      row({ side: 'buy', idempotencyKey: 'b1', realisedUsd: null }),
      row({ side: 'buy', idempotencyKey: 'b2', realisedUsd: null }),
      row({ time: 100, idempotencyKey: 's1' }),
      row({ time: 200, idempotencyKey: 's2' }),
    ])
    expect(merged.map((r) => r.idempotencyKey)).toEqual(['b1', 'b2', 's1', 's2'])
  })

  it('never folds sales of two different tokens that happened in the same instant', () => {
    expect(mergeSales([row({ positionId: 'a', idempotencyKey: 'a1' }), row({ positionId: 'b', idempotencyKey: 'b1' })])).toHaveLength(2)
  })

  it('keeps a row without a result as one without a result', () => {
    expect(mergeSales([row({ realisedUsd: null }), row({ idempotencyKey: 'k#1', realisedUsd: null })])[0]!.realisedUsd).toBeNull()
  })
})
