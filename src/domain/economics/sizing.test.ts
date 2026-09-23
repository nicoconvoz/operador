import { describe, it, expect } from 'vitest'
import { DEFAULT_SIZING_POLICY as P, effectiveDepth, gasFloorUsd, sizeLadder , roundTripCostPct, minProfitPctFor, stopForRatio, roundTripCostForFill, positionTollPct } from './sizing.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../strategy/params.js'
import { type MarketQuality } from '../market/market-quality.js'

const quality = (over: Partial<MarketQuality> = {}): MarketQuality => ({
  liquidityUsd: 1_000_000,
  spreadPct: 0.25,
  slippagePct: 0.1, // measured for $100 → implies $200k of effective depth
  referenceUsd: 100,
  observedAt: 0,
  ...over,
})

describe('effectiveDepth — a measured quote beats reported TVL', () => {
  it('inverts the impact model: 0.1% on $100 means $200k of usable depth', () => {
    expect(effectiveDepth(quality())).toEqual({ usd: 200_000, source: 'measured' })
  })

  it('exposes concentrated pools for what they are', () => {
    // HEV in the first live scan: $186k reported, 5.2% impact on $100.
    const hev = effectiveDepth(quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    expect(hev.usd).toBeCloseTo(3_846, 0)
    expect(hev.source).toBe('measured')
  })

  it('falls back to reported liquidity when nothing was measured', () => {
    expect(effectiveDepth(quality({ slippagePct: 0 }))).toEqual({ usd: 1_000_000, source: 'reported' })
  })
})

describe('sizeLadder — the strategy asks, the pool answers', () => {
  it('caps every fill at the impact budget left after the spread', () => {
    // depth 200k, budget 1% − 0.25% spread = 0.75% → max fill $750
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.tradeable).toBe(true)
    for (const level of sized.levels) {
      expect(level.sizedUsd).toBeLessThanOrEqual(750 + 1e-9)
      expect(level.fillCostPct).toBeLessThanOrEqual(P.maxFillCostPct + 1e-9)
    }
  })

  it('the exit budget binds the TOTAL, and later levels pay for it', () => {
    // depth 200k, exit budget 3% → position cap $3,000.
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.totalUsd).toBeLessThanOrEqual(3_000 + 1e-9)
    expect(sized.exitCostPct).toBeLessThanOrEqual(P.maxExitCostPct + 1e-9)
    expect(sized.levels.some((l) => l.limitedBy === 'exitCost')).toBe(true)
  })

  it('shrinks the ladder by an order of magnitude against the nominal', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality())
    expect(sized.nominalTotalUsd).toBe(41_200)
    expect(sized.totalUsd).toBeLessThan(sized.nominalTotalUsd / 10)
  })

  it('a deep pool lets the full nominal ladder through untouched', () => {
    const deep = quality({ slippagePct: 0.001 }) // $20M of effective depth
    const sized = sizeLadder(DEFAULT_PARAMS, deep)
    expect(sized.totalUsd).toBe(sized.nominalTotalUsd)
    expect(sized.levels.every((l) => l.limitedBy === 'none')).toBe(true)
    expect(sized.levels).toHaveLength(10) // pyramiding, not maxLevels
  })

  it('stops placing levels once they fall below the gas floor', () => {
    // depth tuned so the position cap runs out mid-ladder.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 2 })) // depth $10k
    expect(sized.tradeable).toBe(true)
    expect(sized.levels.length).toBeLessThan(10)
    expect(sized.levels.every((l) => l.sizedUsd >= P.minFillUsd)).toBe(true)
  })
})

describe('sizeLadder — tokens the executor refuses', () => {
  it('refuses when the venue fee alone eats the fill budget', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ spreadPct: 1.5 }))
    expect(sized.tradeable).toBe(false)
    expect(sized.reason).toMatch(/spread/)
  })

  it('a thin pool is not refused — it is shrunk to what it can carry', () => {
    // HEV: 5.2% on $100 → $3,846 of real depth. The budgets, not the floor,
    // are what protect the position: a $14 fill on this pool costs the same
    // 1% as a $750 fill on a deep one. Refusing would be a different rule
    // from the one the budgets already enforce.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
    expect(sized.tradeable).toBe(true)
    expect(sized.totalUsd).toBeLessThan(100) // against a $41,200 nominal ladder
    for (const level of sized.levels) expect(level.fillCostPct).toBeLessThanOrEqual(P.maxFillCostPct + 1e-9)
    expect(sized.exitCostPct).toBeLessThanOrEqual(P.maxExitCostPct + 1e-9)
  })

  it('reported liquidity never rescues a pool the quote says is thin', () => {
    // The scanner would call this a $5M pool. The quote says $2,500.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ liquidityUsd: 5_000_000, slippagePct: 8 }))
    expect(sized.effectiveDepthUsd).toBeLessThan(3_000)
    expect(sized.totalUsd).toBeLessThan(50)
  })

  it('and IS refused once the budget cannot even clear the gas floor', () => {
    // 50% impact on $100 → $400 of depth → a 0.75% fill is $1.50.
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ slippagePct: 50 }))
    expect(sized.tradeable).toBe(false)
    expect(sized.reason).toMatch(/floor/)
  })

  it('still reports the nominal ladder when refusing, for the audit log', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, quality({ spreadPct: 2 }))
    expect(sized.nominalTotalUsd).toBe(41_200)
    expect(sized.depthSource).toBe('measured')
  })
})

describe('gasFloorUsd — the floor is derived, not guessed', () => {
  it('is the size at which gas costs exactly the share you will tolerate', () => {
    expect(gasFloorUsd(0.05, 1)).toBeCloseTo(5, 9)     // $0.05 is 1% of $5
    expect(gasFloorUsd(0.05, 0.5)).toBeCloseTo(10, 9)
    expect(gasFloorUsd(0.20, 1)).toBeCloseTo(20, 9)    // congested chain, higher floor
    expect(gasFloorUsd(0.01, 1)).toBeCloseTo(1, 9)     // cheap chain, lower floor
  })

  it('moves with gas, which a fixed number cannot', () => {
    // The same tolerance on a chain 20x more expensive demands 20x the size.
    expect(gasFloorUsd(0.20, 1) / gasFloorUsd(0.01, 1)).toBeCloseTo(20, 9)
  })

  it('a zero tolerance admits no fill at all', () => {
    expect(gasFloorUsd(0.05, 0)).toBe(Infinity)
  })

  it('a $15 ladder clears the derived floor at Solana gas', () => {
    const capped = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
    const policy = { ...P, minFillUsd: gasFloorUsd(0.05, 1) }
    const sized = sizeLadder(capped, quality(), policy, 200)
    expect(sized.tradeable).toBe(true)
    expect(sized.levels.every((l) => l.sizedUsd === 15)).toBe(true)
  })

  it('…and is refused at congested gas, which is the right answer', () => {
    const capped = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
    const policy = { ...P, minFillUsd: gasFloorUsd(0.20, 1) }
    expect(sizeLadder(capped, quality(), policy, 200).tradeable).toBe(false)
  })
})

// ── The venue cap is production's to choose ─────────────────────────────────
//
// PYRAMIDING is 10 because that is what the `strategy()` header ran, and the
// parity harness asserts those inputs are the backtest's. It is evidence, not a
// preference — so production overriding it must never edit it, exactly as with
// maxUsdPerLevel.
//
// The user's reason for 5: with linInc at 3, DCA-5 already needs a 13% fall and
// DCA-10 needs 28%. A token down 28% is rarely an opportunity, and the capital
// those deep rungs reserve buys more by going to another token — which is
// finding 2 of the capital floor, arriving again by a different road.

describe('sizeLadder — how many rungs the venue will actually fill', () => {
  /** Deep enough that depth never binds, so only the rung count moves. */
  const deep = quality({ liquidityUsd: 500_000_000, slippagePct: 0.001 })

  it('fills ten by default, which is what TradingView ran', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, deep, P, 1_000_000)
    expect(sized.levels).toHaveLength(10)
  })

  it('fills six when production allows five DCAs — the entry plus its ladder', () => {
    const sized = sizeLadder(DEFAULT_PARAMS, deep, { ...P, maxOpenEntries: 6 }, 1_000_000)
    expect(sized.levels).toHaveLength(6)
  })

  it('leaves the reference untouched, because the harness asserts it', () => {
    expect(PYRAMIDING).toBe(10)
    expect(P.maxOpenEntries).toBeUndefined()
  })

  it('reserves capital for six swaps, not eleven, when the ladder is capped', () => {
    // The nominal total is what the ladder WANTS before any cap applies, and
    // a shorter ladder wants less. Sizing that against the old count would
    // hold back capital for rungs that can never fill.
    const ten = sizeLadder(DEFAULT_PARAMS, deep, P, 1_000_000)
    const six = sizeLadder(DEFAULT_PARAMS, deep, { ...P, maxOpenEntries: 6 }, 1_000_000)
    expect(six.nominalTotalUsd).toBeLessThan(ten.nominalTotalUsd)
  })
})

describe('the profit target is DERIVED from what leaving costs', () => {
  // `minProfitPct` was a flat 2, and on the operator's book that sat below the
  // economic floor. Measured on his own numbers: a $15 position in a deep pool
  // pays about 1.3% to go in and out — ten cents of gas and nine of spread —
  // so a 2% target left ELEVEN CENTS of gross per winner while the losers had
  // no bound at all.
  //
  // Winners capped, losers open. That shape cannot work however good the
  // selection is, and no selection rule fixes it.

  it('costs a round trip twice the spread and twice the gas share', () => {
    // Gas is FIXED, so its share is the term that moves with size. At $0.05 a
    // swap it is 0.67% of a $15 position and 0.20% of a $50 one, for the
    // identical trade.
    // Stated as ROUND TRIP shares, which is what the number is: the spread is
    // 0.6% both ways on either size, and the gas share is what moves.
    expect(roundTripCostPct(15, 0.3, 0, 0.05)).toBeCloseTo(0.6 + 0.667, 2)
    expect(roundTripCostPct(50, 0.3, 0, 0.05)).toBeCloseTo(0.6 + 0.2, 2)
    // Same trade, same spread: only the fixed gas changed its weight.
    expect(roundTripCostPct(15, 0.3, 0, 0.05)).toBeGreaterThan(roundTripCostPct(50, 0.3, 0, 0.05))
  })

  it('leaves the chain no more than the share it is given', () => {
    // A third means the target is three times the round trip, so two thirds of
    // every winner is ours.
    expect(minProfitPctFor(1.5, 33.3333)).toBeCloseTo(4.5, 3)
    expect(minProfitPctFor(1.5, 50)).toBeCloseTo(3, 6)
  })

  it('asks a SMALLER position for a BIGGER move, which is the point', () => {
    // Not a penalty invented here: it is the capital floor's own finding
    // stated as a rule — tiny positions are eaten by gas, so they have to
    // travel further to be worth the trip.
    const small = minProfitPctFor(roundTripCostPct(15, 0.3, 0.01, 0.05))
    const large = minProfitPctFor(roundTripCostPct(100, 0.3, 0.01, 0.05))
    expect(small).toBeGreaterThan(large)
    expect(small).toBeCloseTo(3.9, 1)
    expect(large).toBeCloseTo(2.2, 1)
  })

  it('beats the flat two percent where it mattered', () => {
    // $0.11 of gross became $0.39 on a $15 position. The target rose from 2%
    // to 3.9%, which is the whole of the difference.
    const target = minProfitPctFor(roundTripCostPct(15, 0.3, 0.01, 0.05))
    const netAtDerived = (15 * target) / 100 - (15 * roundTripCostPct(15, 0.3, 0.01, 0.05)) / 100
    const netAtTwo = (15 * 2) / 100 - (15 * roundTripCostPct(15, 0.3, 0.01, 0.05)) / 100
    expect(netAtDerived).toBeGreaterThan(netAtTwo * 3)
  })

  it('never goes under the floor, however cheap the pool', () => {
    // The case the arithmetic cannot see: a derived target that rounds to
    // nothing has the engine selling on noise and paying its round trip for a
    // move that means nothing.
    expect(minProfitPctFor(0.001)).toBe(2)
    expect(minProfitPctFor(0)).toBe(2)
  })

  it('refuses to divide by a share of zero', () => {
    // Zero is a real value everywhere else in this codebase and it must not
    // become Infinity here — a target nothing can ever reach is a position
    // that never sells.
    expect(minProfitPctFor(1.5, 0)).toBe(2)
  })

  it('treats a size of zero as unaffordable rather than free', () => {
    expect(roundTripCostPct(0, 0.3, 0, 0.05)).toBe(100)
  })
})

describe('stopForRatio — the stop is what the TARGET makes affordable', () => {
  // The operator, correcting the direction: *una relación 1:4 es que en un
  // lado tengas tp 3.9 y el otro sl en 9.52.* Small target, WIDE stop — one
  // loss for every four wins, not one win worth four losses. The opposite bet
  // to the one derived here first, and his is the one that matches 'aguanta
  // mejor': at a 1% stop twelve positions were cut at an average of −3.01%,
  // which is a book stopped out by noise before anything can work.

  it('derives the stop from the target, the toll and the ratio asked for', () => {
    // 4 x (3.90 - 1.38) - 1.38
    expect(stopForRatio(3.9, 1.38, 4)).toBeCloseTo(8.7, 2)
    expect(stopForRatio(3.9, 1.38, 2)).toBeCloseTo(3.66, 2)
  })

  it('actually produces the ratio it was asked for', () => {
    // The property, read back as a trader would: how many net winners pay for
    // one net loser.
    for (const ratio of [1, 2, 4, 6]) {
      for (const [target, toll] of [[3.9, 1.38], [10, 0.5], [6, 2]] as const) {
        const stop = stopForRatio(target, toll, ratio)
        expect((stop + toll) / (target - toll)).toBeCloseTo(ratio, 6)
      }
    }
  })

  it('has no opinion when the target does not clear the toll', () => {
    // Nothing left after costs, so no stop can make the pair pay. It declines
    // to invent one rather than returning something that looks like an answer.
    expect(stopForRatio(1, 1.38, 4)).toBe(0)
    expect(stopForRatio(3.9, 1.38, 0)).toBe(0)
  })

  it('never returns a NEGATIVE stop, which would sell everything at once', () => {
    // A cheap target with a tight ratio can ask for less loss than the toll
    // already costs. That is the pair being impossible, not a stop of minus
    // one percent.
    expect(stopForRatio(1.5, 1.38, 1)).toBe(0)
  })
})

describe('roundTripCostForFill — the toll at the size actually traded', () => {
  // *El operador pierde de a mucho, no funciona el SL.* It worked; it was
  // sized from the wrong toll. The sweep's own alerts said so: fomopay cut at
  // −50.7% with *su stop estaba en 24%*, Stamp with 15% — against a rule that
  // lands near 9% on an ordinary pool.
  //
  // `quality.slippagePct` is the impact of a quote for `referenceUsd` —
  // $100 — and `roundTripCostPct` took it RAW as the impact of a $15 fill.
  // The paper broker never did: it inverts the quote into an effective depth
  // and charges `usd / (depth / 2)`, which is linear in size. At $15 that is
  // 0.15 of the measured figure. The target and the stop were paying the toll
  // of an order six and a half times bigger than the one they were sized for,
  // and the 1:4 derivation multiplies the toll by about seven.

  const thin = { liquidityUsd: 100_000, spreadPct: 0.25, slippagePct: 1.1, referenceUsd: 100, observedAt: 0 }

  it('scales the measured impact to the fill, exactly as the broker charges it', () => {
    const depth = effectiveDepth(thin).usd
    const impactAtFill = (15 / (depth / 2)) * 100
    expect(impactAtFill).toBeCloseTo(0.165, 6)
    expect(roundTripCostForFill(15, thin, 0.05)).toBeCloseTo(2 * (0.25 + impactAtFill + (100 * 0.05) / 15), 9)
  })

  it('is far below the raw reading on a thin pool, which is the whole bug', () => {
    const raw = roundTripCostPct(15, thin.spreadPct, thin.slippagePct, 0.05)
    const real = roundTripCostForFill(15, thin, 0.05)
    expect(raw).toBeCloseTo(3.37, 2)
    expect(real).toBeCloseTo(1.50, 2)
  })

  it('agrees with the raw reading when the fill IS the reference size', () => {
    // The two formulas are the same thing measured at the same size. Any gap
    // here would mean the scaling is wrong, not merely different.
    expect(roundTripCostForFill(100, thin, 0.05)).toBeCloseTo(roundTripCostPct(100, 0.25, 1.1, 0.05), 9)
  })
})


describe('positionTollPct — what the whole round trip of a position costs', () => {
  // *Veinte centavos no, porque si hay más plata en juego por más escalones
  // debe ser más el piso; y el 20 fue a ojo, debe ser un porcentaje que
  // contemple la comisión.* The operator, on the floor a winner must clear
  // before it is swapped for a better token.
  const deep: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.25, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }

  it('adds the fees already paid to what selling now would cost, as a share of what was deployed', () => {
    // Paid 10 cents entering $15. Leaving $15.30 costs the spread, a sliver
    // of impact on a two-million-dollar pool, and one swap of gas.
    const exit = 15.3 * (0.25 + (15.3 / 1_000_000) * 100) / 100 + 0.05
    expect(positionTollPct(0.1, 15, 15.3, deep, 0.05)).toBeCloseTo((100 * (0.1 + exit)) / 15, 9)
  })

  it('asks more DOLLARS of a bigger position — more money in play, a higher floor', () => {
    const small = (positionTollPct(0.1, 15, 15.3, deep, 0.05) / 100) * 15
    const ladder = (positionTollPct(0.4, 90, 91.8, deep, 0.05) / 100) * 90
    expect(ladder).toBeGreaterThan(small)
  })

  it('charges a thin pool more, because leaving it moves the price', () => {
    const thin: MarketQuality = { ...deep, slippagePct: 3 }
    expect(positionTollPct(0.4, 90, 91.8, thin, 0.05)).toBeGreaterThan(positionTollPct(0.4, 90, 91.8, deep, 0.05))
  })

  it('is unclearable for a position that deployed nothing', () => {
    expect(positionTollPct(0, 0, 0, deep, 0.05)).toBe(Infinity)
  })
})
