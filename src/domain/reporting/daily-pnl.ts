/**
 * The book's result, day by day.
 *
 * The operator's request: *un Log para llevar el control de cuánto va ganando
 * cada día, el mínimo y el máximo de ese día también.* The headline figure —
 * cobrada + sin cobrar − costos — is a running total that moves on every poll,
 * and a running total cannot answer "how did Tuesday go": it only knows now.
 *
 * So the engine writes it down. Every cycle folds one reading of that same
 * figure into the row of the day it was taken on, and a day is kept as four
 * numbers — its first reading, its last, its lowest and its highest. The
 * readings themselves are not kept: at one every eighty seconds that is a
 * thousand rows a day for four numbers anybody asks about.
 *
 * Pure. The clock is passed in, and the day is computed rather than asked of
 * a time-zone database.
 */

/**
 * Buenos Aires is UTC−3 all year: Argentina has not observed summer time since
 * 2009. A fixed offset is therefore exact, and it keeps the day key independent
 * of whatever zone data the runner or the browser happens to ship.
 */
const BUENOS_AIRES_OFFSET_MS = -3 * 60 * 60 * 1000

/**
 * The calendar day `at` falls on in Buenos Aires, as `YYYY-MM-DD`.
 *
 * The operator's day, not the server's. A runner in UTC would close "the day"
 * at nine in the evening local time and split every night across two rows.
 * The string sorts the way the days do, which is what lets the store order by
 * it.
 */
export function tradingDay(at: number): string {
  return new Date(at + BUENOS_AIRES_OFFSET_MS).toISOString().slice(0, 10)
}

/** One reading of the book's net, stamped with the day it belongs to. */
export interface DailyPnlSample {
  readonly day: string
  readonly netUsd: number
  readonly at: number
}

/** A day, as the store keeps it. Every figure is the book's cumulative net. */
export interface DailyPnl {
  readonly day: string
  /** The day's earliest reading. */
  readonly openUsd: number
  /** The day's latest reading — for today, whatever the engine last wrote. */
  readonly closeUsd: number
  readonly minUsd: number
  readonly maxUsd: number
  readonly firstAt: number
  readonly lastAt: number
  readonly samples: number
}

export const dailySample = (netUsd: number, at: number): DailyPnlSample => ({ day: tradingDay(at), netUsd, at })

/**
 * Folds one reading into its day. The reference for what the SQL upsert does,
 * and the rule the in-memory store runs.
 *
 * "First" and "last" are by the reading's TIME, not by the order the writes
 * arrive in. In order — which is every cycle of a single engine — the two are
 * the same: the open keeps the first value and the close takes the new one. Out
 * of order — two writers, a retry — a late, older reading must not drag the
 * close back to where the book was a minute ago. The same rule the position
 * ratchets run on: a stale write never undoes a newer one.
 */
export function foldDailySample(existing: DailyPnl | null, sample: DailyPnlSample): DailyPnl {
  if (existing === null) {
    return {
      day: sample.day,
      openUsd: sample.netUsd,
      closeUsd: sample.netUsd,
      minUsd: sample.netUsd,
      maxUsd: sample.netUsd,
      firstAt: sample.at,
      lastAt: sample.at,
      samples: 1,
    }
  }
  // A reading from another day belongs to another row. Folding it here would
  // hand one day's close to the next — the caller keyed the wrong row.
  if (existing.day !== sample.day) throw new Error(`a ${sample.day} sample cannot fold into ${existing.day}`)
  const earlier = sample.at < existing.firstAt
  const later = sample.at >= existing.lastAt
  return {
    day: existing.day,
    openUsd: earlier ? sample.netUsd : existing.openUsd,
    closeUsd: later ? sample.netUsd : existing.closeUsd,
    minUsd: Math.min(existing.minUsd, sample.netUsd),
    maxUsd: Math.max(existing.maxUsd, sample.netUsd),
    firstAt: earlier ? sample.at : existing.firstAt,
    lastAt: later ? sample.at : existing.lastAt,
    samples: existing.samples + 1,
  }
}
