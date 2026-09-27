import { describe, it, expect } from 'vitest'
import { settle } from './engine.js'
import { holdingBuys, positionLedger } from './ledger.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * The tape is in the order things HAPPENED.
 *
 * TEXTIT, live: the sweep bought DCA-2 at 10:16:49 and DCA-3 at 10:17:31, and
 * the tick then sold all four lots on the 10:15 bar — stamped 10:15:00, the
 * bar it DECIDED on. Sorted by time, the tape read "sold at 10:15, bought at
 * 10:16", so every rebuild of the position found DCA-2 and DCA-3 still held,
 * and the next exit sold them a second time.
 */
const MIN = 60_000
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const position: PersistedPosition = {
  id: 'solana:T:1', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 100,
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
}
const broker = () => new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 100, maxOpenEntries: 6, quality: () => quality })
const entry = (id: string, price: number) => ({ kind: 'entry' as const, id, level: 0, usd: 15, qty: 15 / price, comment: id })

describe('settle — a fill is never stamped before one already on the tape', () => {
  it('stamps a sale decided on an older bar AFTER the rung the sweep bought meanwhile', async () => {
    const store = new MemoryStore()
    await store.savePosition(position)
    const venue = broker()
    await settle([entry('Entry', 1)], 0, 1, 0, position, venue, store)
    await settle([entry('DCA-1', 0.9)], 0, 0.9, 16 * MIN, position, venue, store)
    await settle([{ kind: 'closeAll', comment: '🏁 Exit' }], 15 * MIN, 1.2, 15 * MIN, position, venue, store)

    const fills = await store.fillsFor(position.id)
    const rung = fills.find((f) => f.orderId === 'DCA-1' && f.side === 'buy')!
    for (const sale of fills.filter((f) => f.side === 'sell')) expect(sale.time).toBeGreaterThan(rung.time)
    expect(positionLedger(fills).qty).toBe(0)
    expect(holdingBuys(fills)).toEqual([])
  })

  it('a broker rebuilt from the tape holds nothing after the sale — nothing to sell twice', async () => {
    const store = new MemoryStore()
    await store.savePosition(position)
    const venue = broker()
    await settle([entry('Entry', 1)], 0, 1, 0, position, venue, store)
    await settle([entry('DCA-1', 0.9)], 0, 0.9, 16 * MIN, position, venue, store)
    await settle([{ kind: 'closeAll', comment: '🏁 Exit' }], 15 * MIN, 1.2, 15 * MIN, position, venue, store)

    const rebuilt = broker()
    rebuilt.seed(await store.fillsFor(position.id))
    expect(rebuilt.snapshot(1.2).size).toBe(0)
  })

  it('keeps the time it was given when nothing later is on the tape', async () => {
    const store = new MemoryStore()
    await store.savePosition(position)
    await settle([entry('Entry', 1)], 0, 1, 5 * MIN, position, broker(), store)
    expect((await store.fillsFor(position.id))[0]!.time).toBe(5 * MIN)
  })
})
