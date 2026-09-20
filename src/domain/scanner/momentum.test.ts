import { describe, it, expect } from 'vitest'
import { risingAcrossWindows, unreportedWindows, DEFAULT_MOMENTUM_POLICY } from './momentum.js'
import { type WindowedChangePct } from './snapshot.js'

const P = DEFAULT_MOMENTUM_POLICY
const change = (over: Partial<WindowedChangePct> = {}): WindowedChangePct => ({
  m5: 2, h1: 2, h6: 3, h24: 10, ...over,
})

describe('the rule — is it moving up RIGHT NOW', () => {
  // The operator's words: *no mira el día, mira los últimos 15 minutos: si
  // aumentó 1% para arriba queda, si no no.*
  //
  // Fifteen minutes does not exist in the market feed — it gives m5, h1, h6 and
  // h24 — and the only exact source is the candles, one throttled request per
  // token and up to fifteen minutes stale. Shown both, he chose m5: free,
  // current to the minute, and stricter rather than looser, because a token
  // that moves 1% inside five minutes is moving harder than one that takes
  // fifteen to do it.

  it('admits one up 1% in the last five minutes', () => {
    expect(risingAcrossWindows(change({ m5: 1 }), P)).toBe(true)
  })

  it('takes the 1% AT or above, not strictly above', () => {
    // *Si aumentó 1% para arriba queda.* One percent is in.
    expect(risingAcrossWindows(change({ m5: 1 }), P)).toBe(true)
    expect(risingAcrossWindows(change({ m5: 0.99 }), P)).toBe(false)
  })

  it('refuses one that is flat or falling now, however well it did today', () => {
    expect(risingAcrossWindows(change({ m5: 0, h24: 500 }), P)).toBe(false)
    expect(risingAcrossWindows(change({ m5: -3, h24: 500 }), P)).toBe(false)
  })

  it('IGNORES the day, which is the whole change', () => {
    // A token that ran 40% yesterday morning and has sat still since passes a
    // daily test while not moving at all. One that started moving four minutes
    // ago fails it and is exactly what this exists for.
    expect(risingAcrossWindows({ m5: 3, h1: -8, h6: -20, h24: -45 }, P)).toBe(true)
  })

  it('ignores the hour and the six hours too — one window, on purpose', () => {
    expect(risingAcrossWindows({ m5: 1.5, h1: -30, h6: -60, h24: null }, P)).toBe(true)
  })

  it('refuses an UNREPORTED window, and this is the one place silence fails', () => {
    // Everywhere else a missing measurement leaves a gate silent, because the
    // gate looks for DANGER and absence of evidence is not evidence of danger.
    // Here the question is inverted — is there a reason to BUY — and there is
    // no such thing as an unmeasured reason to buy. Measured live, 36 of 239
    // liquid tokens carried no m5 at all.
    expect(risingAcrossWindows(change({ m5: null }), P)).toBe(false)
    expect(risingAcrossWindows({ h1: 5, h6: 5, h24: 5 }, P)).toBe(false)
  })

  it('refuses the unmeasured even at a threshold of ZERO', () => {
    // A mutation test showed the null check surviving its own removal, and it
    // was right to: `null >= 1` is already false, because null coerces to zero.
    //
    // It stops being dead the moment the threshold is zero. `null >= 0` is
    // TRUE, and every token the provider was quiet about would walk straight
    // in. That is a plausible setting — it means "admit anything not falling" —
    // so the check is load-bearing rather than decorative.
    const anything = { minRisePct: 0 }
    expect(risingAcrossWindows({ m5: null, h1: 5, h6: 5, h24: 5 }, anything)).toBe(false)
    expect(risingAcrossWindows({ h1: 5, h6: 5, h24: 5 }, anything)).toBe(false)
    expect(risingAcrossWindows({ m5: 0, h1: 5, h6: 5, h24: 5 }, anything)).toBe(true)
  })

  it('has no upper bound, and the LIQUIDITY floor is what guards it', () => {
    // What the day used to buy was protection against noise: 1% over five
    // minutes on a dead pool can be a single trade. That job now belongs
    // entirely to the $100,000 liquidity floor — a pool that deep does not move
    // one percent on one trade.
    expect(risingAcrossWindows(change({ m5: 4_000 }), P)).toBe(true)
  })
})

describe('unreportedWindows — a refusal the screen can explain', () => {
  it('names the window when nobody measured it', () => {
    expect(unreportedWindows({ m5: null, h1: 2, h6: 3, h24: 10 })).toEqual(['m5'])
  })

  it('says nothing when it was measured, however red', () => {
    // A token refused for FALLING and one refused because a provider was quiet
    // are the same verdict and completely different facts.
    expect(unreportedWindows(change({ m5: -9 }))).toEqual([])
  })

  it('says nothing about windows the rule does not read', () => {
    expect(unreportedWindows({ m5: 2, h1: null, h6: null, h24: null })).toEqual([])
  })
})
