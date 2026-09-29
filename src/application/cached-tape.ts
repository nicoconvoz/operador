import {
  type EngineCheckpoint,
  type PersistedFill,
  type PersistedPosition,
  type PersistedScan,
  type StatePort,
  type RememberedToken,
} from '../domain/persistence/store.js'
import { type Alert } from '../domain/notifications/alerts.js'
import { type Chain, type SecurityReport } from '../domain/scanner/snapshot.js'
import { type DailyPnlSample } from '../domain/reporting/daily-pnl.js'

/**
 * The fill tape, read from the database ONCE per engine process and then
 * answered from memory.
 *
 * The book 5156a9b opens holds up to 250 positions, each buying up to twenty
 * $1 steps — a thousand fills a day and more — and the engine re-read that
 * tape whole about three times a cycle (the free slots, the common fund, the
 * day log) and once more per funded step, and every held position's fills on
 * every thirty-second sweep. At a couple of hundred bytes a row that is
 * gigabytes a day against a 5 GB MONTHLY transfer allowance, and this project
 * has already watched its whole stack stop the day an allowance ran out: an
 * engine whose store stops answering stops trading.
 *
 * What makes memory CORRECT here rather than merely cheaper: the engine is the
 * only writer of fills while it runs, so after the first read every change to
 * the tape passes through this object. It appends what it writes and nothing
 * else can move underneath it. The dashboard is read-only and keeps its own
 * short read cache; this one is the engine's alone and is wired only there.
 *
 * Three rules keep it from ever serving a tape the database disagrees with:
 *
 *  - **The first write wins, as in SQL.** `recordFill` is `ON CONFLICT DO
 *    NOTHING` on the idempotency key and reports nothing back, so a key already
 *    on the tape is never appended again — a retry of the same order carrying a
 *    different price leaves the tape holding the price the database kept.
 *  - **A write that failed is not guessed at.** A lost reply may hide an insert
 *    that landed, so a failed `recordFill` drops the whole memory and the next
 *    read asks the database, which is the only party that knows.
 *  - **A failed read is never remembered.** An empty tape is a book that owns
 *    nothing and has made nothing; the next reader asks again.
 *
 * The order is the database's own — time, a buy before a sell in one instant,
 * then the key — kept on load and on every append, because realised profit
 * walks each sale against the buys before it. A fill stamped behind the clock
 * (the tick stamps the bar it decided on) is filed where the query would put
 * it, not at the end. Ties inside one instant and one side are ordered by the
 * key's code units, which may differ from the database's collation; nothing
 * the ledger computes depends on the order of two buys, or two sales, at the
 * same instant.
 *
 * Every fill held is frozen and every answer is a fresh array: one copy of the
 * tape now serves every reader in the process, so a reader that edited its
 * answer would be editing everybody's.
 *
 * The one other writer, stated rather than discovered later: the operator's
 * `npm run retire` is a separate process. Its sale reaches this memory at the
 * next engine start — the in-process brokers, rebuilt from fills only when a
 * capital moves, already carried that same blind spot, and the position it
 * sells is closed in the store, so no pass loads it again.
 */
export function cachedTape(store: StatePort): StatePort {
  return new CachedTape(store)
}

const sideRank = (fill: PersistedFill): number => (fill.side === 'buy' ? 0 : 1)

/** `ORDER BY time, CASE side WHEN 'buy' THEN 0 ELSE 1 END, idempotency_key`. */
const tapeOrder = (a: PersistedFill, b: PersistedFill): number =>
  a.time - b.time ||
  sideRank(a) - sideRank(b) ||
  (a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0)

/** Files a fill after every fill that sorts at or before it. New fills are nearly always the newest, so the walk starts at the end. */
function fileInto(fills: PersistedFill[], fill: PersistedFill): void {
  let at = fills.length
  while (at > 0 && tapeOrder(fills[at - 1]!, fill) > 0) at--
  fills.splice(at, 0, fill)
}

interface Tape {
  readonly all: PersistedFill[]
  readonly byPosition: Map<string, PersistedFill[]>
  readonly keys: Set<string>
}

function tapeOf(loaded: readonly PersistedFill[]): Tape {
  const tape: Tape = { all: [], byPosition: new Map(), keys: new Set() }
  for (const fill of [...loaded].sort(tapeOrder)) append(tape, fill)
  return tape
}

/** Appends a fill the tape does not hold yet. The caller has already checked the key. */
function append(tape: Tape, given: PersistedFill): void {
  const fill = Object.freeze({ ...given })
  tape.keys.add(fill.idempotencyKey)
  fileInto(tape.all, fill)
  const own = tape.byPosition.get(fill.positionId)
  if (own) fileInto(own, fill)
  else tape.byPosition.set(fill.positionId, [fill])
}

class CachedTape implements StatePort {
  private tape: Tape | null = null
  /** The load in flight, shared by every reader that arrives while it runs. */
  private loading: Promise<Tape> | null = null
  /**
   * Bumped whenever memory is dropped. A load that began before a failed write
   * may have read the table before that write landed, so it is not allowed to
   * install what it read.
   */
  private generation = 0

  constructor(private readonly store: StatePort) {}

  private load(): Promise<Tape> {
    if (this.tape) return Promise.resolve(this.tape)
    if (this.loading) return this.loading
    const generation = this.generation
    const loading = this.store
      .allFills()
      .then((fills) => {
        const tape = tapeOf(fills)
        if (generation === this.generation) this.tape = tape
        return tape
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null
      })
    this.loading = loading
    return loading
  }

  private forget(): void {
    this.tape = null
    this.loading = null
    this.generation++
  }

  async recordFill(fill: PersistedFill): Promise<void> {
    // Every write reaches the database: the idempotency guarantee lives in SQL
    // and this never second-guesses it. Memory only decides whether to append.
    try {
      await this.store.recordFill(fill)
    } catch (error) {
      this.forget()
      throw error
    }
    // A load in flight may have read the table before or after this insert;
    // either way the key check below leaves exactly one copy. With nothing
    // loaded there is nothing to append to — the first read will find it.
    if (this.loading) await this.loading.catch(() => undefined)
    const tape = this.tape
    if (tape && !tape.keys.has(fill.idempotencyKey)) append(tape, fill)
  }

  async fillsFor(positionId: string): Promise<readonly PersistedFill[]> {
    return [...((await this.load()).byPosition.get(positionId) ?? [])]
  }

  async allFills(): Promise<readonly PersistedFill[]> {
    return [...(await this.load()).all]
  }

  async hasFill(idempotencyKey: string): Promise<boolean> {
    return (await this.load()).keys.has(idempotencyKey)
  }

  // ── Everything else is the store's own ──────────────────────────────────────

  loadPositions(): Promise<readonly PersistedPosition[]> { return this.store.loadPositions() }
  savePosition(position: PersistedPosition): Promise<void> { return this.store.savePosition(position) }
  closePosition(positionId: string): Promise<void> { return this.store.closePosition(positionId) }
  saveScan(scan: PersistedScan): Promise<void> { return this.store.saveScan(scan) }
  latestScan(): Promise<PersistedScan | null> { return this.store.latestScan() }
  latestScansByChain(): Promise<readonly PersistedScan[]> { return this.store.latestScansByChain() }
  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void> { return this.store.saveCheckpoint(checkpoint) }
  loadCheckpoint(): Promise<EngineCheckpoint | null> { return this.store.loadCheckpoint() }
  recordAlert(alert: Alert) { return this.store.recordAlert(alert) }
  alertsSince(seq: number, limit?: number) { return this.store.alertsSince(seq, limit) }
  latestAlertSeq(): Promise<number> { return this.store.latestAlertSeq() }
  discoveredPools(chain: Chain) { return this.store.discoveredPools(chain) }
  recordDiscoveredPools(chain: Chain, pools: readonly { tokenAddress: string; poolAddress: string }[], at: number): Promise<void> {
    return this.store.recordDiscoveredPools(chain, pools, at)
  }
  historyBarsFor(chain: Chain, poolAddress: string) { return this.store.historyBarsFor(chain, poolAddress) }
  recordHistoryBars(chain: Chain, poolAddress: string, bars: number, measuredAt: number): Promise<void> {
    return this.store.recordHistoryBars(chain, poolAddress, bars, measuredAt)
  }
  quietPoolSince(chain: Chain, poolAddress: string): Promise<number | null> { return this.store.quietPoolSince(chain, poolAddress) }
  recordQuietPool(chain: Chain, poolAddress: string, at: number): Promise<void> { return this.store.recordQuietPool(chain, poolAddress, at) }
  cachedSecurity(chain: Chain, address: string) { return this.store.cachedSecurity(chain, address) }
  recordSecurity(chain: Chain, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number): Promise<void> {
    return this.store.recordSecurity(chain, address, security, slippagePct, measuredAt)
  }
  rememberTokens(tokens: readonly RememberedToken[]): Promise<void> { return this.store.rememberTokens(tokens) }
  knownTokens(limit: number, offset?: number): Promise<readonly RememberedToken[]> { return this.store.knownTokens(limit, offset) }
  blacklist(chain: string, tokenAddress: string, reason: string, at: number): Promise<void> {
    return this.store.blacklist(chain, tokenAddress, reason, at)
  }
  blacklisted(): Promise<ReadonlySet<string>> { return this.store.blacklisted() }
  recordDailyPnl(sample: DailyPnlSample): Promise<void> { return this.store.recordDailyPnl(sample) }
  dailyPnl(limit: number) { return this.store.dailyPnl(limit) }
}
