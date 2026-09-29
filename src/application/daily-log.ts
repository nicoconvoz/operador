import { tradingDay, type DailyPnl } from '../domain/reporting/daily-pnl.js'
import { type PersistedFill, type StatePort } from '../domain/persistence/store.js'

/**
 * The read model behind the Log tab and the "funcionando hace…" counter.
 *
 * *Agregale un nuevo botón que funcione de Log, para llevar el control de
 * cuánto va ganando cada día, el mínimo y el máximo de ese día también. Además
 * un contador para saber cuántos días lleva funcionando el programa sin
 * reiniciar los datos.*
 *
 * The engine writes the day rows; this only reads them. Every figure in a row
 * is the headline's own number — cobrada + sin cobrar − costos — as the engine
 * computed it with the same function the screen draws the headline with, so
 * the Log and the headline cannot disagree about what "up" means.
 */

/** Days on screen. A quarter of a year keeps the payload a few kilobytes. */
export const LOG_DAYS = 90
/** One more than is shown, so the oldest row on screen still has a previous day to measure against. */
export const LOG_READ_DAYS = LOG_DAYS + 1

export interface DailyLogRow {
  readonly day: string
  /** Today in Buenos Aires: still being written, one reading per cycle. */
  readonly isToday: boolean
  /** What the day made: its close minus the previous recorded day's close. */
  readonly resultUsd: number
  /** The book's cumulative net at the day's last reading — the Acumulado. */
  readonly closeUsd: number
  readonly minUsd: number
  readonly maxUsd: number
}

/**
 * The day bar's edges, in dollars: −100 at the red end, +100 at the green.
 *
 * Fixed, the operator's call. The first version scaled each day to its own
 * swing, which put a quiet +$1 day on the same green edge as a +$40 one; with
 * the same ends on every card, the dot's position alone compares two days.
 */
export const DAY_BAR_EDGE_USD = 100

/**
 * Where a day's result sits on a bar whose MIDDLE is zero, as a percent of the
 * bar: 50 for a day that made nothing, running right into the green as it
 * gains and left into the red as it loses, and pinned to the edge past
 * ±`DAY_BAR_EDGE_USD` — a day beyond the scale is still drawn, at its end.
 *
 * It replaced a bar that placed the close between the day's low and high, so a
 * losing day that closed near its own high was drawn on the green end.
 */
export function resultAt(resultUsd: number): number {
  if (!Number.isFinite(resultUsd)) return 50
  const at = 50 + (50 * resultUsd) / DAY_BAR_EDGE_USD
  return Math.min(100, Math.max(0, at))
}

export interface DailyLogView {
  readonly days: readonly DailyLogRow[]
  /** When the current data began, or null when there is none. See `dataSince`. */
  readonly runningSince: number | null
  /** "Funcionando hace N días H h sin reiniciar", or null to hide it. */
  readonly uptime: string | null
}

/**
 * One row per day, newest first, at most `limit`.
 *
 * A day's result is its close minus the PREVIOUS RECORDED day's close — the
 * difference between two readings of the same cumulative figure, which is what
 * the book made that day. Recorded, not calendar: a day the engine did not run
 * has no row, and the next day it did is measured from the last close anybody
 * saw, so the movement in between is counted once rather than lost.
 *
 * The first day ever recorded has no previous close, so it is measured from
 * its own OPEN — the first reading the engine took that day. On the day this
 * log was switched on that is not the day's whole story: the book had already
 * made what it made before the first reading, and that is in the Acumulado,
 * not in the day's result.
 */
export function dailyLogRows(records: readonly DailyPnl[], today: string, limit = LOG_DAYS): DailyLogRow[] {
  const oldestFirst = [...records].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const rows = oldestFirst.map((record, i) => {
    const previous = oldestFirst[i - 1]
    return {
      day: record.day,
      isToday: record.day === today,
      resultUsd: record.closeUsd - (previous === undefined ? record.openUsd : previous.closeUsd),
      closeUsd: record.closeUsd,
      minUsd: record.minUsd,
      maxUsd: record.maxUsd,
    }
  })
  return rows.reverse().slice(0, limit)
}

/**
 * Where the current data begins: the earliest fill, or — before anything was
 * ever bought — the earliest day the engine recorded. Null with neither.
 *
 * The FILLS first, because they are what a truncate resets and what every
 * dollar on the screen is built from. The day log only stands in when there are
 * no fills yet; a log that outlived a truncate (the old statement, from
 * memory) would otherwise report the age of a history the fills no longer
 * hold. With no fills, the rows read are the evidence — the newest
 * `LOG_READ_DAYS` of them, which only matters after three months of an engine
 * that never bought anything.
 */
export function dataSince(fills: readonly PersistedFill[], records: readonly DailyPnl[]): number | null {
  // A fold, never `Math.min(...times)`: the tape grows without bound, and
  // spreading it into arguments is how a long history overflows the stack.
  const earliest = (times: Iterable<number>): number | null => {
    let min: number | null = null
    for (const t of times) if (min === null || t < min) min = t
    return min
  }
  return earliest(fills.map((f) => f.time)) ?? earliest(records.map((r) => r.firstAt))
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * "Funcionando hace 5 días 12 h sin reiniciar". Whole days and whole hours,
 * both counted DOWN, so the counter never claims time that has not passed.
 *
 * Null when there is nothing to measure from — the screen hides it rather than
 * drawing "0 días" over an engine that never ran. A clock a little behind the
 * data reads as zero, never as a negative age.
 */
export function uptimeText(since: number | null, now: number): string | null {
  if (since === null) return null
  const elapsed = Math.max(0, now - since)
  const days = Math.floor(elapsed / DAY_MS)
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS)
  return `Funcionando hace ${days} ${days === 1 ? 'día' : 'días'} ${hours} h sin reiniciar`
}

export async function buildDailyLog(store: StatePort, options: { readonly now: () => number }): Promise<DailyLogView> {
  const now = options.now()
  // The tape is the same read the operations view makes, and on the dashboard
  // it comes out of the same cache — this costs the database nothing extra.
  const [records, fills] = await Promise.all([store.dailyPnl(LOG_READ_DAYS), store.allFills()])
  const runningSince = dataSince(fills, records)
  return {
    days: dailyLogRows(records, tradingDay(now)),
    runningSince,
    uptime: uptimeText(runningSince, now),
  }
}
