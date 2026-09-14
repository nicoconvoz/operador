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
  readonly chain: string
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
export interface StatePort {
  loadPositions(): Promise<readonly PersistedPosition[]>
  savePosition(position: PersistedPosition): Promise<void>
  /** Removes a closed position from the working set; its fills remain. */
  closePosition(positionId: string): Promise<void>

  /** No-op when a fill with the same idempotency key already exists. */
  recordFill(fill: PersistedFill): Promise<void>
  fillsFor(positionId: string): Promise<readonly PersistedFill[]>
  /** Whether this exact intended order was already filled. */
  hasFill(idempotencyKey: string): Promise<boolean>

  saveScan(scan: PersistedScan): Promise<void>
  latestScan(): Promise<PersistedScan | null>

  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>
  loadCheckpoint(): Promise<EngineCheckpoint | null>

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
