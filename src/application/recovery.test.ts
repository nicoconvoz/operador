import { describe, it, expect } from 'vitest'
import { planRecovery, orderKeyPart, type OrderProbe, type PendingVerdict } from './recovery.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { idempotencyKeyFor, type PersistedPosition } from '../domain/persistence/store.js'
import { initialState, type Order } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'

const BAR = 1_800_000_000_000

const entry: Order = { kind: 'entry', id: 'DCA-2', level: 2, usd: 300, qty: 1000, comment: 'DCA-2' }
const exit: Order = { kind: 'closeAll', comment: '🏁 Exit' }

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1',
  chain: 'solana',
  tokenAddress: 'Mint1',
  pairAddress: 'Pair1',
  symbol: 'TEST',
  cascade: { ...initialState(), level: 3, ep1: 0.01, wasInTrade: true },
  deathWatch: startDeathWatch(100_000, BAR),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.2, referenceUsd: 100, observedAt: BAR },
  capitalUsd: 500,
  lastBarTime: BAR, lastPriceUsd: 1,
  pendingOrders: [],
  openedAt: BAR - 86_400_000,
  updatedAt: BAR,
  ...over,
})

const probeAlways = (verdict: PendingVerdict): OrderProbe => async () => verdict

const seed = async (store: MemoryStore, p: PersistedPosition) => {
  await store.savePosition(p)
  return store
}

describe('planRecovery — nothing in flight', () => {
  it('resumes a position with no pending orders', async () => {
    const store = await seed(new MemoryStore(), position())
    const plan = await planRecovery(store, probeAlways('unknown'))
    expect(plan.positions).toHaveLength(1)
    expect(plan.halted).toHaveLength(0)
    expect(plan.positions[0]!.position.cascade.level).toBe(3)
  })

  it('restores the checkpoint and the kill switch', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: BAR, lastCompletedBar: BAR, killSwitchEngaged: true })
    const plan = await planRecovery(store, probeAlways('unknown'))
    expect(plan.resumedFromBar).toBe(BAR)
    expect(plan.killSwitchEngaged).toBe(true)
  })

  it('an empty store recovers to an empty engine, not a crash', async () => {
    const plan = await planRecovery(new MemoryStore(), probeAlways('unknown'))
    expect(plan.positions).toEqual([])
    expect(plan.resumedFromBar).toBeNull()
    expect(plan.killSwitchEngaged).toBe(false)
  })
})

describe('planRecovery — a recorded fill is the truth', () => {
  it('never asks the venue about an order the store already has', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry] }))
    const key = idempotencyKeyFor('pos-1', BAR, 'DCA-2')
    await store.recordFill({ positionId: 'pos-1', orderId: 'DCA-2', side: 'buy', time: BAR, price: 0.01, qty: 1000, costUsd: 10, comment: 'DCA-2', idempotencyKey: key })

    let asked = 0
    const plan = await planRecovery(store, async () => { asked++; return 'not-filled' })
    expect(asked).toBe(0)
    expect(plan.positions[0]!.resolutions[0]).toMatchObject({ verdict: 'filled', action: 'record-and-continue' })
  })

  it('the key is deterministic, so a replayed order is recognised, not repeated', () => {
    expect(idempotencyKeyFor('pos-1', BAR, orderKeyPart(entry))).toBe(idempotencyKeyFor('pos-1', BAR, 'DCA-2'))
    expect(orderKeyPart(exit)).toBe('closeAll:🏁 Exit')
    // Different bar, different order: never collides by accident.
    expect(idempotencyKeyFor('pos-1', BAR, 'DCA-2')).not.toBe(idempotencyKeyFor('pos-1', BAR + 1, 'DCA-2'))
    expect(idempotencyKeyFor('pos-1', BAR, 'DCA-2')).not.toBe(idempotencyKeyFor('pos-2', BAR, 'DCA-2'))
  })
})

describe('planRecovery — a confirmed miss may be retried', () => {
  it('resubmits an order the venue never saw', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry] }))
    const plan = await planRecovery(store, probeAlways('not-filled'))
    expect(plan.positions[0]!.resolutions[0]!.action).toBe('resubmit')
    expect(plan.positions[0]!.resumable).toBe(true)
  })

  it('records a fill the venue confirms but the store missed', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry] }))
    const plan = await planRecovery(store, probeAlways('filled'))
    expect(plan.positions[0]!.resolutions[0]!.action).toBe('record-and-continue')
  })
})

describe('planRecovery — an unknown halts, it never guesses', () => {
  it('halts the position when the venue cannot say', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry] }))
    const plan = await planRecovery(store, probeAlways('unknown'))
    expect(plan.positions).toHaveLength(0)
    expect(plan.halted).toHaveLength(1)
    expect(plan.halted[0]!.resolutions[0]!.action).toBe('halt')
  })

  it('a halted position keeps its state — it stops, it does not reset', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry] }))
    const plan = await planRecovery(store, probeAlways('unknown'))
    expect(plan.halted[0]!.position.cascade.level).toBe(3)
    expect(plan.halted[0]!.position.capitalUsd).toBe(500)
  })

  it('one unknown among several pendings halts the whole position', async () => {
    const store = await seed(new MemoryStore(), position({ pendingOrders: [entry, exit] }))
    const probe: OrderProbe = async (_p, order) => (order.kind === 'entry' ? 'not-filled' : 'unknown')
    const plan = await planRecovery(store, probe)
    expect(plan.halted).toHaveLength(1)
    expect(plan.halted[0]!.resolutions.map((r) => r.action)).toEqual(['resubmit', 'halt'])
  })

  it('halting one position does not stop the others', async () => {
    const store = new MemoryStore()
    await store.savePosition(position({ id: 'clean', tokenAddress: 'MintA' }))
    await store.savePosition(position({ id: 'stuck', tokenAddress: 'MintB', pendingOrders: [entry] }))
    const plan = await planRecovery(store, probeAlways('unknown'))
    expect(plan.positions.map((p) => p.position.id)).toEqual(['clean'])
    expect(plan.halted.map((p) => p.position.id)).toEqual(['stuck'])
  })
})

describe('planRecovery — the dead stay dead', () => {
  it('never resumes a blacklisted token, whatever its state says', async () => {
    const store = await seed(new MemoryStore(), position())
    await store.blacklist('solana', 'Mint1', 'sell path broken', BAR)
    const plan = await planRecovery(store, probeAlways('filled'))
    expect(plan.positions).toEqual([])
    expect(plan.halted).toEqual([])
    expect(plan.blacklisted.has('solana:Mint1')).toBe(true)
  })

  it('the first death verdict is the one kept', async () => {
    const store = new MemoryStore()
    await store.blacklist('solana', 'Mint1', 'LP removed', BAR)
    await store.blacklist('solana', 'Mint1', 'something else', BAR + 1000)
    expect(store.blacklistReason('solana', 'Mint1')).toBe('LP removed')
  })
})

describe('MemoryStore — the reference implementation', () => {
  it('is idempotent: the same fill written twice is stored once', async () => {
    const store = new MemoryStore()
    const fill = { positionId: 'p', orderId: 'o', side: 'buy' as const, time: BAR, price: 1, qty: 1, costUsd: 0, comment: 'c', idempotencyKey: 'k' }
    await store.recordFill(fill)
    await store.recordFill({ ...fill, price: 999 })
    const fills = await store.fillsFor('p')
    expect(fills).toHaveLength(1)
    expect(fills[0]!.price).toBe(1) // first write wins
  })

  it('returns copies, so a caller cannot corrupt the store by mutating', async () => {
    const store = await seed(new MemoryStore(), position())
    const loaded = await store.loadPositions()
    ;(loaded[0]!.cascade as { level: number }).level = 99
    const again = await store.loadPositions()
    expect(again[0]!.cascade.level).toBe(3)
  })

  it('a closed position leaves its fills behind for the audit trail', async () => {
    const store = await seed(new MemoryStore(), position())
    await store.recordFill({ positionId: 'pos-1', orderId: 'o', side: 'buy', time: BAR, price: 1, qty: 1, costUsd: 0, comment: 'c', idempotencyKey: 'k' })
    await store.closePosition('pos-1')
    expect(await store.loadPositions()).toEqual([])
    expect(await store.fillsFor('pos-1')).toHaveLength(1)
  })
})
