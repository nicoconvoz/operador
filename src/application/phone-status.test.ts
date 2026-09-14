import { describe, it, expect } from 'vitest'
import { buildPhoneStatus, STALE_AFTER_MS } from './phone-status.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { alert } from '../domain/notifications/alerts.js'
import { type PersistedPosition } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

const position = (id: string, over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id, chain: 'solana', tokenAddress: id, pairAddress: `p-${id}`, symbol: id,
  cascade: initialState(), deathWatch: startDeathWatch(250_000, NOW),
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 200, lastBarTime: NOW, lastPriceUsd: 0.01, pendingOrders: [],
  openedAt: NOW - 60 * MIN, updatedAt: NOW, ...over,
})

const options = { now: () => NOW }

describe('buildPhoneStatus — what the app polls while it sleeps', () => {
  it('reports a quiet, healthy system', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW - MIN, lastCompletedBar: NOW, killSwitchEngaged: false })

    const status = await buildPhoneStatus(store, options)
    expect(status).toMatchObject({ killSwitchEngaged: false, positions: 0, frozen: 0, engineStale: false, cursor: 0 })
  })

  it('an engine that has never checkpointed is not "healthy", it is unknown', async () => {
    const status = await buildPhoneStatus(new MemoryStore(), options)
    expect(status.lastEngineUpdate).toBeNull()
    // Nothing has ever run: that is not the same as running and fine.
    expect(status.engineStale).toBe(true)
  })

  it('calls the engine stale once it has missed long enough — the failure that looks like silence', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW - STALE_AFTER_MS - 1, lastCompletedBar: NOW, killSwitchEngaged: false })
    expect((await buildPhoneStatus(store, options)).engineStale).toBe(true)
  })

  it('carries the kill switch, because that is the state the phone exists to change', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW, lastCompletedBar: NOW, killSwitchEngaged: true })
    expect((await buildPhoneStatus(store, options)).killSwitchEngaged).toBe(true)
  })

  it('counts positions and the frozen ones separately', async () => {
    const store = new MemoryStore()
    await store.savePosition(position('A'))
    await store.savePosition(position('B', { deathWatch: { ...startDeathWatch(1, NOW), stage: 'frozen' } }))

    const status = await buildPhoneStatus(store, options)
    expect(status.positions).toBe(2)
    expect(status.frozen).toBe(1)
  })

  it('reports the newest alert sequence, so the app knows whether it is behind', async () => {
    const store = new MemoryStore()
    await store.recordAlert(alert('engine-started', 'up', '', NOW))
    await store.recordAlert(alert('death-exit', 'DREGG', '', NOW))
    expect((await buildPhoneStatus(store, options)).cursor).toBe(2)
  })

  it('reports the newest sequence even past one page — the cursor must not stall at 100', async () => {
    const store = new MemoryStore()
    for (let i = 0; i < 130; i += 1) await store.recordAlert(alert('heartbeat', `beat ${i}`, '', NOW + i))
    expect((await buildPhoneStatus(store, options)).cursor).toBe(130)
  })

  it('reads no fills — this is polled every minute on a free database', async () => {
    const store = new MemoryStore()
    let fillReads = 0
    const watched = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'fillsFor') fillReads += 1
        return Reflect.get(target, key, receiver)
      },
    })
    await store.savePosition(position('A'))
    await buildPhoneStatus(watched, options)
    expect(fillReads).toBe(0)
  })
})
