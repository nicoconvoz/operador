import { describe, it, expect } from 'vitest'
import { nextDropRung } from './drop-ladder.js'

/**
 * *Podés calibrar según los datos para que las ganancias sean las máximas y
 * las pérdidas las mínimas* — and then *apliquemos la configuración completa.*
 * The operator. Three $15 rungs at −10%, −20% and −30% of the FIRST buy.
 */
describe('nextDropRung — three rungs, measured from the first buy', () => {
  const policy = { maxEntries: 4, dropsPct: [10, 20, 30] }

  it('buys DCA-1 once the price is 10% under the first buy, or further', () => {
    expect(nextDropRung({ entries: 1, firstBuyPrice: 1, priceUsd: 0.9 }, policy)).toBe(1)
    expect(nextDropRung({ entries: 1, firstBuyPrice: 1, priceUsd: 0.85 }, policy)).toBe(1)
  })

  it('waits above the line', () => {
    expect(nextDropRung({ entries: 1, firstBuyPrice: 1, priceUsd: 0.91 }, policy)).toBeNull()
  })

  it('asks DCA-2 for 20% under the FIRST buy, not 10% under the last', () => {
    // 0.85 is more than 5% under a rung bought at 0.9, and only 15% under the
    // first: a ladder measured from the last buy would buy here; this one waits.
    expect(nextDropRung({ entries: 2, firstBuyPrice: 1, priceUsd: 0.85 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 2, firstBuyPrice: 1, priceUsd: 0.8 }, policy)).toBe(2)
  })

  it('asks DCA-3 for 30% under the first buy', () => {
    expect(nextDropRung({ entries: 3, firstBuyPrice: 1, priceUsd: 0.71 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 3, firstBuyPrice: 1, priceUsd: 0.7 }, policy)).toBe(3)
  })

  it('buys ONE rung per call — a gap straight past −30% climbs a rung each sweep', () => {
    expect(nextDropRung({ entries: 1, firstBuyPrice: 1, priceUsd: 0.5 }, policy)).toBe(1)
    expect(nextDropRung({ entries: 2, firstBuyPrice: 1, priceUsd: 0.5 }, policy)).toBe(2)
    expect(nextDropRung({ entries: 3, firstBuyPrice: 1, priceUsd: 0.5 }, policy)).toBe(3)
  })

  it('stops once the ladder is full', () => {
    expect(nextDropRung({ entries: 4, firstBuyPrice: 1, priceUsd: 0.1 }, policy)).toBeNull()
  })

  it('is capped by whichever is shorter, the entries or the list of drops', () => {
    expect(nextDropRung({ entries: 2, firstBuyPrice: 1, priceUsd: 0.1 }, { maxEntries: 2, dropsPct: [10, 20, 30] })).toBeNull()
    expect(nextDropRung({ entries: 2, firstBuyPrice: 1, priceUsd: 0.1 }, { maxEntries: 4, dropsPct: [10] })).toBeNull()
  })

  it('never opens a position, and never buys without a price', () => {
    expect(nextDropRung({ entries: 0, firstBuyPrice: 1, priceUsd: 0.4 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 1, firstBuyPrice: 1, priceUsd: 0 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 1, firstBuyPrice: 0, priceUsd: 0.4 }, policy)).toBeNull()
    expect(nextDropRung({ entries: 1, firstBuyPrice: Number.NaN, priceUsd: 0.4 }, policy)).toBeNull()
  })
})
