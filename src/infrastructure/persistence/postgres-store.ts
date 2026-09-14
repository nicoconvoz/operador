import {
  type EngineCheckpoint,
  type PersistedFill,
  type PersistedPosition,
  type PersistedScan,
  type StatePort,
} from '../../domain/persistence/store.js'
import { type CascadeState } from '../../domain/strategy/state.js'
import { type DeathWatchState } from '../../domain/risk/death-exit.js'
import { type MarketQuality } from '../../domain/market/market-quality.js'
import { type TokenSnapshot } from '../../domain/scanner/snapshot.js'

/**
 * Postgres StatePort.
 *
 * Takes a minimal query interface rather than a driver, so it works with `pg`,
 * Supabase or Neon's serverless client without importing any of them — and so
 * its tests run against a fake instead of a database.
 *
 * The idempotency discipline lives in SQL, not in TypeScript: `ON CONFLICT DO
 * NOTHING` on the fills and blacklist tables means a retry is safe even if two
 * engine instances race. A guarantee enforced by the database cannot be
 * forgotten by a caller.
 */

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

interface PositionRow {
  id: string
  chain: string
  token_address: string
  pair_address: string
  symbol: string
  cascade: CascadeState
  death_watch: DeathWatchState
  quality: MarketQuality
  capital_usd: string | number
  last_bar_time: string | number
  pending_orders: PersistedPosition['pendingOrders']
  opened_at: string | number
  updated_at: string | number
}

/**
 * Postgres returns NUMERIC and BIGINT as STRINGS, to avoid silently losing
 * precision in a JS number. Reading them as-is is a classic way to end up
 * comparing "1800000000000" to 1800000000000 and getting false.
 */
const num = (value: string | number | undefined): number => (typeof value === 'number' ? value : Number(value ?? 0))

export class PostgresStore implements StatePort {
  constructor(private readonly sql: SqlClient) {}

  /** Idempotent: safe to run on every boot. */
  async migrate(schema: string): Promise<void> {
    await this.sql.query(schema)
  }

  async loadPositions(): Promise<readonly PersistedPosition[]> {
    const { rows } = await this.sql.query<PositionRow>('SELECT * FROM positions ORDER BY opened_at')
    return rows.map((row) => ({
      id: row.id,
      chain: row.chain,
      tokenAddress: row.token_address,
      pairAddress: row.pair_address,
      symbol: row.symbol,
      cascade: row.cascade,
      deathWatch: row.death_watch,
      quality: row.quality,
      capitalUsd: num(row.capital_usd),
      lastBarTime: num(row.last_bar_time),
      pendingOrders: row.pending_orders,
      openedAt: num(row.opened_at),
      updatedAt: num(row.updated_at),
    }))
  }

  async savePosition(p: PersistedPosition): Promise<void> {
    await this.sql.query(
      `INSERT INTO positions (id, chain, token_address, pair_address, symbol, cascade, death_watch, quality,
                              capital_usd, last_bar_time, pending_orders, opened_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         cascade = EXCLUDED.cascade,
         death_watch = EXCLUDED.death_watch,
         quality = EXCLUDED.quality,
         capital_usd = EXCLUDED.capital_usd,
         last_bar_time = EXCLUDED.last_bar_time,
         pending_orders = EXCLUDED.pending_orders,
         updated_at = EXCLUDED.updated_at`,
      [p.id, p.chain, p.tokenAddress, p.pairAddress, p.symbol, JSON.stringify(p.cascade), JSON.stringify(p.deathWatch),
       JSON.stringify(p.quality), p.capitalUsd, p.lastBarTime, JSON.stringify(p.pendingOrders), p.openedAt, p.updatedAt],
    )
  }

  async closePosition(positionId: string): Promise<void> {
    await this.sql.query('DELETE FROM positions WHERE id = $1', [positionId])
  }

  async recordFill(fill: PersistedFill): Promise<void> {
    // The whole idempotency guarantee, in one clause.
    await this.sql.query(
      `INSERT INTO fills (idempotency_key, position_id, order_id, side, time, price, qty, cost_usd, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [fill.idempotencyKey, fill.positionId, fill.orderId, fill.side, fill.time, fill.price, fill.qty, fill.costUsd, fill.comment],
    )
  }

  async fillsFor(positionId: string): Promise<readonly PersistedFill[]> {
    const { rows } = await this.sql.query<Record<string, string | number>>(
      'SELECT * FROM fills WHERE position_id = $1 ORDER BY time', [positionId],
    )
    return rows.map((row) => ({
      idempotencyKey: String(row.idempotency_key),
      positionId: String(row.position_id),
      orderId: String(row.order_id),
      side: row.side as 'buy' | 'sell',
      time: num(row.time),
      price: num(row.price),
      qty: num(row.qty),
      costUsd: num(row.cost_usd),
      comment: String(row.comment),
    }))
  }

  async hasFill(idempotencyKey: string): Promise<boolean> {
    const { rows } = await this.sql.query('SELECT 1 FROM fills WHERE idempotency_key = $1', [idempotencyKey])
    return rows.length > 0
  }

  async saveScan(scan: PersistedScan): Promise<void> {
    await this.sql.query(
      `INSERT INTO scans (scanned_at, chain, snapshots) VALUES ($1,$2,$3)
       ON CONFLICT (scanned_at) DO NOTHING`,
      [scan.scannedAt, scan.chain, JSON.stringify(scan.snapshots)],
    )
  }

  async latestScan(): Promise<PersistedScan | null> {
    const { rows } = await this.sql.query<{ scanned_at: string | number; chain: string; snapshots: TokenSnapshot[] }>(
      'SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 1',
    )
    const row = rows[0]
    return row ? { scannedAt: num(row.scanned_at), chain: row.chain, snapshots: row.snapshots } : null
  }

  async saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void> {
    await this.sql.query(
      `INSERT INTO checkpoint (singleton, saved_at, last_completed_bar, kill_switch_engaged)
       VALUES (TRUE,$1,$2,$3)
       ON CONFLICT (singleton) DO UPDATE SET
         saved_at = EXCLUDED.saved_at,
         last_completed_bar = EXCLUDED.last_completed_bar,
         kill_switch_engaged = EXCLUDED.kill_switch_engaged`,
      [checkpoint.savedAt, checkpoint.lastCompletedBar, checkpoint.killSwitchEngaged],
    )
  }

  async loadCheckpoint(): Promise<EngineCheckpoint | null> {
    const { rows } = await this.sql.query<{ saved_at: string | number; last_completed_bar: string | number; kill_switch_engaged: boolean }>(
      'SELECT * FROM checkpoint WHERE singleton = TRUE',
    )
    const row = rows[0]
    return row ? { savedAt: num(row.saved_at), lastCompletedBar: num(row.last_completed_bar), killSwitchEngaged: row.kill_switch_engaged } : null
  }

  async blacklist(chain: string, tokenAddress: string, reason: string, at: number): Promise<void> {
    // DO NOTHING, not DO UPDATE: a death exit is terminal and the first
    // verdict is the one that explains why.
    await this.sql.query(
      `INSERT INTO blacklist (chain, token_address, reason, at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain, token_address) DO NOTHING`,
      [chain, tokenAddress, reason, at],
    )
  }

  async blacklisted(): Promise<ReadonlySet<string>> {
    const { rows } = await this.sql.query<{ chain: string; token_address: string }>('SELECT chain, token_address FROM blacklist')
    return new Set(rows.map((row) => `${row.chain}:${row.token_address}`))
  }
}
