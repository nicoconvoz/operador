import { describe, it, expect } from 'vitest'
import { buildOperations } from './operations-view.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'DREGG',
  cascade: { ...initialState(), level: 3, ep1: 0.01, wasInTrade: true },
  deathWatch: startDeathWatch(250_000, NOW),
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 200, lastBarTime: NOW, lastPriceUsd: 0.011, pendingOrders: [],
  openedAt: NOW - 60 * MIN, updatedAt: NOW, ...over,
})

const fill = (orderId: string, price: number, qty: number, at: number, side: 'buy' | 'sell' = 'buy'): PersistedFill => ({
  positionId: 'pos-1', orderId, side, time: at, price, qty, costUsd: price * qty * 0.006,
  comment: orderId, idempotencyKey: `${orderId}:${at}`,
})

const seed = async (fills: PersistedFill[], over: Partial<PersistedPosition> = {}) => {
  const store = new MemoryStore()
  await store.savePosition(position(over))
  for (const f of fills) await store.recordFill(f)
  return store
}

const options = { now: () => NOW, params: DEFAULT_PARAMS }

describe('buildOperations — the books come from the fills', () => {
  it('an empty store reports nothing, not zeroes that look like activity', async () => {
    const view = await buildOperations(new MemoryStore(), options)
    expect(view.positions).toEqual([])
    expect(view.recentFills).toEqual([])
    expect(view.totals.deployedUsd).toBe(0)
  })

  it('derives deployed, quantity and average cost from the fills themselves', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN), fill('DCA-1', 0.009, 2_000, NOW - 10 * MIN)])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.qty).toBe(3_000)
    expect(p!.deployedUsd).toBeCloseTo(0.01 * 1_000 + 0.009 * 2_000, 9)
    expect(p!.avgCostUsd).toBeCloseTo(28 / 3_000, 9)
  })

  it('marks the position at its last known price and shows the gap', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN)])
    const [p] = (await buildOperations(store, options)).positions
    // Bought at 0.01, marked at 0.011: up 10%.
    expect(p!.marketValueUsd).toBeCloseTo(11, 9)
    expect(p!.unrealisedUsd).toBeCloseTo(1, 9)
    expect(p!.unrealisedPct).toBeCloseTo(10, 6)
  })

  it('shows a loss as a loss', async () => {
    const store = await seed([fill('Entry', 0.02, 1_000, NOW - MIN)])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.unrealisedUsd).toBeLessThan(0)
    expect(p!.unrealisedPct).toBeLessThan(0)
  })

  it('totals what the chain has taken so far', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN), fill('DCA-1', 0.009, 2_000, NOW)])
    const view = await buildOperations(store, options)
    expect(view.totals.costsUsd).toBeGreaterThan(0)
    expect(view.totals.costsUsd).toBeCloseTo(view.positions[0]!.costsUsd, 9)
  })

  it('a sell reduces the quantity held', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 20 * MIN), fill('Entry', 0.012, 1_000, NOW - MIN, 'sell')])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.qty).toBe(0)
    expect(p!.marketValueUsd).toBeNull()
  })
})

describe('buildOperations — the ladder, planned against actual', () => {
  it('marks which rungs filled, at what price, and which one is next', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN), fill('DCA-1', 0.0094, 2_000, NOW - 10 * MIN)])
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    expect(ladder[0]).toMatchObject({ level: 0, filled: true, fillPrice: 0.01 })
    expect(ladder[1]).toMatchObject({ level: 1, filled: true, fillPrice: 0.0094 })
    // The machine is at level 3, so that is the rung it waits on.
    expect(ladder[2]).toMatchObject({ level: 2, filled: false, pending: false })
    expect(ladder[3]).toMatchObject({ level: 3, filled: false, pending: true })
  })

  it('computes each rung trigger from the anchor entry, not from the last fill', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN)])
    const { ladder } = (await buildOperations(store, options)).positions[0]!
    // ep1 = 0.01, linear drops 1%, 4%, 7% …
    expect(ladder[1]!.triggerPrice).toBeCloseTo(0.01 * 0.99, 12)
    expect(ladder[2]!.triggerPrice).toBeCloseTo(0.01 * 0.96, 12)
    expect(ladder[0]!.triggerPrice).toBeNull() // the entry has no trigger of its own
  })

  it('flags the rungs the venue will never fill', async () => {
    const { ladder } = (await buildOperations(await seed([]), options)).positions[0]!
    expect(ladder.filter((r) => r.beyondPyramiding).map((r) => r.level)).toEqual([10, 11])
  })

  it('carries the nominal size of each rung, so the plan is visible too', async () => {
    const { ladder } = (await buildOperations(await seed([]), options)).positions[0]!
    expect(ladder[0]!.nominalUsd).toBe(1_000)
    expect(ladder[1]!.nominalUsd).toBe(2_200)
  })
})

describe('buildOperations — the tape', () => {
  it('lists fills newest first, tagged with the token', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 30 * MIN),
      fill('DCA-1', 0.009, 2_000, NOW - 10 * MIN),
      fill('DCA-2', 0.008, 3_000, NOW - MIN),
    ])
    const { recentFills } = await buildOperations(store, options)
    expect(recentFills.map((f) => f.orderId)).toEqual(['DCA-2', 'DCA-1', 'Entry'])
    expect(recentFills[0]!.symbol).toBe('DREGG')
  })

  it('counts buys and sells', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 20 * MIN), fill('Entry', 0.012, 1_000, NOW - MIN, 'sell')])
    const { totals } = await buildOperations(store, options)
    expect(totals.buys).toBe(1)
    expect(totals.sells).toBe(1)
  })

  it('caps the tape so a long history does not become the whole page', async () => {
    const many = Array.from({ length: 80 }, (_, i) => fill(`DCA-${i}`, 0.01, 10, NOW - i * MIN))
    const view = await buildOperations(await seed(many), { ...options, tapeLength: 25 })
    expect(view.recentFills).toHaveLength(25)
  })
})

describe('buildOperations — what needs attention', () => {
  it('surfaces a pending order and the death stage', async () => {
    const store = await seed([], {
      pendingOrders: [{ kind: 'entry', id: 'DCA-3', level: 3, usd: 100, qty: 1, comment: 'DCA-3' }],
      deathWatch: { ...startDeathWatch(250_000, NOW), stage: 'frozen' },
    })
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.hasPendingOrders).toBe(true)
    expect(p!.deathStage).toBe('frozen')
  })
})

describe('buildOperations — the ladder points at what is actually waiting', () => {
  it('marks the rung whose ORDER is in flight, not the level the machine reached', async () => {
    // The machine advances to level 1 the moment it signals the Entry, but the
    // Entry itself does not fill until the next bar's open. Pointing at rung 1
    // then says "waiting for DCA-1" while rung 0 — the order actually in
    // flight — sits unmarked. Reading that, you would think the entry had
    // happened.
    const store = await seed([], {
      cascade: { ...initialState(), level: 1, ep1: 0.01, wasInTrade: true },
      pendingOrders: [{ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 1500, comment: 'Entry' }],
    })
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    expect(ladder[0]!.pending).toBe(true)
    expect(ladder[1]!.pending).toBe(false)
  })

  it('falls back to the level being waited on when nothing is in flight', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN)], {
      cascade: { ...initialState(), level: 1, ep1: 0.01, wasInTrade: true },
      pendingOrders: [],
    })
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    // Entry filled, nothing in flight: the ladder points at the trigger the
    // strategy is watching for.
    expect(ladder[0]!.filled).toBe(true)
    expect(ladder[1]!.pending).toBe(true)
  })
})
