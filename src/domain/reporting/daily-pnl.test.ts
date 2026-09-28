import { describe, it, expect } from 'vitest'
import { tradingDay, dailySample, foldDailySample, type DailyPnl } from './daily-pnl.js'

describe('tradingDay — the operator’s calendar, not the server’s', () => {
  // *Cuánto va ganando cada día.* A day is the one he lives in: Buenos Aires,
  // three hours behind UTC all year. A runner in UTC closing "the day" at 21:00
  // local would split his evening across two rows.

  it('02:59 UTC is still the previous day in Buenos Aires', () => {
    expect(tradingDay(Date.parse('2026-09-28T02:59:59.999Z'))).toBe('2026-09-27')
  })

  it('03:00 UTC is midnight in Buenos Aires, and the new day', () => {
    expect(tradingDay(Date.parse('2026-09-28T03:00:00.000Z'))).toBe('2026-09-28')
  })

  it('an afternoon in UTC is the same date', () => {
    expect(tradingDay(Date.parse('2026-09-28T18:30:00Z'))).toBe('2026-09-28')
  })

  it('crosses a month and a year the same way', () => {
    expect(tradingDay(Date.parse('2027-01-01T02:00:00Z'))).toBe('2026-12-31')
    expect(tradingDay(Date.parse('2027-01-01T03:00:00Z'))).toBe('2027-01-01')
  })

  it('there is no summer time to trip over: January and July agree', () => {
    // Argentina has not observed DST since 2009. Pinned so nobody "fixes" it
    // with a zone database that disagrees on a server somewhere.
    expect(tradingDay(Date.parse('2027-01-15T02:59:00Z'))).toBe('2027-01-14')
    expect(tradingDay(Date.parse('2027-07-15T02:59:00Z'))).toBe('2027-07-14')
  })
})

describe('dailySample — one reading of the book, stamped with its day', () => {
  it('carries the figure, the moment, and the day that moment belongs to', () => {
    const at = Date.parse('2026-09-28T02:30:00Z')
    expect(dailySample(12.5, at)).toEqual({ day: '2026-09-27', netUsd: 12.5, at })
  })
})

describe('foldDailySample — a day is its first, last, lowest and highest reading', () => {
  const day = '2026-09-28'
  const T = Date.parse('2026-09-28T12:00:00Z')

  it('the first sample of a day sets every field', () => {
    expect(foldDailySample(null, { day, netUsd: 10, at: T })).toEqual<DailyPnl>({
      day, openUsd: 10, closeUsd: 10, minUsd: 10, maxUsd: 10, firstAt: T, lastAt: T, samples: 1,
    })
  })

  it('later samples keep the open, move the close, widen the range and count', () => {
    let row = foldDailySample(null, { day, netUsd: 10, at: T })
    row = foldDailySample(row, { day, netUsd: 4, at: T + 60_000 })
    row = foldDailySample(row, { day, netUsd: 15, at: T + 120_000 })
    row = foldDailySample(row, { day, netUsd: 12, at: T + 180_000 })
    expect(row).toEqual<DailyPnl>({
      day, openUsd: 10, closeUsd: 12, minUsd: 4, maxUsd: 15, firstAt: T, lastAt: T + 180_000, samples: 4,
    })
  })

  it('a sample that arrives LATE never moves the close backwards', () => {
    // Two writers, or a retry: the older reading must not overwrite the newer
    // close — and if it is older than the first, it becomes the open.
    let row = foldDailySample(null, { day, netUsd: 10, at: T })
    row = foldDailySample(row, { day, netUsd: 20, at: T + 120_000 })
    row = foldDailySample(row, { day, netUsd: 5, at: T + 60_000 })
    expect(row.closeUsd).toBe(20)
    expect(row.lastAt).toBe(T + 120_000)
    expect(row.minUsd).toBe(5)
    row = foldDailySample(row, { day, netUsd: 7, at: T - 60_000 })
    expect(row.openUsd).toBe(7)
    expect(row.firstAt).toBe(T - 60_000)
    expect(row.samples).toBe(4)
  })

  it('a sample on another day is never folded into this one', () => {
    const row = foldDailySample(null, { day, netUsd: 10, at: T })
    expect(() => foldDailySample(row, { day: '2026-09-29', netUsd: 11, at: T + 86_400_000 })).toThrow()
  })
})
