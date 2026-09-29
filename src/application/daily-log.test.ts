import { describe, it, expect } from 'vitest'
import { buildDailyLog, dailyLogRows, dataSince, dayActivity, activityAverages, resultAt, uptimeText, DAY_BAR_EDGE_USD, LOG_DAYS, LOG_READ_DAYS } from './daily-log.js'
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
    expect(log).toEqual({ days: [], runningSince: null, uptime: null, averages: null })
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

describe('resultAt — where the day’s result sits on a bar from −100 to +100 dollars', () => {
  it('the edges are fixed at −100 and +100 dollars', () => {
    expect(DAY_BAR_EDGE_USD).toBe(100)
  })

  it('a day that made nothing sits in the middle', () => {
    expect(resultAt(0)).toBe(50)
  })

  it('a gain goes right toward green, a loss left toward red, by how much', () => {
    expect(resultAt(50)).toBe(75)
    expect(resultAt(100)).toBe(100)
    expect(resultAt(-50)).toBe(25)
    expect(resultAt(-100)).toBe(0)
  })

  it('a small result stays near the middle', () => {
    expect(resultAt(1)).toBe(50.5)
    expect(resultAt(-2)).toBe(49)
  })

  it('a day past either edge stays on the edge', () => {
    expect(resultAt(250)).toBe(100)
    expect(resultAt(-180)).toBe(0)
  })
})

describe('dayActivity — what each day DID, read off the tape', () => {
  // *Debe haber alguna clase de promedio de operaciones por día que vamos a
  // descubrir.* The operator. Counted from the fills the screen already reads,
  // so it needs no engine change and no relaunch.
  const at = (iso: string) => Date.parse(iso)
  const buy = (id: string, time: number): PersistedFill => ({
    positionId: id, orderId: 'Entry', side: 'buy', time, price: 1, qty: 5, costUsd: 0.04, comment: '🟢 Entry', idempotencyKey: `${id}:b:${time}`,
  })
  const sell = (id: string, time: number, comment: string, lot = 'Entry'): PersistedFill => ({
    positionId: id, orderId: lot, side: 'sell', time, price: 1.1, qty: 5, costUsd: 0.04, comment, idempotencyKey: `${id}:s:${lot}:${time}`,
  })

  it('counts each buy, and a sale of five lots at one instant as ONE close', () => {
    // SDOG sold its five lots in one TP: five sell fills, one close.
    const close = at('2026-09-29T19:45:00Z')
    const fills = [
      buy('sdog', at('2026-09-29T18:29:00Z')), buy('sdog', at('2026-09-29T18:42:00Z')), buy('sdog', at('2026-09-29T18:58:00Z')),
      ...['Entry', 'DCA-1', 'DCA-2', 'DCA-3', 'DCA-4'].map((lot) => sell('sdog', close, '🏁 Exit', lot)),
    ]
    expect(dayActivity(fills).get('2026-09-29')).toEqual({ buys: 3, closes: 1, tp: 1, gainLock: 0, frozen: 0, death: 0, other: 0 })
  })

  it('names each close by the exit that took it', () => {
    const t = at('2026-09-29T15:00:00Z')
    const fills = [
      sell('a', t, '🏁 Exit'), sell('b', t + 1, '🔐 Piso de ganancia'), sell('c', t + 2, '❄️ Salida por congelamiento'),
      sell('d', t + 3, '☠️ Death Exit'), sell('e', t + 4, '🔁 Rotación'),
    ]
    expect(dayActivity(fills).get('2026-09-29')).toEqual({ buys: 0, closes: 5, tp: 1, gainLock: 1, frozen: 1, death: 1, other: 1 })
  })

  it('counts the fixed TP as a take-profit, never as "other"', () => {
    // *Poné un TP fijo al 12.5% del promedio.* It replaces the strategy's own
    // exit in practice, so the day's TP count is both of them.
    const t = at('2026-09-29T15:00:00Z')
    const fills = [sell('a', t, '🏁 Exit'), sell('b', t + 1, '🎯 TP fijo'), sell('b2', t + 2, '🎯 TP fijo', 'DCA-1')]
    expect(dayActivity(fills).get('2026-09-29')).toEqual({ buys: 0, closes: 3, tp: 3, gainLock: 0, frozen: 0, death: 0, other: 0 })
  })

  it('files a fill under its Buenos Aires day, like the result it sits beside', () => {
    // 02:00 UTC on the 30th is still the 29th in Buenos Aires.
    const days = dayActivity([buy('x', at('2026-09-30T02:00:00Z')), buy('y', at('2026-09-30T04:00:00Z'))])
    expect(days.get('2026-09-29')!.buys).toBe(1)
    expect(days.get('2026-09-30')!.buys).toBe(1)
  })

  it('hangs the counts on each day of the log, zeros where nothing happened', () => {
    const activity = dayActivity([buy('x', at('2026-09-28T15:00:00Z'))])
    const rows = dailyLogRows([day('2026-09-27', 0, 1), day('2026-09-28', 1, 2)], '2026-09-28', LOG_DAYS, activity)
    expect(rows[0]!.activity).toEqual({ buys: 1, closes: 0, tp: 0, gainLock: 0, frozen: 0, death: 0, other: 0 })
    expect(rows[1]!.activity).toEqual({ buys: 0, closes: 0, tp: 0, gainLock: 0, frozen: 0, death: 0, other: 0 })
  })
})

describe('activityAverages — the average day, over FINISHED days only', () => {
  const act = (buys: number, closes: number, tp: number) => ({ buys, closes, tp, gainLock: 0, frozen: closes - tp, death: 0, other: 0 })
  const row = (d: string, isToday: boolean, a: ReturnType<typeof act>) => ({ day: d, isToday, resultUsd: 0, closeUsd: 0, minUsd: 0, maxUsd: 0, activity: a })

  it('averages the finished days and leaves today out — a day half done is not a day', () => {
    const avg = activityAverages([row('2026-10-01', true, act(99, 99, 99)), row('2026-09-30', false, act(40, 10, 8)), row('2026-09-29', false, act(20, 6, 4))])
    expect(avg).toEqual({ days: 2, buys: 30, closes: 8, tp: 6, frozen: 2 })
  })

  it('is null until one day has finished', () => {
    expect(activityAverages([row('2026-09-29', true, act(5, 1, 1))])).toBeNull()
    expect(activityAverages([])).toBeNull()
  })
})
