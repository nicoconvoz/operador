import { type Alert } from '../notifications/alerts.js'
import { type Chain, type SecurityReport } from '../scanner/snapshot.js'

/**
 * One row of the permanent registry, named as the operator named the columns.
 *
 * The market fields are the snapshot as LAST SEEN and are never read as
 * current — every scan re-prices what it intends to examine. They exist so the
 * registry can be ordered by activity, which is what makes a bounded read
 * useful instead of arbitrary.
 */
export interface RememberedToken {
  readonly contract: string
  readonly token: string
  readonly pool: string | null
  readonly price: number | null
  readonly volume24h: number | null
  readonly liquidity: number | null
  readonly marketCap: number | null
  readonly txns: number | null
  readonly lastUpdate: number
}

export interface CachedSecurity {
  readonly security: SecurityReport
  readonly slippagePct: number | null
  readonly measuredAt: number
}
import { type DeathWatchState } from '../risk/death-exit.js'
import { type MarketQuality } from '../market/market-quality.js'
import { type CascadeState, type Order } from '../strategy/state.js'
import { type TokenSnapshot } from '../scanner/snapshot.js'

/**
 * Durable state — the contract that makes unattended operation survivable.
 *
 * The engine's memory is a CACHE. This is the truth. An instance that can be
 * stopped for idleness, reclaimed on a terms change, or restarted by the
 * provider will go down without warning, and it has to come back knowing
 * exactly where it was: mid-ladder, with a death watch armed, with an order
 * it may or may not have already placed.
 *
 * Everything here is plain data. No classes, no closures, nothing that only
 * exists while a process does.
 */

/** A position the engine is running, as it must survive a restart. */
export interface PersistedPosition {
  readonly id: string
  /** Typed, not a free string: the sell probe and the candle source are both chosen by it. */
  readonly chain: Chain
  readonly tokenAddress: string
  readonly pairAddress: string
  readonly symbol: string

  /** The strategy's own state machine. */
  readonly cascade: CascadeState
  /** The death watch, including its evidence chain. */
  readonly deathWatch: DeathWatchState
  /** Quality as last measured — the death exit's liquidity baseline lives here. */
  readonly quality: MarketQuality
  /** Capital this slot was allocated. */
  readonly capitalUsd: number

  /** Close time of the last bar this position has already evaluated. */
  readonly lastBarTime: number
  /**
   * Close of that bar. The death watch needs it to size a sell probe of the
   * right magnitude — quoting $100 of a token tells you nothing about whether
   * a $5,000 position can leave.
   */
  readonly lastPriceUsd: number | null
  /**
   * Orders emitted on that bar and NOT yet confirmed filled.
   *
   * This is the field that makes recovery safe. A process that dies between
   * "decided to buy" and "saw the fill" must not decide again from scratch:
   * it reconciles these against the chain first.
   */
  readonly pendingOrders: readonly Order[]

  readonly openedAt: number
  readonly updatedAt: number
}

/** A completed cycle, kept for the audit trail and for tuning. */
export interface PersistedFill {
  readonly positionId: string
  readonly orderId: string
  readonly side: 'buy' | 'sell'
  readonly time: number
  readonly price: number
  readonly qty: number
  readonly costUsd: number
  readonly comment: string
  /**
   * Client-generated, unique per intended order. The engine writes the fill
   * under this key, so replaying the same order after a crash collides
   * instead of buying twice.
   */
  readonly idempotencyKey: string
}

/** One scanner pass, so a restart does not start blind. */
export interface PersistedScan {
  readonly scannedAt: number
  readonly chain: string
  readonly snapshots: readonly TokenSnapshot[]
}

export interface EngineCheckpoint {
  readonly savedAt: number
  /** Bar close the engine had finished processing across all positions. */
  readonly lastCompletedBar: number
  readonly killSwitchEngaged: boolean
}

/**
 * The persistence port. One interface, two implementations: an in-memory one
 * for tests and paper runs, and Postgres for the live engine.
 *
 * Every write is idempotent by key so a retry after an ambiguous failure is
 * safe — the same discipline the order path needs, applied to storage.
 */
/**
 * An alert as stored: the domain alert, plus the position it holds in the log.
 *
 * The cursor is a SEQUENCE, not a timestamp. Two alerts can share a
 * millisecond, and a timestamp cursor then has to choose between skipping one
 * and replaying it forever — on a channel whose whole job is to deliver a
 * death exit exactly once, neither is acceptable.
 */
export interface StoredAlert extends Alert {
  readonly seq: number
}

export interface StatePort {
  loadPositions(): Promise<readonly PersistedPosition[]>
  savePosition(position: PersistedPosition): Promise<void>
  /** Removes a closed position from the working set; its fills remain. */
  closePosition(positionId: string): Promise<void>

  /** No-op when a fill with the same idempotency key already exists. */
  recordFill(fill: PersistedFill): Promise<void>
  fillsFor(positionId: string): Promise<readonly PersistedFill[]>
  /**
   * Every fill ever recorded, oldest first — INCLUDING those of positions that
   * have since closed.
   *
   * That inclusion is the point. Realised profit is the common fund the
   * allocator spends, and most of it belongs to positions that are no longer in
   * the working set. `fills` deliberately has no foreign key to `positions` for
   * exactly this reason: a closed position leaves, its trade history does not.
   */
  allFills(): Promise<readonly PersistedFill[]>
  /** Whether this exact intended order was already filled. */
  hasFill(idempotencyKey: string): Promise<boolean>

  saveScan(scan: PersistedScan): Promise<void>
  latestScan(): Promise<PersistedScan | null>
  /**
   * The newest scan of EACH chain.
   *
   * Separate from `latestScan` because the universe spans chains and a single
   * newest row cannot represent it: scanning BSC would make every Solana token
   * vanish from the screen, which looks exactly like the scanner having
   * stopped finding them.
   */
  latestScansByChain(): Promise<readonly PersistedScan[]>

  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>
  loadCheckpoint(): Promise<EngineCheckpoint | null>

  /**
   * Appends to the alert log. Returns the alert with the sequence it was
   * given, so the writer can report where it landed.
   */
  recordAlert(alert: Alert): Promise<StoredAlert>
  /**
   * Alerts newer than `seq`, oldest first — the cursor is EXCLUSIVE, so a
   * client that passes back the last sequence it received never sees it twice.
   */
  alertsSince(seq: number, limit?: number): Promise<readonly StoredAlert[]>
  /**
   * The newest sequence in the log, or 0 when it is empty.
   *
   * Separate from `alertsSince` because a client asking "am I behind?" must
   * not have to read a page to find out — and reading the FIRST page to learn
   * the LAST sequence is wrong the moment the log outgrows one page.
   */
  latestAlertSeq(): Promise<number>

  /**
   * The pools discovery last found on a chain, or null if it never ran.
   *
   * Discovery is ten throttled calls per chain and most of what a scan costs
   * once the candle downloads are cached. It expires — new pools appear — but
   * a pool younger than the window cannot clear the history gate anyway, which
   * needs 250 bars: 2.6 days at 15m.
   */
  discoveredPools(chain: Chain): Promise<{ pools: readonly { tokenAddress: string; poolAddress: string }[]; discoveredAt: number } | null>
  recordDiscoveredPools(chain: Chain, pools: readonly { tokenAddress: string; poolAddress: string }[], at: number): Promise<void>

  /** How many bars a pool had when last measured, or null if never. */
  historyBarsFor(chain: Chain, poolAddress: string): Promise<{ bars: number; measuredAt: number } | null>
  recordHistoryBars(chain: Chain, poolAddress: string, bars: number, measuredAt: number): Promise<void>

  /** When this pool was last found NOT to be trading, or null. */
  quietPoolSince(chain: Chain, poolAddress: string): Promise<number | null>
  recordQuietPool(chain: Chain, poolAddress: string, at: number): Promise<void>

  /** The last security examination of a token, or null if never examined. */
  cachedSecurity(chain: Chain, address: string): Promise<CachedSecurity | null>
  recordSecurity(chain: Chain, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number): Promise<void>

  /**
   * Every token ever priced, kept FOREVER, ordered by what was moving.
   *
   * The operator's idea, and it answers the constraint the whole scanner ran
   * into: the free providers cap discovery at about 570 a sweep and no
   * threshold widens that. Ten pages is GeckoTerminal's ceiling, Jupiter's
   * lists cap at 100 each, DexScreener's boosts are paid promotions. The only
   * lever left is TIME — a registry accumulates what every sweep found, so a
   * week of scans knows far more than any one of them.
   *
   * NEVER pruned. Every other cache in this store expires because it is an
   * optimisation; this one is the memory the providers do not have.
   *
   * `limit` is not timidity: reading it whole would cost one DexScreener call
   * per thirty rows, and the point is to reach further rather than to spend
   * more. The order is last-known 24h volume, so a bounded read takes the ones
   * worth re-pricing first.
   */
  rememberTokens(tokens: readonly RememberedToken[]): Promise<void>
  knownTokens(limit: number): Promise<readonly RememberedToken[]>

  /** Tokens the death exit has condemned. Never traded again. */
  blacklist(chain: string, tokenAddress: string, reason: string, at: number): Promise<void>
  blacklisted(): Promise<ReadonlySet<string>>
}

/**
 * The key an order is written under.
 *
 * Deterministic on purpose: the same position, the same bar and the same order
 * id always produce the same key, so an order replayed after a crash is
 * recognised as the one already placed rather than treated as a new one. This
 * is what stands between a restart and a double buy.
 */
export const idempotencyKeyFor = (positionId: string, barTime: number, orderId: string): string =>
  `${positionId}:${barTime}:${orderId}`
