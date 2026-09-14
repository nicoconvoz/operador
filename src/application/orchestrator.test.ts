import { describe, it, expect } from 'vitest'
import { runCycle, type CycleConfig, type CycleDeps } from './orchestrator.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState, type Order } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type Candidate } from '../domain/scanner/ranking.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candles } from './replay.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const quality: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: NOW }

const flat = (bars = 300): Candles => {
  const time: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = []
  for (let i = 0; i < bars; i++) {
    time.push(i * HOUR); open.push(1); high.push(1.001); low.push(0.999); close.push(1); volume.push(10_000)
  }
  return { time, open, high, low, close, volume }
}

const candidate = (address: string, score: number): Candidate => ({
  snapshot: { chain: 'solana', address, symbol: address, pairAddress: `pair-${address}` } as TokenSnapshot,
  opportunity: { score, components: {} as never },
  marketQuality: quality,
})

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Held', pairAddress: 'PairHeld', symbol: 'HELD',
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, NOW), quality, capitalUsd: 300,
  lastBarTime: -1, lastPriceUsd: 1, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const config: CycleConfig = {
  params: DEFAULT_PARAMS,
  portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: 2_000, maxPositions: 4 },
  heartbeatMs: 60 * 60 * 1000,
}

const rig = (over: Partial<CycleDeps> = {}) => {
  const store = new MemoryStore()
  const alerts = new RecordingAlerts()
  const deps: CycleDeps = {
    store,
    alerts,
    probe: async () => 'not-filled',
    candlesFor: async () => flat(),
    healthFor: async () => null,
    brokerFor: async () => new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 1_000, maxOpenEntries: 10, quality: () => quality }),
    scan: async () => [candidate('a', 90), candidate('b', 80)],
    now: () => NOW,
    ...over,
  }
  return { deps, store, alerts, throttle: new AlertThrottle(60_000) }
}

describe('runCycle — order of operations is the safety property', () => {
  it('recovers before it scans: a cold start opens positions and checkpoints', async () => {
    const { deps, store, throttle } = rig()
    const result = await runCycle(deps, config, throttle)
    expect(result.recovery.positions).toEqual([])
    expect(result.opened).toHaveLength(2)
    const checkpoint = await store.loadCheckpoint()
    expect(checkpoint?.savedAt).toBe(NOW)
  })

  it('persists every opened position with a death watch already armed', async () => {
    const { deps, store, throttle } = rig()
    await runCycle(deps, config, throttle)
    const stored = await store.loadPositions()
    expect(stored).toHaveLength(2)
    for (const p of stored) {
      expect(p.deathWatch.stage).toBe('healthy')
      // The baseline every future liquidity collapse is measured against.
      expect(p.deathWatch.entryLiquidityUsd).toBe(quality.liquidityUsd)
    }
  })

  it('ticks existing positions and advances their bar', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position())
    const result = await runCycle(deps, config, throttle)
    expect(result.ticks).toHaveLength(1)
    expect(result.ticks[0]!.position.lastBarTime).toBe(flat().time.at(-1))
  })
})

describe('runCycle — a halted position is contained, not ignored', () => {
  const pending: Order = { kind: 'entry', id: 'DCA-1', level: 1, usd: 100, qty: 100, comment: 'DCA-1' }

  it('alerts critically and never ticks it', async () => {
    const { deps, store, alerts, throttle } = rig({ probe: async () => 'unknown' })
    await store.savePosition(position({ pendingOrders: [pending] }))
    const result = await runCycle(deps, config, throttle)
    expect(result.haltedIds).toEqual(['pos-1'])
    expect(result.ticks).toEqual([])
    expect(alerts.sent.some((a) => a.kind === 'position-halted' && a.level === 'critical')).toBe(true)
  })

  it('its capital is NOT free — the engine does not double its own exposure', async () => {
    const { deps, store, throttle } = rig({ probe: async () => 'unknown' })
    await store.savePosition(position({ capitalUsd: 1_900, pendingOrders: [pending] }))
    const result = await runCycle(deps, config, throttle)
    // $2,000 total with $1,900 committed to a halted position leaves $100 —
    // under the floor, so nothing new opens.
    expect(result.opened).toEqual([])
  })

  it('it also consumes a slot', async () => {
    const { deps, store, throttle } = rig({ probe: async () => 'unknown' })
    for (let i = 0; i < 4; i++) {
      await store.savePosition(position({ id: `p${i}`, tokenAddress: `T${i}`, capitalUsd: 10, pendingOrders: [pending] }))
    }
    const result = await runCycle(deps, config, throttle)
    expect(result.haltedIds).toHaveLength(4)
    expect(result.opened).toEqual([]) // maxPositions 4, all consumed
  })
})

describe('runCycle — the kill switch', () => {
  it('opens nothing but keeps the death watch running on open positions', async () => {
    const { deps, store, alerts, throttle } = rig()
    await store.saveCheckpoint({ savedAt: NOW, lastCompletedBar: 0, killSwitchEngaged: true })
    await store.savePosition(position())
    const result = await runCycle(deps, config, throttle)

    expect(result.killSwitchEngaged).toBe(true)
    expect(result.opened).toEqual([])
    // Stopping new risk is not abandoning open risk.
    expect(result.ticks).toHaveLength(1)
    expect(alerts.sent.some((a) => a.kind === 'kill-switch' && a.level === 'critical')).toBe(true)
  })

  it('stays engaged across cycles', async () => {
    const { deps, store, throttle } = rig()
    await store.saveCheckpoint({ savedAt: NOW, lastCompletedBar: 0, killSwitchEngaged: true })
    await runCycle(deps, config, throttle)
    expect((await store.loadCheckpoint())?.killSwitchEngaged).toBe(true)
  })
})

describe('runCycle — what it refuses to open', () => {
  it('never reopens a token it already holds', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('Held', 99), candidate('new', 50)] })
    await store.savePosition(position())
    const result = await runCycle(deps, config, throttle)
    expect(result.opened.map((p) => p.tokenAddress)).toEqual(['new'])
  })

  it('never reopens a blacklisted token, however highly it ranks', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('dead', 99), candidate('ok', 10)] })
    await store.blacklist('solana', 'dead', 'sell path broken', NOW)
    const result = await runCycle(deps, config, throttle)
    expect(result.opened.map((p) => p.tokenAddress)).toEqual(['ok'])
  })

  it('alerts when the scanner finds nothing', async () => {
    const { deps, alerts, throttle } = rig({ scan: async () => [] })
    const result = await runCycle(deps, config, throttle)
    expect(result.opened).toEqual([])
    expect(alerts.sent.some((a) => a.kind === 'scan-empty')).toBe(true)
  })

  it('a position with no candles is skipped without stopping the cycle', async () => {
    const { deps, store, throttle } = rig({ candlesFor: async () => null })
    await store.savePosition(position())
    const result = await runCycle(deps, config, throttle)
    expect(result.ticks).toEqual([])
    expect(result.opened.length).toBeGreaterThan(0)
  })
})

describe('runCycle — liveness', () => {
  it('always reports a heartbeat with the shape of the cycle', async () => {
    const { deps, alerts, throttle } = rig()
    await runCycle(deps, config, throttle)
    const beat = alerts.sent.find((a) => a.kind === 'heartbeat')
    expect(beat).toBeDefined()
    // The COUNTS, not the wording. A heartbeat that stops naming how many
    // positions ran is broken; one that says it in another language is not.
    expect(beat!.body).toMatch(/\d+.*\d+.*\d+/)
  })

  it('checkpoints the furthest bar any position reached', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position())
    await runCycle(deps, config, throttle)
    expect((await store.loadCheckpoint())?.lastCompletedBar).toBe(flat().time.at(-1))
  })
})

describe('runCycle — the sell path is confirmed before money moves', () => {
  it('refuses to open a token whose sell path cannot be confirmed NOW', async () => {
    const { deps, alerts, throttle } = rig()
    const asked: string[] = []

    await runCycle(
      { ...deps, confirmSellable: async (snapshot) => { asked.push(snapshot.address); return false } },
      config,
      throttle,
    )

    // The scanner's verdict can be up to two hours old, because its security
    // reports are cached so the budget can reach every token. A cached
    // honeypot flag is exactly the one that must not be trusted at the moment
    // capital is committed.
    expect(asked.length).toBeGreaterThan(0)
    expect(await deps.store.loadPositions()).toEqual([])
    expect(alerts.sent.some((a) => a.kind === 'provider-degraded')).toBe(true)
  })

  it('opens normally when the sell path still answers', async () => {
    const { deps, throttle } = rig()
    await runCycle({ ...deps, confirmSellable: async () => true }, config, throttle)
    expect((await deps.store.loadPositions()).length).toBeGreaterThan(0)
  })

  it('opens when no confirmation port is wired — the check is an addition, not a gate that fails closed on absence', async () => {
    const { deps, throttle } = rig()
    await runCycle(deps, config, throttle)
    expect((await deps.store.loadPositions()).length).toBeGreaterThan(0)
  })
})
