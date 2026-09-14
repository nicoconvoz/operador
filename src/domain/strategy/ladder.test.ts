import { describe, it, expect } from 'vitest'
import { dropPct, triggerPrice, usdForLevel, ladderCapital } from './ladder.js'
import { DEFAULT_PARAMS, assertParams, ParamsError, type CascadeParams } from './params.js'

const linear = DEFAULT_PARAMS
const geometric: CascadeParams = { ...DEFAULT_PARAMS, progression: 'geometric' }

describe('ladder — DCA.pine drop progression', () => {
  it('linear: drop(n) = base + (n-1) * increment', () => {
    // defaults: 1 + (n-1)*3
    expect(dropPct(linear, 1)).toBe(1)
    expect(dropPct(linear, 2)).toBe(4)
    expect(dropPct(linear, 3)).toBe(7)
    expect(dropPct(linear, 10)).toBe(28)
  })

  it('geometric: drop(n) = base * multiplier^(n-1)', () => {
    // defaults: 1 * 10^(n-1)
    expect(dropPct(geometric, 1)).toBe(1)
    expect(dropPct(geometric, 2)).toBe(10)
    expect(dropPct(geometric, 3)).toBe(100)
  })

  it('trigger price sits drop(n)% below the anchor entry', () => {
    expect(triggerPrice(linear, 100, 1)).toBeCloseTo(99, 12)
    expect(triggerPrice(linear, 100, 2)).toBeCloseTo(96, 12)
    expect(triggerPrice(linear, 0.01, 10)).toBeCloseTo(0.0072, 12)
  })

  it('with the default 10 levels every trigger is a positive price', () => {
    // The 50-level reference goes negative at n=34. Ten levels never do.
    for (let n = 1; n <= 10; n++) expect(triggerPrice(linear, 1, n)).toBeGreaterThan(0)
  })
})

describe('ladder — DCA.pine amount progression', () => {
  it('usd(n) = base * (1 + increment * n), capped', () => {
    // defaults: 1000 * (1 + 1.2n), cap 5000
    expect(usdForLevel(linear, 0)).toBe(1000)
    expect(usdForLevel(linear, 1)).toBe(2200)
    expect(usdForLevel(linear, 2)).toBe(3400)
    expect(usdForLevel(linear, 3)).toBe(4600)
    expect(usdForLevel(linear, 4)).toBe(5000) // 5800 hits the cap
    expect(usdForLevel(linear, 10)).toBe(5000)
  })

  it('the cap is the only thing standing between a typo and ruin', () => {
    const wild: CascadeParams = { ...linear, amountIncrement: 100 }
    expect(usdForLevel(wild, 1)).toBe(linear.maxUsdPerLevel)
  })

  it('full-ladder capital with defaults is $46,200 — not the $10k initial_capital', () => {
    // 1000 + 2200 + 3400 + 4600 + 5000 * 7
    expect(ladderCapital(linear)).toBe(46_200)
  })
})

describe('params — guard rails', () => {
  it('accepts the defaults', () => {
    expect(() => assertParams(DEFAULT_PARAMS)).not.toThrow()
  })

  it('refuses more than 10 levels: pyramiding = 10 is the real ceiling', () => {
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 11 })).toThrow(ParamsError)
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 50 })).toThrow(ParamsError)
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 0 })).toThrow(ParamsError)
  })

  it('refuses a geometric multiplier that does not grow', () => {
    expect(() =>
      assertParams({ ...DEFAULT_PARAMS, progression: 'geometric', geometricMultiplier: 1 }),
    ).toThrow(ParamsError)
  })
})
