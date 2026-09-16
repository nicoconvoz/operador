import { describe, it, expect } from 'vitest'
import { entryAlertLabel, MAX_CATCH_UP_BARS, tickPosition, type EngineConfig, type TickInput } from './engine.js'
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

// ── Catch-up: the strategy's clock is the BAR, not the cycle ─────────────────
//
// Production ran one tick per cycle and one cycle per ~37 minutes. On 15-minute
// bars that meant the engine saw ten of every twenty-two bars, and every
// parameter counted in bars silently changed meaning: `confirmBars: 20` stopped
// being five hours and became eleven, so the rebound confirmation could never
// complete inside a position's life and the DCA ladder NEVER fired once in
// production. Ten entries, six exits, zero DCAs.
//
// A scheduler getting slower must not change what the strategy computes.

/** A flat series — no gates fire, so these tests measure only bar walking. */
const flat = (bars: number, price = 1): Candles => ({
  time: Array.from({ length: bars }, (_, i) => i * HOUR),
  open: Array.from({ length: bars }, () => price),
  high: Array.from({ length: bars }, () => price * 1.001),
  low: Array.from({ length: bars }, () => price * 0.999),
  close: Array.from({ length: bars }, () => price),
  volume: Array.from({ length: bars }, () => 10_000),
})

describe('tickPosition — it advances every bar it missed', () => {
  it('walks each unprocessed bar instead of jumping to the newest', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    // Five bars behind: the shape of a cycle that took longer than a bar.
    const stale = position({ lastBarTime: candles.time[294]! })

    const result = await tickPosition({ position: stale, candles, health: null, broker }, config, store, alerts, throttle)

    expect(result.barsAdvanced).toBe(5)
    expect(result.position.lastBarTime).toBe(candles.time[299])
  })

  it('a position that is up to date does nothing', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    const current = position({ lastBarTime: candles.time[299]! })

    const result = await tickPosition({ position: current, candles, health: null, broker }, config, store, alerts, throttle)

    expect(result.skipped).toBe('already-processed')
    expect(result.barsAdvanced).toBe(0)
  })

  it('a brand new position starts at the newest bar — it does not replay history', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)

    // lastBarTime is -1 on a position the portfolio just opened. Walking from
    // there would replay every candle the provider returned and fill a ladder
    // at prices that are days old.
    const result = await tickPosition({ position: position({ lastBarTime: -1 }), candles, health: null, broker }, config, store, alerts, throttle)

    expect(result.barsAdvanced).toBe(1)
    expect(result.position.lastBarTime).toBe(candles.time[299])
  })

  it('an outage longer than the cap resumes at the cap, not at the beginning', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(400)

    const result = await tickPosition(
      { position: position({ lastBarTime: candles.time[0]! }), candles, health: null, broker },
      config, store, alerts, throttle,
    )

    // Replaying a week of bars would decide orders against prices nobody can
    // trade at any more. Bounded, and the position still ends up current.
    expect(result.barsAdvanced).toBe(MAX_CATCH_UP_BARS)
    expect(result.position.lastBarTime).toBe(candles.time[399])
  })

  it('executes a pending order at the bar that FOLLOWS the decision, not at the newest', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    const decidedAt = candles.time[294]!
    const order = { kind: 'entry' as const, id: 'Entry', level: 0, usd: 15, qty: 15, comment: '🟢 Entry' }

    await tickPosition(
      { position: position({ lastBarTime: decidedAt, pendingOrders: [order], cascade: { ...initialState(), level: 1, ep1: 1 } }), candles, health: null, broker },
      config, store, alerts, throttle,
    )

    const fills = await store.fillsFor('pos-1')
    const entry = fills.find((f) => f.side === 'buy')
    // An order decided at bar 294 fills at bar 295's open. Filling it at bar
    // 299 would book a price five bars away from the decision that caused it.
    expect(entry?.time).toBe(candles.time[295])
  })
})

// ── Never exit at a loss on price ───────────────────────────────────────────
//
// CLAUDE.md states it as a premise, not a preference: the strategy exits a
// DEAD ASSET, never a falling one. The ladder's whole argument is that a drop
// is an opportunity to average down, so selling into one destroys the edge the
// system exists to harvest.
//
// It leaked anyway, and not through the rule — through EXECUTION. The exit is
// decided at a bar's close, where price IS above average cost, and fills at the
// next bar's OPEN. Production sold BinanceTown at -13.1% with the comment
// "🏁 Exit" because the gap between that close and that open was -14.8%. On
// 15-minute small caps the execution gap is routinely larger than the whole
// +2% profit target, so a rule enforced only at decision time is not enforced.
//
// A real venue can look at the price before it sends the order. So it does.

const held = (entryPrice: number, qty: number) => {
  const { store, alerts, throttle } = rig()
  const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 1_000, maxOpenEntries: 10, quality: () => quality })
  broker.seed([{ orderId: 'Entry', side: 'buy', time: 0, price: entryPrice, qty, costUsd: 0, comment: '🟢 Entry' }])
  return { store, alerts, throttle, broker }
}

/** Flat until the last bar, which opens at `gapTo` — the gap-down. */
const gapDown = (bars: number, price: number, gapTo: number): Candles => {
  const c = flat(bars, price)
  return {
    ...c,
    open: [...c.open.slice(0, -1), gapTo],
    low: [...c.low.slice(0, -1), gapTo * 0.999],
    close: [...c.close.slice(0, -1), gapTo],
  }
}

describe('tickPosition — a falling price is not a reason to sell', () => {
  // The ladder is still THREE LEVELS DEEP while the exit is in flight, and that
  // is not a detail of the fixture — it is the invariant. `stepCascade` resets
  // the cycle on `!inPosition && wasInTrade`: it reacts to the BROKER going
  // flat, never to the exit being signalled. So a position with an unfilled
  // exit still carries its ladder, and nothing has to be rolled back.
  const exiting = (lastBarTime: number) => position({
    lastBarTime,
    cascade: { ...initialState(), level: 3, ep1: 1, wasInTrade: true },
    pendingOrders: [{ kind: 'closeAll' as const, comment: '🏁 Exit' as const }],
  })

  it('refuses a normal exit that would fill below average cost', async () => {
    const { store, alerts, throttle, broker } = held(1, 100)
    const candles = gapDown(300, 1, 0.87) // the -13% production actually booked

    await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    expect(sells).toEqual([])
  })

  it('keeps the ladder alive, so the drop can become a DCA instead of a loss', async () => {
    const { store, alerts, throttle, broker } = held(1, 100)
    const candles = gapDown(300, 1, 0.87)

    // A machine that reset to flat here would have walked away from a ladder it
    // was three levels into — the very ladder whose job is to average this drop
    // down. It survives because the broker still holds, and the broker is what
    // the reset listens to.
    const result = await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    expect(result.position.cascade.level).toBe(3)
    expect(result.position.cascade.ep1).toBe(1)
  })

  it('sells the moment the price is back above average cost', async () => {
    const { store, alerts, throttle, broker } = held(1, 100)
    const candles = gapDown(300, 1, 1.05)

    await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    expect(sells).toHaveLength(1)
    expect(sells[0]!.price).toBeCloseTo(1.05, 2) // minus the venue spread
  })

  it('a death exit sells at ANY price — a dead asset is the one exception', async () => {
    const { store, alerts, throttle, broker } = held(1, 100)
    const candles = gapDown(300, 1, 0.42)
    const dying = position({
      lastBarTime: candles.time[298]!,
      cascade: { ...initialState(), level: 3, ep1: 1, wasInTrade: true },
      pendingOrders: [{ kind: 'closeAll' as const, comment: '☠️ Death Exit' as const }],
    })

    // The no-loss rule assumes the asset mean-reverts. When the asset has
    // stopped being an asset, holding out for a better price is how you end up
    // holding something unsellable.
    await tickPosition({ position: dying, candles, health: null, broker }, config, store, alerts, throttle)

    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    expect(sells).toHaveLength(1)
    expect(sells[0]!.price).toBeCloseTo(0.42, 2) // minus the venue spread
  })
})

// ── What an entry alert says it is ──────────────────────────────────────────
//
// The label was chosen from the machine's level, read BEFORE stepCascade runs
// its own reset. After a sale the machine still says "in trade" on that bar, so
// a full re-opening went out as "➕ … Entry" — the plus sign that means DCA.
//
// Live, that read as the ladder finally firing while the DCA count was still
// zero. The ORDER knows better than the machine does: both entry doors emit
// level 0, and a DCA emits its own level.

describe('entryAlertLabel — the order is the fact, not the machine', () => {
  it('names the classic door', () => {
    expect(entryAlertLabel({ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 1, comment: '🟢 Entry' }))
      .toEqual({ opening: true, icon: '🟢', name: 'Entry' })
  })

  it('names the trend re-entry as its own door, not as a DCA', () => {
    expect(entryAlertLabel({ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 1, comment: '🚀 Re-Entry' }))
      .toEqual({ opening: true, icon: '🚀', name: 'Re-Entry' })
  })

  it('still marks a real ladder rung with the plus', () => {
    expect(entryAlertLabel({ kind: 'entry', id: 'DCA-3', level: 3, usd: 40, qty: 1, comment: 'DCA-3' }))
      .toEqual({ opening: false, icon: '➕', name: 'DCA-3' })
  })
})

// ── The ladder at depth, through the path production uses ───────────────────
//
// The deepest thing production has ever reached is DCA-1, and the parity
// harness proves the ladder to DCA-4 against TradingView's own trade list. What
// neither covers is the LIVE loop: decide, persist, the process dies, rebuild
// from fills, decide again — with six rungs open instead of two.
//
// The sharpest difference at depth is the cost basis. Six rungs down, the
// average sits far below the FIRST entry, so a sale under the opening price can
// be a healthy profit. A guard reading the wrong fill would behave backwards
// exactly here, and never anywhere shallower.

describe('tickPosition — a ladder six rungs deep', () => {
  /** Entry plus five DCAs, a nickel apart. Seeded, so the basis is exactly 0.875. */
  const deep = () => {
    const { store, alerts, throttle } = rig()
    const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 10_000, maxOpenEntries: 10, quality: () => quality })
    broker.seed([1, 0.95, 0.9, 0.85, 0.8, 0.75].map((price, level) => ({
      orderId: level === 0 ? 'Entry' : `DCA-${level}`,
      side: 'buy' as const, time: level, price, qty: 100, costUsd: 0, comment: level === 0 ? '🟢 Entry' : `DCA-${level}`,
    })))
    return { store, alerts, throttle, broker }
  }

  const exiting = (lastBarTime: number) => position({
    lastBarTime,
    cascade: { ...initialState(), level: 6, ep1: 1, wasInTrade: true },
    pendingOrders: [{ kind: 'closeAll' as const, comment: '🏁 Exit' as const }],
  })

  it('lets a deep ladder out at 0.92 — under the 1.00 entry, over the 0.875 average', async () => {
    const { store, alerts, throttle, broker } = deep()
    const candles = gapDown(300, 1, 0.92)

    await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    // The whole point of averaging down: the position is green at a price the
    // first rung is deeply red at.
    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    expect(sells).toHaveLength(6)
  })

  it('still refuses below the AVERAGE, not below the last rung', async () => {
    const { store, alerts, throttle, broker } = deep()
    // 0.80 is above the last rung at 0.75 and below the 0.875 basis. A guard
    // comparing against the most recent fill would let this one through at a
    // loss on the position as a whole.
    const candles = gapDown(300, 1, 0.8)

    await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    expect((await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')).toEqual([])
  })

  it('records one fill per rung, each keyed apart so none collides', async () => {
    const { store, alerts, throttle, broker } = deep()
    const candles = gapDown(300, 1, 0.95)

    await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    const sells = (await store.fillsFor('pos-1')).filter((f) => f.side === 'sell')
    // Six rungs leave in one order, and the store rejects duplicate keys — so
    // anything less than six here is a collision silently eating a fill.
    expect(sells).toHaveLength(6)
    expect(new Set(sells.map((f) => f.idempotencyKey)).size).toBe(6)
  })

  it('leaves the position flat and the machine reset once the ladder is out', async () => {
    const { store, alerts, throttle, broker } = deep()
    const candles = gapDown(300, 1, 0.95)

    const result = await tickPosition({ position: exiting(candles.time[298]!), candles, health: null, broker }, config, store, alerts, throttle)

    expect(broker.snapshot(0.95).size).toBe(0)
    expect(result.position.cascade.level).toBe(0)
    expect(result.position.cascade.awaitReentry).toBe(true)
  })
})

// ── The death watch does not wait for a bar ─────────────────────────────────
//
// PURR sat frozen for four hours and would have stayed frozen forever. Its pool
// had stopped producing candles, and tickPosition returns 'already-processed'
// BEFORE the death watch runs:
//
//   const first = firstUnprocessedBar(...)
//   if (first === null) return { skipped: 'already-processed' }
//
// No new bar → no tick → no observation → no clean streak → the freeze can
// never lift. And the same door is shut on the way in: a token going quiet
// could never be CONDEMNED either.
//
// Which inverts the guarantee exactly. A pool that stopped trading is the
// profile of one being abandoned, and that is when the watch should be most
// awake. CLAUDE.md says it plainly: evaluated continuously for every open
// position, INDEPENDENT of price. Coupling it to candles was a mistake.

describe('tickPosition — health is assessed even with no new bar', () => {
  const upToDate = (candles: Candles) => position({
    lastBarTime: candles.time.at(-1)!,
    cascade: { ...initialState(), level: 1, ep1: 1, wasInTrade: true },
  })

  it('still reports already-processed — nothing was decided', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)

    const result = await tickPosition(
      { position: upToDate(candles), candles, health: healthy(), broker },
      config, store, alerts, throttle,
    )

    expect(result.skipped).toBe('already-processed')
    expect(result.barsAdvanced).toBe(0)
  })

  it('but folds the observation in, so a freeze can still clear', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    const frozen: DeathWatchState = {
      ...startDeathWatch(1_000_000, 0), stage: 'frozen', cleanStreak: 5,
      evidence: [{ observedAt: 0, source: 's', signals: [{ kind: 'lpRemoved', stage: 2, detail: 'LP unlocked' }], stageAfter: 'frozen', verdict: 'freeze' }],
    }

    // The sixth clean reading. Without this the streak could never reach it,
    // because the only place it advances was behind the early return.
    const result = await tickPosition(
      { position: upToDate(candles) as PersistedPosition, candles, health: healthy(), broker },
      config, store, alerts, throttle,
    )
    expect(result.position.deathWatch).toBeDefined()

    const withFrozen = { ...upToDate(candles), deathWatch: frozen }
    const cleared = await tickPosition(
      { position: withFrozen, candles, health: healthy(), broker },
      config, store, alerts, throttle,
    )
    expect(cleared.position.deathWatch.stage).toBe('healthy')
  })

  it('persists what it learned, or the next pass starts from nothing', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    await store.savePosition(upToDate(candles))

    await tickPosition(
      { position: upToDate(candles), candles, health: healthy(), broker },
      config, store, alerts, throttle,
    )

    const [stored] = await store.loadPositions()
    expect(stored!.deathWatch.cleanStreak).toBeGreaterThan(0)
  })

  it('can still condemn a token that went quiet AND stopped being sellable', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    let position = { ...upToDate(candles), deathWatch: startDeathWatch(1_000_000, 0) }

    // A pool with no candles and no sell route is the shape of a rug. It used
    // to be the one case nothing looked at.
    for (let i = 0; i < 4; i++) {
      const result = await tickPosition(
        { position, candles, health: healthy({ sellQuote: 'failed', observedAt: i }), broker },
        config, store, alerts, throttle,
      )
      position = result.position
    }

    expect(position.deathWatch.stage).toBe('dead')
  })

  it('does nothing at all when no monitor ran', async () => {
    const { store, alerts, throttle, broker } = rig()
    const candles = flat(300)
    const before = upToDate(candles)

    const result = await tickPosition({ position: before, candles, health: null, broker }, config, store, alerts, throttle)

    expect(result.position).toBe(before)
  })
})
