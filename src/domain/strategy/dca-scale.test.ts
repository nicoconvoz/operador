import { describe, it, expect } from 'vitest'
import { dcaScale, measuredDcaScale, dropLabel, scaledDropPct, volatilityPct, volatilityBefore, DEFAULT_DCA_SCALE_POLICY } from './dca-scale.js'

/**
 * *Confío más en mi criterio que en tus cálculos: hacé que el piso de los DCA
 * sea más largo y más separado para las volátiles, y más cortos y rápidos para
 * las tranquilas.* The more a token moves, the WIDER its rungs:
 * `scale = clamp(sqrt(vol / 2.7), 0.5, 3)`, each drop times it, never past 90%.
 */
const BASE = [10, 15, 20, 25, 30]
const ladderAt = (volPct: number | null) => BASE.map((drop) => scaledDropPct(drop, dcaScale(volPct)))

describe('dcaScale — the more it moves, the wider the rungs', () => {
  it('leaves the base drops alone at the median volatility, 2.7%', () => {
    expect(dcaScale(2.7)).toBe(1)
    expect(ladderAt(2.7)).toEqual(BASE)
  })

  it('tightens a CALM token: 1% a bar buys at 6.1 / 9.1 / 12.2 / 15.2 / 18.3', () => {
    expect(dcaScale(1)).toBeCloseTo(0.609, 3)
    expect(ladderAt(1).map((d) => Number(d.toFixed(1)))).toEqual([6.1, 9.1, 12.2, 15.2, 18.3])
  })

  it('spreads a VOLATILE token: 10% a bar waits at 19.2 / 28.9 / 38.5 / 48.1 / 57.7', () => {
    expect(dcaScale(10)).toBeCloseTo(1.925, 3)
    expect(ladderAt(10).map((d) => Number(d.toFixed(1)))).toEqual([19.2, 28.9, 38.5, 48.1, 57.7])
  })

  it('caps the spread at three times, and no rung past 90%', () => {
    expect(dcaScale(50)).toBe(3)
    expect(ladderAt(50)).toEqual([30, 45, 60, 75, 90])
    expect(scaledDropPct(40, 3)).toBe(90)
  })

  it('floors the tightening at half', () => {
    expect(dcaScale(0.1)).toBe(0.5)
    expect(ladderAt(0.1)).toEqual([5, 7.5, 10, 12.5, 15])
  })

  it('is ONE when nothing was measured — silence is not evidence', () => {
    expect(dcaScale(null)).toBe(1)
    expect(dcaScale(Number.NaN)).toBe(1)
    expect(dcaScale(Number.POSITIVE_INFINITY)).toBe(1)
    expect(dcaScale(-1)).toBe(1)
    // A day of identical closes is a feed repeating itself over empty bars far
    // more often than a token that did not move.
    expect(dcaScale(0)).toBe(1)
    expect(ladderAt(null)).toEqual(BASE)
  })

  it('tells a caller that stores it "nobody knows" apart from "measured, and ordinary"', () => {
    expect(measuredDcaScale(2.7)).toBe(1)
    expect(measuredDcaScale(10)).toBeCloseTo(1.925, 3)
    for (const silent of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(measuredDcaScale(silent)).toBeNull()
  })
})

describe('dropLabel — the line as the operator reads it', () => {
  it('keeps a whole number whole and rounds the rest to one decimal', () => {
    expect(dropLabel(10)).toBe('10')
    expect(dropLabel(scaledDropPct(10, dcaScale(10)))).toBe('19.2')
    expect(dropLabel(scaledDropPct(30, dcaScale(1)))).toBe('18.3')
  })
})

describe('volatilityPct — the swing of the 15-minute log returns', () => {
  it('measures a token that moves ±1% every bar at 1%', () => {
    // Up 1% then back, over and over: every log return is ±ln(1.01).
    const closes = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? 1 : 1.01))
    expect(volatilityPct(closes)).toBeCloseTo(Math.log(1.01) * 100, 9)
  })

  it('is the deviation around ZERO, the measure the replay ran', () => {
    // A steady climb of 1% a bar has no spread around its own mean and still
    // moves 1% a bar. The replay measured sqrt(mean(r²)), so this does too.
    const closes = Array.from({ length: 8 }, (_, i) => 1.01 ** i)
    expect(volatilityPct(closes)).toBeCloseTo(Math.log(1.01) * 100, 9)
  })

  it('needs five returns — six closes — or it says nothing', () => {
    expect(volatilityPct([1, 1.01, 1, 1.01, 1])).toBeNull()
    expect(volatilityPct([1, 1.01, 1, 1.01, 1, 1.01])).not.toBeNull()
    expect(volatilityPct([])).toBeNull()
  })

  it('says nothing about a series with a close it cannot read', () => {
    expect(volatilityPct([1, 1.01, 0, 1.01, 1, 1.01, 1])).toBeNull()
    expect(volatilityPct([1, 1.01, Number.NaN, 1.01, 1, 1.01, 1])).toBeNull()
  })
})

describe('volatilityBefore — only the bars that had CLOSED in the 24 hours before', () => {
  const BAR = 15 * 60_000
  const DAY = 24 * 60 * 60_000
  // Two days of 15m bars, calm (±1%) the first day and wild (±10%) the second.
  const bars = 192
  const time = Array.from({ length: bars }, (_, i) => i * BAR)
  const close = time.map((_, i) => (i < 96 ? (i % 2 === 0 ? 1 : 1.01) : (i % 2 === 0 ? 1 : 1.1)))

  it('reads the calm day for a buy at the end of it', () => {
    expect(volatilityBefore({ time, close }, DAY, BAR)).toBeCloseTo(Math.log(1.01) * 100, 9)
  })

  it('reads the wild day for a buy at the end of it', () => {
    expect(volatilityBefore({ time, close }, 2 * DAY, BAR)).toBeCloseTo(Math.log(1.1) * 100, 9)
  })

  it('never reads a bar that closed AFTER the buy', () => {
    // A bar opening at 23:45 closes at the buy, and counts; one opening at
    // midnight closes a quarter of an hour after it, and does not.
    const spike: number[] = [...close]
    spike[96] = 100
    expect(volatilityBefore({ time, close: spike }, DAY, BAR)).toBeCloseTo(Math.log(1.01) * 100, 9)
  })

  it('says nothing before the candles reach far enough back', () => {
    expect(volatilityBefore({ time, close }, 4 * BAR, BAR)).toBeNull()
  })

  it('looks back 24 hours by default', () => {
    expect(DEFAULT_DCA_SCALE_POLICY.windowMs).toBe(DAY)
    expect(DEFAULT_DCA_SCALE_POLICY.medianVolPct).toBe(2.7)
  })
})
