import { describe, it, expect } from 'vitest'
import { tierOf, tierUsd, admittedUsd, TIER_USD } from './token-tier.js'
import { type TokenSnapshot } from '../scanner/snapshot.js'

// *Si el token es más peligroso le asignamos 5 USD, si es normal 10, si es muy
// bueno 15 y si es seguro seguro 25.* The operator, on the table: liquidity,
// the top ten holders' share and the pool's age.

const DAY = 86_400_000
const NOW = 100 * DAY

const token = (liquidityUsd: number, topHoldersPct: number | null, ageDays: number | null): TokenSnapshot =>
  ({
    liquidityUsd,
    observedAt: NOW,
    pairCreatedAt: ageDays === null ? null : NOW - ageDays * DAY,
    security: { topHoldersPct },
  }) as unknown as TokenSnapshot

describe('only the classes admitted are bought', () => {
  // *De todas las monedas dejame las que califiquen como 15 y 25.*
  it('buys very good and safe, and nothing for dangerous or normal, from "good" up', () => {
    expect(admittedUsd(token(100_000, 10, 90), 'good')).toBe(0)
    expect(admittedUsd(token(500_000, 10, 90), 'good')).toBe(0)
    expect(admittedUsd(token(2_000_000, 10, 90), 'good')).toBe(25)
    expect(admittedUsd(token(9_000_000, 10, 90), 'good')).toBe(50)
  })

  it('buys every class from "dangerous" up', () => {
    expect(admittedUsd(token(100_000, 10, 90), 'dangerous')).toBe(5)
  })
})

describe('the four classes, and what each one buys', () => {
  it('pays $5, $10, $25 and $50 — *a las que valen 25 ponele 50 y a las que valen 15 ponele 25*', () => {
    expect(TIER_USD).toEqual({ dangerous: 5, normal: 10, good: 25, safe: 50 })
  })

  it('is DANGEROUS under $250k of liquidity', () => {
    expect(tierOf(token(249_999, 10, 90))).toBe('dangerous')
  })

  it('is DANGEROUS when the top ten hold more than half — however deep the pool', () => {
    expect(tierOf(token(20_000_000, 50.1, 90))).toBe('dangerous')
  })

  it('is DANGEROUS when nobody measured the holders — the smaller bet on silence', () => {
    expect(tierOf(token(20_000_000, null, 90))).toBe('dangerous')
  })

  it('is NORMAL from $250k to $1M', () => {
    expect(tierOf(token(250_000, 40, 90))).toBe('normal')
    expect(tierOf(token(999_999, 40, 90))).toBe('normal')
  })

  it('is VERY GOOD from $1M to $5M', () => {
    expect(tierOf(token(1_000_000, 40, 90))).toBe('good')
    expect(tierOf(token(5_000_000, 40, 90))).toBe('good')
  })

  it('is SAFE over $5M, with the top ten under 30% and more than 30 days old', () => {
    expect(tierOf(token(5_000_001, 29.9, 31))).toBe('safe')
    expect(tierUsd(token(5_000_001, 29.9, 31))).toBe(50)
  })

  it('stays VERY GOOD over $5M when it misses any of the other two', () => {
    expect(tierOf(token(8_000_000, 30, 90))).toBe('good')
    expect(tierOf(token(8_000_000, 20, 30))).toBe('good')
    expect(tierOf(token(8_000_000, 20, null))).toBe('good')
  })
})
