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
/**
 * Fifteen minutes, and it became TWO.
 *
 * The long window was sized against a scan payload of ~490 KB, when `scans`
 * held the whole universe as JSONB. `worthStoring` cut that to what the engine
 * may act on — about 1% of it — and the whole view response measures 16.7 KB
 * today. The number it was protecting no longer exists.
 *
 * What the long window COST is what the operator reported: *difieren siempre
 * que lo abrís.* `cacheFor` is a module-level cache and Vercel runs many
 * serverless instances, so there is no single module and no shared answer.
 * With a 15-minute window against a 30-minute scan, two instances could hold
 * DIFFERENT scans for half of every cycle — and the ten-second poll round
 * robins between them. Measured: ten calls to the same URL seconds apart, nine
 * returning three unscored tokens and one returning four scored ones.
 *
 * Two minutes narrows that to a fifteenth of the cycle. It does NOT close it,
 * and nothing in this process can: an in-process cache cannot be shared across
 * instances that do not share a process. Closing it properly means caching
 * outside the lambda, which is a bill and a dependency for a screen that now
 * disagrees with itself for two minutes an hour.
 *
 * Affordable, measured rather than assumed: at 16.7 KB a response and one read
 * per two minutes, a polling viewer costs about 0.36 GB a month against Neon's
 * 5 GB — and the reads are shared by every viewer on that instance.
 */
const CACHE_SCAN_MS = 120_000
const CACHE_STATE_MS = 120_000

/**
 * When the fills behind the money figures were actually read.
 *
 * Null before the first read, and per INSTANCE — which is the whole reason it
 * exists. `cacheFor` is a module cache and Vercel runs many instances, so two
 * polls seconds apart land on different ones holding answers up to the TTL
 * apart. Nothing inside this process can close that: a cache in memory is not
 * shared by processes that do not share memory.
 *
 * So the figure says how old it is instead. The operator hit this twice and
 * paid for it both times — once reading a cumulative profit as money
 * vanishing, once as two totals that would not agree — and nothing was wrong
 * either time. Stale and labelled beats absent, and beats stale and silent by
 * a great deal more.
 */
export let lastFillsReadAt: () => number | null = () => null

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
  // Exported so the view can say how old the money figures are. It is the
  // FILLS that matter: everything on the screen with a dollar sign is built by
  // walking them, and they are the only cached read whose staleness looks like
  // money moving rather than like a list being short.
  lastFillsReadAt = memo.fills.readAt

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
