import { describe, it, expect } from 'vitest'
import {
  dcaScale, measuredDcaScale, dropLabel, scaledDropPct, volatilityPct, volatilityBefore, DEFAULT_DCA_SCALE_POLICY,
  realtimeDcaScale, lastHourVolatilityPct, MEDIAN_VOL_5M_PCT, REALTIME_BAR_MS, REALTIME_DCA_SCALE_POLICY,
} from './dca-scale.js'

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

describe('realtimeDcaScale — the next rung, from how much the token moves NOW', () => {
  // *Que el próximo escalón DCA lo calcule por la cantidad de volatilidad que
  // tenga en ese preciso momento la moneda — si es mucha, escalón bien largo;
  // si es poca, escalón corto.* Then *tiempo real*: the last hour of CLOSED
  // 5-minute bars, against the median of that measure over the 336 entries.
  it('leaves the base drops alone at the median, 2.17% a 5-minute bar', () => {
    expect(MEDIAN_VOL_5M_PCT).toBe(2.17)
    expect(realtimeDcaScale(2.17)).toBe(1)
  })

  it('doubles the spacing at four times the median: sqrt(8.68 / 2.17) = 2', () => {
    expect(realtimeDcaScale(8.68)).toBeCloseTo(2, 12)
  })

  it('caps at three times the base drops and floors at half', () => {
    expect(realtimeDcaScale(100)).toBe(3)
    expect(realtimeDcaScale(0.01)).toBe(0.5)
  })

  it('is null when nothing was measured, so the caller falls back — silence is not evidence', () => {
    for (const silent of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(realtimeDcaScale(silent)).toBeNull()
  })
})

describe('lastHourVolatilityPct — the 5-minute bars that CLOSED in the last hour', () => {
  const BAR = 5 * 60_000
  const HOUR = 60 * 60_000
  // Two hours of 5-minute bars: calm (±1%) the first hour, wild (±10%) the second.
  const bars = 24
  const time = Array.from({ length: bars }, (_, i) => i * BAR)
  const close = time.map((_, i) => (i < 12 ? (i % 2 === 0 ? 1 : 1.01) : (i % 2 === 0 ? 1 : 1.1)))

  it('bars five minutes long, an hour back', () => {
    expect(REALTIME_BAR_MS).toBe(BAR)
    expect(REALTIME_DCA_SCALE_POLICY.windowMs).toBe(HOUR)
    expect(REALTIME_DCA_SCALE_POLICY.medianVolPct).toBe(MEDIAN_VOL_5M_PCT)
  })

  it('reads the calm hour at the end of it, and the wild one at the end of that', () => {
    expect(lastHourVolatilityPct({ time, close }, HOUR)).toBeCloseTo(Math.log(1.01) * 100, 9)
    expect(lastHourVolatilityPct({ time, close }, 2 * HOUR)).toBeCloseTo(Math.log(1.1) * 100, 9)
  })

  it('never reads the bar still being built', () => {
    // The bar opening at 1:00 closes at 1:05; asked at 1:04 it is still moving,
    // and a spike inside it is not yet a fact about the token.
    const spike: number[] = [...close]
    spike[12] = 100
    expect(lastHourVolatilityPct({ time, close: spike }, HOUR + 4 * 60_000)).toBeCloseTo(Math.log(1.01) * 100, 9)
  })

  it('never reads a bar that closed more than an hour ago', () => {
    // At 2:00 the bar that closed at 1:00 is an hour old and out; a crash in it
    // is the past, not the present.
    const old: number[] = [...close]
    old[11] = 100
    expect(lastHourVolatilityPct({ time, close: old }, 2 * HOUR)).toBeCloseTo(Math.log(1.1) * 100, 9)
  })

  it('needs five returns in the hour, or it says nothing', () => {
    // Six closes in the hour: five returns, enough. Five closes: not.
    expect(lastHourVolatilityPct({ time: time.slice(0, 6), close: close.slice(0, 6) }, 6 * BAR)).not.toBeNull()
    expect(lastHourVolatilityPct({ time: time.slice(0, 5), close: close.slice(0, 5) }, 5 * BAR)).toBeNull()
    expect(lastHourVolatilityPct({ time: [], close: [] }, HOUR)).toBeNull()
  })
})
