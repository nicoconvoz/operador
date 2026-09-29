import { describe, it, expect } from 'vitest'
import {
  nextDipBounce,
  watchAfterBuy,
  dipWatchWorthWriting,
  keepDipWatch,
  dipArmLine,
  bounceLine,
  DEFAULT_DIP_BOUNCE_POLICY,
  type DipBouncePolicy,
  type DipWatch,
} from './dip-bounce.js'

/**
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla.* The operator — then *disminuí los
 * escalones a 20*.
 */
const POLICY: DipBouncePolicy = DEFAULT_DIP_BOUNCE_POLICY

interface Buy { readonly time: number; readonly price: number }

/**
 * Walks a run of live prices through the rule the way the sweep does: the
 * stored watch in, the next one out, and every buy recorded at the price it
 * fired on — then the reference becomes that price.
 */
const walk = (prices: readonly number[], policy: DipBouncePolicy = POLICY, start: { watch?: DipWatch | null; buys?: readonly Buy[] } = {}) => {
  let watch: DipWatch | null = start.watch ?? null
  const buys: Buy[] = [...(start.buys ?? [])]
  let at = 1_000
  for (const price of prices) {
    at += 30_000
    const step = nextDipBounce(watch, { priceUsd: price, at, buys }, policy)
    watch = step.watch
    if (step.action === 'buy') {
      buys.push({ time: at, price })
      watch = watchAfterBuy(price, at, buys[0]!.time, watch)
    }
  }
  return { watch, buys }
}

describe('the dip-bounce ladder — the operator’s numbers', () => {
  it('buys on a 3% dip and a 2% bounce, twenty times at most', () => {
    expect(DEFAULT_DIP_BOUNCE_POLICY).toEqual({ dipPct: 3, bouncePct: 2, maxSteps: 20 })
  })

  it('draws the arming line 3% under the reference and the buying line 2% over the low', () => {
    expect(dipArmLine(1, POLICY)).toBeCloseTo(0.97, 12)
    expect(bounceLine(0.95, POLICY)).toBeCloseTo(0.969, 12)
  })
})

describe('the dip-bounce ladder — the FIRST buy, off the highest price seen', () => {
  it('starts the watch at the first price it sees, unarmed, and buys nothing', () => {
    const step = nextDipBounce(null, { priceUsd: 1, at: 5, buys: [] }, POLICY)
    expect(step.action).toBe('none')
    expect(step.watch).toEqual({ reference: 1, low: null, armed: false, at: 5, holdingSince: null })
  })

  it('follows the high up while unarmed, and measures the dip from it', () => {
    const { watch, buys } = walk([1, 1.1, 1.2, 1.17])
    expect(buys).toEqual([])
    expect(watch?.reference).toBe(1.2)
    expect(watch?.armed).toBe(false)
  })

  it('arms at exactly 3% under the high, and tracks the low while armed', () => {
    const { watch, buys } = walk([1.2, 1.164, 1.15, 1.16])
    expect(buys).toEqual([])
    expect(watch?.armed).toBe(true)
    expect(watch?.low).toBe(1.15)
  })

  it('never arms at 2.9% under the high, however it bounces', () => {
    const { buys } = walk([1, 0.971, 0.99, 0.972, 1])
    expect(buys).toEqual([])
  })

  it('buys on exactly a 2% bounce off the low — and says how far it fell and bounced', () => {
    const watch = walk([1, 0.95]).watch
    const step = nextDipBounce(watch, { priceUsd: 0.969, at: 999_999, buys: [] }, POLICY)
    expect(step.action).toBe('buy')
    expect(step.step).toBe(1)
    expect(step.fellPct).toBeCloseTo(5, 9)
    expect(step.bouncedPct).toBeCloseTo(2, 9)
  })

  it('does not buy on a 1.9% bounce', () => {
    const { buys } = walk([1, 0.95, 0.968])
    expect(buys).toEqual([])
  })

  it('never buys on the sweep that armed it — the low IS that price', () => {
    const step = nextDipBounce(null, { priceUsd: 1, at: 1, buys: [] }, POLICY)
    const armed = nextDipBounce(step.watch, { priceUsd: 0.96, at: 2, buys: [] }, POLICY)
    expect(armed.watch?.armed).toBe(true)
    expect(armed.action).toBe('none')
  })

  it('disarms without buying when the price gaps back to the high — the dip is undone, and the high moves up', () => {
    const { watch, buys } = walk([1, 0.95, 1.05])
    expect(buys).toEqual([])
    expect(watch).toMatchObject({ armed: false, reference: 1.05, low: null })
  })
})

describe('the dip-bounce ladder — every later buy, off the LAST buy', () => {
  it('measures the next dip from the last buy, not from the high, and needs a fresh bounce off a fresh low', () => {
    // The first buy at 0.969; the next arms under 0.93993 and buys 2% off its own low.
    const { buys } = walk([1, 0.95, 0.969, 0.95, 0.94, 0.935, 0.95, 0.9537])
    expect(buys.map((b) => b.price)).toEqual([0.969, 0.9537])
  })

  it('a bounce that never dipped 3% under the last buy buys nothing, however far it runs', () => {
    const { buys } = walk([1, 0.95, 0.969, 0.945, 0.98, 1.2, 1.5])
    expect(buys.map((b) => b.price)).toEqual([0.969])
  })

  it('stops at twenty buys, the first included — and a new holding starts over', () => {
    const saw: number[] = []
    let price = 1
    for (let i = 0; i < 40; i++) {
      saw.push(price, price * 0.96, price * 0.96 * 1.021)
      price = price * 0.96 * 1.021
    }
    const full = walk(saw)
    expect(full.buys).toHaveLength(20)
    const more = nextDipBounce(full.watch, { priceUsd: 0.0001, at: 1e12, buys: full.buys }, POLICY)
    expect(more.action).toBe('none')
  })

  it('reads twenty from the policy, not from a constant', () => {
    const saw: number[] = []
    let price = 1
    for (let i = 0; i < 10; i++) {
      saw.push(price, price * 0.96, price * 0.96 * 1.021)
      price = price * 0.96 * 1.021
    }
    expect(walk(saw, { ...POLICY, maxSteps: 3 }).buys).toHaveLength(3)
  })
})

describe('the dip-bounce ladder — every buy is under the one before, so no at-a-loss check is needed', () => {
  // A buy only fires armed — the low at least 3% under the reference — and
  // strictly under the reference; after it the reference is that buy's price.
  // So each buy is strictly under the last, and the average of what was paid
  // is always above the next one.
  const noisy = (seed: number, n: number): number[] => {
    let x = seed
    let price = 1
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) % 2 ** 31
      // Moves of up to ±6% a look, gaps included.
      price *= 1 + ((x / 2 ** 31) - 0.5) * 0.12
      out.push(price)
    }
    return out
  }

  for (const seed of [1, 7, 42, 2026, 99_991]) {
    it(`holds on a noisy walk (seed ${seed})`, () => {
      const { buys } = walk(noisy(seed, 3_000))
      expect(buys.length).toBeGreaterThan(3)
      for (let i = 1; i < buys.length; i++) {
        const before = buys.slice(0, i)
        // Equal dollars each, so the average cost is the harmonic mean of the prices.
        const avg = before.length / before.reduce((sum, b) => sum + 1 / b.price, 0)
        expect(buys[i]!.price).toBeLessThan(buys[i - 1]!.price)
        expect(buys[i]!.price).toBeLessThan(avg)
      }
    })
  }
})

describe('the dip-bounce ladder — whose watch it is', () => {
  it('a watch of another holding is ignored: a new holding starts over at the price it sees', () => {
    const old: DipWatch = { reference: 0.5, low: 0.4, armed: true, at: 10, holdingSince: 1 }
    const step = nextDipBounce(old, { priceUsd: 2, at: 50, buys: [] }, POLICY)
    expect(step.watch).toMatchObject({ reference: 2, low: null, armed: false, holdingSince: null })
    expect(step.action).toBe('none')
  })

  it('a watch older than the holding’s last buy is stale: the reference is what that buy paid', () => {
    // The sweep bought and died before it wrote the watch down.
    const armed: DipWatch = { reference: 1, low: 0.95, armed: true, at: 10, holdingSince: 5 }
    const buys = [{ time: 5, price: 1 }, { time: 20, price: 0.969 }]
    const step = nextDipBounce(armed, { priceUsd: 0.97, at: 30, buys }, POLICY)
    expect(step.action).toBe('none')
    expect(step.watch).toMatchObject({ reference: 0.969, armed: false, low: null, holdingSince: 5 })
  })

  it('a price that is not a price changes nothing — silence is not a dip', () => {
    const watch: DipWatch = { reference: 1, low: 0.95, armed: true, at: 10, holdingSince: null }
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const step = nextDipBounce(watch, { priceUsd: price, at: 20, buys: [] }, POLICY)
      expect(step.action).toBe('none')
      expect(step.watch).toBe(watch)
    }
  })

  it('stamps a moved watch after the one it replaces, so two sweeps sharing one clock still write in order', () => {
    const stored: DipWatch = { reference: 1, low: null, armed: false, at: 500, holdingSince: null }
    const step = nextDipBounce(stored, { priceUsd: 0.96, at: 500, buys: [] }, POLICY)
    expect(step.watch?.at).toBe(501)
    expect(watchAfterBuy(0.97, 500, 400, { ...stored, at: 900 }).at).toBe(901)
    expect(watchAfterBuy(0.97, 950, 400, { ...stored, at: 900 })).toEqual({ reference: 0.97, low: null, armed: false, at: 950, holdingSince: 400 })
  })
})

describe('the dip-bounce ladder — what is worth a write', () => {
  const base: DipWatch = { reference: 1, low: null, armed: false, at: 10, holdingSince: null }

  it('a first watch, another holding, a stale one, and a flip of armed are always written', () => {
    expect(dipWatchWorthWriting(null, base, null)).toBe(true)
    expect(dipWatchWorthWriting(base, { ...base, holdingSince: 7 }, null)).toBe(true)
    expect(dipWatchWorthWriting(base, { ...base, at: 50 }, 20)).toBe(true)
    expect(dipWatchWorthWriting(base, { ...base, armed: true, low: 0.97 }, null)).toBe(true)
  })

  it('the high or the low moving 0.1% or more is written; less is not — finer than both lines', () => {
    expect(dipWatchWorthWriting(base, { ...base, reference: 1.001, at: 11 }, null)).toBe(true)
    expect(dipWatchWorthWriting(base, { ...base, reference: 1.0009, at: 11 }, null)).toBe(false)
    const armed: DipWatch = { ...base, armed: true, low: 0.95 }
    expect(dipWatchWorthWriting(armed, { ...armed, low: 0.95 * 0.999, at: 11 }, null)).toBe(true)
    expect(dipWatchWorthWriting(armed, { ...armed, low: 0.95 * 0.9995, at: 11 }, null)).toBe(false)
  })

  it('the clock alone is never a write', () => {
    expect(dipWatchWorthWriting(base, { ...base, at: 9_999 }, null)).toBe(false)
  })
})

describe('the dip-bounce ladder — what the store keeps', () => {
  const older: DipWatch = { reference: 1, low: 0.95, armed: true, at: 10, holdingSince: null }
  const newer: DipWatch = { reference: 0.969, low: null, armed: false, at: 20, holdingSince: 5 }

  it('keeps the newer watch: a stale snapshot never undoes a newer reading', () => {
    expect(keepDipWatch(older, newer)).toBe(newer)
    expect(keepDipWatch(newer, older)).toBe(newer)
    expect(keepDipWatch(newer, { ...older, at: 20 })).toBe(newer)
  })

  it('a write carrying no watch keeps what is stored', () => {
    expect(keepDipWatch(newer, null)).toBe(newer)
    expect(keepDipWatch(newer, undefined)).toBe(newer)
    expect(keepDipWatch(null, null)).toBeNull()
    expect(keepDipWatch(undefined, older)).toBe(older)
  })
})
