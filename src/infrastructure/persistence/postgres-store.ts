import {
  type EngineCheckpoint,
  type PersistedFill,
  type PersistedPosition,
  type PersistedScan,
  type StatePort,
  type StoredAlert,
  type CachedSecurity,
  type RememberedToken,
} from '../../domain/persistence/store.js'
import { type Alert, type AlertKind, type AlertLevel } from '../../domain/notifications/alerts.js'
import { type CascadeState } from '../../domain/strategy/state.js'
import { type DeathWatchState } from '../../domain/risk/death-exit.js'
import { type MarketQuality } from '../../domain/market/market-quality.js'
import { type Chain, type SecurityReport, type TokenSnapshot } from '../../domain/scanner/snapshot.js'

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

interface ScanRow {
  scanned_at: string | number
  chain: string
  snapshots: TokenSnapshot[]
}

interface AlertRow {
  seq: string | number
  kind: AlertKind
  level: AlertLevel
  at: string | number
  title: string
  body: string
  data: Record<string, unknown> | null
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
  last_price_usd: string | number | null
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
      chain: row.chain as Chain,
      tokenAddress: row.token_address,
      pairAddress: row.pair_address,
      symbol: row.symbol,
      cascade: row.cascade,
      deathWatch: row.death_watch,
      quality: row.quality,
      capitalUsd: num(row.capital_usd),
      lastBarTime: num(row.last_bar_time),
      lastPriceUsd: row.last_price_usd === null ? null : num(row.last_price_usd),
      pendingOrders: row.pending_orders,
      openedAt: num(row.opened_at),
      updatedAt: num(row.updated_at),
    }))
  }

  async savePosition(p: PersistedPosition): Promise<void> {
    await this.sql.query(
      `INSERT INTO positions (id, chain, token_address, pair_address, symbol, cascade, death_watch, quality,
                              capital_usd, last_bar_time, last_price_usd, pending_orders, opened_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         cascade = EXCLUDED.cascade,
         death_watch = EXCLUDED.death_watch,
         quality = EXCLUDED.quality,
         capital_usd = EXCLUDED.capital_usd,
         last_bar_time = EXCLUDED.last_bar_time,
         last_price_usd = EXCLUDED.last_price_usd,
         pending_orders = EXCLUDED.pending_orders,
         updated_at = EXCLUDED.updated_at`,
      [p.id, p.chain, p.tokenAddress, p.pairAddress, p.symbol, JSON.stringify(p.cascade), JSON.stringify(p.deathWatch),
       JSON.stringify(p.quality), p.capitalUsd, p.lastBarTime, p.lastPriceUsd, JSON.stringify(p.pendingOrders), p.openedAt, p.updatedAt],
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
    return rows.map(toFill)
  }

  async allFills(): Promise<readonly PersistedFill[]> {
    const { rows } = await this.sql.query<Record<string, string | number>>('SELECT * FROM fills ORDER BY time')
    return rows.map(toFill)
  }

  async hasFill(idempotencyKey: string): Promise<boolean> {
    const { rows } = await this.sql.query('SELECT 1 FROM fills WHERE idempotency_key = $1', [idempotencyKey])
    return rows.length > 0
  }

  /**
   * The newest picture of a chain, and only the newest.
   *
   * A scan row carries the WHOLE universe as JSONB — about 280 snapshots per
   * chain — and nothing ever deleted one. At a scan every fifteen minutes on
   * two chains that is roughly 40 MB a day into a 0.5 GB free tier, and the
   * project eventually answered nothing at all: *"Your account or project has
   * exceeded the quota"*, which takes the dashboard AND the engine's writes
   * with it. An unattended system whose store fills up does not degrade, it
   * stops.
   *
   * Nothing ever read an old one. `latestScansByChain` wants the newest per
   * chain, `latestScan` the newest overall, and `scanOnce`'s `previous`
   * argument — the one thing that could have used history, for
   * `liquidityGrowth` — is never passed by the runtime. The archive was pure
   * cost with no reader.
   *
   * Pruned AFTER the insert and scoped to the CHAIN, so a scan that fails
   * halfway cannot leave that chain with no universe at all, and one chain's
   * turn never deletes the other's — the same rule `latestScansByChain` exists
   * for.
   */
  async saveScan(scan: PersistedScan): Promise<void> {
    await this.sql.query(
      `INSERT INTO scans (scanned_at, chain, snapshots) VALUES ($1,$2,$3)
       ON CONFLICT (scanned_at) DO NOTHING`,
      [scan.scannedAt, scan.chain, JSON.stringify(scan.snapshots)],
    )
    await this.sql.query('DELETE FROM scans WHERE chain = $1 AND scanned_at < $2', [scan.chain, scan.scannedAt])
  }

  async latestScansByChain(): Promise<readonly PersistedScan[]> {
    // DISTINCT ON is Postgres' way of saying "the newest row per chain" in one
    // pass. A single ORDER BY ... LIMIT 1 answers a different question, and
    // answering it here made the whole universe collapse to one chain.
    const { rows } = await this.sql.query<ScanRow>(
      'SELECT DISTINCT ON (chain) scanned_at, chain, snapshots FROM scans ORDER BY chain, scanned_at DESC',
    )
    return rows.map((row) => ({ scannedAt: num(row.scanned_at), chain: row.chain, snapshots: row.snapshots }))
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

  async recordAlert(alert: Alert): Promise<StoredAlert> {
    // RETURNING seq: the database assigns the order, so two engine instances
    // writing at once still produce one unambiguous sequence.
    const { rows } = await this.sql.query<{ seq: string | number }>(
      `INSERT INTO alerts (kind, level, at, title, body, data)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq`,
      [alert.kind, alert.level, alert.at, alert.title, alert.body, alert.data ? JSON.stringify(alert.data) : null],
    )
    return { ...alert, seq: num(rows[0]!.seq) }
  }

  async alertsSince(seq: number, limit = 100): Promise<readonly StoredAlert[]> {
    const { rows } = await this.sql.query<AlertRow>(
      `SELECT seq, kind, level, at, title, body, data FROM alerts
       WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
      [seq, limit],
    )
    return rows.map((row) => ({
      seq: num(row.seq),
      kind: row.kind,
      level: row.level,
      at: num(row.at),
      title: row.title,
      body: row.body,
      ...(row.data ? { data: row.data } : {}),
    }))
  }

  async discoveredPools(chain: Chain) {
    const { rows } = await this.sql.query<{ pools: { tokenAddress: string; poolAddress: string }[]; discovered_at: string | number }>(
      'SELECT pools, discovered_at FROM pool_discovery WHERE chain = $1', [chain],
    )
    const row = rows[0]
    return row ? { pools: row.pools, discoveredAt: num(row.discovered_at) } : null
  }

  async recordDiscoveredPools(chain: Chain, pools: readonly { tokenAddress: string; poolAddress: string }[], at: number): Promise<void> {
    await this.sql.query(
      `INSERT INTO pool_discovery (chain, pools, discovered_at) VALUES ($1, $2, $3)
       ON CONFLICT (chain) DO UPDATE SET pools = EXCLUDED.pools, discovered_at = EXCLUDED.discovered_at`,
      [chain, JSON.stringify(pools), at],
    )
  }

  async historyBarsFor(chain: Chain, poolAddress: string): Promise<{ bars: number; measuredAt: number } | null> {
    const { rows } = await this.sql.query<{ bars: string | number; measured_at: string | number }>(
      'SELECT bars, measured_at FROM pool_history WHERE chain = $1 AND pool_address = $2',
      [chain, poolAddress],
    )
    const row = rows[0]
    return row ? { bars: num(row.bars), measuredAt: num(row.measured_at) } : null
  }

  async recordHistoryBars(chain: string, poolAddress: string, bars: number, measuredAt: number): Promise<void> {
    // DO UPDATE, unlike the blacklist: this is a measurement that improves, not
    // a verdict that must keep its first answer.
    await this.sql.query(
      `INSERT INTO pool_history (chain, pool_address, bars, measured_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain, pool_address) DO UPDATE SET bars = EXCLUDED.bars, measured_at = EXCLUDED.measured_at`,
      [chain, poolAddress, bars, measuredAt],
    )
  }

  async quietPoolSince(chain: Chain, poolAddress: string): Promise<number | null> {
    const { rows } = await this.sql.query<{ measured_at: string | number }>(
      'SELECT measured_at FROM pool_quiet WHERE chain = $1 AND pool_address = $2',
      [chain, poolAddress],
    )
    const row = rows[0]
    return row ? num(row.measured_at) : null
  }

  async recordQuietPool(chain: Chain, poolAddress: string, at: number): Promise<void> {
    await this.sql.query(
      `INSERT INTO pool_quiet (chain, pool_address, measured_at) VALUES ($1, $2, $3)
       ON CONFLICT (chain, pool_address) DO UPDATE SET measured_at = EXCLUDED.measured_at`,
      [chain, poolAddress, at],
    )
  }

  async cachedSecurity(chain: Chain, address: string): Promise<CachedSecurity | null> {
    const { rows } = await this.sql.query<{ security: SecurityReport; slippage_pct: string | number | null; measured_at: string | number }>(
      'SELECT security, slippage_pct, measured_at FROM token_security WHERE chain = $1 AND address = $2',
      [chain, address],
    )
    const row = rows[0]
    if (!row) return null
    return {
      security: row.security,
      slippagePct: row.slippage_pct === null ? null : num(row.slippage_pct),
      measuredAt: num(row.measured_at),
    }
  }

  async recordSecurity(chain: string, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number): Promise<void> {
    await this.sql.query(
      `INSERT INTO token_security (chain, address, security, slippage_pct, measured_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (chain, address) DO UPDATE
         SET security = EXCLUDED.security, slippage_pct = EXCLUDED.slippage_pct, measured_at = EXCLUDED.measured_at`,
      [chain, address, JSON.stringify(security), slippagePct, measuredAt],
    )
  }

  /**
   * The permanent registry. NEVER pruned, and that is the point.
   *
   * Every other cache in this store expires or is truncated because it is an
   * optimisation. This one is the memory the discovery providers do not have:
   * they cap a sweep at about 570 tokens and no threshold widens that, so the
   * only lever left is TIME — a week of scans knows far more than any one of
   * them.
   *
   * Written in ONE statement rather than a loop. A scan remembers several
   * hundred tokens and a round trip each would be several hundred round trips
   * against a free tier whose limit is network transfer, which is the bill
   * that once took this project offline for thirty-four hours.
   */
  async rememberTokens(tokens: readonly RememberedToken[]): Promise<void> {
    if (tokens.length === 0) return
    const values: unknown[] = []
    const rows = tokens.map((token, i) => {
      const at = i * 9
      values.push(token.contract, token.token, token.pool, token.price, token.volume24h, token.liquidity, token.marketCap, token.txns, token.lastUpdate)
      return `(${at + 1},${at + 2},${at + 3},${at + 4},${at + 5},${at + 6},${at + 7},${at + 8},${at + 9})`
    })
    await this.sql.query(
      `INSERT INTO solana_cache (contract, token, pool, price, volume24h, liquidity, market_cap, txns, last_update)
       VALUES ${rows.join(',')}
       ON CONFLICT (contract) DO UPDATE SET
         token = EXCLUDED.token,
         -- A pool we already knew is kept when the new row has none: forgetting
         -- where a token trades is the one thing this table exists to prevent.
         pool = COALESCE(EXCLUDED.pool, solana_cache.pool),
         price = EXCLUDED.price,
         volume24h = EXCLUDED.volume24h,
         liquidity = EXCLUDED.liquidity,
         market_cap = EXCLUDED.market_cap,
         txns = EXCLUDED.txns,
         last_update = EXCLUDED.last_update`,
      values,
    )
  }

  /**
   * Ordered by what was MOVING, bounded on purpose.
   *
   * Reading it whole would cost one price request per thirty rows, and the
   * point of the registry is to reach further rather than to spend more. An
   * unmeasured volume sorts LAST rather than being excluded — silence is not a
   * zero, and the registry's job is remembering what the providers forgot.
   */
  async knownTokens(limit: number): Promise<readonly RememberedToken[]> {
    const { rows } = await this.sql.query<Record<string, unknown>>(
      `SELECT contract, token, pool, price, volume24h, liquidity, market_cap, txns, last_update
       FROM solana_cache ORDER BY volume24h DESC NULLS LAST LIMIT $1`,
      [limit],
    )
    const maybe = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
    return rows.map((row) => ({
      contract: String(row.contract),
      token: String(row.token),
      pool: row.pool === null || row.pool === undefined ? null : String(row.pool),
      price: maybe(row.price),
      volume24h: maybe(row.volume24h),
      liquidity: maybe(row.liquidity),
      marketCap: maybe(row.market_cap),
      txns: maybe(row.txns),
      lastUpdate: num(row.last_update as string | number),
    }))
  }

  async latestAlertSeq(): Promise<number> {
    const { rows } = await this.sql.query<{ seq: string | number }>('SELECT seq FROM alerts ORDER BY seq DESC LIMIT 1')
    return rows.length === 0 ? 0 : num(rows[0]!.seq)
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

const toFill = (row: Record<string, string | number>): PersistedFill => ({
  idempotencyKey: String(row.idempotency_key),
  positionId: String(row.position_id),
  orderId: String(row.order_id),
  side: row.side as 'buy' | 'sell',
  time: num(row.time),
  price: num(row.price),
  qty: num(row.qty),
  costUsd: num(row.cost_usd),
  comment: String(row.comment),
})
