import { describe, it, expect } from 'vitest'
import { bookCapital, fundRungsFromFreeCapital, fundStepFromFreeCapital, freeSlots } from './free-capital.js'
import { capitalForFillsUsd, ladderCapitalUsd } from './paper-run.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

const quality: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 }
const params = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
const GAS = 0.05
const ONE_ENTRY = ladderCapitalUsd(params, 1, GAS)
const TWO_ENTRIES = ladderCapitalUsd(params, 2, GAS)

const position = (id: string, capitalUsd: number): PersistedPosition => ({
  id, chain: 'solana', tokenAddress: id, pairAddress: `pair-${id}`, symbol: id,
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, 0), quality, capitalUsd,
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
})

const fill = (positionId: string, side: 'buy' | 'sell', price: number, qty: number, time: number): PersistedFill => ({
  positionId, orderId: 'Entry', side, time, price, qty, costUsd: 0, comment: side === 'buy' ? '🟢 Entry' : '🏁 Exit',
  idempotencyKey: `${positionId}:${side}:${time}`,
})

describe('bookCapital — ONE definition of what is free', () => {
  it('is the capital, plus what the book has made, minus what the open positions hold', () => {
    // A closed round trip that made ten dollars: the common fund.
    const fills = [fill('old', 'buy', 1, 10, 0), fill('old', 'sell', 2, 10, 1)]
    const book = bookCapital(100, fills, [{ capitalUsd: 30 }, { capitalUsd: 20 }])
    expect(book.totalUsd).toBeCloseTo(110, 9)
    expect(book.committedUsd).toBeCloseTo(50, 9)
    expect(book.freeUsd).toBeCloseTo(60, 9)
  })

  it('is never negative — an over-committed book has nothing free, not a debt', () => {
    expect(bookCapital(10, [], [{ capitalUsd: 30 }]).freeUsd).toBe(0)
  })
})

describe('fundRungsFromFreeCapital — a rung takes its capital when it fires', () => {
  const rig = async (total: number, held: PersistedPosition, others: readonly PersistedPosition[] = []) => {
    const store = new MemoryStore()
    await store.savePosition(held)
    for (const other of others) await store.savePosition(other)
    const fund = fundRungsFromFreeCapital({ store, totalCapitalUsd: total, params, gasUsdPerSwap: GAS })
    return { store, fund }
  }

  it('raises the position to what one more entry needs, and saves it', async () => {
    const { store, fund } = await rig(100, position('T', ONE_ENTRY), [position('U', 60)])
    const funded = await fund(position('T', ONE_ENTRY), 2)
    expect(funded?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
    expect((await store.loadPositions()).find((p) => p.id === 'T')?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
  })

  it('refuses when the free capital cannot cover it, and touches nothing', async () => {
    // 40 − 15.89 − 20 leaves 4.11 free, against the 15.84 a second entry adds.
    const { store, fund } = await rig(40, position('T', ONE_ENTRY), [position('U', 20)])
    expect(await fund(position('T', ONE_ENTRY), 2)).toBeNull()
    expect((await store.loadPositions()).find((p) => p.id === 'T')?.capitalUsd).toBeCloseTo(ONE_ENTRY, 9)
  })

  it('charges nothing for a rung the position can already pay for — and never LOWERS it', async () => {
    const { store, fund } = await rig(50, position('T', 45))
    expect((await fund(position('T', 45), 2))?.capitalUsd).toBe(45)
    expect((await store.loadPositions())[0]?.capitalUsd).toBe(45)
  })

  it('reads the capital from the STORE, never from the caller’s snapshot', async () => {
    // The trim-over-tick bug's shape, from the other side: a sweep holding a
    // copy from before a rung was funded must not pay for that rung twice —
    // nor write the smaller number back over the larger one.
    const { store, fund } = await rig(40, position('T', TWO_ENTRIES))
    const funded = await fund(position('T', ONE_ENTRY), 2)
    expect(funded?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
    expect((await store.loadPositions())[0]?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
  })

  it('counts what the book has MADE as free — the same common fund the allocator spends', async () => {
    const { store, fund } = await rig(20, position('T', ONE_ENTRY))
    // Without the fund: 20 − 15.89 = 4.11 free, not enough. With a closed
    // round trip that made twenty dollars, it is.
    expect(await fund(position('T', ONE_ENTRY), 2)).toBeNull()
    await store.recordFill(fill('old', 'buy', 1, 20, 0))
    await store.recordFill(fill('old', 'sell', 2, 20, 1))
    expect((await fund(position('T', ONE_ENTRY), 2))?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
  })
})

describe('fundRungsFromFreeCapital — ladder A: each rung is priced at its OWN size', () => {
  // *Arriesguémonos, activá la A.* A $10 first buy, then $15, $20, $25, $30 and
  // $35. The capital `entries` entries need is the first buy plus the first
  // `entries − 1` rungs, with the same gas and headroom the allocator uses.
  const ten = { ...DEFAULT_PARAMS, maxUsdPerLevel: 10 }
  const RUNGS = [15, 20, 25, 30, 35]
  const FIRST = ladderCapitalUsd(ten, 1, GAS)
  const rig = async (total: number, held: PersistedPosition) => {
    const store = new MemoryStore()
    await store.savePosition(held)
    const fund = fundRungsFromFreeCapital({ store, totalCapitalUsd: total, params: ten, gasUsdPerSwap: GAS, rungsUsd: RUNGS })
    return { store, fund }
  }

  it('allocates the one-entry slot at about $10.63 — the first buy alone', () => {
    expect(FIRST).toBeCloseTo(capitalForFillsUsd([10], GAS), 9)
    expect(FIRST).toBeCloseTo(10.63, 2)
  })

  it('raises a position to $10 + $15 for DCA-1, and to all $135 for DCA-5', async () => {
    const { fund } = await rig(1_000, position('T', FIRST))
    expect((await fund(position('T', FIRST), 2))?.capitalUsd).toBeCloseTo(capitalForFillsUsd([10, 15], GAS), 9)
    expect((await fund(position('T', FIRST), 6))?.capitalUsd).toBeCloseTo(capitalForFillsUsd([10, 15, 20, 25, 30, 35], GAS), 9)
  })

  it('asks the free capital for exactly the next rung’s share, and refuses when it is not there', async () => {
    // Three entries funded ($10 + $15 + $20); DCA-3 adds $25 grossed up, about $26.37.
    const three = capitalForFillsUsd([10, 15, 20], GAS)
    const four = capitalForFillsUsd([10, 15, 20, 25], GAS)
    const { fund } = await rig(four - 0.01, position('T', three))
    expect(await fund(position('T', three), 4)).toBeNull()
    const enough = await rig(four + 0.01, position('T', three))
    expect((await enough.fund(position('T', three), 4))?.capitalUsd).toBeCloseTo(four, 9)
  })
})

describe('freeSlots — ONE definition of how many tokens the free capital can still take', () => {
  // *No pongas tope, el tope son 5000 dividido 50, que es lo que tengo.* Then
  // twenty steps of a dollar: capital / $20, less what the open slots hold.
  it('is the free capital over the slot, rounded down — nothing grossed up, no haircut', () => {
    expect(freeSlots(bookCapital(5_000, [], []), 20)).toBe(250)
    expect(freeSlots(bookCapital(1_500, [], []), 20)).toBe(75)
    expect(freeSlots(bookCapital(5_000, [], Array.from({ length: 70 }, () => ({ capitalUsd: 20 }))), 20)).toBe(180)
    expect(freeSlots(bookCapital(5_000, [], Array.from({ length: 250 }, () => ({ capitalUsd: 20 }))), 20)).toBe(0)
  })

  it('counts what the book made and paid: the common fund moves it', () => {
    const lost = [fill('old', 'buy', 1, 30, 0), fill('old', 'sell', 0.5, 30, 1)]
    expect(freeSlots(bookCapital(100, lost, []), 20)).toBe(4)
  })

  it('is zero on a slot of nothing, never infinite', () => {
    expect(freeSlots(bookCapital(100, [], []), 0)).toBe(0)
  })
})

describe('fundStepFromFreeCapital — the fees a step pays come out of the free capital', () => {
  // A slot reserves exactly steps × step, so the spread, the impact and the gas
  // of each $1 buy are not in it. When a step finds its cash short, the
  // shortfall is asked of the book's FREE capital — the same definition the
  // allocator opens positions with — and refused when there is none.
  const rig = async (total: number, held: PersistedPosition, cash: number, others: readonly PersistedPosition[] = []) => {
    const store = new MemoryStore()
    await store.savePosition(held)
    for (const other of others) await store.savePosition(other)
    const asked: number[] = []
    const fund = fundStepFromFreeCapital({
      store,
      totalCapitalUsd: total,
      cashOf: async (p) => { asked.push(p.capitalUsd); return cash + (p.capitalUsd - held.capitalUsd) },
    })
    return { store, fund, asked }
  }

  it('returns the position as stored when its cash already pays for the step', async () => {
    const { fund } = await rig(100, position('T', 20), 12)
    expect((await fund(position('T', 20), 1.06))?.capitalUsd).toBe(20)
  })

  it('raises the capital by exactly the shortfall, and saves it', async () => {
    const { store, fund } = await rig(100, position('T', 20), 0.5)
    const funded = await fund(position('T', 20), 1.06)
    expect(funded!.capitalUsd).toBeCloseTo(20.56, 6)
    expect(funded!.capitalUsd).toBeGreaterThan(20.56)
    expect((await store.loadPositions())[0]!.capitalUsd).toBeCloseTo(20.56, 6)
  })

  it('refuses when the free capital cannot cover the shortfall, and touches nothing', async () => {
    // 40 − 20 − 20 leaves nothing free.
    const { store, fund } = await rig(40, position('T', 20), 0.5, [position('U', 20)])
    expect(await fund(position('T', 20), 1.06)).toBeNull()
    expect((await store.loadPositions()).find((p) => p.id === 'T')!.capitalUsd).toBe(20)
  })

  it('reads the capital from the STORE, never from the caller’s snapshot', async () => {
    const { fund, asked } = await rig(100, position('T', 25), 12)
    await fund(position('T', 20), 1.06)
    expect(asked).toEqual([25])
  })
})
