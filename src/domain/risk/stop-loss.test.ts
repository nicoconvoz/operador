import { describe, it, expect } from 'vitest'
import { shouldStopOut, stopLossPctFor, drawdownPct, DEFAULT_STOP_LOSS_POLICY, FLAT_ONE_PCT_STOP, type StopLossInput } from './stop-loss.js'

const P = DEFAULT_STOP_LOSS_POLICY
const held = (over: Partial<StopLossInput> = {}): StopLossInput => ({
  entryPriceUsd: 0.01, marketPriceUsd: 0.01, openQty: 1_500, runAtEntryPct: 100, ...over,
})

describe('the stop is sized to what the token has already done', () => {
  // The operator's rule: *el SL proporcional al % de crecimiento. Si es de
  // 1000%, 50% de lo invertido, ese es el techo; si es 500%, 25%, y así.*
  //
  // A fixed percentage assumes every token is equally jumpy and these are not.
  // Measured live: HOJAK up 1248% in FIVE MINUTES, TIPPED 4814% over six hours.
  // Five percent on something moving like that is not risk control, it is a
  // coin flip that exits on noise.

  it('gives a token up 1000% the fifty percent ceiling the operator named', () => {
    expect(stopLossPctFor(1000, P)).toBe(50)
  })

  it('gives a token up 500% half of that', () => {
    expect(stopLossPctFor(500, P)).toBe(25)
  })

  it('scales in between rather than stepping', () => {
    expect(stopLossPctFor(200, P)).toBe(10)
    expect(stopLossPctFor(300, P)).toBe(15)
  })

  it('never goes under five, or the spread itself would sell the position', () => {
    expect(stopLossPctFor(100, P)).toBe(5)
    expect(stopLossPctFor(20, P)).toBe(5)
    expect(stopLossPctFor(0.1, P)).toBe(5)
  })

  it('never goes over fifty, or the rule stops existing', () => {
    // TIPPED was up 4814%. A twentieth of that is 241%, which is a stop that
    // can never be reached — the same as having none at all.
    expect(stopLossPctFor(4814, P)).toBe(50)
  })

  it('takes the FLOOR when nobody measured the run', () => {
    // Silence is not evidence of volatility. The narrow stop is the
    // conservative answer here: it risks an exit that was not necessary, never
    // a loss that was not bounded.
    expect(stopLossPctFor(null, P)).toBe(5)
    expect(stopLossPctFor(undefined, P)).toBe(5)
  })

  it('treats a FALL as no run at all, not as a negative stop', () => {
    // A negative product is swallowed by the floor, which is why there is no
    // separate clamp: a mutation test showed one to be dead code.
    expect(stopLossPctFor(-90, P)).toBe(5)
  })
})

describe('the stop itself', () => {
  it('closes a token that ran 1000% only after it gives back half', () => {
    const ran = { runAtEntryPct: 1000 }
    expect(shouldStopOut(held({ ...ran, marketPriceUsd: 0.0051 }), P)).toBe(false)
    expect(shouldStopOut(held({ ...ran, marketPriceUsd: 0.005 }), P)).toBe(true)
  })

  it('closes a calm one at five percent', () => {
    expect(shouldStopOut(held({ runAtEntryPct: 10, marketPriceUsd: 0.0095 }), P)).toBe(true)
    expect(shouldStopOut(held({ runAtEntryPct: 10, marketPriceUsd: 0.00951 }), P)).toBe(false)
  })

  it('measures against the ENTRY price, not against anything that moves', () => {
    // *Con respecto al valor invertido.* With one buy they are the same number,
    // but a stop measured against an average cost CHASES a laddered position
    // down and can never be reached.
    expect(shouldStopOut({ entryPriceUsd: 1, marketPriceUsd: 0.94, openQty: 10, runAtEntryPct: 10 }, P)).toBe(true)
    expect(shouldStopOut({ entryPriceUsd: 0.5, marketPriceUsd: 0.94, openQty: 10, runAtEntryPct: 10 }, P)).toBe(false)
  })

  it('never fires without a live price — silence is not a fall', () => {
    // The one thing worse than holding a loser is selling a healthy position on
    // a number no second source confirmed. A $15.06 position once left at a
    // tenth of a cent because two feeds disagreed about the unit.
    expect(shouldStopOut(held({ marketPriceUsd: null }), P)).toBe(false)
    expect(shouldStopOut(held({ marketPriceUsd: 0 }), P)).toBe(false)
    expect(shouldStopOut(held({ marketPriceUsd: -1 }), P)).toBe(false)
  })

  it('has nothing to stop out of when nothing is held', () => {
    expect(shouldStopOut(held({ openQty: 0, marketPriceUsd: 0.001 }), P)).toBe(false)
  })

  it('is disabled by a zero share, which is a real value and not "unset"', () => {
    // The third time this project has had to say it out loud. A strategy that
    // never stops out is the reference behaviour, and asking for it must not
    // quietly hand back a default.
    expect(shouldStopOut(held({ marketPriceUsd: 0.000001 }), { ...P, shareOfRun: 0, minStopPct: 0 })).toBe(false)
  })

  it('fires on a collapse as readily as on the threshold', () => {
    expect(shouldStopOut(held({ marketPriceUsd: 0.0000001 }), P)).toBe(true)
  })

  it('reports how far under water it is, for the alert and the audit trail', () => {
    expect(drawdownPct(held({ marketPriceUsd: 0.009 }))!).toBeCloseTo(-10, 9)
    expect(drawdownPct(held({ marketPriceUsd: null }))).toBeNull()
  })
})

describe('a stop in DOLLARS, and only dollars', () => {
  // *Ponele un SL de 0.10 centavos, todo lo que caiga a partir de ahí salte,
  // inmediatamente.* And, when the first version kept a percentage beside it:
  // *no quiero que mires el porcentaje cuando detecte 0.10 SL.*
  //
  // So when a dollar limit is set it is the WHOLE rule. No flat percent, no
  // 1:4 derivation, no ceiling: the position has lost ten cents or it has not.
  //
  // Price only, never the toll. A position is born about ten cents under
  // water — the buy's own cost — so a limit that counted costs would sell every
  // position the instant it was bought. The rule is about the token falling.

  const tenCents = { ...FLAT_ONE_PCT_STOP, maxLossUsd: 0.1 }
  const at = (price: number | null, qty = 15): StopLossInput => ({
    entryPriceUsd: 1, marketPriceUsd: price, openQty: qty, runAtEntryPct: null,
  })

  it('cuts once the position has lost ten cents', () => {
    // 15 × (1 − 0.993) = $0.105
    expect(shouldStopOut(at(0.993), tenCents)).toBe(true)
  })

  it('holds at nine cents', () => {
    // 15 × (1 − 0.994) = $0.09
    expect(shouldStopOut(at(0.994), tenCents)).toBe(false)
  })

  it('does not look at the percentage at all', () => {
    // A $5 position down 1.5% has lost seven and a half cents. The 1% flat
    // stop beside it WOULD have cut — and must not, because the operator said
    // not to look. Dollars decide alone.
    expect(shouldStopOut(at(0.985, 5), tenCents)).toBe(false)
    expect(shouldStopOut(at(0.985, 5), FLAT_ONE_PCT_STOP)).toBe(true)
  })

  it('never fires on silence', () => {
    expect(shouldStopOut(at(null), tenCents)).toBe(false)
  })

  it('leaves the percent stop exactly as it was when no dollar limit is set', () => {
    expect(shouldStopOut(at(0.993), FLAT_ONE_PCT_STOP)).toBe(false)
    expect(shouldStopOut(at(0.989), FLAT_ONE_PCT_STOP)).toBe(true)
  })
})

