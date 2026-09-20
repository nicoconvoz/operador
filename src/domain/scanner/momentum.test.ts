import { describe, it, expect } from 'vitest'
import { risingAcrossWindows, unreportedWindows, DEFAULT_MOMENTUM_POLICY } from './momentum.js'
import { type WindowedChangePct } from './snapshot.js'

const P = DEFAULT_MOMENTUM_POLICY
const change = (over: Partial<WindowedChangePct> = {}): WindowedChangePct => ({
  m5: 1, h1: 2, h6: 3, h24: 10, ...over,
})

describe('the rule — it ran today and it has not turned', () => {
  // The operator's words: *que en el último día haya subido más del 5% y en la
  // última hora todavía sea positivo.*
  //
  // Two windows answering two different questions, and the conjunction is the
  // whole idea. The DAY says a move happened at all, with a threshold, because
  // a token up 0.2% has not done anything worth calling a move. The HOUR says
  // it has not already turned — and it has NO threshold, because "still
  // positive" is exactly a question about the sign.

  it('admits one up more than 5% today with the hour still green', () => {
    expect(risingAcrossWindows(change({ h24: 10, h1: 2 }), P)).toBe(true)
  })

  it('refuses one that ran today but is turning NOW', () => {
    // The case the hour exists for. Up 40% since yesterday and falling this
    // hour is a top rolling over, and the engine would be buying the roll.
    expect(risingAcrossWindows(change({ h24: 40, h1: -0.1 }), P)).toBe(false)
  })

  it('refuses one rising now that has not moved on the day', () => {
    // The mirror case. Five percent is the operator's line between a move and
    // an ordinary wobble, and below it the hour is noise on a flat token.
    expect(risingAcrossWindows(change({ h24: 4.9, h1: 5 }), P)).toBe(false)
  })

  it('takes FIVE as the line, strictly above', () => {
    expect(risingAcrossWindows(change({ h24: 5 }), P)).toBe(false)
    expect(risingAcrossWindows(change({ h24: 5.01 }), P)).toBe(true)
  })

  it('takes the hour strictly above ZERO — flat is not still rising', () => {
    expect(risingAcrossWindows(change({ h1: 0 }), P)).toBe(false)
    expect(risingAcrossWindows(change({ h1: 0.01 }), P)).toBe(true)
  })

  it('ignores the six hours and the five minutes entirely', () => {
    // The previous rule read h6 and m5 and this one does not. A token can have
    // dipped six hours ago or paused in the last five minutes; neither is the
    // question the operator is asking.
    expect(risingAcrossWindows({ m5: -50, h1: 2, h6: -90, h24: 10 }, P)).toBe(true)
  })

  it('refuses an UNREPORTED window, and this is the one place silence fails', () => {
    // Everywhere else in this scanner a missing measurement leaves the gate
    // silent, because the gate looks for DANGER and absence of evidence is not
    // evidence of danger.
    //
    // Here the question is inverted: not *is there a reason to refuse* but *is
    // there a reason to BUY*, and there is no such thing as an unmeasured
    // reason to buy.
    expect(risingAcrossWindows(change({ h24: null }), P)).toBe(false)
    expect(risingAcrossWindows(change({ h1: null }), P)).toBe(false)
    expect(risingAcrossWindows({ h1: 2, h6: 3, h24: 10 }, P)).toBe(true)
  })

  it('has no upper bound, which is the point and the cost', () => {
    // Measured live in the sweep this rule was sized on, the strongest readings
    // were NTDA at 3,706,097% and USDF at 1,443,687% — not moves, but pools too
    // young to have a day, reporting the change since inception. The rule
    // admits them and nothing here stops it.
    //
    // What does stop it is `minAgeHours`, which survives *anulá todos los
    // filtros* precisely because it is not a filter on the token: you cannot
    // read a 24-hour window on something younger than 24 hours. And
    // `priceMismatch` catches the rest, being a SAFETY gate.
    expect(risingAcrossWindows({ m5: null, h1: 4.4, h6: null, h24: 3_706_097 }, P)).toBe(true)
  })
})

describe('unreportedWindows — a refusal the screen can explain', () => {
  it('names the windows the rule reads and nobody measured', () => {
    expect(unreportedWindows({ m5: 1, h1: null, h6: 3, h24: null })).toEqual(['h24', 'h1'])
  })

  it('says nothing about the windows the rule does not read', () => {
    // A token refused for FALLING and one refused because a provider was quiet
    // are the same verdict and completely different facts. Naming h6 or m5 here
    // would send the reader after a window that decides nothing.
    expect(unreportedWindows({ m5: null, h1: 2, h6: null, h24: 10 })).toEqual([])
  })
})
