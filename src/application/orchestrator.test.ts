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
    await store.savePosition(position({ capitalUsd: 1_990, pendingOrders: [pending] }))

    // $2,000 total with $1,990 committed to a halted position leaves $10 — under
    // the gas floor for a single rung, so nothing new opens. A halted position
    // is unresolved, not finished: its capital may still be in the token.
    const result = await runCycle(deps, config, throttle)

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

describe('runCycle — the chosen token is re-examined before money moves', () => {
  it('refuses to open a token that no longer passes its gates', async () => {
    const { deps, alerts, throttle } = rig()
    const asked: string[] = []

    await runCycle(
      {
        ...deps,
        confirmEntry: async (snapshot) => {
          asked.push(snapshot.address)
          return { ok: false, reason: 'gates', failures: [{ gate: 'mintAuthority', reason: 'failed', detail: 'mint authority is active again' }] }
        },
      },
      config,
      throttle,
    )

    // The scanner's verdict can be hours old: security reports are cached so
    // the budget can reach every token, and a watch pass allocates from a shelf
    // up to twice the scan interval old. Both are right for ranking and wrong
    // at the moment capital is committed.
    expect(asked.length).toBeGreaterThan(0)
    expect(await deps.store.loadPositions()).toEqual([])
    // INFO and once, not a warning per token. A refused entry is an
    // opportunity not taken: nothing was bought and no money is at stake, so a
    // phone must not buzz for it — and a cycle that declines a dozen candidates
    // must not buzz twelve times.
    const refusals = alerts.sent.filter((a) => a.kind === 'entry-refused')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.level).toBe('info')
  })

  it('says WHICH gate turned, not just that something did', async () => {
    // "No se abre la posición" alone sends the reader nowhere. A gate that
    // turned is the check working; a provider that could not answer is the
    // system blind, and those ask for very different reactions.
    const { deps, alerts, throttle } = rig()
    await runCycle(
      {
        ...deps,
        confirmEntry: async () => ({
          ok: false,
          reason: 'gates',
          failures: [{ gate: 'mintAuthority', reason: 'failed', detail: 'la autoridad de minteo volvió' }],
        }),
      },
      config,
      throttle,
    )
    expect(alerts.sent.some((a) => a.body.includes('la autoridad de minteo volvió'))).toBe(true)
  })

  it('refuses rather than guesses when the token cannot be read at all', async () => {
    const { deps, throttle } = rig()
    await runCycle(
      { ...deps, confirmEntry: async () => ({ ok: false, reason: 'unreadable', detail: '502' }) },
      config,
      throttle,
    )
    expect(await deps.store.loadPositions()).toEqual([])
  })

  it('opens normally when the token still passes everything', async () => {
    const { deps, throttle } = rig()
    await runCycle(
      { ...deps, confirmEntry: async (snapshot) => ({ ok: true, snapshot }) },
      config,
      throttle,
    )
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
  // Narrow enough that capital, not the slot ceiling, is what binds — so any
  // extra token can only have come from money the system made.
  const tight: CycleConfig = {
    ...config,
    portfolio: { ...config.portfolio, totalCapitalUsd: 120, maxPositions: 8 },
  }

  const banked = async (store: MemoryStore, sellPrice: number, costUsd: number) => {
    // 'gone' is not in the working set; its fills are, and they are where the
    // fund lives. `fills` has no foreign key to `positions` for this reason.
    await store.recordFill({ positionId: 'gone', orderId: 'Entry', side: 'buy', time: NOW - 2000, price: 1, qty: 400, costUsd, comment: 'Entry', idempotencyKey: 'g1' })
    await store.recordFill({ positionId: 'gone', orderId: 'Exit', side: 'sell', time: NOW - 1000, price: sellPrice, qty: 400, costUsd, comment: 'Exit', idempotencyKey: 'g2' })
  }

  const scan = async () => Array.from({ length: 8 }, (_, i) => candidate(`t${i}`, 90 - i))
  const throttle = () => new AlertThrottle(60_000)

  it('carries more tokens once a closed position has banked the money for them', async () => {
    const withoutFund = rig({ scan })
    const before = (await runCycle(withoutFund.deps, tight, throttle())).opened.length

    const withFund = rig({ scan })
    await banked(withFund.store, 1.75, 0) // +$300 realised, nothing paid away
    const after = (await runCycle(withFund.deps, tight, throttle())).opened.length

    expect(after).toBeGreaterThan(before)
  })

  it('takes the chain’s cut out of the fund, because that cash is already gone', async () => {
    const gross = rig({ scan })
    await banked(gross.store, 1.75, 0) // +$300, no costs
    const onGross = (await runCycle(gross.deps, tight, throttle())).opened.length

    const net = rig({ scan })
    await banked(net.store, 1.75, 160) // +$300 gross, $320 of costs: net NEGATIVE
    const onNet = (await runCycle(net.deps, tight, throttle())).opened.length

    // Spending the gross would hand the allocator dollars the chain already
    // took, which is the commonest way a strategy that looks profitable is not.
    expect(onNet).toBeLessThan(onGross)
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

// ── Two ceilings, and the lower one was stale ───────────────────────────────
//
// Freeing $950 opened no new tokens, because the book was capped twice over:
// maxPositions at 5, and a $200 floor per slot that dated from before the
// sizing fixes. CLAUDE.md records that measurement being superseded — reserving
// gas and 5% of price headroom dropped the floor where the system trades at all
// from ~$200 to under $50 — but the number stayed, still enforcing the old
// reality.
//
// The floor is not a guess any more. It is what the ladder needs, derived from
// the ladder that will actually run, exactly as the gas floor is.

describe('runCycle — the slot floor is the ladder, not a remembered number', () => {
  const production: CycleConfig = {
    ...config,
    params: { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 },
    maxOpenEntries: 6,
    gasUsdPerSwap: 0.05,
    portfolio: { ...config.portfolio, totalCapitalUsd: 600, maxPositions: 8, minPositionUsd: 200 },
  }

  it('opens the slots a $95 ladder can fund, not the ones a $200 floor allowed', async () => {
    const { deps, throttle } = rig({
      scan: async () => Array.from({ length: 8 }, (_, i) => candidate(`t${i}`, 90 - i)),
    })

    // $570 deployable. At the stale $200 floor that is two slots; at what the
    // ladder actually needs it is six.
    const result = await runCycle(deps, production, throttle)

    expect(result.opened.length).toBeGreaterThan(2)
  })

  it('still refuses to open more slots than the hard ceiling allows', async () => {
    const { deps, throttle } = rig({
      scan: async () => Array.from({ length: 20 }, (_, i) => candidate(`t${i}`, 90 - i)),
    })

    // Capital is not the only limit. The ceiling bounds how many tokens can be
    // dying at once, and that is a risk decision, not an arithmetic one.
    const result = await runCycle(deps, { ...production, portfolio: { ...production.portfolio, maxPositions: 3 } }, throttle)

    expect(result.opened).toHaveLength(3)
  })
})

// ── A free slot does not wait out a scan ────────────────────────────────────
//
// Opening was fused to RUNNING a scan, so an empty slot sat through half an
// hour of throttled discovery before anything could go in it — with candidates
// already examined, already stored, already good. The fusion was never
// necessary: the expensive half of a scan is fetching, and gates, scoring and
// ranking are pure.

describe('runCycle — a watch pass fills free slots from the shelf', () => {
  const shelved = async () => [candidate('a', 90), candidate('b', 85)]

  it('opens positions without running a scan', async () => {
    let scans = 0
    const { deps, throttle } = rig({
      scan: async () => { scans++; return [] },
      recall: async () => ({ candidates: await shelved(), scannedAt: NOW - 60_000 }),
    })

    const result = await runCycle(deps, config, throttle, 'watch')

    expect(scans).toBe(0)
    expect(result.opened).toHaveLength(2)
  })

  it('opens nothing when the shelf is empty or too old to trust', async () => {
    const { deps, throttle } = rig({ recall: async () => null })
    expect((await runCycle(deps, config, throttle, 'watch')).opened).toEqual([])
  })

  it('never swaps one token for another on a watch pass', async () => {
    const { deps, store, throttle } = rig({ recall: async () => ({ candidates: await shelved(), scannedAt: NOW - 60_000 }) })
    await store.savePosition(position({ id: 'idle-1', tokenAddress: 'Idle', symbol: 'IDLE', openedAt: NOW - 9 * HOUR, lastBarTime: NOW }))

    // Taking a slot off one token and giving it to another is a judgement about
    // which is better RIGHT NOW, and it deserves data gathered right now.
    // Filling a slot that is already empty does not.
    const result = await runCycle(deps, config, throttle, 'watch')

    expect(result.releasedIds).toEqual([])
  })

  it('still refuses a token it already holds, or one on the blacklist', async () => {
    const { deps, store, throttle } = rig({ recall: async () => ({ candidates: [candidate('a', 90), candidate('b', 85)], scannedAt: NOW - 60_000 }) })
    await store.savePosition(position({ tokenAddress: 'a', symbol: 'A', lastBarTime: NOW }))
    await store.blacklist('solana', 'b', 'died', NOW - HOUR)

    const result = await runCycle(deps, config, throttle, 'watch')

    expect(result.opened).toEqual([])
  })
})

// ── Zero means no ceiling, everywhere it is read ────────────────────────────
//
// `maxPositions: 0` was given the meaning "the capital decides" inside
// planPortfolio, and the orchestrator went on computing `maxPositions - open`
// to get the slots left. With five positions open that is MINUS FIVE, and the
// guard is `slotsLeft > 0`, so the book froze at five while $950 of freed
// capital and thirty-eight candidates sat waiting.
//
// A sentinel that means one thing in one file and another thing next door is
// not a sentinel, it is a trap.

describe('runCycle — no ceiling means no ceiling', () => {
  const uncapped: CycleConfig = {
    ...config,
    params: { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 },
    maxOpenEntries: 6,
    gasUsdPerSwap: 0.05,
    portfolio: { ...config.portfolio, totalCapitalUsd: 1_500, maxPositions: 0 },
  }

  const many = async () => Array.from({ length: 30 }, (_, i) => candidate(`t${i}`, 90 - i))

  it('keeps opening past the number already held', async () => {
    const { deps, store, throttle } = rig({ scan: many })
    for (let i = 0; i < 5; i++) {
      await store.savePosition(position({ id: `p${i}`, tokenAddress: `H${i}`, symbol: `H${i}`, capitalUsd: 95.09, lastBarTime: NOW }))
    }

    const result = await runCycle(deps, uncapped, throttle)

    expect(result.opened.length).toBeGreaterThan(0)
  })

  it('fills the book to what the capital carries, not to what is already in it', async () => {
    const { deps, throttle } = rig({ scan: many })

    // $1,500 at a $95 ladder is about fourteen.
    const result = await runCycle(deps, uncapped, throttle)

    expect(result.opened.length).toBeGreaterThanOrEqual(13)
  })

  it('still stops at an explicit ceiling', async () => {
    const { deps, store, throttle } = rig({ scan: many })
    await store.savePosition(position({ id: 'p0', tokenAddress: 'H0', symbol: 'H0', capitalUsd: 95.09, lastBarTime: NOW }))

    const result = await runCycle(deps, { ...uncapped, portfolio: { ...uncapped.portfolio, maxPositions: 3 } }, throttle)

    // One already open, so two more and no further.
    expect(result.opened).toHaveLength(2)
  })
})

// ── A position that cannot be refreshed is not a position to ignore ─────────
//
// Found live: eighteen positions sitting at bars four hours apart while the
// engine logged healthy passes. The tick loop reads
//
//   const candles = await deps.candlesFor(position)
//   if (!candles) continue
//
// and the adapter swallows every error into null. So a position whose candle
// request was rate-limited was skipped in SILENCE — and skipped means its
// DEATH WATCH did not run either, because the whole tick is one step.
//
// That inverts the guarantee exactly: the position the provider is failing on
// is the one that stops being watched.

describe('runCycle — a position it could not refresh', () => {
  it('says so, rather than skipping it quietly', async () => {
    const { deps, store, alerts, throttle } = rig({ candlesFor: async () => null })
    await store.savePosition(position({ lastBarTime: NOW - 9 * HOUR }))

    await runCycle(deps, config, throttle)

    const said = alerts.sent.find((a) => a.title.includes('HELD') || a.body.includes('HELD'))
    expect(said, 'a skipped position must produce an alert').toBeDefined()
  })

  it('grades it as a risk, because an unwatched position is one', async () => {
    const { deps, store, alerts, throttle } = rig({ candlesFor: async () => null })
    await store.savePosition(position({ lastBarTime: NOW - 9 * HOUR }))

    await runCycle(deps, config, throttle)

    // Skipping the tick skips the death watch with it. A token that cannot be
    // priced is exactly the shape of one worth worrying about.
    const said = alerts.sent.find((a) => a.kind === 'provider-degraded' || a.kind === 'position-halted')
    expect(said?.level).not.toBe('info')
  })

  it('reports which ones it could not reach', async () => {
    const { deps, store, throttle } = rig({ candlesFor: async () => null })
    await store.savePosition(position({ lastBarTime: NOW - 9 * HOUR }))

    const result = await runCycle(deps, config, throttle)

    expect(result.unreachableIds).toEqual(['pos-1'])
  })

  it('one unreachable position never stops the others', async () => {
    let asked = 0
    const { deps, store, throttle } = rig({
      candlesFor: async () => (++asked === 1 ? null : flat()),
    })
    await store.savePosition(position({ id: 'a', tokenAddress: 'A', symbol: 'A', lastBarTime: NOW - 9 * HOUR }))
    await store.savePosition(position({ id: 'b', tokenAddress: 'B', symbol: 'B', lastBarTime: NOW - 9 * HOUR }))

    const result = await runCycle(deps, config, throttle)

    expect(result.unreachableIds).toHaveLength(1)
    expect(result.ticks).toHaveLength(1)
  })
})

// ── Do not ask for candles a position already has ───────────────────────────
//
// Eighteen positions asking for candles every five minutes is ~216 throttled
// requests an hour, against a provider that limits by IP on a runner shared
// with thousands of unrelated jobs. But there are only FOUR closed bars in an
// hour: three quarters of those requests could not have told the engine
// anything it did not already know.
//
// The engine acts on closed bars only, so a position already standing on the
// latest closed bar has nothing to do — and asking is how it runs out of quota
// for the positions that do.

describe('runCycle — it only fetches what a new bar would change', () => {
  const FIFTEEN = 15 * 60_000
  const paced: CycleConfig = { ...config, barMs: FIFTEEN }
  // Bars are stamped by their OPEN, so the newest CLOSED one opened two bars ago.
  const latestClosed = Math.floor(NOW / FIFTEEN) * FIFTEEN - FIFTEEN

  it('skips the request for a position already on the latest closed bar', async () => {
    let asked = 0
    const { deps, store, throttle } = rig({ candlesFor: async () => { asked++; return flat() } })
    await store.savePosition(position({ lastBarTime: latestClosed }))

    await runCycle(deps, paced, throttle)

    expect(asked).toBe(0)
  })

  it('still asks once a bar has closed under it', async () => {
    let asked = 0
    const { deps, store, throttle } = rig({ candlesFor: async () => { asked++; return flat() } })
    await store.savePosition(position({ lastBarTime: latestClosed - FIFTEEN }))

    await runCycle(deps, paced, throttle)

    expect(asked).toBe(1)
  })

  it('a skipped request is NOT an unreachable position', async () => {
    const { deps, store, throttle } = rig({ candlesFor: async () => { throw new Error('should not be called') } })
    await store.savePosition(position({ lastBarTime: latestClosed }))

    // Nothing to do is not the same as could not be reached, and conflating
    // them would raise an alarm every five minutes on a healthy book.
    const result = await runCycle(deps, paced, throttle)

    expect(result.unreachableIds).toEqual([])
  })

  it('asks for everything when no bar size is configured — the old behaviour', async () => {
    let asked = 0
    const { deps, store, throttle } = rig({ candlesFor: async () => { asked++; return flat() } })
    await store.savePosition(position({ lastBarTime: latestClosed }))

    await runCycle(deps, config, throttle)

    expect(asked).toBe(1)
  })
})

describe('runCycle — a frozen ladder gives back what it can no longer spend', () => {
  const held = (over: Partial<PersistedPosition> = {}) => position({
    id: 'held-1', tokenAddress: 'Held', symbol: 'HELD', openedAt: NOW - 6 * HOUR, lastBarTime: NOW, capitalUsd: 95, ...over,
  })
  const entryFill = { positionId: 'held-1', orderId: 'Entry', side: 'buy' as const, time: NOW - HOUR, price: 1, qty: 15, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'h1' }

  it('trims a frozen position to what it has actually deployed', async () => {
    // The operator asked the right question: six frozen positions, and none of
    // them ever hands its slot on. The SLOT genuinely cannot move — it holds
    // tokens, and selling them is the strategy's decision and never the
    // allocator's. But frozen means NO NEW CAPITAL ENTERS, so every dollar it
    // reserves for rungs that can never fire is dead money.
    //
    // With `maxPositions: 0` the book is bounded by capital rather than by slot
    // count, so freeing that reserve is exactly what buys another token.
    const { deps, store, throttle } = rig()
    await store.savePosition(held({ deathWatch: { ...held().deathWatch, stage: 'frozen' } }))
    await store.recordFill(entryFill)

    await runCycle(deps, config, throttle)

    const after = (await store.loadPositions()).find((p) => p.id === 'held-1')
    expect(after?.capitalUsd).toBe(15)
  })

  it('leaves a healthy position the whole ladder it is still going to climb', async () => {
    // The trim is about a ladder that CANNOT fire, never about one that simply
    // has not yet. A healthy position one rung in is still going to cascade.
    const { deps, store, throttle } = rig()
    await store.savePosition(held())
    await store.recordFill(entryFill)

    await runCycle(deps, config, throttle)

    const after = (await store.loadPositions()).find((p) => p.id === 'held-1')
    expect(after?.capitalUsd).toBeGreaterThan(15)
  })
})
