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
import { type CachedSecurity , type RememberedToken } from '../../domain/persistence/store.js'

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
    const armed = this.positions.get(position.id)?.breakEvenArmed === true || position.breakEvenArmed === true
    this.positions.set(position.id, structuredClone({ ...position, breakEvenArmed: armed }))
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

  async knownTokens(limit: number): Promise<readonly RememberedToken[]> {
    return [...this.registry.values()]
      .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1))
      .slice(0, limit)
  }

  async blacklist(chain: string, tokenAddress: string, reason: string, at: number): Promise<void> {
    // A death exit is terminal, so the FIRST verdict is the one kept.
    const key = `${chain}:${tokenAddress}`
    if (!this.blacklistEntries.has(key)) this.blacklistEntries.set(key, { reason, at })
  }

  async blacklisted(): Promise<ReadonlySet<string>> {
    return new Set(this.blacklistEntries.keys())
  }

  /** Test helper: why a token was condemned. */
  blacklistReason(chain: string, tokenAddress: string): string | null {
    return this.blacklistEntries.get(`${chain}:${tokenAddress}`)?.reason ?? null
  }
}
