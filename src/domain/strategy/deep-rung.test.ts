import { describe, it, expect } from 'vitest'
import {
  nextDeepRung,
  nextPriceLow,
  priceLowMoved,
  priceLowWorthWriting,
  keepPriceLow,
  deepRungArmed,
  deepRungLine,
  reboundLine,
  DEFAULT_DEEP_RUNG_POLICY,
  type DeepRungPolicy,
  type PriceLow,
} from './deep-rung.js'

/**
 * *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay un
 * rebote de 10%, nueva compra DCA de $20.* The operator.
 */
const POLICY: DeepRungPolicy = DEFAULT_DEEP_RUNG_POLICY
const SINCE = 1_000

/** One holding, its first buy at 1.00 and a single entry held. */
const at = (lowPrice: number | null, priceUsd: number, over: Partial<Parameters<typeof nextDeepRung>[0]> = {}) =>
  nextDeepRung({ entries: 1, firstBuyPrice: 1, lowPrice, priceUsd, avgCostUsd: 1, ...over }, POLICY)

/** Folds a run of live prices into the holding's low, the way the sweep does. */
const lowOf = (prices: readonly number[], start: PriceLow | null = null): PriceLow | null =>
  prices.reduce<PriceLow | null>((low, price, i) => nextPriceLow(low, price, { since: SINCE, at: SINCE + i }), start)

describe('the deep rung — the operator’s numbers', () => {
  it('arms past 80% under the first buy, buys on a 10% rebound, and buys ONE rung', () => {
    expect(DEFAULT_DEEP_RUNG_POLICY).toEqual({ fallPct: 80, reboundPct: 10, maxEntries: 2 })
  })

  it('draws the arming line at a fifth of the first buy, and the rebound line 10% over the low', () => {
    expect(deepRungLine(1, POLICY)).toBeCloseTo(0.2, 12)
    expect(deepRungLine(0.05, POLICY)).toBeCloseTo(0.01, 12)
    expect(reboundLine(0.15, POLICY)).toBeCloseTo(0.165, 12)
  })
})

describe('the deep rung — (a) MORE than 80% under the first buy', () => {
  it('never arms at 79% under it, however hard it bounces', () => {
    expect(deepRungArmed(1, 0.21, POLICY)).toBe(false)
    expect(at(0.21, 0.5)).toBeNull()
  })

  it('never arms at exactly 80% — the operator said MORE than', () => {
    expect(deepRungArmed(1, 0.2, POLICY)).toBe(false)
    expect(deepRungArmed(0.3, 0.06, POLICY)).toBe(false)
    expect(at(0.2, 0.22)).toBeNull()
  })

  it('arms at 80.5% under it', () => {
    expect(deepRungArmed(1, 0.195, POLICY)).toBe(true)
    expect(at(0.195, 0.2145)).toBe(1)
  })

  it('never arms with no low on record — silence is not a fall', () => {
    expect(deepRungArmed(1, null, POLICY)).toBe(false)
    expect(at(null, 0.15)).toBeNull()
  })
})

describe('the deep rung — (b) a rebound of at least 10% off the low', () => {
  it('does not buy on a 9.9% rebound', () => {
    expect(at(0.1, 0.1099)).toBeNull()
  })

  it('buys on exactly 10%', () => {
    expect(at(0.1, 0.11)).toBe(1)
    expect(at(0.15, 0.165)).toBe(1)
  })

  it('buys on more than 10% too — the line is a floor, not a window', () => {
    expect(at(0.1, 0.15)).toBe(1)
  })

  it('does not buy AT the low: a price still falling has not rebounded', () => {
    expect(at(0.1, 0.1)).toBeNull()
  })
})

describe('the deep rung — (c) only while the position is at a loss', () => {
  it('does not buy a position the rebound put back at or over its average cost', () => {
    expect(at(0.1, 0.5, { avgCostUsd: 0.5 })).toBeNull()
    expect(at(0.1, 0.5, { avgCostUsd: 0.4 })).toBeNull()
  })

  it('buys one still under it', () => {
    expect(at(0.1, 0.5, { avgCostUsd: 0.51 })).toBe(1)
  })

  it('does not buy with no average cost to be under', () => {
    expect(at(0.1, 0.11, { avgCostUsd: null })).toBeNull()
  })
})

describe('the deep rung — once bought, nothing more for that holding', () => {
  it('never buys again once the holding holds two entries', () => {
    expect(at(0.1, 0.11, { entries: 2 })).toBeNull()
    expect(at(0.01, 0.02, { entries: 2 })).toBeNull()
  })

  it('never buys before the first buy either', () => {
    expect(at(0.1, 0.11, { entries: 0 })).toBeNull()
  })

  it('buys nothing when the venue holds only the first buy', () => {
    expect(nextDeepRung({ entries: 1, firstBuyPrice: 1, lowPrice: 0.1, priceUsd: 0.11, avgCostUsd: 1 }, { ...POLICY, maxEntries: 1 })).toBeNull()
  })

  it('refuses nonsense prices rather than trading on them', () => {
    expect(at(0.1, 0)).toBeNull()
    expect(at(0.1, Number.NaN)).toBeNull()
    expect(at(0, 0.11)).toBeNull()
    expect(at(0.1, 0.11, { firstBuyPrice: 0 })).toBeNull()
  })
})

describe('the low — the lowest live price seen since the holding’s first buy', () => {
  it('starts at the first price seen', () => {
    expect(lowOf([0.9])).toEqual({ price: 0.9, at: SINCE, holdingSince: SINCE })
  })

  it('only ever falls, and keeps when it was seen', () => {
    expect(lowOf([0.9, 0.5, 0.7, 0.6])).toEqual({ price: 0.5, at: SINCE + 1, holdingSince: SINCE })
  })

  it('keeps falling while armed: the rebound is measured from the NEW low', () => {
    // Armed at 0.18, then it kept going to 0.12: the rebound is measured from
    // 0.12 now, so the line is 0.132 — and 0.13 is not there yet.
    const low = lowOf([0.5, 0.18, 0.12])!
    expect(low.price).toBe(0.12)
    expect(deepRungArmed(1, low.price, POLICY)).toBe(true)
    expect(at(low.price, 0.13)).toBeNull()
    expect(at(low.price, 0.132)).toBe(1)
  })

  it('does not move on a price that is not a price', () => {
    const low = lowOf([0.5])
    expect(nextPriceLow(low, 0, { since: SINCE, at: 9 })).toEqual(low)
    expect(nextPriceLow(low, Number.NaN, { since: SINCE, at: 9 })).toEqual(low)
    expect(nextPriceLow(null, -1, { since: SINCE, at: 9 })).toBeNull()
  })

  it('a NEW holding resets it: the old holding’s low is history', () => {
    const old = lowOf([0.05])!
    expect(nextPriceLow(old, 0.8, { since: SINCE + 50, at: SINCE + 60 })).toEqual({ price: 0.8, at: SINCE + 60, holdingSince: SINCE + 50 })
  })
})

describe('the low — written only when it moves', () => {
  const low = (price: number, holdingSince = SINCE): PriceLow => ({ price, at: 1, holdingSince })

  it('writes a first low, a lower one, and a new holding’s', () => {
    expect(priceLowMoved(null, low(0.5))).toBe(true)
    expect(priceLowMoved(low(0.5), low(0.4))).toBe(true)
    expect(priceLowMoved(low(0.5), low(0.9, SINCE + 1))).toBe(true)
  })

  it('does not rewrite an unchanged low every thirty seconds', () => {
    expect(priceLowMoved(low(0.5), low(0.5))).toBe(false)
  })
})

describe('the low — written only once a decision reads it', () => {
  // Every write is the whole position row, and what once ran this project out
  // of its free tier was NETWORK. Above the arming line no decision reads the
  // low: the rung is not armed, and once it is, the low it rebounds from is
  // under the line by construction. So a low is written only under the line —
  // and there, every time it falls, so the rebound is measured exactly.
  const low = (price: number, holdingSince = SINCE): PriceLow => ({ price, at: 1, holdingSince })

  it('writes nothing above the line, however far it fell', () => {
    expect(priceLowWorthWriting(null, low(0.5), 1, POLICY)).toBe(false)
    expect(priceLowWorthWriting(low(0.5), low(0.21), 1, POLICY)).toBe(false)
    expect(priceLowWorthWriting(null, low(0.2), 1, POLICY)).toBe(false)
  })

  it('writes the first low under the line, and every lower one after it', () => {
    expect(priceLowWorthWriting(null, low(0.19), 1, POLICY)).toBe(true)
    expect(priceLowWorthWriting(low(0.19), low(0.189), 1, POLICY)).toBe(true)
  })

  it('does not rewrite an unchanged low', () => {
    expect(priceLowWorthWriting(low(0.19), low(0.19), 1, POLICY)).toBe(false)
  })

  it('writes a new holding’s low once it is under ITS line', () => {
    expect(priceLowWorthWriting(low(0.05), low(0.9, SINCE + 1), 1, POLICY)).toBe(false)
    expect(priceLowWorthWriting(low(0.05), low(0.1, SINCE + 1), 1, POLICY)).toBe(true)
  })

  it('writes nothing when there is no low', () => {
    expect(priceLowWorthWriting(low(0.1), null, 1, POLICY)).toBe(false)
  })
})

describe('the low — what the store keeps', () => {
  const low = (price: number, holdingSince = SINCE, at = 1): PriceLow => ({ price, at, holdingSince })

  it('keeps the LOWER of two for the same holding — a stale snapshot never raises it', () => {
    expect(keepPriceLow(low(0.1), low(0.5, SINCE, 9))).toEqual(low(0.1))
    expect(keepPriceLow(low(0.5), low(0.1, SINCE, 9))).toEqual(low(0.1, SINCE, 9))
  })

  it('takes a NEWER holding’s low whole, and never an older one’s', () => {
    expect(keepPriceLow(low(0.1), low(0.9, SINCE + 1))).toEqual(low(0.9, SINCE + 1))
    expect(keepPriceLow(low(0.9, SINCE + 1), low(0.1))).toEqual(low(0.9, SINCE + 1))
  })

  it('keeps what is stored when the write carries none', () => {
    expect(keepPriceLow(low(0.1), null)).toEqual(low(0.1))
    expect(keepPriceLow(low(0.1), undefined)).toEqual(low(0.1))
    expect(keepPriceLow(null, null)).toBeNull()
    expect(keepPriceLow(undefined, low(0.3))).toEqual(low(0.3))
  })
})
