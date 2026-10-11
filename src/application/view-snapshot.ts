/**
 * What the screen reads, written by the engine.
 *
 * *Que esto lo maneje GitHub y que Vercel sólo sea un visor de lo que hace
 * GitHub* (2026-10-11). The dashboard polled every ten seconds and re-read the
 * book, the tape and the last scan from Postgres every two minutes on every
 * Vercel instance — 5.1 of Supabase's 5 GB of monthly egress, with a week of
 * the cycle still to go. The engine already holds all of it in memory, so it
 * writes it out instead (`takeViewSnapshot`), the runtime publishes the file,
 * and the dashboard answers its reads from that file (`readsFromSnapshot`).
 *
 * One shape for both ends, so the screen and the engine cannot disagree about
 * what a read returns. JSON-safe: the blacklist travels as a list.
 */

import type { DailyPnl } from '../domain/reporting/daily-pnl.js'
import type { EngineCheckpoint, PersistedFill, PersistedPosition, PersistedScan, StatePort } from '../domain/persistence/store.js'
import { LOG_READ_DAYS } from './daily-log.js'

export interface ViewSnapshot {
  readonly version: 1
  /** When the engine wrote it, in epoch milliseconds. */
  readonly at: number
  readonly positions: readonly PersistedPosition[]
  readonly fills: readonly PersistedFill[]
  /** The newest scan of every chain. */
  readonly scans: readonly PersistedScan[]
  readonly checkpoint: EngineCheckpoint | null
  readonly blacklist: readonly string[]
  /** The day log, `LOG_READ_DAYS` of it — the one read the screen makes. */
  readonly days: readonly DailyPnl[]
}

type ViewReads = Pick<
  StatePort,
  'loadPositions' | 'allFills' | 'latestScansByChain' | 'latestScan' | 'loadCheckpoint' | 'blacklisted' | 'dailyPnl'
>

/** Everything the screen reads, from the engine's own store. */
export async function takeViewSnapshot(store: ViewReads, at: number): Promise<ViewSnapshot> {
  const [positions, fills, scans, checkpoint, blacklist, days] = await Promise.all([
    store.loadPositions(),
    store.allFills(),
    store.latestScansByChain(),
    store.loadCheckpoint(),
    store.blacklisted(),
    store.dailyPnl(LOG_READ_DAYS),
  ])
  return { version: 1, at, positions, fills, scans, checkpoint, blacklist: [...blacklist], days }
}

/**
 * The same reads, answered from a snapshot. The latest scan is the newest of
 * the chains' — what the store's own `latestScan` returns — so it costs no
 * second copy. A day log asked for a different length gets what there is.
 */
export function readsFromSnapshot(snapshot: ViewSnapshot): ViewReads {
  const newest = [...snapshot.scans].sort((a, b) => b.scannedAt - a.scannedAt)[0] ?? null
  return {
    loadPositions: async () => snapshot.positions,
    allFills: async () => snapshot.fills,
    latestScansByChain: async () => snapshot.scans,
    latestScan: async () => newest,
    loadCheckpoint: async () => snapshot.checkpoint,
    blacklisted: async () => new Set(snapshot.blacklist),
    dailyPnl: async (limit: number) => snapshot.days.slice(0, limit),
  }
}

/**
 * When to publish: on the first pass, then once `everyMs` has passed since the
 * last publish that WORKED; never two at once; never fatal. A failed publish
 * is retried on the next pass — the screen going stale is the only cost, and
 * it says how old its figures are.
 */
export function viewPublisher(deps: {
  readonly take: () => Promise<unknown>
  readonly publish: (content: string) => Promise<void>
  readonly everyMs: number
  readonly now: () => number
  readonly onError: (error: unknown) => void
}): { maybePublish(): Promise<void> } {
  let lastAt: number | null = null
  let busy = false
  return {
    async maybePublish() {
      if (busy) return
      const at = deps.now()
      if (lastAt !== null && at - lastAt < deps.everyMs) return
      busy = true
      try {
        await deps.publish(JSON.stringify(await deps.take()))
        lastAt = at
      } catch (error) {
        deps.onError(error)
      } finally {
        busy = false
      }
    },
  }
}

/**
 * The screen's reads, answered from the published view: fetched at most once
 * per `everyMs`, shared by every read that asks inside the window. When it
 * cannot be read the last good view still answers, and with none at all the
 * reads go to `fallback` — the database — so the screen is never empty. A
 * failure is never remembered: the next read tries the view again.
 *
 * `writtenAt` is when the ENGINE wrote what is on the screen, so the screen
 * can say how old its figures are; null while it is reading the database.
 */
export function remoteViewReads(deps: {
  readonly load: () => Promise<ViewSnapshot>
  readonly fallback: ViewReads
  readonly everyMs: number
  readonly now: () => number
}): ViewReads & { writtenAt(): number | null } {
  let good: { reads: ViewReads; at: number; fetchedAt: number } | null = null
  let inFlight: Promise<ViewReads | null> | null = null

  const current = (): Promise<ViewReads | null> => {
    if (good && deps.now() - good.fetchedAt < deps.everyMs) return Promise.resolve(good.reads)
    inFlight ??= deps
      .load()
      .then((snapshot) => {
        good = { reads: readsFromSnapshot(snapshot), at: snapshot.at, fetchedAt: deps.now() }
        return good.reads
      })
      .catch(() => good?.reads ?? null)
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const via = <K extends keyof ViewReads>(key: K) =>
    (async (...args: Parameters<ViewReads[K]>) => {
      const reads = (await current()) ?? deps.fallback
      return (reads[key] as (...a: Parameters<ViewReads[K]>) => ReturnType<ViewReads[K]>)(...args)
    }) as ViewReads[K]

  return {
    loadPositions: via('loadPositions'),
    allFills: via('allFills'),
    latestScansByChain: via('latestScansByChain'),
    latestScan: via('latestScan'),
    loadCheckpoint: via('loadCheckpoint'),
    blacklisted: via('blacklisted'),
    dailyPnl: via('dailyPnl'),
    writtenAt: () => good?.at ?? null,
  }
}
