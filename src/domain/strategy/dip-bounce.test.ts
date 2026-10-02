import { describe, it, expect } from 'vitest'
import {
  nextDipBounce,
  watchAfterBuy,
  dipWatchWorthWriting,
  keepDipWatch,
  dipArmLine,
  bounceLine,
  crashLine,
  dipBounceThresholds,
  DEFAULT_DIP_BOUNCE_POLICY,
  type DipBouncePolicy,
  type DipWatch,
  stepSizeUsd,
  ladderTotalUsd,
} from './dip-bounce.js'

/**
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla.* The operator — then *disminuí los
 * escalones a 20*, then *3% suma 2%, el 2% suma 2% por cada DCA*, then *el
 * rebote dejalo que aumente de 1%, no de a 2%*.
 */
const POLICY: DipBouncePolicy = DEFAULT_DIP_BOUNCE_POLICY

/** The rule before the steps: every buy on the same 3% dip, 2% bounce and 20% ceiling. */
const FLAT: DipBouncePolicy = { ...POLICY, dipStepPct: 0, bounceStepPct: 0 }

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
  it('buys on a 3% dip and a 2% bounce, twenty times at most, never past 20% — and each DCA asks 2 more points of dip and ceiling, 1 more of bounce', () => {
    expect(DEFAULT_DIP_BOUNCE_POLICY).toEqual({ dipPct: 3, bouncePct: 2, maxSteps: 20, maxDipPct: 20, dipStepPct: 2, bounceStepPct: 1 })
  })

  it('draws the arming line 3% under the reference and the buying line 2% over the low — for the first buy and DCA 1', () => {
    for (const step of [1, 2]) {
      expect(dipArmLine(1, POLICY, step)).toBeCloseTo(0.97, 12)
      expect(bounceLine(0.95, POLICY, step)).toBeCloseTo(0.969, 12)
    }
  })

  it('draws the collapse line 20% under the reference — for the first buy and DCA 1', () => {
    for (const step of [1, 2]) {
      expect(crashLine(1, POLICY, step)).toBeCloseTo(0.8, 12)
      expect(crashLine(0.5, POLICY, step)).toBeCloseTo(0.4, 12)
    }
  })

  it('draws each DCA’s own lines: DCA 3 arms 7% under, buys 4% over the low and collapses past 24%', () => {
    expect(dipArmLine(1, POLICY, 4)).toBeCloseTo(0.93, 12)
    expect(bounceLine(0.9, POLICY, 4)).toBeCloseTo(0.936, 12)
    expect(crashLine(1, POLICY, 4)).toBeCloseTo(0.76, 12)
  })
})

describe('the dip-bounce ladder — each DCA asks for a bigger dip and a bigger bounce', () => {
  // *3% suma 2%, el 2% suma 2% por cada DCA* — then *el rebote dejalo que
  // aumente de 1%, no de a 2%*, and the ceiling grows with the dip. CURVE
  // bought five times in sixteen minutes while its price moved −0.5%, −1.2%,
  // −1.8% and −2.9%: a 2% bounce eats most of a 3% dip in a choppy token.
  const asks = (step: number, policy: DipBouncePolicy = POLICY) => dipBounceThresholds(step, policy)

  it('asks the first buy and DCA 1 for 3% and 2% under a 20% ceiling, then 2 points of dip and ceiling and 1 of bounce per DCA', () => {
    expect(asks(1)).toEqual({ dipPct: 3, bouncePct: 2, maxDipPct: 20 })
    expect(asks(2)).toEqual({ dipPct: 3, bouncePct: 2, maxDipPct: 20 })
    expect(asks(3)).toEqual({ dipPct: 5, bouncePct: 3, maxDipPct: 22 })
    expect(asks(4)).toEqual({ dipPct: 7, bouncePct: 4, maxDipPct: 24 })
    expect(asks(5)).toEqual({ dipPct: 9, bouncePct: 5, maxDipPct: 26 })
    expect(asks(11)).toEqual({ dipPct: 21, bouncePct: 11, maxDipPct: 38 })
    expect(asks(20)).toEqual({ dipPct: 39, bouncePct: 20, maxDipPct: 56 })
  })

  it('keeps the same 17-point window between the dip that arms and the fall that collapses, at every step', () => {
    for (let step = 1; step <= POLICY.maxSteps; step++) expect(asks(step).maxDipPct - asks(step).dipPct).toBe(17)
  })

  it('a ceiling of zero stays off at every step: the dip grows, the ceiling does not appear', () => {
    for (const step of [1, 2, 3, 11, 20]) expect(asks(step, { ...POLICY, maxDipPct: 0 }).maxDipPct).toBe(0)
  })

  /**
   * `k − 1` buys held, the last at a price of one, the watch written after it:
   * the next buy is the k-th, and it measures from one.
   */
  const holding = (k: number) => {
    const buys = Array.from({ length: k - 1 }, (_, i) => ({ time: 1_000 + i, price: 1 + (k - 2 - i) * 0.01 }))
    const last = buys[buys.length - 1]!
    return { buys, watch: watchAfterBuy(last.price, last.time, buys[0]!.time, null) }
  }

  for (const k of [2, 3, 4, 11]) {
    const { dipPct, bouncePct } = dipBounceThresholds(k, POLICY)
    it(`buy ${k} (DCA ${k - 1}) arms at exactly ${dipPct}% and buys on exactly a ${bouncePct}% bounce — and says what it asked`, () => {
      const low = 1 - dipPct / 100
      const { buys } = walk([low, low * (1 + bouncePct / 100)], POLICY, holding(k))
      expect(buys).toHaveLength(k)
      const armed = walk([low], POLICY, holding(k)).watch
      const step = nextDipBounce(armed, { priceUsd: low * (1 + bouncePct / 100), at: 1e12, buys: holding(k).buys }, POLICY)
      expect(step).toMatchObject({ action: 'buy', step: k, thresholds: dipBounceThresholds(k, POLICY) })
      expect(step.fellPct).toBeCloseTo(dipPct, 9)
      expect(step.bouncedPct).toBeCloseTo(bouncePct, 9)
    })

    it(`buy ${k} (DCA ${k - 1}) does not arm on a dip of ${(dipPct - 0.1).toFixed(1)}%, and does not buy on a bounce of ${(bouncePct - 0.1).toFixed(1)}%`, () => {
      const short = 1 - (dipPct - 0.1) / 100
      // A bounce that would buy, had it armed.
      expect(walk([short, short * (1 + (bouncePct + 0.5) / 100)], POLICY, holding(k)).buys).toHaveLength(k - 1)
      const low = 1 - dipPct / 100
      expect(walk([low, low * (1 + (bouncePct - 0.1) / 100)], POLICY, holding(k)).buys).toHaveLength(k - 1)
    })
  }

  // CURVE, modelled: the first buy at one, then four swings, each a 3.1–3.8%
  // dip under the last buy and a bounce of 2–3% off the low, then four more of
  // the same chop. The flat rule buys every swing — what ran.
  const CURVE_DIPS = [3.3, 3.5, 3.4, 3.8, 3.1, 3.6, 3.2, 3.7]
  const CURVE_BOUNCES = [2.9, 2.9, 2.9, 2.8, 2.4, 2.0, 2.7, 2.5]
  const chop: number[] = []
  const flatBuys: number[] = [1]
  for (let i = 0, top = 1; i < CURVE_DIPS.length; i++) {
    const low = top * (1 - CURVE_DIPS[i]! / 100)
    top = low * (1 + CURVE_BOUNCES[i]! / 100)
    chop.push(low, top)
    flatBuys.push(top)
  }
  const afterFirst = { buys: [{ time: 1_000, price: 1 }], watch: watchAfterBuy(1, 1_000, 1_000, null) }

  it('CURVE’s chop bought every swing on the flat rule — nine buys drifting down a few percent', () => {
    const { buys } = walk(chop, FLAT, afterFirst)
    expect(buys.map((b) => b.price)).toEqual(flatBuys)
    expect(1 - buys[4]!.price).toBeLessThan(0.035)
  })

  it('CURVE’s chop buys DCA 1 and then stops: DCA 2 needs a 5% dip and a 3% bounce, and no swing gives both', () => {
    const { buys } = walk(chop, POLICY, afterFirst)
    expect(buys.map((b) => b.price)).toEqual([1, flatBuys[1]])
    expect(dipBounceThresholds(3, POLICY)).toMatchObject({ dipPct: 5, bouncePct: 3 })
  })
})

describe('the dip-bounce ladder — zero steps are the flat rule, exactly', () => {
  it('asks every buy for the same 3%, 2% and 20%', () => {
    for (let step = 1; step <= 20; step++) expect(dipBounceThresholds(step, FLAT)).toEqual({ dipPct: 3, bouncePct: 2, maxDipPct: 20 })
  })

  it('buys every 4% dip and 2.1% bounce, twenty in a row — the same buys and the same watch as a policy with no steps at all', () => {
    const saw: number[] = [1]
    let price = 1
    for (let i = 0; i < 25; i++) {
      saw.push(price * 0.96, price * 0.96 * 1.021)
      price = price * 0.96 * 1.021
    }
    const flat = walk(saw, FLAT)
    expect(flat.buys).toHaveLength(20)
    expect(flat.buys.map((b) => b.price)).toEqual(saw.filter((_, i) => i > 0 && i % 2 === 0).slice(0, 20))
    // The stepped rule stops at DCA 2 on the same walk: a 4% dip is not 5%.
    expect(walk(saw, POLICY).buys).toHaveLength(2)
  })
})

describe('the dip-bounce ladder — the ceiling grows with the dip, so all twenty buys are reachable', () => {
  // *El techo del 20% crece 2 puntos por DCA, igual que la caída.* DCA 10 asks
  // a 21% dip; a fixed 20% ceiling would mark every such dip a collapse, and
  // the book would top out at ten buys.
  const ten = Array.from({ length: 10 }, (_, i) => ({ time: 1_000 + i, price: 1 + (9 - i) * 0.05 }))
  const afterTen = { buys: ten, watch: watchAfterBuy(1, ten[9]!.time, ten[0]!.time, null) }

  for (const fall of [21, 25, 30, 38]) {
    it(`DCA 10 fires on a ${fall}% dip and an 11% bounce`, () => {
      const low = 1 - fall / 100
      expect(walk([low, low * 1.11], POLICY, afterTen).buys).toHaveLength(11)
    })
  }

  it('DCA 10 does not arm on a 20.9% dip, and a 39% dip is a collapse: no bounce buys it, and it says so', () => {
    expect(walk([0.791, 0.791 * 1.2], POLICY, afterTen).buys).toHaveLength(10)
    const crash = nextDipBounce(afterTen.watch, { priceUsd: 0.61, at: 1e9, buys: ten }, POLICY)
    expect(crash.crashedPct).toBeCloseTo(39, 9)
    expect(crash.watch).toMatchObject({ armed: true, crashed: true })
    // Deeper still, and a bounce that stays past the line: nothing.
    expect(walk([0.61, 0.55, 0.55 * 1.12], POLICY, afterTen).buys).toHaveLength(10)
    // Back within its own 38% — not the first buy's 20% — the collapse clears.
    const back = walk([0.61, 0.65], POLICY, afterTen)
    expect(back.watch).toMatchObject({ armed: true, low: 0.65 })
    expect(back.watch).not.toHaveProperty('crashed')
    expect(walk([0.61, 0.65, 0.65 * 1.11], POLICY, afterTen).buys).toHaveLength(11)
  })

  it('a synthetic descent — each buy one point past its own dip and bounce — reaches all twenty, and stops there', () => {
    const seen: number[] = [1]
    let top = 1
    for (let k = 1; k <= 25; k++) {
      const { dipPct, bouncePct } = dipBounceThresholds(k, POLICY)
      const low = top * (1 - (dipPct + 1) / 100)
      top = low * (1 + (bouncePct + 1) / 100)
      seen.push(low, top)
    }
    const { buys } = walk(seen, POLICY)
    expect(buys).toHaveLength(20)
    for (let i = 1; i < buys.length; i++) expect(buys[i]!.price).toBeLessThan(buys[i - 1]!.price)
    // The same buys with the ceiling off: on this descent it never spoke.
    expect(walk(seen, { ...POLICY, maxDipPct: 0 }).buys).toEqual(buys)
    // A ceiling that stayed at 20% would have refused DCA 10's 22% here.
    expect(dipBounceThresholds(11, POLICY).dipPct + 1).toBeGreaterThan(POLICY.maxDipPct)
  })
})

describe('the dip-bounce ladder — a watch armed under a shallower line', () => {
  // The thresholds are derived from the buys, never stored. A watch written by
  // the flat rule before the steps — armed at 3% for what is now DCA 2 — has
  // not dipped far enough for DCA 2's 5%: it is not armed for it.
  const buys = [{ time: 1_000, price: 1.02 }, { time: 2_000, price: 1 }]
  const armedAtFour: DipWatch = { reference: 1, low: 0.96, armed: true, at: 2_500, holdingSince: 1_000 }

  it('buys nothing on a bounce off a 4% low, and waits unarmed off the same reference — written, so the store takes it', () => {
    const step = nextDipBounce(armedAtFour, { priceUsd: 0.96 * 1.035, at: 3_000, buys }, POLICY)
    expect(step.action).toBe('none')
    expect(step.watch).toEqual({ reference: 1, low: null, armed: false, at: 3_000, holdingSince: 1_000 })
    expect(dipWatchWorthWriting(armedAtFour, step.watch, 2_000)).toBe(true)
    expect(keepDipWatch(armedAtFour, step.watch)).toBe(step.watch)
  })

  it('arms again at 5% and buys on a 3% bounce off the new low', () => {
    const { buys: after } = walk([0.96 * 1.035, 0.95, 0.95 * 1.03], POLICY, { buys, watch: armedAtFour })
    expect(after.map((b) => b.price)).toEqual([1.02, 1, 0.95 * 1.03])
  })

  it('a watch armed past this step’s line keeps its low, as it always did', () => {
    const deep: DipWatch = { ...armedAtFour, low: 0.94 }
    const step = nextDipBounce(deep, { priceUsd: 0.94 * 1.031, at: 3_000, buys }, POLICY)
    expect(step.action).toBe('buy')
    expect(step.fellPct).toBeCloseTo(6, 9)
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
    // On the flat rule, where every buy asks the same 4% dip and 2.1% bounce
    // this walk gives; the stepped one is walked to twenty further down.
    const saw: number[] = []
    let price = 1
    for (let i = 0; i < 40; i++) {
      saw.push(price, price * 0.96, price * 0.96 * 1.021)
      price = price * 0.96 * 1.021
    }
    const full = walk(saw, FLAT)
    expect(full.buys).toHaveLength(20)
    const more = nextDipBounce(full.watch, { priceUsd: 0.0001, at: 1e12, buys: full.buys }, FLAT)
    expect(more.action).toBe('none')
  })

  it('reads twenty from the policy, not from a constant', () => {
    const saw: number[] = []
    let price = 1
    for (let i = 0; i < 10; i++) {
      saw.push(price, price * 0.96, price * 0.96 * 1.021)
      price = price * 0.96 * 1.021
    }
    expect(walk(saw, { ...FLAT, maxSteps: 3 }).buys).toHaveLength(3)
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

  for (const [name, policy] of [['stepped', POLICY], ['flat', FLAT]] as const) for (const seed of [1, 7, 42, 2026, 99_991]) {
    it(`holds on a noisy walk (seed ${seed}, ${name})`, () => {
      const { buys } = walk(noisy(seed, 3_000), policy)
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

describe('the dip-bounce ladder — a fall of more than 20% is a collapse, not a dip', () => {
  // "If it fell more than 20% it is a collapse, not a dip: don't buy there.
  // Wait until it is back within 20%." The operator, on the first hour and a
  // half at $5 a step: every token doing well bought on falls of 3% to 15.6%;
  // YAP and BAGSPAY bought on 31–34% and were −$35 of the −$52 lost.
  const OFF: DipBouncePolicy = { ...POLICY, maxDipPct: 0 }
  /** A fall of `pct` under a reference of one, then a 2.1% bounce off it. */
  const dipOf = (pct: number) => [1, 1 - pct / 100, (1 - pct / 100) * 1.021]
  const FIRST = 0.96 * 1.021

  for (const pct of [4, 10, 15.6]) {
    it(`a ${pct}% dip buys exactly as before — the same buy and the same watch`, () => {
      const on = walk(dipOf(pct))
      const off = walk(dipOf(pct), OFF)
      expect(on.buys).toHaveLength(1)
      expect(on.buys).toEqual(off.buys)
      expect(on.watch).toEqual(off.watch)
    })
  }

  it('a 20.0% dip still buys: only MORE than 20 is a collapse', () => {
    expect(walk(dipOf(20)).buys.map((b) => b.price)).toEqual([0.8 * 1.021])
    expect(walk(dipOf(20.1)).buys).toEqual([])
  })

  it('a 31.6% first dip does not buy, however it bounces — and the watch says it collapsed', () => {
    const { buys, watch } = walk([1, 0.684, 0.684 * 1.021, 0.684 * 1.1, 0.75])
    expect(buys).toEqual([])
    expect(watch).toMatchObject({ reference: 1, armed: true, low: 0.684, crashed: true })
  })

  it('buys once the price is back within 20% and bounces 2% off the NEW low: back to −18%, then +2%', () => {
    const back = walk([1, 0.684, 0.82])
    // The collapse cleared on the look that came back, and that look is the new low.
    expect(back.buys).toEqual([])
    expect(back.watch).toMatchObject({ reference: 1, armed: true, low: 0.82 })
    expect(back.watch).not.toHaveProperty('crashed')
    const step = nextDipBounce(back.watch, { priceUsd: 0.82 * 1.021, at: 1e9, buys: [] }, POLICY)
    expect(step.action).toBe('buy')
    expect(step.fellPct).toBeCloseTo(18, 9)
    expect(step.bouncedPct).toBeCloseTo(2.1, 9)
    // A 2% bounce off the COLLAPSE low, still under the line, is not it.
    expect(walk([1, 0.684, 0.7, 0.72, 0.75]).buys).toEqual([])
  })

  it('back exactly on the line clears it: within 20% means at or over 80% of the reference', () => {
    const { watch } = walk([1, 0.684, 0.8])
    expect(watch).toMatchObject({ armed: true, low: 0.8 })
    expect(watch).not.toHaveProperty('crashed')
  })

  it('back to under a 3% dip, it waits for a fresh one — disarmed, the collapse forgotten', () => {
    const { buys, watch } = walk([1, 0.684, 0.98])
    expect(buys).toEqual([])
    expect(watch).toMatchObject({ reference: 1, armed: false, low: null })
    expect(watch).not.toHaveProperty('crashed')
  })

  it('back over the high while collapsed: disarmed, and the high moves up — as any undone dip', () => {
    const { watch } = walk([1, 0.684, 1.05])
    expect(watch).toMatchObject({ reference: 1.05, armed: false, low: null })
    expect(watch).not.toHaveProperty('crashed')
  })

  it('collapses on the look an armed low slides past 20%, not only on a gap', () => {
    // Armed at −4%, down to −15% with no bounce, then −22% and a 2.5% bounce
    // that is still under the line.
    const { buys, watch } = walk([1, 0.96, 0.85, 0.78, 0.78 * 1.025])
    expect(buys).toEqual([])
    expect(watch).toMatchObject({ low: 0.78, crashed: true })
  })

  it('applies to every later buy, measured from the LAST buy', () => {
    // The first buy on a 4% dip; then 25% under it and a bounce: nothing. Back
    // to −10% of it and a 2% bounce: the second buy.
    const prices = [1, 0.96, FIRST, FIRST * 0.75, FIRST * 0.75 * 1.05, FIRST * 0.9, FIRST * 0.9 * 1.021]
    expect(walk(prices).buys.map((b) => b.price)).toEqual([FIRST, FIRST * 0.9 * 1.021])
  })

  it('a fresh watch for a later buy that finds the price already 30% under it has collapsed', () => {
    const step = nextDipBounce(null, { priceUsd: 0.7, at: 50, buys: [{ time: 5, price: 1 }] }, POLICY)
    expect(step.action).toBe('none')
    expect(step.watch).toMatchObject({ reference: 1, armed: true, low: 0.7, crashed: true, holdingSince: 5 })
    expect(step.crashedPct).toBeCloseTo(30, 9)
  })

  it('a token that collapsed and never comes back within 20% never buys again — nothing is sold, it just stops adding', () => {
    const deep = [0.7, 0.72, 0.6, 0.63, 0.5, 0.52, 0.4, 0.45, 0.3, 0.33].map((x) => FIRST * x)
    expect(walk([1, 0.96, FIRST, ...deep]).buys.map((b) => b.price)).toEqual([FIRST])
  })

  it('says the collapse ONCE, on the look it happened — how far the low fell — and again only after a recovery', () => {
    const start = walk([1]).watch
    const crash = nextDipBounce(start, { priceUsd: 0.684, at: 1e6, buys: [] }, POLICY)
    expect(crash.crashedPct).toBeCloseTo(31.6, 9)
    const deeper = nextDipBounce(crash.watch, { priceUsd: 0.6, at: 1e6 + 1, buys: [] }, POLICY)
    expect(deeper.crashedPct).toBeNull()
    expect(deeper.watch).toMatchObject({ low: 0.6, crashed: true })
    const bounce = nextDipBounce(deeper.watch, { priceUsd: 0.62, at: 1e6 + 2, buys: [] }, POLICY)
    expect(bounce.crashedPct).toBeNull()
    const back = nextDipBounce(bounce.watch, { priceUsd: 0.85, at: 1e6 + 3, buys: [] }, POLICY)
    expect(back.crashedPct).toBeNull()
    const again = nextDipBounce(back.watch, { priceUsd: 0.75, at: 1e6 + 4, buys: [] }, POLICY)
    expect(again.crashedPct).toBeCloseTo(25, 9)
    // An ordinary dip says nothing.
    expect(nextDipBounce(start, { priceUsd: 0.9, at: 1e6, buys: [] }, POLICY).crashedPct).toBeNull()
  })

  it('zero turns it off: the 31.6% dip buys, as it did before', () => {
    expect(walk(dipOf(31.6), OFF).buys).toHaveLength(1)
    expect(walk(dipOf(31.6)).buys).toEqual([])
  })

  it('changes NOTHING on a walk whose dips all stay within 20% — the same buys and the same watch, look by look', () => {
    // The dips the tokens doing well actually bought on, 3% to 15.6%, each
    // with its bounce and a wobble that does not undo it — on the flat rule
    // they were measured under, every buy asking the same 3% and 2%.
    const falls = [4, 10, 15.6, 3.2, 7.5, 12, 5, 9.9, 3, 14, 6, 11]
    const seen: number[] = [1]
    let reference = 1
    for (const fall of falls) {
      const low = reference * (1 - fall / 100)
      seen.push(reference * 0.99, low * 1.01, low, low * 1.015, low * 1.021)
      reference = low * 1.021
    }
    const gentle = (seed: number, n: number): number[] => {
      let x = seed
      let price = 1
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) % 2 ** 31
        price *= 1 + ((x / 2 ** 31) - 0.5) * 0.04
        out.push(price)
      }
      return out
    }
    for (const prices of [seen, ...[1, 7, 42, 2026, 99_991].map((seed) => gentle(seed, 3_000))]) {
      let on: DipWatch | null = null
      let off: DipWatch | null = null
      const buys: Buy[] = []
      let deepest = 0
      let at = 1_000
      for (const price of prices) {
        at += 30_000
        const a = nextDipBounce(on, { priceUsd: price, at, buys }, FLAT)
        const b = nextDipBounce(off, { priceUsd: price, at, buys }, { ...FLAT, maxDipPct: 0 })
        expect(a.action).toBe(b.action)
        expect(a.watch).toEqual(b.watch)
        if (b.watch?.armed && b.watch.low !== null) deepest = Math.max(deepest, (1 - b.watch.low / b.watch.reference) * 100)
        on = a.watch
        off = b.watch
        if (a.action === 'buy') {
          buys.push({ time: at, price })
          on = watchAfterBuy(price, at, buys[0]!.time, on)
          off = watchAfterBuy(price, at, buys[0]!.time, off)
        }
      }
      // The precondition that makes this the majority: nothing here fell 20%.
      expect(deepest).toBeLessThanOrEqual(20)
      expect(buys.length).toBeGreaterThan(5)
    }
  })
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

  it('a collapse, and its clearing, are always written — they decide whether the next bounce buys', () => {
    const armed: DipWatch = { ...base, armed: true, low: 0.7 }
    expect(dipWatchWorthWriting(armed, { ...armed, crashed: true, at: 11 }, null)).toBe(true)
    expect(dipWatchWorthWriting({ ...armed, crashed: true }, { ...armed, at: 11 }, null)).toBe(true)
    expect(dipWatchWorthWriting({ ...armed, crashed: true }, { ...armed, crashed: true, at: 11 }, null)).toBe(false)
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

describe('stepSizeUsd — each step doubles the one before', () => {
  // *Hacé que cada escalón sea 1, 2, 4, 8, 16, 32.* The operator.
  it('buys the base first and doubles it on every later buy', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => stepSizeUsd(i, 1, 2))).toEqual([1, 2, 4, 8, 16, 32])
  })

  it('stays flat with a growth of one — the ladder as it was', () => {
    expect([0, 1, 5].map((i) => stepSizeUsd(i, 5, 1))).toEqual([5, 5, 5])
  })

  it('adds a slot up exactly: $63 for six doubling steps from a dollar, $30 for six flat fives', () => {
    expect(ladderTotalUsd(1, 2, 6)).toBe(63)
    expect(ladderTotalUsd(5, 1, 6)).toBe(30)
  })
})
