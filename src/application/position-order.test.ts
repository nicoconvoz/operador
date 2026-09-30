import { describe, it, expect } from 'vitest'
import { alphabetical, sortPositions } from './position-order.js'

const p = (symbol: string, id = symbol) => ({ id, symbol })

describe('alphabetical — Operaciones lists the book by name', () => {
  it('orders by symbol, ignoring case', () => {
    // *En Operaciones ordená los tokens alfabéticamente.* The operator.
    const sorted = alphabetical([p('ZCAT'), p('e/acc'), p('BOME'), p('useless'), p('AQUA')])
    expect(sorted.map((x) => x.symbol)).toEqual(['AQUA', 'BOME', 'e/acc', 'useless', 'ZCAT'])
  })

  it('reads numbers as numbers, so TOKEN2 comes before TOKEN10', () => {
    expect(alphabetical([p('TOKEN10'), p('TOKEN2')]).map((x) => x.symbol)).toEqual(['TOKEN2', 'TOKEN10'])
  })

  it('keeps two positions with the same symbol in a stable order, by id', () => {
    expect(alphabetical([p('KORI', 'b'), p('KORI', 'a')]).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('never reorders what it was given', () => {
    const given = [p('ZCAT'), p('AQUA')]
    alphabetical(given)
    expect(given.map((x) => x.symbol)).toEqual(['ZCAT', 'AQUA'])
  })
})

describe('sortPositions — the three orders Operaciones offers', () => {
  // *Quiero un filtro por orden alfabético, por mayor ganancia — o sea más
  // cerca del 12.5% — y otro para las más perdedoras, teniendo en cuenta la
  // pérdida y el piso DCA más profundo.* The operator.
  const q = (symbol: string, unrealisedPct: number | null, unrealisedUsd: number, bought: number) =>
    ({ id: `solana:${symbol}:1`, symbol, unrealisedPct, unrealisedUsd, steps: { bought } })
  const book = [
    q('MID', 4, 0.2, 1), q('NEAR', 11.8, 1.5, 3), q('DEEP', -30, -9, 6), q('DIP', -30, -1.5, 1), q('NEW', null, 0, 0), q('ALSO', -30, -9, 4),
  ]

  it('sorts by name, as the tab always did', () => {
    expect(sortPositions(book, 'alphabetical').map((x) => x.symbol)).toEqual(['ALSO', 'DEEP', 'DIP', 'MID', 'NEAR', 'NEW'])
  })

  it('puts the one closest to its +12.5% take-profit first, and one with no price last', () => {
    expect(sortPositions(book, 'nearestTp').map((x) => x.symbol)).toEqual(['NEAR', 'MID', 'ALSO', 'DEEP', 'DIP', 'NEW'])
  })

  it('puts the biggest loss in dollars first — which grows with every DCA — and the deeper ladder first on a tie', () => {
    expect(sortPositions(book, 'losers').map((x) => x.symbol)).toEqual(['DEEP', 'ALSO', 'DIP', 'NEW', 'MID', 'NEAR'])
  })

  it('never reorders what it was given', () => {
    sortPositions(book, 'losers')
    expect(book.map((x) => x.symbol)).toEqual(['MID', 'NEAR', 'DEEP', 'DIP', 'NEW', 'ALSO'])
  })
})
