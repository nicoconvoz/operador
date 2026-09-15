import { describe, it, expect } from 'vitest'
import { retireToken, type RetireDeps } from './retire.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

const NOW = 1_800_000_000_000
const quality: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: NOW }

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'FakeBTC111', pairAddress: 'Pair1', symbol: 'BTC',
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, NOW), quality, capitalUsd: 285,
  lastBarTime: NOW, lastPriceUsd: 2, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const rig = (store = new MemoryStore()) => {
  const alerts = new RecordingAlerts()
  const deps: RetireDeps = {
    store,
    alerts,
    now: () => NOW,
    brokerFor: async (p) => {
      const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 10, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      return broker
    },
  }
  return { store, alerts, deps }
}

const request = { chain: 'solana' as const, tokenAddress: 'FakeBTC111', reason: 'wearing the BTC ticker at a mint that is not wBTC' }

describe('retireToken — an operator taking one token off the board', () => {
  it('closes the position and blacklists the token', async () => {
    const { store, deps } = rig()
    await store.savePosition(position())

    const result = await retireToken(deps, request)

    expect(result.retired).toBe(true)
    expect(result.symbol).toBe('BTC')
    expect(await store.loadPositions()).toEqual([])
    expect((await store.blacklisted()).has('solana:FakeBTC111')).toBe(true)
  })

  it('cancels an entry that had not filled yet — there is nothing to sell', async () => {
    const { store, deps } = rig()
    await store.savePosition(position({
      pendingOrders: [{ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 7.5, comment: '🟢 Entry' }],
    }))

    const result = await retireToken(deps, request)

    expect(result.cancelledOrders).toBe(1)
    expect(result.soldQty).toBe(0)
    expect((await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')).toEqual([])
  })

  it('sells what the position actually holds before closing it', async () => {
    const { store, deps } = rig()
    await store.savePosition(position())
    await store.recordFill({
      positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 1000, price: 2, qty: 7.5,
      costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: 'seed-1',
    })

    const result = await retireToken(deps, request)

    // The tokens are real and leaving the board means leaving the token. A
    // blacklist alone would abandon the bag: recovery SKIPS a blacklisted
    // position, so it stops being ticked while its holdings stay bought — and
    // its capital stops counting as committed, which is how the portfolio
    // quietly hands the same dollars to somebody else.
    expect(result.soldQty).toBeCloseTo(7.5, 6)
    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    expect(sells).toHaveLength(1)
  })

  it('refuses to sell at a price nobody measured', async () => {
    const { store, deps } = rig()
    await store.savePosition(position({ lastPriceUsd: null }))
    await store.recordFill({
      positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 1000, price: 2, qty: 7.5,
      costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: 'seed-1',
    })

    const result = await retireToken(deps, request)

    // Booking a sale at an invented price would put a fiction in the one
    // ledger the whole system derives its numbers from. Better to stop and say
    // so: the position stays, whole, for a human to look at.
    expect(result.retired).toBe(false)
    expect(result.refusal).toMatch(/precio/i)
    expect(await store.loadPositions()).toHaveLength(1)
    expect((await store.blacklisted()).has('solana:FakeBTC111')).toBe(false)
  })

  it('blacklists a token it holds no position in, so the scanner stops offering it', async () => {
    const { store, deps } = rig()

    const result = await retireToken(deps, request)

    expect(result.retired).toBe(true)
    expect(result.symbol).toBeNull()
    expect((await store.blacklisted()).has('solana:FakeBTC111')).toBe(true)
  })

  it('says what it did, loudly — this is a human moving money', async () => {
    const { store, alerts, deps } = rig()
    await store.savePosition(position())

    await retireToken(deps, request)

    const sent = alerts.sent.find((a) => a.title.includes('BTC'))
    expect(sent?.level).toBe('critical')
    expect(sent?.body).toContain('wearing the BTC ticker')
  })

  it('is safe to run twice', async () => {
    const { store, deps } = rig()
    await store.savePosition(position())

    await retireToken(deps, request)
    const second = await retireToken(deps, request)

    expect(second.retired).toBe(true)
    expect(await store.loadPositions()).toEqual([])
  })
})
