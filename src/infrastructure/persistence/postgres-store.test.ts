import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PostgresStore, type SqlClient } from './postgres-store.js'
import { initialState } from '../../domain/strategy/state.js'
import { startDeathWatch } from '../../domain/risk/death-exit.js'
import { type PersistedPosition } from '../../domain/persistence/store.js'
import { type DipWatch } from '../../domain/strategy/dip-bounce.js'

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

describe('the registry writes in chunks, because a statement has a parameter limit', () => {
  // Found by the operator asking whether writing it would slow the first cold
  // scan down. It does not — but the question sent me back to the statement,
  // and it carries NINE parameters per token in ONE insert.
  //
  // Postgres allows 65,535. At 564 tokens that is 5,076 and it works; at 7,282
  // the statement fails. It is caught, so the cycle survives — and the
  // registry would simply stop growing, in silence, exactly when it had
  // accumulated enough to be worth having. A failure that only shows up once
  // the thing starts working is the worst kind this project collects.

  it('splits a write too large for one statement', async () => {
    const statements: number[] = []
    const sql = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('solana_cache')) statements.push(values?.length ?? 0)
        return { rows: [] }
      },
    }
    const store = new PostgresStore(sql as never)
    await store.rememberTokens(
      Array.from({ length: 3_000 }, (_, i) => ({
        contract: `c${i}`, token: `T${i}`, pool: null, price: 1, volume24h: 1,
        liquidity: 1, marketCap: 1, txns: 1, lastUpdate: 1,
      })),
    )
    expect(statements.length).toBeGreaterThan(1)
    for (const count of statements) expect(count).toBeLessThan(65_535)
  })

  it('still writes a small one in a single statement', async () => {
    const statements: number[] = []
    const sql = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('solana_cache')) statements.push(values?.length ?? 0)
        return { rows: [] }
      },
    }
    const store = new PostgresStore(sql as never)
    await store.rememberTokens([
      { contract: 'a', token: 'A', pool: null, price: 1, volume24h: 1, liquidity: 1, marketCap: 1, txns: 1, lastUpdate: 1 },
    ])
    expect(statements).toEqual([9])
  })
})

describe('the fill queries ask for a deterministic order', () => {
  // The figure this protects is the one the whole system exists to produce,
  // and it was not reproducible from the same data.

  it('sorts buys before sells within the same instant', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).allFills()
    expect(calls[0]!.sql).toContain('ORDER BY time')
    expect(calls[0]!.sql).toContain("CASE side WHEN 'buy' THEN 0 ELSE 1 END")
  })

  it('breaks the remaining ties on a unique column', async () => {
    // Without a total order two instances can still disagree, just less often
    // — which is worse than disagreeing loudly, because it looks like it works.
    const { client, calls } = fakeSql()
    await new PostgresStore(client).allFills()
    expect(calls[0]!.sql).toContain('idempotency_key')
  })

  it('asks the same of a single position', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).fillsFor('pos-1')
    expect(calls[0]!.sql).toContain("CASE side WHEN 'buy' THEN 0 ELSE 1 END")
  })
})

describe('PostgresStore — the break-even ratchet is enforced in SQL', () => {
  // *Hay monedas que estaban ganando un montón, retrocedieron hasta perder, y
  // cerraron en pérdida porque no tomaron la ganancia cuando pudieron.*
  // Measured: four losers had been above the target first, two of them on a
  // bar CLOSE, $5.57 lost between them.
  //
  // The fix is a ratchet — once a position reaches the target it may never
  // close at a loss — and a ratchet that any save can undo is not one. Every
  // step of the cycle writes the WHOLE row: the tick, the trim, the rotation.
  // This project already paid once for a step writing a stale snapshot over
  // what the tick had just decided. So the rule lives where no caller can
  // forget it: armed = what was stored OR what is being written.

  it('never lets a save turn an armed position back off', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition({ ...position, breakEvenArmed: true })
    expect(calls[0]!.sql).toContain('break_even_armed = positions.break_even_armed OR EXCLUDED.break_even_armed')
  })

  it('writes the flag, and absent is false rather than null', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(position)
    expect(calls[0]!.params).toContain(false)
  })

  it('reads it back', async () => {
    const { client } = fakeSql([[{
      id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
      cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
      capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
      opened_at: '1', updated_at: '1', break_even_armed: true,
    }]])
    const [loaded] = await new PostgresStore(client).loadPositions()
    expect(loaded!.breakEvenArmed).toBe(true)
  })

  it('keeps the first entry score — a later save cannot move the baseline', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition({ ...position, entryScore: 93.2 })
    expect(calls[0]!.sql).toContain('entry_score = COALESCE(positions.entry_score, EXCLUDED.entry_score)')
    expect(calls[0]!.params).toContain(93.2)
  })

  it('reads the entry score back as a number, and absent as null', async () => {
    const row = {
      id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
      cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
      capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
      opened_at: '1', updated_at: '1', break_even_armed: false,
    }
    const [scored] = await new PostgresStore(fakeSql([[{ ...row, entry_score: '93.2' }]]).client).loadPositions()
    expect(scored!.entryScore).toBe(93.2)
    const [bare] = await new PostgresStore(fakeSql([[{ ...row, entry_score: null }]]).client).loadPositions()
    expect(bare!.entryScore).toBeNull()
  })

  it('keeps the first DCA scale — a stale snapshot without one never erases it', async () => {
    // *Aplicá el de en la línea.* The scale is measured once, from the day
    // before the first buy; every step of the cycle writes the whole row, and
    // most of those rows were read before the tick measured it.
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition({ ...position, dcaScale: 0.52 })
    expect(calls[0]!.sql).toContain('dca_scale = COALESCE(positions.dca_scale, EXCLUDED.dca_scale)')
    expect(calls[0]!.sql).toContain('entry_score, dca_scale, gain_lock_pct, gain_lock_since')
    expect(calls[0]!.params.slice(-8, -5)).toEqual([0.52, null, null])
    const { client: bare, calls: bareCalls } = fakeSql()
    await new PostgresStore(bare).savePosition(position)
    expect(bareCalls[0]!.params.slice(-8, -5)).toEqual([null, null, null])
  })

  it('reads the DCA scale back as a number, and absent as null', async () => {
    const row = {
      id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
      cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
      capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
      opened_at: '1', updated_at: '1', break_even_armed: false,
    }
    const load = async (extra: Record<string, unknown>) =>
      (await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions())[0]!.dcaScale
    expect(await load({ dca_scale: '0.52' })).toBe(0.52)
    expect(await load({ dca_scale: null })).toBeNull()
    expect(await load({})).toBeNull()
  })

  it('adds the column to a table that already holds money, without a truncate', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_scale DOUBLE PRECISION;')
  })
})

describe('PostgresStore — the real-time DCA scale: the NEWER reading wins, in SQL', () => {
  // *Tiempo real.* The sweep writes what it measured from the last hour; the
  // tick, the trim and a funded rung write the whole row back from snapshots
  // read before it. So the upsert decides, exactly as the MemoryStore does:
  // the pair with the newer `dca_scale_now_at` wins, and a write with an older
  // pair or none keeps what is stored.
  const upsert = async (p: PersistedPosition) => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(p)
    return calls[0]!
  }
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')
  const row = {
    id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
    cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
    capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
    opened_at: '1', updated_at: '1', break_even_armed: false,
  }
  const load = async (extra: Record<string, unknown>) => {
    const [loaded] = await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions()
    return [loaded!.dcaScaleNow, loaded!.dcaScaleNowAt]
  }

  it('writes the pair just before the liquidity watch, and a missing or half reading as two nulls', async () => {
    const measured = await upsert({ ...position, dcaScaleNow: 2.1, dcaScaleNowAt: 1_700 })
    expect(measured.sql).toContain('gain_lock_pct, gain_lock_since, dca_scale_now, dca_scale_now_at')
    expect(measured.sql).toContain('$21')
    expect(measured.params.slice(-5, -3)).toEqual([2.1, 1_700])
    expect((await upsert(position)).params.slice(-5, -3)).toEqual([null, null])
    expect((await upsert({ ...position, dcaScaleNow: 2.1, dcaScaleNowAt: null })).params.slice(-5, -3)).toEqual([null, null])
  })

  it('takes the written pair only when it is NEWER than the stored one', async () => {
    const sql = squash((await upsert(position)).sql)
    const newer = 'WHEN EXCLUDED.dca_scale_now_at IS NOT NULL AND (positions.dca_scale_now_at IS NULL OR EXCLUDED.dca_scale_now_at > positions.dca_scale_now_at)'
    expect(sql).toContain(`dca_scale_now = CASE ${newer} THEN EXCLUDED.dca_scale_now ELSE positions.dca_scale_now END`)
    expect(sql).toContain(`dca_scale_now_at = CASE ${newer} THEN EXCLUDED.dca_scale_now_at ELSE positions.dca_scale_now_at END`)
  })

  it('reads the pair back as numbers, and anything less than both as nothing', async () => {
    expect(await load({ dca_scale_now: '2.1', dca_scale_now_at: '1700' })).toEqual([2.1, 1_700])
    expect(await load({ dca_scale_now: null, dca_scale_now_at: null })).toEqual([null, null])
    expect(await load({ dca_scale_now: '2.1', dca_scale_now_at: null })).toEqual([null, null])
    expect(await load({})).toEqual([null, null])
  })

  it('adds both columns to a table that already holds money, without a truncate', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_scale_now DOUBLE PRECISION;')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_scale_now_at BIGINT;')
  })
})

describe('PostgresStore — the gain lock ratchets in SQL', () => {
  // *Con cada aumento de 20%, aumentar el break-even 10%.* The floor only ever
  // rises while the same holding lives, and the tick, the trim and a funded
  // rung all write the whole row from snapshots older than the sweep's. So the
  // upsert decides, exactly as `keepGainLock` does in the MemoryStore:
  // same holding → the greater floor; a newer holding → its pair; an older one,
  // or none in the write → what is stored.
  const upsert = async (p: PersistedPosition) => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(p)
    return calls[0]!
  }
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')

  it('writes the pair, and a missing lock as two nulls', async () => {
    const locked = await upsert({ ...position, gainLock: { pct: 20, since: 1_700 } })
    expect(locked.sql).toContain('gain_lock_pct, gain_lock_since')
    expect(locked.params.slice(-7, -5)).toEqual([20, 1_700])
    expect((await upsert(position)).params.slice(-7, -5)).toEqual([null, null])
  })

  it('keeps what is stored when the write carries no lock, or an OLDER holding’s', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain('gain_lock_pct = CASE WHEN EXCLUDED.gain_lock_since IS NULL THEN positions.gain_lock_pct')
    expect(sql).toContain('gain_lock_since = CASE WHEN EXCLUDED.gain_lock_since IS NULL THEN positions.gain_lock_since')
    // Anything not newer and not the same holding falls through to the stored pair.
    expect(sql).toMatch(/ELSE positions\.gain_lock_pct END/)
    expect(sql).toMatch(/ELSE positions\.gain_lock_since END/)
  })

  it('takes a NEWER holding’s pair whole', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain('WHEN positions.gain_lock_since IS NULL OR EXCLUDED.gain_lock_since > positions.gain_lock_since THEN EXCLUDED.gain_lock_pct')
    expect(sql).toContain('WHEN positions.gain_lock_since IS NULL OR EXCLUDED.gain_lock_since > positions.gain_lock_since THEN EXCLUDED.gain_lock_since')
  })

  it('never lowers the floor of the same holding', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain('WHEN EXCLUDED.gain_lock_since = positions.gain_lock_since THEN GREATEST(positions.gain_lock_pct, EXCLUDED.gain_lock_pct)')
  })

  it('reads the pair back as numbers, and a half-written or absent pair as no lock', async () => {
    const row = {
      id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
      cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
      capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
      opened_at: '1', updated_at: '1', break_even_armed: false,
    }
    const load = async (extra: Record<string, unknown>) =>
      (await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions())[0]!.gainLock
    expect(await load({ gain_lock_pct: 20, gain_lock_since: '1700' })).toEqual({ pct: 20, since: 1_700 })
    expect(await load({ gain_lock_pct: null, gain_lock_since: null })).toBeNull()
    expect(await load({ gain_lock_pct: 20, gain_lock_since: null })).toBeNull()
    expect(await load({})).toBeNull()
  })
})

describe('PostgresStore — the day log merges in SQL, in one statement', () => {
  // One write per cycle, and the merge happens where two writers cannot race
  // it: the database. The same rule the MemoryStore runs in TypeScript.
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')
  const T = Date.parse('2026-09-28T12:00:00Z')

  it('the first sample of a day sets every field from the one reading', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).recordDailyPnl({ day: '2026-09-28', netUsd: 12.5, at: T })
    const sql = squash(calls[0]!.sql)
    expect(sql).toContain('INSERT INTO daily_pnl (day, open_usd, close_usd, min_usd, max_usd, first_at, last_at, samples)')
    expect(sql).toContain('VALUES ($1, $2, $2, $2, $2, $3, $3, 1)')
    expect(calls[0]!.params).toEqual(['2026-09-28', 12.5, T])
  })

  it('a later sample keeps the open, moves the close, widens the range and counts', async () => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).recordDailyPnl({ day: '2026-09-28', netUsd: 1, at: T })
    const sql = squash(calls[0]!.sql)
    expect(sql).toContain('ON CONFLICT (day) DO UPDATE SET')
    expect(sql).toContain('open_usd = CASE WHEN EXCLUDED.first_at < daily_pnl.first_at THEN EXCLUDED.open_usd ELSE daily_pnl.open_usd END')
    expect(sql).toContain('first_at = LEAST(daily_pnl.first_at, EXCLUDED.first_at)')
    expect(sql).toContain('close_usd = CASE WHEN EXCLUDED.last_at >= daily_pnl.last_at THEN EXCLUDED.close_usd ELSE daily_pnl.close_usd END')
    expect(sql).toContain('last_at = GREATEST(daily_pnl.last_at, EXCLUDED.last_at)')
    expect(sql).toContain('min_usd = LEAST(daily_pnl.min_usd, EXCLUDED.min_usd)')
    expect(sql).toContain('max_usd = GREATEST(daily_pnl.max_usd, EXCLUDED.max_usd)')
    expect(sql).toContain('samples = daily_pnl.samples + 1')
  })

  it('a sample on a new day starts a new row, because the day is the key', async () => {
    const { client, calls } = fakeSql()
    const store = new PostgresStore(client)
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 1, at: T })
    await store.recordDailyPnl({ day: '2026-09-29', netUsd: 2, at: T + 86_400_000 })
    expect(calls.map((c) => c.params[0])).toEqual(['2026-09-28', '2026-09-29'])
    expect(squash(calls[1]!.sql)).toContain('VALUES ($1, $2, $2, $2, $2, $3, $3, 1)')
  })

  it('reads the newest days first, bounded, with NUMERIC and BIGINT parsed', async () => {
    const { client, calls } = fakeSql([[
      { day: '2026-09-28', open_usd: '10.5', close_usd: '9', min_usd: '3', max_usd: '14.25', first_at: String(T), last_at: String(T + 60_000), samples: '4' },
    ]])
    const days = await new PostgresStore(client).dailyPnl(91)
    expect(squash(calls[0]!.sql)).toContain('FROM daily_pnl ORDER BY day DESC LIMIT $1')
    expect(calls[0]!.params).toEqual([91])
    expect(days).toEqual([
      { day: '2026-09-28', openUsd: 10.5, closeUsd: 9, minUsd: 3, maxUsd: 14.25, firstAt: T, lastAt: T + 60_000, samples: 4 },
    ])
  })

  it('the table is created on boot, without touching a table that holds money', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(squash(schema)).toContain('CREATE TABLE IF NOT EXISTS daily_pnl ( day TEXT PRIMARY KEY,')
  })

  it('the reset script clears it with the rest of the state, so a truncate starts the log over', () => {
    const reset = readFileSync(new URL('../../../tools/reset.sql', import.meta.url), 'utf8')
    const everything = reset.split('\n').find((line) => line.includes('TRUNCATE TABLE positions, fills'))
    expect(everything).toContain('daily_pnl')
  })
})

describe('PostgresStore — the liquidity watch: the NEWER watch wins, in SQL', () => {
  // *Siempre esperar la recuperación del 5% de liquidez a partir del mínimo.*
  // The sweep moves the watch; the tick, the trim and a funded rung write the
  // whole row back from snapshots read before it. So the upsert decides,
  // exactly as the MemoryStore does: the watch with the newer `at` wins, and a
  // write with an older one or none keeps what is stored.
  const upsert = async (p: PersistedPosition) => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(p)
    return calls[0]!
  }
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')
  const watch = { peakUsd: 100_000, minUsd: 82_000, braked: true, holdingSince: 1_700, at: 1_800 }
  const row = {
    id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
    cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
    capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
    opened_at: '1', updated_at: '1', break_even_armed: false,
  }
  const load = async (extra: Record<string, unknown>) => {
    const [loaded] = await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions()
    return loaded!.liquidityWatch
  }

  it('writes the watch just before the price low, as JSON, and none as null', async () => {
    const written = await upsert({ ...position, liquidityWatch: watch })
    expect(written.sql).toContain('dca_scale_now, dca_scale_now_at, liquidity_watch, price_low, dip_watch)')
    expect(written.sql).toContain('$22')
    expect(JSON.parse(written.params.at(-3) as string)).toEqual(watch)
    expect((await upsert(position)).params.at(-3)).toBeNull()
    expect((await upsert({ ...position, liquidityWatch: null })).params.at(-3)).toBeNull()
  })

  it('takes the written watch only when it is NEWER than the stored one', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain(
      "liquidity_watch = CASE WHEN EXCLUDED.liquidity_watch IS NOT NULL AND (positions.liquidity_watch IS NULL " +
      "OR (EXCLUDED.liquidity_watch->>'at')::bigint > (positions.liquidity_watch->>'at')::bigint) " +
      'THEN EXCLUDED.liquidity_watch ELSE positions.liquidity_watch END',
    )
  })

  it('reads it back whole, and anything malformed as nothing', async () => {
    expect(await load({ liquidity_watch: watch })).toEqual(watch)
    expect(await load({ liquidity_watch: JSON.stringify(watch) })).toEqual(watch)
    expect(await load({ liquidity_watch: null })).toBeNull()
    expect(await load({})).toBeNull()
    expect(await load({ liquidity_watch: { ...watch, minUsd: 'x' } })).toBeNull()
    expect(await load({ liquidity_watch: { ...watch, braked: 'yes' } })).toBeNull()
  })

  it('adds the column to a table that already holds money, without a truncate', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS liquidity_watch JSONB;')
  })
})

describe('PostgresStore — the price low: a stale snapshot never raises it, in SQL', () => {
  // *Si el precio cae más de 80% y hay un rebote de 10%, nueva compra DCA de
  // $20.* The rebound is measured from the lowest live price the holding has
  // seen, and it has to survive a restart. The sweep lowers it; the tick, the
  // trim and a funded rung write the whole row back from snapshots read before
  // it. So the upsert decides, exactly as `keepPriceLow` does in the
  // MemoryStore: the same holding keeps the LOWER price, a newer holding's low
  // replaces it whole, and a write with an older holding's low, or none, keeps
  // what is stored.
  const upsert = async (p: PersistedPosition) => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(p)
    return calls[0]!
  }
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')
  const low = { price: 0.15, at: 1_900, holdingSince: 1_700 }
  const row = {
    id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
    cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
    capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
    opened_at: '1', updated_at: '1', break_even_armed: false,
  }
  const load = async (extra: Record<string, unknown>) => {
    const [loaded] = await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions()
    return loaded!.priceLow
  }

  it('writes the low just before the dip watch, as JSON, and none as null', async () => {
    const written = await upsert({ ...position, priceLow: low })
    expect(written.sql).toContain('liquidity_watch, price_low, dip_watch)')
    expect(written.sql).toContain('$23')
    expect(JSON.parse(written.params.at(-2) as string)).toEqual(low)
    expect((await upsert(position)).params.at(-2)).toBeNull()
    expect((await upsert({ ...position, priceLow: null })).params.at(-2)).toBeNull()
  })

  it('keeps what is stored when the write carries none, or an OLDER holding’s', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain('price_low = CASE WHEN EXCLUDED.price_low IS NULL THEN positions.price_low')
    expect(sql).toMatch(/ELSE positions\.price_low END/)
  })

  it('takes a NEWER holding’s low whole, and the LOWER price of the same holding', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain(
      "WHEN positions.price_low IS NULL OR (EXCLUDED.price_low->>'holdingSince')::bigint > (positions.price_low->>'holdingSince')::bigint THEN EXCLUDED.price_low",
    )
    expect(sql).toContain(
      "WHEN (EXCLUDED.price_low->>'holdingSince')::bigint = (positions.price_low->>'holdingSince')::bigint " +
      "AND (EXCLUDED.price_low->>'price')::double precision < (positions.price_low->>'price')::double precision THEN EXCLUDED.price_low",
    )
  })

  it('reads it back whole, and anything malformed as nothing', async () => {
    expect(await load({ price_low: low })).toEqual(low)
    expect(await load({ price_low: JSON.stringify(low) })).toEqual(low)
    expect(await load({ price_low: null })).toBeNull()
    expect(await load({})).toBeNull()
    expect(await load({ price_low: { ...low, price: 'x' } })).toBeNull()
    expect(await load({ price_low: { ...low, price: 0 } })).toBeNull()
    expect(await load({ price_low: { price: 0.15, at: 1_900 } })).toBeNull()
    expect(await load({ price_low: '{not json' })).toBeNull()
  })

  it('adds the column to a table that already holds money, without a truncate', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS price_low JSONB;')
  })
})

describe('PostgresStore — the dip-bounce watch: the newer reading wins, in SQL', () => {
  // *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD.* The
  // sweep arms the watch, tracks its low and moves its reference; the tick, the
  // trim and a funded step write the whole row back from snapshots read before
  // it. So the upsert decides, exactly as `keepDipWatch` does in the
  // MemoryStore: the NEWER watch wins, and none keeps what is stored.
  const upsert = async (p: PersistedPosition) => {
    const { client, calls } = fakeSql()
    await new PostgresStore(client).savePosition(p)
    return calls[0]!
  }
  const squash = (sql: string) => sql.replace(/\s+/g, ' ')
  const watch = { reference: 1, low: 0.95, armed: true, at: 1_900, holdingSince: null }
  const later = { reference: 0.969, low: null, armed: false, at: 2_000, holdingSince: 1_950 }
  const row = {
    id: 'pos-1', chain: 'solana', token_address: 'Mint1', pair_address: 'Pair1', symbol: 'TEST',
    cascade: position.cascade, death_watch: position.deathWatch, quality: position.quality,
    capital_usd: '500', last_bar_time: '1', last_price_usd: '1', pending_orders: [],
    opened_at: '1', updated_at: '1', break_even_armed: false,
  }
  const load = async (extra: Record<string, unknown>) => {
    const [loaded] = await new PostgresStore(fakeSql([[{ ...row, ...extra }]]).client).loadPositions()
    return loaded!.dipWatch
  }

  it('writes the watch last, as JSON, and none as null', async () => {
    const written = await upsert({ ...position, dipWatch: watch })
    expect(written.sql).toContain('price_low, dip_watch)')
    expect(written.sql).toContain('$24')
    expect(JSON.parse(written.params.at(-1) as string)).toEqual(watch)
    expect((await upsert(position)).params.at(-1)).toBeNull()
    expect((await upsert({ ...position, dipWatch: null })).params.at(-1)).toBeNull()
  })

  it('takes the written watch only when it is NEWER than the stored one', async () => {
    const sql = squash((await upsert(position)).sql)
    expect(sql).toContain(
      "dip_watch = CASE WHEN EXCLUDED.dip_watch IS NOT NULL AND (positions.dip_watch IS NULL " +
      "OR (EXCLUDED.dip_watch->>'at')::bigint > (positions.dip_watch->>'at')::bigint) " +
      'THEN EXCLUDED.dip_watch ELSE positions.dip_watch END',
    )
  })

  it('reads it back whole — before the first buy and after it — and anything malformed as nothing', async () => {
    expect(await load({ dip_watch: watch })).toEqual(watch)
    expect(await load({ dip_watch: later })).toEqual(later)
    expect(await load({ dip_watch: JSON.stringify(later) })).toEqual(later)
    expect(await load({ dip_watch: null })).toBeNull()
    expect(await load({})).toBeNull()
    expect(await load({ dip_watch: { ...watch, reference: 0 } })).toBeNull()
    expect(await load({ dip_watch: { ...watch, reference: 'x' } })).toBeNull()
    expect(await load({ dip_watch: { ...watch, armed: 'yes' } })).toBeNull()
    expect(await load({ dip_watch: { ...watch, low: -1 } })).toBeNull()
    expect(await load({ dip_watch: { reference: 1, low: null, armed: false, at: 1 } })).toBeNull()
    expect(await load({ dip_watch: '{not json' })).toBeNull()
  })

  it('writes and reads back a COLLAPSED watch — and a row from before the field reads as not collapsed', async () => {
    const crashed: DipWatch = { reference: 1, low: 0.684, armed: true, at: 2_100, holdingSince: null, crashed: true }
    expect(JSON.parse((await upsert({ ...position, dipWatch: crashed })).params.at(-1) as string)).toEqual(crashed)
    expect(await load({ dip_watch: crashed })).toEqual(crashed)
    expect(await load({ dip_watch: JSON.stringify(crashed) })).toEqual(crashed)
    // Every row written before the field existed, and anything but `true`.
    expect(await load({ dip_watch: watch })).not.toHaveProperty('crashed')
    for (const odd of [false, 'yes', 1, null]) {
      const read = await load({ dip_watch: { ...watch, crashed: odd } })
      expect(read, String(odd)).toEqual(watch)
      expect(read, String(odd)).not.toHaveProperty('crashed')
    }
  })

  it('adds the column to a table that already holds money, without a truncate', () => {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    expect(schema).toContain('ALTER TABLE positions ADD COLUMN IF NOT EXISTS dip_watch JSONB;')
  })
})

describe('PostgresStore — the registry, read in pages and never written by the engine', () => {
  const read = async (limit: number, offset?: number) => {
    const { client, calls } = fakeSql([[]])
    await new PostgresStore(client).knownTokens(limit, offset)
    return calls[0]!
  }

  it('reads a page, busiest first, from an offset', async () => {
    const call = await read(500, 1_000)
    expect(call.sql.replace(/\s+/g, ' ')).toContain('FROM solana_cache ORDER BY volume24h DESC NULLS LAST, contract LIMIT $1 OFFSET $2')
    expect(call.params).toEqual([500, 1_000])
  })

  it('starts at the top when no offset is given', async () => {
    expect((await read(600)).params).toEqual([600, 0])
  })

  it('reads the whole registry with no limit — LIMIT ALL, never a number it cannot bind', async () => {
    const call = await read(Number.POSITIVE_INFINITY, 500)
    expect(call.sql.replace(/\s+/g, ' ')).toContain('ORDER BY volume24h DESC NULLS LAST, contract LIMIT ALL OFFSET $1')
    expect(call.params).toEqual([500])
  })
})
