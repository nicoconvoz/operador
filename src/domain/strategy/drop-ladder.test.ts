import { describe, it, expect } from 'vitest'
import { nextDropRung } from './drop-ladder.js'

/**
 * *Armá un solo paso de DCA: si el precio cae al 50% de lo que vale, volver a
 * comprar — sólo esa condición.* The operator.
 */
describe('nextDropRung — one rung, bought when the price has halved', () => {
  const policy = { maxEntries: 2, dropPct: 50 }

  it('buys the rung once the price is at half the last buy, or under it', () => {
    expect(nextDropRung({ entries: 1, lastBuyPrice: 1, priceUsd: 0.5 }, policy)).toBe(1)
    expect(nextDropRung({ entries: 1, lastBuyPrice: 1, priceUsd: 0.3 }, policy)).toBe(1)
  })

  it('waits above half', () => {
    expect(nextDropRung({ entries: 1, lastBuyPrice: 1, priceUsd: 0.51 }, policy)).toBeNull()
  })

  it('buys it once — the ladder is one step', () => {
    expect(nextDropRung({ entries: 2, lastBuyPrice: 0.5, priceUsd: 0.2 }, policy)).toBeNull()
  })

  it('never opens a position, and never buys without a price', () => {
    expect(nextDropRung({ entries: 0, lastBuyPrice: 1, priceUsd: 0.4 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 1, lastBuyPrice: 1, priceUsd: 0 }, policy)).toBeNull()
  })
})
