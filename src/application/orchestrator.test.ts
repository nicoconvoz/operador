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
  // priceUsd is not decoration: the death watch sizes its sell probe from it.
  // This fixture omitted it behind a cast, which is how a position shipped
  // with a placeholder price and froze itself on its first observation.
  snapshot: { chain: 'solana', address, symbol: address, pairAddress: `pair-${address}`, priceUsd: 0.01 } as TokenSnapshot,
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

describe('runCycle — a new position is born knowing its price', () => {
  it('records the price the scanner measured, not a placeholder', async () => {
    const { deps, throttle } = rig()
    await runCycle(deps, config, throttle)
    const [opened] = await deps.store.loadPositions()

    // It used to be 1. The death watch sizes its sell probe from this number,
    // so a placeholder asked "if I sell 285 units do I get $285 back?" of a
    // token trading at less than a cent — got a fraction of that, called it
    // implausible, and froze every new position on its first observation.
    expect(opened!.lastPriceUsd).not.toBe(1)
    expect(opened!.lastPriceUsd).toBeGreaterThan(0)
  })
})

// ── Slots reserved and never used ───────────────────────────────────────────
//
// A slot is handed to a token BEFORE the strategy enters it, and CASCADE DCA
// then waits for its own gates. When those never line up the position sits at
// level 0 indefinitely, holding a slot and its capital against nothing.
//
// Measured live: a token open five hours and twenty minutes with zero fills,
// holding $285 and one of five slots, while candidates scoring 76 and 72 waited
// outside. slotsLeft and committed counted it exactly as they counted a
// position three DCA levels deep.

describe('runCycle — a reservation nobody used gives up its slot', () => {
  const idle = (over: Partial<PersistedPosition> = {}) => position({
    id: 'idle-1', tokenAddress: 'Idle', symbol: 'IDLE', openedAt: NOW - 6 * HOUR, lastBarTime: NOW, ...over,
  })

  it('closes a position that reserved a slot and never bought anything', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(idle())

    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual(['idle-1'])
    expect((await store.loadPositions()).map((p) => p.symbol)).not.toContain('IDLE')
  })

  it('hands the freed capital and slot to the candidates that were waiting', async () => {
    const { deps, store, throttle } = rig()
    // Four slots, three already taken, one of them by a reservation that has
    // never traded. Without the release the book can add exactly one.
    await store.savePosition(idle())
    await store.savePosition(position({ id: 'busy-1', tokenAddress: 'Busy1', symbol: 'BUSY1' }))
    await store.savePosition(position({ id: 'busy-2', tokenAddress: 'Busy2', symbol: 'BUSY2' }))
    await store.recordFill({ positionId: 'busy-1', orderId: 'Entry', side: 'buy', time: NOW - HOUR, price: 1, qty: 10, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'b1' })
    await store.recordFill({ positionId: 'busy-2', orderId: 'Entry', side: 'buy', time: NOW - HOUR, price: 1, qty: 10, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'b2' })

    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual(['idle-1'])
    expect(result.opened).toHaveLength(2)
  })

  it('never takes the slot of a position that has traded', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(idle({ openedAt: NOW - 90 * HOUR }))
    await store.recordFill({ positionId: 'idle-1', orderId: 'Entry', side: 'buy', time: NOW - 80 * HOUR, price: 1, qty: 10, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'x1' })

    // With fills it is a COMMITMENT, not a reservation: the slot cannot come
    // back without selling, and selling is the strategy's call.
    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toContain('idle-1')
  })

  it('does not blacklist what it releases — the token did nothing wrong', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(idle())

    await runCycle(deps, config, throttle)

    // It never set up. That is not a verdict, and it is welcome back the day
    // its gates do line up.
    expect((await store.blacklisted()).size).toBe(0)
  })

  it('does not hand the slot straight back to the token that just gave it up', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('Idle', 99), candidate('a', 90)] })
    await store.savePosition(idle())

    const result = await runCycle(deps, config, throttle)

    // Top of the ranking and freshly evicted. Re-opening it in the same breath
    // is not a reallocation, it is a round trip through the database.
    expect(result.opened.map((p) => p.tokenAddress)).not.toContain('Idle')
  })

  it('keeps a reservation when nothing is waiting for its slot', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [] })
    await store.savePosition(idle())

    // Freeing a slot into an empty queue is pure loss: the incumbent might
    // still enter, and nothing else can use what it gives up.
    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual([])
  })

  it('says so, naming the hours it sat there', async () => {
    // The scan still rates it, and nothing clearly better is queued, so the
    // rule that fires is the idle window rather than the re-examination.
    const { deps, store, alerts, throttle } = rig({ scan: async () => [candidate('Idle', 85), candidate('a', 90)] })
    await store.savePosition(idle())

    await runCycle(deps, config, throttle)

    const said = alerts.sent.find((a) => a.title.includes('IDLE'))
    expect(said?.body).toContain('6h')
  })
})

// ── Watching costs almost nothing; discovering costs everything ─────────────
//
// One cycle did both, so looking after open positions ran at the pace of the
// scan: a held token got attention once every ~35 minutes, on 15-minute bars.
// A scan is hundreds of throttled calls; a watch pass is one candle request and
// one sell probe per position, under a minute for five of them.
//
// The asymmetry is the argument. A token you HOLD can rug in ten minutes. A new
// opportunity missed by an hour is a missed opportunity — nothing more.

describe('runCycle — a watch pass looks after what is open, and nothing else', () => {
  it('advances open positions without going looking for new ones', async () => {
    let scans = 0
    const { deps, store, throttle } = rig({ scan: async () => { scans++; return [candidate('a', 90)] } })
    await store.savePosition(position())

    const result = await runCycle(deps, config, throttle, 'watch')

    expect(scans).toBe(0)
    expect(result.ticks).toHaveLength(1)
    expect(result.opened).toEqual([])
  })

  it('still reconciles the past first — a watch pass is a prefix of a cycle, not a shortcut', async () => {
    const { deps, store, throttle } = rig({ probe: async () => 'unknown' })
    const inFlight: Order = { kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 15, comment: 'Entry' }
    await store.savePosition(position({ pendingOrders: [inFlight], lastBarTime: 0 }))

    // An order nobody can confirm halts the position. Skipping recovery on the
    // cheap pass would be trading on state that was never verified.
    const result = await runCycle(deps, config, throttle, 'watch')

    expect(result.haltedIds).toEqual(['pos-1'])
  })

  it('still checkpoints, so a watch pass is not invisible to the dashboard', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position())

    await runCycle(deps, config, throttle, 'watch')

    expect((await store.loadCheckpoint())?.savedAt).toBe(NOW)
  })

  it('takes no slots back, because nothing is waiting to use them', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position({ id: 'idle-1', tokenAddress: 'Idle', symbol: 'IDLE', openedAt: NOW - 9 * HOUR, lastBarTime: NOW }))

    // Releasing a slot needs a queue, and a watch pass never looked at one.
    const result = await runCycle(deps, config, throttle, 'watch')

    expect(result.releasedIds).toEqual([])
  })

  it('says which kind of pass it was', async () => {
    const { deps, throttle } = rig()
    expect((await runCycle(deps, config, throttle, 'watch')).kind).toBe('watch')
    expect((await runCycle(deps, config, throttle)).kind).toBe('full')
  })
})

// ── Capital that was reserved against rungs that do not exist ───────────────
//
// A slot kept whatever the portfolio handed it at birth. Measured live: five
// positions holding $285 each while a flat six-rung $15 ladder can only ever
// deploy about $95. The surplus counted as COMMITTED, so the engine could
// neither spend it nor open anything with it.

describe('runCycle — a position keeps only what its ladder can spend', () => {
  const ladderConfig: CycleConfig = {
    ...config,
    params: { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 },
    maxOpenEntries: 6,
    gasUsdPerSwap: 0.05,
    portfolio: { ...config.portfolio, totalCapitalUsd: 2_000, maxPositions: 6 },
  }

  it('trims an over-allocated position down to what six rungs need', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position({ capitalUsd: 285, lastBarTime: NOW }))

    await runCycle(deps, ladderConfig, throttle)

    const [stored] = (await store.loadPositions()).filter((p) => p.id === 'pos-1')
    expect(stored!.capitalUsd).toBeCloseTo(95.1, 1)
  })

  it('never trims below what is already in the token', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position({ capitalUsd: 900, lastBarTime: NOW }))
    // $400 of basis still held: that money is IN the token, and calling it free
    // would hand the same dollars out twice.
    await store.recordFill({ positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 1000, price: 4, qty: 100, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'k1' })

    await runCycle(deps, ladderConfig, throttle)

    const [stored] = (await store.loadPositions()).filter((p) => p.id === 'pos-1')
    expect(stored!.capitalUsd).toBeCloseTo(400, 6)
  })

  it('only ever trims down — a small allocation is never topped up', async () => {
    const { deps, store, throttle } = rig()
    await store.savePosition(position({ capitalUsd: 40, lastBarTime: NOW }))

    // Raising it would be re-risking money the allocator never agreed to put
    // here. A ladder that cannot fill its deeper rungs simply does not fill them.
    await runCycle(deps, ladderConfig, throttle)

    const [stored] = (await store.loadPositions()).filter((p) => p.id === 'pos-1')
    expect(stored!.capitalUsd).toBe(40)
  })

  it('spends the freed capital on more tokens', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('a', 90), candidate('b', 85), candidate('c', 80)] })
    await store.savePosition(position({ capitalUsd: 1_900, lastBarTime: NOW }))

    // With $1,900 locked up there is nothing left. Trimmed to ~$95 there is.
    const result = await runCycle(deps, ladderConfig, throttle)

    expect(result.opened.length).toBeGreaterThan(0)
  })
})

// ── The common fund ─────────────────────────────────────────────────────────
//
// What the system has MADE is capital too, and it was ignored: the book was
// sized against a fixed number from the environment forever, so a profitable
// engine never got any bigger.

describe('runCycle — profit becomes capital', () => {
  // Just enough for two slots at the portfolio's $200 floor, so a third can
  // only ever come from money the system made.
  const tight: CycleConfig = {
    ...config,
    portfolio: { ...config.portfolio, totalCapitalUsd: 600, maxPositions: 4 },
  }

  const banked = async (store: MemoryStore, sellPrice: number, costUsd: number) => {
    // 'gone' is not in the working set; its fills are, and they are where the
    // fund lives. `fills` has no foreign key to `positions` for this reason.
    await store.recordFill({ positionId: 'gone', orderId: 'Entry', side: 'buy', time: NOW - 2000, price: 1, qty: 400, costUsd, comment: 'Entry', idempotencyKey: 'g1' })
    await store.recordFill({ positionId: 'gone', orderId: 'Exit', side: 'sell', time: NOW - 1000, price: sellPrice, qty: 400, costUsd, comment: 'Exit', idempotencyKey: 'g2' })
  }

  const scan = async () => [candidate('a', 90), candidate('b', 85), candidate('c', 80)]

  it('opens what the configured capital alone can carry', async () => {
    const { deps, throttle } = rig({ scan })
    expect((await runCycle(deps, tight, throttle)).opened).toHaveLength(2)
  })

  it('carries one more once a closed position has banked the money for it', async () => {
    const { deps, store, throttle } = rig({ scan })
    await banked(store, 1.75, 0) // +$300 realised

    expect((await runCycle(deps, tight, throttle)).opened).toHaveLength(3)
  })

  it('takes the chain’s cut out of the fund, because that cash is already gone', async () => {
    const { deps, store, throttle } = rig({ scan })
    await banked(store, 1.75, 160) // +$300 gross, $320 of costs

    // Gross profit would have funded a third ladder. Net, there is less money
    // than the engine started with, and pretending otherwise spends dollars
    // the chain already took.
    expect((await runCycle(deps, tight, throttle)).opened).toHaveLength(2)
  })
})

// ── Re-examined the moment it goes flat ─────────────────────────────────────

describe('runCycle — a token that took its profit is re-examined at once', () => {
  const traded = async (store: MemoryStore, score: number) => {
    await store.savePosition(position({ id: 'flat-1', tokenAddress: 'Flat', symbol: 'FLAT', lastBarTime: NOW }))
    await store.recordFill({ positionId: 'flat-1', orderId: 'Entry', side: 'buy', time: NOW - 2000, price: 1, qty: 10, costUsd: 0, comment: 'Entry', idempotencyKey: 'f1' })
    await store.recordFill({ positionId: 'flat-1', orderId: 'Exit', side: 'sell', time: NOW - 1000, price: 1.2, qty: 10, costUsd: 0, comment: 'Exit', idempotencyKey: 'f2' })
    return score
  }

  it('hands the slot on when something clearly better is waiting', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('Flat', 40), candidate('a', 90)] })
    await traded(store, 40)

    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual(['flat-1'])
  })

  it('keeps it when it is still the best thing available', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('Flat', 90), candidate('a', 45)] })
    await traded(store, 90)

    // It banked a profit and the scanner still rates it top. Swapping here
    // would be churn dressed as discipline.
    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual([])
  })

  it('does not re-examine a position that is still holding tokens', async () => {
    const { deps, store, throttle } = rig({ scan: async () => [candidate('Held', 5), candidate('a', 95)] })
    await store.savePosition(position({ lastBarTime: NOW }))
    await store.recordFill({ positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 1000, price: 1, qty: 10, costUsd: 0, comment: 'Entry', idempotencyKey: 'h1' })

    const result = await runCycle(deps, config, throttle)

    expect(result.releasedIds).toEqual([])
  })
})
