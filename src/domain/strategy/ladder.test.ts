import { describe, it, expect } from 'vitest'
import { dropPct, triggerPrice, usdForLevel, ladderCapital } from './ladder.js'
import { DEFAULT_PARAMS, PYRAMIDING, assertParams, ParamsError, type CascadeParams } from './params.js'

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

  it('linear triggers go to zero at n=34 and negative beyond — unreachable levels', () => {
    // drop(34) = 1 + 33*3 = 100. Signalled by the machine, never fillable.
    // Irrelevant in practice: the broker rejects everything past the 10th entry.
    for (let n = 1; n <= 33; n++) expect(triggerPrice(linear, 1, n)).toBeGreaterThan(0)
    expect(triggerPrice(linear, 1, 34)).toBeCloseTo(0, 12)
    expect(triggerPrice(linear, 1, 35)).toBeLessThan(0)
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

  it('capital the broker can actually deploy: 10 entries = $41,200, not the $10k initial_capital', () => {
    // Entry + DCA-1..DCA-9: 1000 + 2200 + 3400 + 4600 + 5000 * 6
    expect(ladderCapital({ ...linear, maxLevels: PYRAMIDING - 1 })).toBe(41_200)
    // What the machine would signal with maxLevels = 50, if nothing rejected it.
    expect(ladderCapital(linear)).toBe(1000 + 2200 + 3400 + 4600 + 5000 * 47)
  })
})

describe('params — guard rails', () => {
  it('accepts the defaults', () => {
    expect(() => assertParams(DEFAULT_PARAMS)).not.toThrow()
  })

  it('mirrors the reference input range 1..50', () => {
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 50 })).not.toThrow()
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 51 })).toThrow(ParamsError)
    expect(() => assertParams({ ...DEFAULT_PARAMS, maxLevels: 0 })).toThrow(ParamsError)
  })

  it('the broker, not the strategy, caps fills at pyramiding = 10', () => {
    expect(PYRAMIDING).toBe(10)
    expect(DEFAULT_PARAMS.maxLevels).toBe(50)
  })

  it('refuses a geometric multiplier that does not grow', () => {
    expect(() =>
      assertParams({ ...DEFAULT_PARAMS, progression: 'geometric', geometricMultiplier: 1 }),
    ).toThrow(ParamsError)
  })
})
