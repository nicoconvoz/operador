import { describe, it, expect } from 'vitest'
import { risingAcrossWindows, unreportedWindows } from './momentum.js'
import { type WindowedChangePct } from './snapshot.js'

const change = (over: Partial<WindowedChangePct> = {}): WindowedChangePct => ({
  m5: 1, h1: 2, h6: 3, h24: 10, ...over,
})

describe('risingAcrossWindows — green all the way down', () => {
  // The operator's rule: *mirá las últimas 4 horas, que no haya bajado de 0% y
  // que se haya incrementado en el total del tiempo hasta los 5m.* Four hours
  // is not a window anyone reports, so it reads the two that bracket it.

  it('admits a token green on all three windows', () => {
    expect(risingAcrossWindows(change())).toBe(true)
  })

  it('refuses one falling in ANY of them', () => {
    expect(risingAcrossWindows(change({ m5: -0.1 }))).toBe(false)
    expect(risingAcrossWindows(change({ h1: -0.1 }))).toBe(false)
    expect(risingAcrossWindows(change({ h6: -0.1 }))).toBe(false)
  })

  it('refuses a FLAT window — zero is not a rise', () => {
    // *Que no haya bajado de 0%* and *que se haya incrementado* are two
    // conditions, and the second one excludes standing still. A token that has
    // not moved has not given a reason to buy it.
    expect(risingAcrossWindows(change({ m5: 0 }))).toBe(false)
  })

  it('ignores the DAY entirely', () => {
    // The rule is about the last four hours. A token down 40% since yesterday
    // that has been climbing all morning is exactly the bottom-turning shape
    // the near windows exist to catch, and the day would veto it.
    expect(risingAcrossWindows(change({ h24: -40 }))).toBe(true)
  })

  it('refuses an UNREPORTED window, and this is the one place silence fails', () => {
    // Everywhere else in this scanner a missing measurement leaves the gate
    // silent, because the gate looks for DANGER and absence of evidence is not
    // evidence of danger.
    //
    // Here the question is inverted: not *is there a reason to refuse* but *is
    // there a reason to BUY*, and there is no such thing as an unmeasured
    // reason to buy. Measured live, 36 of 239 liquid tokens carried no `m5` at
    // all — mostly priced through GeckoTerminal, which does not report it.
    // Admitting those would be buying on a provider's silence.
    expect(risingAcrossWindows(change({ m5: null }))).toBe(false)
    // A window the provider simply did not include is the normal shape of this.
    expect(risingAcrossWindows({ h1: 2, h6: 3, h24: 10 })).toBe(false)
    expect(risingAcrossWindows(change({ h1: null }))).toBe(false)
    expect(risingAcrossWindows(change({ h6: null }))).toBe(false)
  })

  it('does not care HOW big the rise is', () => {
    // Argued once already for `momentum`: there is no percentage at which a
    // rise becomes "a rise", so a threshold there is a guess wearing the
    // clothes of a measurement. Zero is not a guess.
    expect(risingAcrossWindows(change({ m5: 0.01, h1: 0.01, h6: 0.01 }))).toBe(true)
    expect(risingAcrossWindows(change({ m5: 1248, h1: 690, h6: 690 }))).toBe(true)
  })

  it('admits the tokens that were running, which is the point and the cost', () => {
    // Measured live, and stated rather than discovered later: this rule buys
    // the top of a vertical as happily as the start of a climb. HOJAK was up
    // 1248% in five minutes and passes. What is supposed to answer that is the
    // EXIT, not the door.
    const hojak = { m5: 1248, h1: 690, h6: 690, h24: null }
    expect(risingAcrossWindows(hojak)).toBe(true)
  })
})

describe('unreportedWindows — a refusal the screen can explain', () => {
  it('names which windows nobody measured', () => {
    expect(unreportedWindows({ m5: null, h1: 2, h24: 10 } as never)).toEqual(['h6', 'm5'])
  })

  it('says nothing when every window was measured, however red', () => {
    // A token refused for FALLING and one refused because a provider was quiet
    // are the same verdict and completely different facts. The screen has to
    // tell them apart, and this project has paid for that confusion more than
    // once.
    expect(unreportedWindows(change({ m5: -5, h1: -5, h6: -5 }))).toEqual([])
  })
})
