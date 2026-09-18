import { Pool } from 'pg'
import { PostgresStore } from '../../src/infrastructure/persistence/postgres-store.js'
import { cacheFor } from '../../src/application/read-cache.js'

/**
 * One pool for the whole app. Next.js reuses the module across requests, and
 * a pool created per request is how a free-tier database runs out of
 * connections at the worst possible moment.
 */
let pool: Pool | null = null
let cached: {
  scans: () => Promise<Awaited<ReturnType<PostgresStore['latestScansByChain']>>>
  scan: () => Promise<Awaited<ReturnType<PostgresStore['latestScan']>>>
  blacklist: () => Promise<Awaited<ReturnType<PostgresStore['blacklisted']>>>
  positions: () => Promise<Awaited<ReturnType<PostgresStore['loadPositions']>>>
  fills: () => Promise<Awaited<ReturnType<PostgresStore['allFills']>>>
  checkpoint: () => Promise<Awaited<ReturnType<PostgresStore['loadCheckpoint']>>>
} | null = null

/**
 * The SIX reads the dashboard makes, served from memory while their subject
 * cannot have changed.
 *
 * The page polls every ten seconds because that is how often the profit can
 * move — and the profit moves because of the PRICE feed, which is DexScreener
 * and not this database. Everything being re-read from Postgres in between
 * changes far more slowly: a scan lands once an hour, a position when the
 * engine ticks, and the blacklist almost never.
 *
 * Measured on the live project: each poll pulled the whole universe back as
 * JSONB — the response was 490 KB — 8,640 times a day. About **3.5 GB daily
 * against Neon's 5 GB MONTHLY transfer allowance**, so the free tier was gone
 * in thirty-four hours and took the engine's writes with it. An unattended
 * system whose store stops answering does not degrade, it stops.
 *
 * The windows are set by how fast each answer can actually change, not by
 * taste:
 *
 * | Read | Window | Because |
 * |---|---|---|
 * | `latestScansByChain`, `latestScan`, `blacklisted` | 15 min | a scan happens once an HOUR; this still refreshes four times inside one |
 * | `loadPositions`, `allFills`, `loadCheckpoint` | 2 min | the engine ticks every FIVE minutes |
 *
 * Both are finer than what they watch, and the arithmetic is what set them
 * rather than comfort: at 5 min and 60 s the bill came to 7.3 GB a month, which
 * is still over a 5 GB allowance. **A fix that lands just past the limit is not
 * a fix**, so the windows went to where the number has room to be wrong.
 *
 * **The screen does not get slower.** The figure is `qty × livePrice`: the
 * quantity comes from here and barely moves, the price comes from the feed
 * every ten seconds, so the number goes on ticking exactly as before.
 */
const CACHE_SCAN_MS = 900_000
const CACHE_STATE_MS = 120_000

export function openStore(): PostgresStore {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const store = new PostgresStore({
    query: async <T>(text: string, params?: readonly unknown[]) => {
      const result = await pool!.query(text, params as unknown[])
      return { rows: result.rows as T[] }
    },
  })

  // Wrapped once per module, not per request, so every viewer of every tab
  // shares the same answer. Cached per METHOD rather than around `buildView`,
  // because the three builders ask for overlapping things and a cache around
  // the whole view would still pay for `loadPositions` three times.
  //
  // Only the reads. Nothing that WRITES is touched, and the engine does not use
  // this module at all — it opens its own store, uncached, because a trading
  // decision on a minute-old position is not a saving, it is a bug.
  cached ??= {
    scans: cacheFor(() => store.latestScansByChain(), CACHE_SCAN_MS),
    scan: cacheFor(() => store.latestScan(), CACHE_SCAN_MS),
    blacklist: cacheFor(() => store.blacklisted(), CACHE_SCAN_MS),
    positions: cacheFor(() => store.loadPositions(), CACHE_STATE_MS),
    fills: cacheFor(() => store.allFills(), CACHE_STATE_MS),
    checkpoint: cacheFor(() => store.loadCheckpoint(), CACHE_STATE_MS),
  }
  const memo = cached

  return Object.assign(Object.create(Object.getPrototypeOf(store) as object), store, {
    latestScansByChain: memo.scans,
    latestScan: memo.scan,
    blacklisted: memo.blacklist,
    loadPositions: memo.positions,
    allFills: memo.fills,
    loadCheckpoint: memo.checkpoint,
  }) as PostgresStore
}

/**
 * The message, never the stack: a stack from a database client carries
 * connection details, and these endpoints are one paste away from public.
 */
export const failed = (error: unknown, status = 500): Response =>
  Response.json({ error: String(error).slice(0, 200) }, { status })
