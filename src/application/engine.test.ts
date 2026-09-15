import { describe, it, expect } from 'vitest'
import { tickPosition, type EngineConfig, type TickInput } from './engine.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type AssetHealthObservation, type DeathWatchState } from '../domain/risk/death-exit.js'
import { idempotencyKeyFor, type PersistedPosition } from '../domain/persistence/store.js'
import { orderKeyPart } from './recovery.js'
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
  lastBarTime: -1, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0, ...over,
})

const config: EngineConfig = { params: DEFAULT_PARAMS }

/** One more bar, so a decided order has a next open to fill at. */
const extend = (c: Candles): Candles => ({
  time: [...c.time, c.time.at(-1)! + HOUR],
  open: [...c.open, c.open.at(-1)!],
  high: [...c.high, c.high.at(-1)!],
  low: [...c.low, c.low.at(-1)!],
  close: [...c.close, c.close.at(-1)!],
  volume: [...c.volume, c.volume.at(-1)!],
})

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


describe('tickPosition — the orders actually execute', () => {
  const armed = (bars: Candles) => ({
    ...position(),
    pendingOrders: [{ kind: 'entry' as const, id: 'Entry', level: 0, usd: 100, qty: 100, comment: 'Entry' }],
    lastBarTime: bars.time[bars.time.length - 2]!,
  })

  it(`fills what the PREVIOUS bar decided, at this bar's open`, async () => {
    const candles = decline(300)
    const r = rig()
    const { result } = await tick({ candles, position: armed(candles) }, r)

    const fills = await r.store.fillsFor('pos-1')
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ orderId: 'Entry', side: 'buy', qty: 100 })
    // Parity semantics, the ones the TradingView harness pinned: an order
    // decided at a close fills at the NEXT bar's open, never at the close that
    // decided it.
    expect(fills[0]!.price).toBeGreaterThanOrEqual(candles.open[candles.open.length - 1]!)
    // What stays pending is exactly what THIS bar decided — nothing is carried
    // over. Asserting the id is absent would be wrong: the strategy may well
    // decide the same order again, and that is a new intention, not a stale one.
    expect(result.position.pendingOrders).toEqual(result.orders)
    expect(r.broker.openTrades).toHaveLength(1)
  })

  it('records a fill once, however many times the bar is replayed', async () => {
    const candles = decline(300)
    const store = new MemoryStore()
    const held = armed(candles)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = { ...rig(), store }
      r.broker.seed(await store.fillsFor('pos-1'))
      await tick({ candles, position: held }, r)
    }

    // A retried cycle must not buy twice. The key is deterministic for exactly
    // this reason, and the store enforces it.
    expect(await store.fillsFor('pos-1')).toHaveLength(1)
  })

  it('leaves the books untouched when there was nothing to fill', async () => {
    const candles = decline(300)
    const r = rig()
    await tick({ candles, position: { ...position(), lastBarTime: candles.time[candles.time.length - 2]! } }, r)
    expect(await r.store.fillsFor('pos-1')).toEqual([])
  })
})

describe('tickPosition — the fill recovery will look for', () => {
  it('keys a fill so recovery recognises it, instead of halting a position it just traded', async () => {
    const candles = decline(300)
    const decidedAt = candles.time[candles.time.length - 2]!
    const order = { kind: 'entry' as const, id: 'Entry', level: 0, usd: 100, qty: 100, comment: 'Entry' }
    const r = rig()

    await tick({ candles, position: { ...position(), pendingOrders: [order], lastBarTime: decidedAt } }, r)

    // Recovery asks by the bar the order was DECIDED on, not the one it filled
    // at. These two used to disagree, which would have halted every position
    // the engine had just traded — the exact opposite of what recovery is for.
    const key = idempotencyKeyFor('pos-1', decidedAt, orderKeyPart(order))
    expect(await r.store.hasFill(key)).toBe(true)
  })
})

describe('tickPosition — the ladder is sized to the wallet, not to Pine', () => {
  it('emits an entry the position can actually afford', async () => {
    const candles = decline(300)
    // Exactly production: $285 of capital against a strategy whose nominal
    // level 0 is $1,000. Unsized, the broker refuses it for funds — and a
    // silent rejection looks identical to a strategy with no signals.
    const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 285, maxOpenEntries: 10, quality: () => quality })
    const r = { ...rig(), broker }
    const held = { ...position(), capitalUsd: 285, lastBarTime: candles.time[candles.time.length - 2]! }

    // Bar one decides the entry; bar two fills it at the open.
    const first = await tick({ candles, position: held }, r)
    expect(first.result.orders.filter((o) => o.kind === 'entry')).toHaveLength(1)

    const entry = first.result.orders.find((o) => o.kind === 'entry')!
    expect(entry.usd).toBeLessThan(285)

    await tick({ candles: extend(candles), position: first.result.position }, r)
    expect(await r.store.fillsFor('pos-1')).toHaveLength(1)
    expect(r.broker.rejections).toEqual([])
  })

  it('still lets a position LEAVE when the ladder cannot be sized at all', async () => {
    const candles = decline(300)
    // A pool too thin to size against must not trap the money already in it.
    const thin = { liquidityUsd: 900, spreadPct: 0.3, slippagePct: 60, referenceUsd: 100, observedAt: 0 }
    const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 285, maxOpenEntries: 10, quality: () => thin })
    const r = { ...rig(), broker }
    const held = { ...position(), capitalUsd: 285, quality: thin, lastBarTime: candles.time[candles.time.length - 2]! }

    const { result } = await tick({ candles, position: held }, r)
    expect(result.orders.filter((o) => o.kind === 'entry')).toEqual([])
  })
})

describe('tickPosition — the broker is the truth about what is held', () => {
  it('resyncs a machine that thinks it holds something the broker never bought', async () => {
    const candles = decline(300)
    const r = rig()
    // Exactly what production did: an entry was signalled, the broker refused
    // it for funds, and the state machine advanced anyway. It then waits for a
    // DCA trigger on a position it does not hold, forever, holding capital
    // hostage and showing a ladder that is pure fiction.
    const desynced = {
      ...position(),
      cascade: { ...initialState(), level: 3, ep1: 1, wasInTrade: true },
      pendingOrders: [],
      lastBarTime: candles.time[candles.time.length - 2]!,
    }

    const { result } = await tick({ candles, position: desynced }, r)

    // The fills are the facts, and the broker keeps them. A machine that
    // disagrees with the broker is wrong by definition — so it restarts from
    // flat, which means the next order it can emit is an ENTRY, not a DCA
    // against a cost basis that never existed.
    const entries = result.orders.filter((o) => o.kind === 'entry')
    expect(entries.map((o) => o.id)).toEqual(['Entry'])
    expect(r.alerts.sent.some((a) => a.title.includes('desincronizada'))).toBe(true)
  })

  it('does NOT resync while a decided order is still waiting to fill', async () => {
    const candles = decline(300)
    const r = rig()
    // Decided at a close, fills at the next open: flat-with-pending is the
    // normal state for exactly one bar and must not be mistaken for a
    // desync.
    const waiting = {
      ...position(),
      cascade: { ...initialState(), level: 1, ep1: 1, wasInTrade: true },
      pendingOrders: [{ kind: 'entry' as const, id: 'Entry', level: 0, usd: 100, qty: 100, comment: 'Entry' }],
      lastBarTime: candles.time[candles.time.length - 2]!,
    }

    const { result } = await tick({ candles, position: waiting }, r)
    expect(result.position.cascade.level).not.toBe(0)
  })
})
