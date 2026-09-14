import { describe, it, expect } from 'vitest'
import { buildDashboard } from './dashboard.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState, type Order } from '../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'DREGG',
  cascade: { ...initialState(), level: 3 },
  deathWatch: startDeathWatch(100_000, NOW),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.2, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 475, lastBarTime: NOW, lastPriceUsd: 0.0123, pendingOrders: [], openedAt: NOW - HOUR, updatedAt: NOW,
  ...over,
})

const options = { now: () => NOW }

describe('buildDashboard — what is running', () => {
  it('an empty system reports itself as never having run', async () => {
    const view = await buildDashboard(new MemoryStore(), options)
    expect(view.positions).toEqual([])
    expect(view.totals.committedUsd).toBe(0)
    expect(view.warnings).toContain('No positions and no checkpoint: the engine has never completed a cycle.')
  })

  it('maps a position into what a human needs to see', async () => {
    const store = new MemoryStore()
    await store.savePosition(position())
    const [view] = (await buildDashboard(store, options)).positions
    expect(view).toMatchObject({
      symbol: 'DREGG',
      capitalUsd: 475,
      filledDcas: 2, // level 3 = entry + 2 DCAs
      deathStage: 'healthy',
      lastPriceUsd: 0.0123,
      hasPendingOrders: false,
    })
  })

  it('totals commitment across positions', async () => {
    const store = new MemoryStore()
    await store.savePosition(position())
    await store.savePosition(position({ id: 'pos-2', tokenAddress: 'Mint2', symbol: 'TROLL', capitalUsd: 300 }))
    const view = await buildDashboard(store, options)
    expect(view.totals.positions).toBe(2)
    expect(view.totals.committedUsd).toBe(775)
  })

  it('reports the last scan and the blacklist size', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - HOUR, chain: 'solana', snapshots: [{} as TokenSnapshot, {} as TokenSnapshot] })
    await store.blacklist('solana', 'Dead1', 'LP removed', NOW)
    const view = await buildDashboard(store, options)
    expect(view.lastScan).toEqual({ at: NOW - HOUR, tokensSeen: 2 })
    expect(view.blacklistedCount).toBe(1)
  })
})

describe('buildDashboard — warnings a human should act on', () => {
  it('warns about the kill switch', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW, lastCompletedBar: NOW, killSwitchEngaged: true })
    const view = await buildDashboard(store, options)
    expect(view.killSwitchEngaged).toBe(true)
    expect(view.warnings[0]).toContain('Kill switch is engaged')
  })

  it('warns about an unconfirmed order in flight, by name', async () => {
    const store = new MemoryStore()
    const pending: Order = { kind: 'entry', id: 'DCA-1', level: 1, usd: 100, qty: 1, comment: 'DCA-1' }
    await store.savePosition(position({ pendingOrders: [pending] }))
    const view = await buildDashboard(store, options)
    expect(view.totals.pending).toBe(1)
    expect(view.warnings.some((w) => w.includes('unconfirmed order') && w.includes('DREGG'))).toBe(true)
  })

  it('warns about frozen positions and shows why', async () => {
    const store = new MemoryStore()
    const frozen: DeathWatchState = {
      ...startDeathWatch(100_000, NOW),
      stage: 'frozen',
      evidence: [{ observedAt: NOW, source: 'jupiter', signals: [{ kind: 'liquidityCollapse', stage: 1, detail: 'liquidity $30000 = 30.0% of entry' }], stageAfter: 'frozen', verdict: 'freeze' }],
    }
    await store.savePosition(position({ deathWatch: frozen }))
    const view = await buildDashboard(store, options)
    expect(view.totals.frozen).toBe(1)
    expect(view.warnings.some((w) => w.includes('frozen') && w.includes('DREGG'))).toBe(true)
    expect(view.positions[0]!.deathSignals[0]).toContain('30.0% of entry')
  })

  it('shows the newest death signals first, and at most three', async () => {
    const store = new MemoryStore()
    const evidence = ['first', 'second', 'third', 'fourth'].map((detail, i) => ({
      observedAt: NOW + i, source: 's',
      signals: [{ kind: 'sellPathBroken' as const, stage: 2 as const, detail }],
      stageAfter: 'frozen' as const, verdict: 'none' as const,
    }))
    await store.savePosition(position({ deathWatch: { ...startDeathWatch(100_000, NOW), stage: 'frozen', evidence } }))
    const view = await buildDashboard(store, options)
    expect(view.positions[0]!.deathSignals).toEqual(['fourth', 'third', 'second'])
  })

  it('warns when a position has gone stale — the shape of a silently dead engine', async () => {
    const store = new MemoryStore()
    await store.savePosition(position({ updatedAt: NOW - 5 * HOUR }))
    const view = await buildDashboard(store, { now: () => NOW, staleAfterMs: 2 * HOUR })
    expect(view.warnings.some((w) => w.includes('is the engine running?'))).toBe(true)
  })

  it('a healthy system warns about nothing', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW, lastCompletedBar: NOW, killSwitchEngaged: false })
    await store.savePosition(position())
    const view = await buildDashboard(store, options)
    expect(view.warnings).toEqual([])
  })
})
