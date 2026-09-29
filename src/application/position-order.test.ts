import { describe, it, expect } from 'vitest'
import { alphabetical } from './position-order.js'

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
