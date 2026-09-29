import {
  type EngineCheckpoint,
  type PersistedFill,
  type PersistedPosition,
  type PersistedScan,
  type StatePort,
  type StoredAlert,
} from '../../domain/persistence/store.js'
import { type Alert } from '../../domain/notifications/alerts.js'
import { type Chain, type SecurityReport } from '../../domain/scanner/snapshot.js'
import { keepGainLock } from '../../domain/risk/gain-lock.js'
import { keepLiquidityWatch } from '../../domain/strategy/liquidity-brake.js'
import { keepPriceLow } from '../../domain/strategy/deep-rung.js'
import { keepDipWatch } from '../../domain/strategy/dip-bounce.js'
import { type CachedSecurity , type RememberedToken } from '../../domain/persistence/store.js'
import { foldDailySample, type DailyPnl, type DailyPnlSample } from '../../domain/reporting/daily-pnl.js'

/** A position's real-time DCA scale as a whole pair, or null. */
const readingOf = (position: PersistedPosition | undefined): { scale: number; at: number } | null =>
  position?.dcaScaleNow !== null && position?.dcaScaleNow !== undefined &&
  position.dcaScaleNowAt !== null && position.dcaScaleNowAt !== undefined
    ? { scale: position.dcaScaleNow, at: position.dcaScaleNowAt }
    : null

/**
 * In-memory StatePort — for tests, paper runs, and as the reference that
 * defines what "correct" means for the Postgres implementation.
 *
 * It is deliberately strict about the things that matter: writes are
 * idempotent by key, and reads return copies so a caller mutating what it got
 * back cannot corrupt the store. A store that is loose in memory hides the
 * bugs the real one will have.
 */
export class MemoryStore implements StatePort {
  private readonly positions = new Map<string, PersistedPosition>()
  private readonly fills = new Map<string, PersistedFill>()
  private readonly blacklistEntries = new Map<string, { reason: string; at: number }>()
  private readonly alerts: StoredAlert[] = []
  /**
   * One scan per chain, not one scan. Keeping a single row meant scanning BSC
   * erased the Solana universe — the reference implementation was reproducing
   * the very bug the Postgres one had.
   */
  private readonly scans = new Map<string, PersistedScan>()
  private checkpoint: EngineCheckpoint | null = null

  async loadPositions(): Promise<readonly PersistedPosition[]> {
    return [...this.positions.values()].map((p) => structuredClone(p))
  }

  async savePosition(position: PersistedPosition): Promise<void> {
    // The break-even ratchet, kept exactly as the SQL keeps it. A reference
    // store looser than production would let the tests pass on a rule the real
    // one enforces and this one does not.
    const stored = this.positions.get(position.id)
    const armed = stored?.breakEvenArmed === true || position.breakEvenArmed === true
    // The score baseline, kept exactly as the SQL keeps it: the first
    // non-null value, never moved by a later save.
    const entryScore = stored?.entryScore ?? position.entryScore ?? null
    // The DCA scale, by the same rule: measured once, never erased.
    const dcaScale = stored?.dcaScale ?? position.dcaScale ?? null
    // The gain lock, by the same rule the upsert spells out in its CASE.
    const gainLock = keepGainLock(stored?.gainLock, position.gainLock)
    // The real-time DCA scale, by the rule the upsert spells out in its CASE:
    // the NEWER pair wins, and a half pair is no reading at all.
    const written = readingOf(position)
    const kept = readingOf(stored)
    const now = written !== null && (kept === null || written.at > kept.at) ? written : kept
    // The liquidity watch, by the rule the upsert spells out in its CASE: the
    // NEWER watch wins, and a write carrying none keeps what is stored.
    const liquidityWatch = keepLiquidityWatch(stored?.liquidityWatch, position.liquidityWatch)
    // The price low, by the rule the upsert spells out in its CASE: the same
    // holding keeps the LOWER price, a newer holding's replaces it, and a
    // write carrying none keeps what is stored.
    const priceLow = keepPriceLow(stored?.priceLow, position.priceLow)
    // The dip-bounce watch, by the rule the upsert spells out in its CASE: the
    // NEWER watch wins, and a write carrying none keeps what is stored.
    const dipWatch = keepDipWatch(stored?.dipWatch, position.dipWatch)
    this.positions.set(position.id, structuredClone({
      ...position, breakEvenArmed: armed, entryScore, dcaScale, gainLock,
      dcaScaleNow: now?.scale ?? null, dcaScaleNowAt: now?.at ?? null,
      liquidityWatch, priceLow, dipWatch,
    }))
  }

  async closePosition(positionId: string): Promise<void> {
    this.positions.delete(positionId)
  }

  async recordAlert(alert: Alert): Promise<StoredAlert> {
    // The sequence comes from the log's own length, never from the clock:
    // ordering must survive two alerts raised in the same millisecond.
    const stored: StoredAlert = { ...alert, seq: this.alerts.length + 1 }
    this.alerts.push(structuredClone(stored))
    return stored
  }

  async alertsSince(seq: number, limit = 100): Promise<readonly StoredAlert[]> {
    return this.alerts.filter((a) => a.seq > seq).slice(0, limit).map((a) => structuredClone(a))
  }

  private readonly poolHistory = new Map<string, { bars: number; measuredAt: number }>()

  async historyBarsFor(chain: Chain, poolAddress: string): Promise<{ bars: number; measuredAt: number } | null> {
    return this.poolHistory.get(`${chain}:${poolAddress}`) ?? null
  }

  async recordHistoryBars(chain: Chain, poolAddress: string, bars: number, measuredAt: number): Promise<void> {
    this.poolHistory.set(`${chain}:${poolAddress}`, { bars, measuredAt })
  }

  private readonly security = new Map<string, CachedSecurity>()

  private readonly quiet = new Map<string, number>()

  async quietPoolSince(chain: Chain, poolAddress: string): Promise<number | null> {
    return this.quiet.get(`${chain}:${poolAddress}`) ?? null
  }

  async recordQuietPool(chain: Chain, poolAddress: string, at: number): Promise<void> {
    this.quiet.set(`${chain}:${poolAddress}`, at)
  }

  async cachedSecurity(chain: Chain, address: string): Promise<CachedSecurity | null> {
    return this.security.get(`${chain}:${address}`) ?? null
  }

  async recordSecurity(chain: Chain, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number): Promise<void> {
    this.security.set(`${chain}:${address}`, { security: structuredClone(security), slippagePct, measuredAt })
  }

  async latestAlertSeq(): Promise<number> {
    return this.alerts.at(-1)?.seq ?? 0
  }

  async recordFill(fill: PersistedFill): Promise<void> {
    // First write wins: a retry after an ambiguous failure must not append a
    // second fill for the same intended order.
    if (this.fills.has(fill.idempotencyKey)) return
    this.fills.set(fill.idempotencyKey, structuredClone(fill))
  }

  private readonly discovery = new Map<string, { pools: readonly { tokenAddress: string; poolAddress: string }[]; discoveredAt: number }>()

  async discoveredPools(chain: Chain) {
    const found = this.discovery.get(chain)
    return found ? { pools: [...found.pools], discoveredAt: found.discoveredAt } : null
  }

  async recordDiscoveredPools(chain: Chain, pools: readonly { tokenAddress: string; poolAddress: string }[], at: number) {
    this.discovery.set(chain, { pools: [...pools], discoveredAt: at })
  }

  async allFills(): Promise<readonly PersistedFill[]> {
    return [...this.fills.values()]
      .sort((a, b) => a.time - b.time)
      .map((f) => structuredClone(f))
  }

  async fillsFor(positionId: string): Promise<readonly PersistedFill[]> {
    return [...this.fills.values()]
      .filter((f) => f.positionId === positionId)
      .sort((a, b) => a.time - b.time)
      .map((f) => structuredClone(f))
  }

  async hasFill(idempotencyKey: string): Promise<boolean> {
    return this.fills.has(idempotencyKey)
  }

  async saveScan(scan: PersistedScan): Promise<void> {
    const held = this.scans.get(scan.chain)
    if (held && held.scannedAt > scan.scannedAt) return // Never go backwards.
    this.scans.set(scan.chain, structuredClone(scan))
  }

  async latestScansByChain(): Promise<readonly PersistedScan[]> {
    const newest = new Map<string, PersistedScan>()
    for (const scan of this.scans.values()) newest.set(scan.chain, scan)
    return [...newest.values()].map((scan) => structuredClone(scan))
  }

  async latestScan(): Promise<PersistedScan | null> {
    const newest = [...this.scans.values()].sort((a, b) => b.scannedAt - a.scannedAt)[0]
    return newest ? structuredClone(newest) : null
  }

  async saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void> {
    this.checkpoint = { ...checkpoint }
  }

  async loadCheckpoint(): Promise<EngineCheckpoint | null> {
    return this.checkpoint ? { ...this.checkpoint } : null
  }

  /**
   * The permanent registry. Never pruned, by instruction.
   *
   * Ordered by last-known 24h volume because a bounded read costs one price
   * request per thirty rows — the first thirty had better be the thirty worth
   * re-pricing. An unmeasured volume goes to the BACK rather than being
   * dropped: the registry's whole job is remembering what the providers have
   * forgotten, and silence is not a zero.
   */
  private readonly registry = new Map<string, RememberedToken>()

  async rememberTokens(tokens: readonly RememberedToken[]): Promise<void> {
    for (const token of tokens) this.registry.set(token.contract, token)
  }

  async knownTokens(limit: number, offset = 0): Promise<readonly RememberedToken[]> {
    return [...this.registry.values()]
      // The SQL's total order: the contract breaks a tie, so pages never overlap.
      .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1) || a.contract.localeCompare(b.contract))
      .slice(offset, offset + limit)
  }

  async blacklist(chain: string, tokenAddress: string, reason: string, at: number): Promise<void> {
    // A death exit is terminal, so the FIRST verdict is the one kept.
    const key = `${chain}:${tokenAddress}`
    if (!this.blacklistEntries.has(key)) this.blacklistEntries.set(key, { reason, at })
  }

  async blacklisted(): Promise<ReadonlySet<string>> {
    return new Set(this.blacklistEntries.keys())
  }

  /** The day log, keyed by day. The same fold the SQL upsert spells out. */
  private readonly days = new Map<string, DailyPnl>()

  async recordDailyPnl(sample: DailyPnlSample): Promise<void> {
    this.days.set(sample.day, foldDailySample(this.days.get(sample.day) ?? null, sample))
  }

  async dailyPnl(limit: number): Promise<readonly DailyPnl[]> {
    // `YYYY-MM-DD` sorts the way the days do, exactly as `ORDER BY day` does.
    return [...this.days.values()]
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .slice(0, limit)
      .map((day) => ({ ...day }))
  }

  /** Test helper: why a token was condemned. */
  blacklistReason(chain: string, tokenAddress: string): string | null {
    return this.blacklistEntries.get(`${chain}:${tokenAddress}`)?.reason ?? null
  }
}
