import { describe, it, expect } from 'vitest'
import { PostgresStore, type SqlClient } from './postgres-store.js'
import { initialState } from '../../domain/strategy/state.js'
import { startDeathWatch } from '../../domain/risk/death-exit.js'
import { type PersistedPosition } from '../../domain/persistence/store.js'

const NOW = 1_800_000_000_000

/** Records every statement and answers with whatever was queued. */
const fakeSql = (responses: Record<string, unknown>[][] = []) => {
  const calls: { sql: string; params: readonly unknown[] }[] = []
  let next = 0
  const client: SqlClient = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      return { rows: (responses[next++] ?? []) as never[] }
    },
  }
  return { client, calls }
}

const position: PersistedPosition = {
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'TEST',
  cascade: { ...initialState(), level: 3 },
  deathWatch: startDeathWatch(100_000, NOW),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.2, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 500, lastBarTime: NOW, lastPriceUsd: 1, pendingOrders: [], openedAt: NOW, updatedAt: NOW,
}

describe('PostgresStore — idempotency lives in SQL, not in TypeScript', () => {
  it('a fill can never be written twice: ON CONFLICT DO NOTHING', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).recordFill({
      idempotencyKey: 'k', positionId: 'p', orderId: 'o', side: 'buy', time: NOW, price: 1, qty: 1, costUsd: 0, comment: 'c',
    })
    expect(calls[0]!.sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING')
    expect(calls[0]!.params[0]).toBe('k')
  })

  it('a blacklist entry keeps the FIRST verdict, never overwrites it', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).blacklist('solana', 'Mint1', 'LP removed', NOW)
    expect(calls[0]!.sql).toContain('ON CONFLICT (chain, token_address) DO NOTHING')
    expect(calls[0]!.sql).not.toContain('DO UPDATE')
  })

  it('a position UPSERTS, because its state is meant to move', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(position)
    expect(calls[0]!.sql).toContain('ON CONFLICT (id) DO UPDATE')
    expect(calls[0]!.sql).toContain('pending_orders = EXCLUDED.pending_orders')
  })

  it('the checkpoint is a singleton, so two cannot disagree', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).saveCheckpoint({ savedAt: NOW, lastCompletedBar: 10, killSwitchEngaged: true })
    expect(calls[0]!.sql).toContain('ON CONFLICT (singleton) DO UPDATE')
    expect(calls[0]!.params[2]).toBe(true)
  })
})

describe('PostgresStore — reading back what Postgres actually returns', () => {
  it('parses NUMERIC and BIGINT, which arrive as strings', async () => {
    // Postgres returns these as strings to avoid precision loss in JS numbers.
    const { client } = fakeSql([[{
      id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
      cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
      capital_usd: '500.00', last_bar_time: '1800000000000', last_price_usd: '0.0123', pending_orders: [],
      opened_at: '1800000000000', updated_at: '1800000000000',
    }]])
    const [loaded] = await new PostgresStore(client).loadPositions()
    expect(loaded!.capitalUsd).toBe(500)
    expect(loaded!.lastBarTime).toBe(NOW)
    expect(loaded!.lastPriceUsd).toBe(0.0123)
    expect(loaded!.cascade.level).toBe(3)
    expect(typeof loaded!.openedAt).toBe('number')
  })

  it('round-trips a position through save and load', async () => {
    const { client, calls } = fakeSql()
    const store = new PostgresStore(client)
    await store.savePosition(position)
    const saved = calls[0]!.params
    // The domain objects go in as JSON and must come back identical.
    expect(JSON.parse(saved[5] as string)).toEqual(position.cascade)
    expect(JSON.parse(saved[6] as string)).toEqual(position.deathWatch)
    expect(JSON.parse(saved[7] as string)).toEqual(position.quality)
  })

  it('an empty checkpoint table reads as null, not as a crash', async () => {
    const { client } = fakeSql([[]])
    expect(await new PostgresStore(client).loadCheckpoint()).toBeNull()
  })

  it('builds the blacklist key the same way the domain does', async () => {
    const { client } = fakeSql([[{ chain: 'solana', token_address: 'Mint1' }]])
    const set = await new PostgresStore(client).blacklisted()
    expect(set.has('solana:Mint1')).toBe(true)
  })

  it('hasFill answers from row count', async () => {
    const present = fakeSql([[{ '?column?': 1 }]])
    expect(await new PostgresStore(present.client).hasFill('k')).toBe(true)
    const absent = fakeSql([[]])
    expect(await new PostgresStore(absent.client).hasFill('k')).toBe(false)
  })
})

describe('PostgresStore — a scan is the newest picture, not an archive', () => {
  it('drops the older scans of that chain as soon as a new one lands', async () => {
    // `scans` stores the WHOLE universe as JSONB — about 280 snapshots per
    // chain — and nothing ever deleted a row. A scan every fifteen minutes on
    // two chains writes roughly 40 MB a day into a 0.5 GB free tier, and the
    // project stopped answering at all: "Your account or project has exceeded
    // the quota", which takes the dashboard AND the engine's writes with it.
    //
    // Nothing reads an old one. `latestScansByChain` wants the newest per
    // chain, `latestScan` the newest overall, and `scanOnce`'s `previous`
    // argument is never passed by the runtime. The history was pure cost.
    const { client, calls } = fakeSql()
    const store = new PostgresStore(client)

    await store.saveScan({ scannedAt: NOW, chain: 'solana', snapshots: [] })

    const pruned = calls.find((c) => /DELETE FROM scans/i.test(c.sql))
    expect(pruned).toBeDefined()
    expect(pruned!.params).toEqual(['solana', NOW])
  })

  it('never touches the other chain, which has its own newest', async () => {
    // One chain failing must not cost the other its universe — the same rule
    // `latestScansByChain` exists for.
    const { client, calls } = fakeSql()
    const store = new PostgresStore(client)

    await store.saveScan({ scannedAt: NOW, chain: 'bsc', snapshots: [] })

    const pruned = calls.find((c) => /DELETE FROM scans/i.test(c.sql))!
    expect(pruned.sql).toMatch(/chain\s*=\s*\$1/i)
    expect(pruned.params[0]).toBe('bsc')
  })
})
