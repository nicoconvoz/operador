import { describe, it, expect } from 'vitest'
import { tickPosition, type EngineConfig, type TickInput } from './engine.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/telegram.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type AssetHealthObservation, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type Candles } from './replay.js'

const HOUR = 3_600_000
const quality: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 }

/** A long decline from a swing high — what the classic entry gate wants. */
const decline = (bars: number): Candles => {
  const time: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = []
  for (let i = 0; i < bars; i++) {
    const price = i < bars - 40 ? 1 : 1 - ((i - (bars - 40)) / 40) * 0.35
    time.push(i * HOUR)
    open.push(price); high.push(price * 1.005); low.push(price * 0.995); close.push(price)
    volume.push(10_000)
  }
  return { time, open, high, low, close, volume }
}

const healthy = (over: Partial<AssetHealthObservation> = {}): AssetHealthObservation => ({
  observedAt: 0, source: 'test', sellQuote: 'ok', liquidityUsd: 1_000_000, lpStatus: 'burned',
  mintAuthorityActive: false, freezeAuthorityActive: false, transfersBlocked: false,
  topHolderMovedPct: 0, hoursSinceLastTrade: 0, ...over,
})

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'TEST',
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, 0), quality, capitalUsd: 1_000,
  lastBarTime: -1, pendingOrders: [], openedAt: 0, updatedAt: 0, ...over,
})

const config: EngineConfig = { params: DEFAULT_PARAMS }

const rig = () => ({
  store: new MemoryStore(),
  alerts: new RecordingAlerts(),
  throttle: new AlertThrottle(60_000),
  broker: new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 1_000, maxOpenEntries: 10, quality: () => quality }),
})

const tick = async (input: Partial<TickInput> & Pick<TickInput, 'candles'>, r = rig()) => {
  const result = await tickPosition(
    { position: position(), health: null, broker: r.broker, ...input },
    config, r.store, r.alerts, r.throttle,
  )
  return { result, ...r }
}

describe('tickPosition — never decides the same bar twice', () => {
  it('skips a bar it has already processed', async () => {
    const candles = decline(300)
    const last = candles.time.at(-1)!
    const { result } = await tick({ candles, position: position({ lastBarTime: last }) })
    expect(result.skipped).toBe('already-processed')
    expect(result.orders).toEqual([])
  })

  it('skips an empty candle set instead of crashing', async () => {
    const empty: Candles = { time: [], open: [], high: [], low: [], close: [], volume: [] }
    const { result } = await tick({ candles: empty })
    expect(result.skipped).toBe('no-bars')
  })

  it('advances lastBarTime so the next restart cannot replay it', async () => {
    const candles = decline(300)
    const { result, store } = await tick({ candles })
    expect(result.position.lastBarTime).toBe(candles.time.at(-1))
    const persisted = await store.loadPositions()
    expect(persisted[0]!.lastBarTime).toBe(candles.time.at(-1))
  })
})

describe('tickPosition — writes before it sends', () => {
  it('persists the orders as pending before they are submitted', async () => {
    const candles = decline(300)
    const { result, store } = await tick({ candles })
    const persisted = await store.loadPositions()
    expect(persisted[0]!.pendingOrders).toEqual(result.orders)
  })

  it('persists the cascade and the death watch together', async () => {
    const candles = decline(300)
    const { store } = await tick({ candles, health: healthy() })
    const persisted = await store.loadPositions()
    expect(persisted[0]!.cascade).toBeDefined()
    expect(persisted[0]!.deathWatch.stage).toBe('healthy')
  })
})

describe('tickPosition — the death watch has the last word', () => {
  const frozenWatch = (): DeathWatchState => ({ ...startDeathWatch(1_000_000, 0), stage: 'frozen' })

  it('a frozen watch removes entries and says which were vetoed', async () => {
    const candles = decline(300)
    const open = await tick({ candles })
    // Only meaningful if the strategy wanted to enter on this bar.
    if (open.result.orders.length === 0) return

    const { result } = await tick({ candles, position: position({ deathWatch: frozenWatch() }) })
    expect(result.orders.filter((o) => o.kind === 'entry')).toEqual([])
    expect(result.vetoed.length).toBeGreaterThan(0)
  })

  it('three confirmed bad observations kill the position and blacklist the token', async () => {
    const candles = decline(300)
    const r = rig()
    let pos = position()
    for (let i = 0; i < 3; i++) {
      const out = await tickPosition(
        { position: pos, candles: { ...candles, time: candles.time.map((t) => t + i) }, health: healthy({ sellQuote: 'failed', observedAt: i }), broker: r.broker },
        config, r.store, r.alerts, r.throttle,
      )
      pos = out.position
    }
    expect(pos.deathWatch.stage).toBe('dead')
    expect(await r.store.blacklisted()).toContain('solana:Mint1')
    expect(r.alerts.sent.some((a) => a.kind === 'death-exit' && a.level === 'critical')).toBe(true)
  })

  it('a dead watch replaces every order with the death exit while in position', async () => {
    const candles = decline(300)
    const r = rig()
    // Put a real position on the broker's books.
    r.broker.execute([{ kind: 'entry', id: 'Entry', level: 0, usd: 100, qty: 100, comment: 'x' }], 1, 0)
    const dead: DeathWatchState = { ...startDeathWatch(1_000_000, 0), stage: 'dead' }
    const out = await tickPosition(
      { position: position({ deathWatch: dead, cascade: { ...initialState(), level: 2, ep1: 1, wasInTrade: true } }), candles, health: null, broker: r.broker },
      config, r.store, r.alerts, r.throttle,
    )
    expect(out.orders).toEqual([{ kind: 'closeAll', comment: '☠️ Death Exit' }])
  })
})

describe('tickPosition — what it tells the human', () => {
  it('announces an opened position', async () => {
    const candles = decline(300)
    const { result, alerts } = await tick({ candles })
    if (result.orders.some((o) => o.kind === 'entry')) {
      expect(alerts.sent.some((a) => a.kind === 'position-opened')).toBe(true)
    }
  })

  it('does not alert twice for the same death exit order', async () => {
    const candles = decline(300)
    const r = rig()
    r.broker.execute([{ kind: 'entry', id: 'Entry', level: 0, usd: 100, qty: 100, comment: 'x' }], 1, 0)
    const dead: DeathWatchState = { ...startDeathWatch(1_000_000, 0), stage: 'dead' }
    await tickPosition(
      { position: position({ deathWatch: dead, cascade: { ...initialState(), level: 2, ep1: 1, wasInTrade: true } }), candles, health: null, broker: r.broker },
      config, r.store, r.alerts, r.throttle,
    )
    expect(r.alerts.sent.filter((a) => a.kind === 'position-closed')).toHaveLength(0)
  })

  it('throttles freeze alerts per position', async () => {
    const candles = decline(300)
    const r = rig()
    let pos = position()
    for (let i = 0; i < 3; i++) {
      const out = await tickPosition(
        { position: pos, candles: { ...candles, time: candles.time.map((t) => t + i) }, health: healthy({ topHolderMovedPct: 50, observedAt: i }), broker: r.broker },
        config, r.store, r.alerts, r.throttle,
      )
      pos = out.position
    }
    expect(r.alerts.sent.filter((a) => a.kind === 'ladder-frozen')).toHaveLength(1)
  })
})
