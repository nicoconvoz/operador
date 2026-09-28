import { describe, it, expect } from 'vitest'
import { buildDailyLog, dailyLogRows, dataSince, uptimeText, LOG_DAYS, LOG_READ_DAYS } from './daily-log.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { type DailyPnl } from '../domain/reporting/daily-pnl.js'
import { type PersistedFill } from '../domain/persistence/store.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const day = (d: string, open: number, close: number, over: Partial<DailyPnl> = {}): DailyPnl => ({
  day: d, openUsd: open, closeUsd: close, minUsd: Math.min(open, close) - 1, maxUsd: Math.max(open, close) + 1,
  firstAt: Date.parse(`${d}T12:00:00Z`), lastAt: Date.parse(`${d}T20:00:00Z`), samples: 10, ...over,
})

describe('dailyLogRows — one row per day, newest first', () => {
  it('a day’s result is its close minus the previous day’s close', () => {
    const rows = dailyLogRows([day('2026-09-27', 0, 10), day('2026-09-28', 11, 7)], '2026-09-28')
    expect(rows[0]).toMatchObject({ day: '2026-09-28', resultUsd: 7 - 10, closeUsd: 7 })
  })

  it('the first day ever recorded has no previous close, so it is measured from its own open', () => {
    const rows = dailyLogRows([day('2026-09-27', 2, 10), day('2026-09-28', 11, 7)], '2026-09-28')
    expect(rows[1]).toMatchObject({ day: '2026-09-27', resultUsd: 10 - 2, closeUsd: 10 })
  })

  it('a gap in the days — the engine was off — measures from the last day it did record', () => {
    const rows = dailyLogRows([day('2026-09-20', 0, 4), day('2026-09-28', 5, 9)], '2026-09-28')
    expect(rows[0]!.resultUsd).toBe(9 - 4)
  })

  it('is newest first whatever order the store handed them in, and carries the range', () => {
    const rows = dailyLogRows([day('2026-09-28', 1, 2), day('2026-09-26', 0, 1), day('2026-09-27', 1, 1)], '2026-09-28')
    expect(rows.map((r) => r.day)).toEqual(['2026-09-28', '2026-09-27', '2026-09-26'])
    expect(rows[0]).toMatchObject({ minUsd: 0, maxUsd: 3 })
  })

  it('marks today, which is still being written', () => {
    const rows = dailyLogRows([day('2026-09-27', 0, 1), day('2026-09-28', 1, 2)], '2026-09-28')
    expect(rows.map((r) => r.isToday)).toEqual([true, false])
  })

  it(`shows at most ${LOG_DAYS} days, and the oldest shown still measures against the day before it`, () => {
    const records = Array.from({ length: LOG_READ_DAYS }, (_, i) => {
      const d = new Date(Date.parse('2026-01-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10)
      return day(d, i, i + 1)
    })
    const rows = dailyLogRows(records, '2026-12-31')
    expect(rows).toHaveLength(LOG_DAYS)
    // The oldest on screen is the second record, so its result is against the
    // first record's close — not its own open.
    expect(rows.at(-1)).toMatchObject({ day: '2026-01-02', resultUsd: 2 - 1 })
  })

  it('an empty log is an empty list', () => {
    expect(dailyLogRows([], '2026-09-28')).toEqual([])
  })
})

describe('uptimeText — how long the data has been running without a reset', () => {
  const since = Date.parse('2026-09-20T00:00:00Z')

  it('counts days and hours', () => {
    expect(uptimeText(since, since + 3 * HOUR)).toBe('Funcionando hace 0 días 3 h sin reiniciar')
    expect(uptimeText(since, since + DAY)).toBe('Funcionando hace 1 día 0 h sin reiniciar')
    expect(uptimeText(since, since + 5 * DAY + 12 * HOUR + 59 * 60_000)).toBe('Funcionando hace 5 días 12 h sin reiniciar')
  })

  it('says nothing when there is nothing to measure from', () => {
    expect(uptimeText(null, since)).toBeNull()
  })

  it('a clock slightly behind the data never counts backwards', () => {
    expect(uptimeText(since, since - 60_000)).toBe('Funcionando hace 0 días 0 h sin reiniciar')
  })
})

describe('dataSince — where the current data begins', () => {
  const fill = (time: number): PersistedFill => ({
    positionId: 'p', orderId: 'Entry', side: 'buy', time, price: 1, qty: 1, costUsd: 0, comment: 'Entry', idempotencyKey: `k${time}`,
  })

  it('the earliest fill, whatever order they arrive in', () => {
    expect(dataSince([fill(5_000), fill(2_000), fill(9_000)], [day('2026-09-28', 0, 1, { firstAt: 1_000 })])).toBe(2_000)
  })

  it('with no fills yet, the earliest day the engine recorded', () => {
    expect(dataSince([], [day('2026-09-28', 0, 1, { firstAt: 7_000 }), day('2026-09-27', 0, 1, { firstAt: 3_000 })])).toBe(3_000)
  })

  it('with neither, nothing', () => {
    expect(dataSince([], [])).toBeNull()
  })
})

describe('buildDailyLog — what the Log tab and the counter read', () => {
  const now = Date.parse('2026-09-28T15:00:00Z')

  it('reads the log and the tape, and names today in Buenos Aires', async () => {
    const store = new MemoryStore()
    await store.recordDailyPnl({ day: '2026-09-27', netUsd: 4, at: now - DAY })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 6, at: now - HOUR })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 5, at: now })
    await store.recordFill({
      positionId: 'p', orderId: 'Entry', side: 'buy', time: now - 2 * DAY - 3 * HOUR, price: 1, qty: 1, costUsd: 0,
      comment: 'Entry', idempotencyKey: 'k',
    })

    const log = await buildDailyLog(store, { now: () => now })

    expect(log.days.map((d) => [d.day, d.isToday, d.resultUsd, d.closeUsd])).toEqual([
      ['2026-09-28', true, 1, 5],
      ['2026-09-27', false, 0, 4],
    ])
    expect(log.runningSince).toBe(now - 2 * DAY - 3 * HOUR)
    expect(log.uptime).toBe('Funcionando hace 2 días 3 h sin reiniciar')
  })

  it('an untouched store has no days and no counter', async () => {
    const log = await buildDailyLog(new MemoryStore(), { now: () => now })
    expect(log).toEqual({ days: [], runningSince: null, uptime: null })
  })

  it(`asks the store for ${LOG_READ_DAYS} days, one more than it shows`, async () => {
    const store = new MemoryStore()
    const asked: number[] = []
    const read = store.dailyPnl.bind(store)
    store.dailyPnl = async (limit) => {
      asked.push(limit)
      return read(limit)
    }
    await buildDailyLog(store, { now: () => now })
    expect(asked).toEqual([LOG_READ_DAYS])
  })
})
