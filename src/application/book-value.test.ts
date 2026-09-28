import { describe, it, expect } from 'vitest'
import { bookNetUsd, valuePosition } from './book-value.js'
import { buildOperations } from './operations-view.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'open', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'OPEN',
  cascade: initialState(), deathWatch: startDeathWatch(100_000, NOW),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 15, lastBarTime: NOW, lastPriceUsd: 1.1, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const fill = (positionId: string, side: 'buy' | 'sell', price: number, qty: number, costUsd: number, at: number): PersistedFill => ({
  positionId, orderId: 'Entry', side, time: at, price, qty, costUsd, comment: side, idempotencyKey: `${positionId}:${side}:${at}`,
})

// One position still open, one that closed with a sale — the book the
// headline is asked about every ten seconds.
const tape: PersistedFill[] = [
  fill('closed', 'buy', 1, 10, 0.05, NOW - 3_000),
  fill('closed', 'sell', 1.5, 10, 0.08, NOW - 2_000),
  fill('open', 'buy', 1, 20, 0.1, NOW - 1_000),
]

describe('bookNetUsd — cobrada + sin cobrar − costos, in one place', () => {
  it('adds what the sales banked, what the open book is worth over its cost, and takes off every cost', () => {
    // Realised: 10 × (1.5 − 1) = 5. Costs: 0.05 + 0.08 + 0.1 = 0.23.
    // Unrealised at the live 1.2: 20 × (1.2 − 1) = 4.
    const net = bookNetUsd([position()], tape, new Map([['solana:Mint1', 1.2]]))
    expect(net).toBeCloseTo(5 - 0.23 + 4, 9)
  })

  it('values at the last bar close when no live price came back, as the screen does', () => {
    const net = bookNetUsd([position()], tape, new Map())
    expect(net).toBeCloseTo(5 - 0.23 + 20 * (1.1 - 1), 9)
  })

  it('a zero live price is not a price', () => {
    const net = bookNetUsd([position()], tape, new Map([['solana:Mint1', 0]]))
    expect(net).toBeCloseTo(5 - 0.23 + 20 * (1.1 - 1), 9)
  })

  it('is EXACTLY the figure the headline draws', async () => {
    // Two implementations of "how much are we up" is the failure this project
    // keeps paying for: the engine writes this number into the Log, and the
    // screen draws the other one over it. They must be the same computation.
    const store = new MemoryStore()
    await store.savePosition(position())
    for (const f of tape) await store.recordFill(f)
    const prices = new Map([['solana:Mint1', 1.2]])
    const view = await buildOperations(store, { now: () => NOW, params: DEFAULT_PARAMS, livePrices: async () => prices })
    expect(bookNetUsd(await store.loadPositions(), await store.allFills(), prices)).toBe(view.totals.netUsd)
  })
})

describe('valuePosition — what one position holds and is worth now', () => {
  it('says which price it used', () => {
    const own = tape.filter((f) => f.positionId === 'open')
    expect(valuePosition(position(), own, new Map([['solana:Mint1', 1.2]]))).toMatchObject({
      qty: 20, priceUsd: 1.2, priceIsLive: true, marketValueUsd: 24,
    })
    expect(valuePosition(position(), own, new Map())).toMatchObject({ priceUsd: 1.1, priceIsLive: false })
  })

  it('a flat position is worth nothing and has nothing unrealised', () => {
    const own = tape.filter((f) => f.positionId === 'closed')
    expect(valuePosition(position({ id: 'closed' }), own, new Map())).toMatchObject({ qty: 0, marketValueUsd: null, unrealisedUsd: null })
  })
})
