import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import type { PersistedPosition } from '../domain/persistence/store.js'
import { LOG_READ_DAYS } from './daily-log.js'
import { readsFromSnapshot, remoteViewReads, takeViewSnapshot, viewPublisher } from './view-snapshot.js'

const position: PersistedPosition = {
  id: 'solana:T:1', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(100_000, 0),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: 0 },
  capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
}

const seeded = async () => {
  const store = new MemoryStore()
  await store.savePosition(position)
  await store.recordFill({ idempotencyKey: 'k1', positionId: position.id, orderId: 'Entry', side: 'buy', time: 10, price: 1, qty: 15, costUsd: 0.1, comment: '🟢 Entry' })
  await store.saveScan({ scannedAt: 20, chain: 'solana', snapshots: [] })
  await store.saveCheckpoint({ savedAt: 30, lastCompletedBar: 0, killSwitchEngaged: false })
  await store.blacklist('solana', 'DEAD', 'death', 40)
  return store
}

describe('the view snapshot — the engine writes what the screen reads, so the screen never asks the database', () => {
  // *Que esto lo maneje GitHub y que Vercel sólo sea un visor de lo que hace
  // GitHub* (2026-10-11), after the dashboard alone spent 5.1 of Supabase's
  // 5 GB of monthly egress.
  it('answers every read the dashboard makes, exactly as the store did, through JSON', async () => {
    const store = await seeded()
    const snapshot = JSON.parse(JSON.stringify(await takeViewSnapshot(store, 1_000)))
    const reads = readsFromSnapshot(snapshot)
    expect(await reads.loadPositions()).toEqual(await store.loadPositions())
    expect(await reads.allFills()).toEqual(await store.allFills())
    expect(await reads.latestScansByChain()).toEqual(await store.latestScansByChain())
    expect(await reads.latestScan()).toEqual(await store.latestScan())
    expect(await reads.loadCheckpoint()).toEqual(await store.loadCheckpoint())
    expect([...(await reads.blacklisted())]).toEqual([...(await store.blacklisted())])
    expect(await reads.dailyPnl(LOG_READ_DAYS)).toEqual(await store.dailyPnl(LOG_READ_DAYS))
    expect(snapshot.at).toBe(1_000)
  })

  it('takes the newest scan of every chain as the latest one, without asking again', async () => {
    const store = await seeded()
    await store.saveScan({ scannedAt: 50, chain: 'bsc', snapshots: [] })
    const reads = readsFromSnapshot(await takeViewSnapshot(store, 1_000))
    expect((await reads.latestScan())?.scannedAt).toBe(50)
  })

  it('has no latest scan when nothing was ever scanned', async () => {
    const reads = readsFromSnapshot(await takeViewSnapshot(new MemoryStore(), 1))
    expect(await reads.latestScan()).toBeNull()
    expect(await reads.loadPositions()).toEqual([])
  })
})

describe('publishing the view — every two minutes, never two at once, never fatal', () => {
  const rig = () => {
    let clock = 0
    const published: string[] = []
    let fail = false
    let release: (() => void) | null = null
    let hold = false
    const publisher = viewPublisher({
      take: async () => ({ at: clock }),
      publish: async (content) => {
        if (hold) await new Promise<void>((resolve) => { release = resolve })
        if (fail) throw new Error('403')
        published.push(content)
      },
      everyMs: 120_000,
      now: () => clock,
      onError: () => {},
    })
    return {
      publisher, published,
      at: (ms: number) => { clock = ms },
      failing: (on: boolean) => { fail = on },
      holding: (on: boolean) => { hold = on },
      release: () => release?.(),
    }
  }

  it('publishes on the first pass and then once every two minutes', async () => {
    const r = rig()
    await r.publisher.maybePublish()
    r.at(60_000); await r.publisher.maybePublish()
    r.at(120_000); await r.publisher.maybePublish()
    expect(r.published.map((c) => JSON.parse(c).at)).toEqual([0, 120_000])
  })

  it('never starts a second publish while one is still going', async () => {
    const r = rig()
    r.holding(true)
    const first = r.publisher.maybePublish()
    r.at(500_000)
    await r.publisher.maybePublish()
    r.release()
    await first
    expect(r.published).toHaveLength(1)
  })

  it('swallows a failure and tries again on the next pass', async () => {
    const r = rig()
    r.failing(true)
    await expect(r.publisher.maybePublish()).resolves.toBeUndefined()
    r.failing(false)
    r.at(1); await r.publisher.maybePublish()
    expect(r.published).toHaveLength(1)
  })
})

describe('the screen reads the published view, and the database only when it cannot', () => {
  const snapshotAt = async (at: number) => {
    const store = await seeded()
    return JSON.parse(JSON.stringify(await takeViewSnapshot(store, at)))
  }

  it('answers from the published view, fetching it at most once per window', async () => {
    let fetched = 0
    let clock = 0
    const view = await snapshotAt(500)
    const reads = remoteViewReads({ load: async () => { fetched += 1; return view }, fallback: readsFromSnapshot(await snapshotAt(1)), everyMs: 60_000, now: () => clock })
    expect((await reads.loadPositions()).map((p) => p.id)).toEqual(['solana:T:1'])
    await reads.allFills()
    clock = 59_000; await reads.latestScan()
    expect(fetched).toBe(1)
    clock = 61_000; await reads.loadCheckpoint()
    expect(fetched).toBe(2)
    // It says how old the figures are: when the ENGINE wrote them.
    expect(reads.writtenAt()).toBe(500)
  })

  it('falls back to the database when the view cannot be read, and tries the view again next time', async () => {
    let failing = true
    const view = await snapshotAt(500)
    let fallbackAsked = 0
    const fallbackReads = readsFromSnapshot(await snapshotAt(1))
    const fallback = { ...fallbackReads, loadPositions: async () => { fallbackAsked += 1; return fallbackReads.loadPositions() } }
    const reads = remoteViewReads({ load: async () => { if (failing) throw new Error('404'); return view }, fallback, everyMs: 60_000, now: () => 0 })
    await reads.loadPositions()
    expect(fallbackAsked).toBe(1)
    expect(reads.writtenAt()).toBeNull()
    failing = false
    await reads.loadPositions()
    expect(fallbackAsked).toBe(1)
    expect(reads.writtenAt()).toBe(500)
  })
})
