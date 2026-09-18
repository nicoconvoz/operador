import { describe, it, expect } from 'vitest'
import { priceRatio, pricesDisagree } from './price-agreement.js'

describe('price agreement — the same token, two sources', () => {
  it('measures the gap symmetrically, because which one is wrong is unknowable', () => {
    expect(priceRatio(10, 1)).toBe(10)
    expect(priceRatio(1, 10)).toBe(10)
  })

  it('catches the two that actually happened', () => {
    // ZCAT: market $0.1318 against candles $1,429.49.
    expect(pricesDisagree(0.1318, 1429.49, 5)).toBe(true)
    // USDF: bought at 0.031564, sold by a freeze exit at 0.0000021879.
    expect(pricesDisagree(0.031564, 0.0000021879, 5)).toBe(true)
  })

  it('lets ordinary movement through, which is why the band is generous', () => {
    // The last CLOSED bar can be half an hour old and these tokens move. A
    // tight band would refuse the whole universe; this exists to catch a
    // mismatched UNIT, not a price that moved.
    expect(pricesDisagree(1, 1.9, 5)).toBe(false)
    expect(pricesDisagree(1, 4.9, 5)).toBe(false)
    expect(pricesDisagree(1, 5.1, 5)).toBe(true)
  })

  it('treats an absent, zero or nonsense price as SILENCE, never as a mismatch', () => {
    // Reading a missing second opinion as a disagreement would halt every
    // position the feed happened to be quiet about.
    expect(pricesDisagree(null, 1, 5)).toBe(false)
    expect(pricesDisagree(1, undefined, 5)).toBe(false)
    expect(pricesDisagree(0, 1, 5)).toBe(false)
    expect(pricesDisagree(1, Number.NaN, 5)).toBe(false)
    expect(priceRatio(0, 1)).toBeNull()
  })
})
