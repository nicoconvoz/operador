import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildRuntime } from './main.js'
import { loadConfig } from './config.js'
import { exitLevelsFor, sweepStops } from '../application/stop-sweep.js'
import { exitSizingFrom, tickConfigFrom } from '../application/orchestrator.js'
import { capitalForFillsUsd, ladderCapitalUsd } from '../application/paper-run.js'
import { tickPosition } from '../application/engine.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { type Candles } from '../application/replay.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, assessAssetHealth } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type SqlClient } from '../infrastructure/persistence/postgres-store.js'
import { runCycle, type CycleDeps } from '../application/orchestrator.js'
import { fundStepFromFreeCapital, freeSlots, bookCapital } from '../application/free-capital.js'
import { positionLedger } from '../application/ledger.js'
import { dipBounceThresholds } from '../domain/strategy/dip-bounce.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { type Candidate } from '../domain/scanner/ranking.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

/**
 * The composition root, asked the questions the engine asks.
 *
 * Every wiring bug this project has paid for lived out here, untested: a
 * missing `discover`, a missing `poolMarkets`, a capital trim that wrote over
 * the tick. And the lesson written down after the stop was "switched off" and
 * cut six positions the next morning: *test the path the engine runs, not the
 * setting.* So these build the runtime from an environment and read the rules
 * back out of it, the way a cycle and the loop between cycles do.
 *
 * No network: nothing here fetches, and the store answers every query empty.
 * The sweep CAN fetch now — the last hour of 5-minute bars for a rung that
 * could fire, and the book's pools for the liquidity watch — so `fetch` itself
 * refuses, and the tests that want an answer stub one.
 */
const quiet: SqlClient = { query: async () => ({ rows: [] }) }
beforeEach(() => {
  vi.stubGlobal('fetch', async () => { throw new Error('no network in this test') })
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const runtime = (env: Record<string, string> = {}) =>
  buildRuntime(loadConfig({ DATABASE_URL: 'postgres://user:secret@host:5432/db', ...env }), {
    sql: quiet,
    postJson: async () => { throw new Error('no network in this test') },
  })

/**
 * The ladder the dip-bounce scenarios below were argued with: 3% and 2%,
 * twenty steps. Production now starts DCA 1 at 15% and 8% with six steps
 * (`production-ladder.ts`); the falls replayed here are about the MECHANISM —
 * the sweep, the pool check, the TP, the funding — so they pin the numbers
 * they were written against, and `runtime()` alone speaks for production.
 */
const LEGACY_LADDER = { OPERADOR_DIP_PCT: '3', OPERADOR_BOUNCE_PCT: '2', OPERADOR_MAX_STEPS: '20', OPERADOR_STEP_USD: '5', OPERADOR_STEP_GROWTH: '1', OPERADOR_STOP_MAX_LOSS_USD: '0', OPERADOR_FIXED_TP_PCT: '12.5', OPERADOR_PRESSURE_TP_DROP_PCT: '0', OPERADOR_CRASH_STOP_PCT: '0', OPERADOR_TIERS: '0', OPERADOR_DEATH_WATCH: '1', OPERADOR_MIN_PROFIT_PCT: '12.5', OPERADOR_MAX_COST_SHARE_PCT: '0', OPERADOR_GAIN_LOCK: '1', OPERADOR_ENTRY_FLOORS: '0', OPERADOR_LIVE_PRICE: '1', OPERADOR_STRATEGY_EXIT: '1' }

/**
 * And the order they were argued with: the cheapest to trade first. Production
 * serves the most volatile first now; the book and the shelf scenarios below
 * are about the cut and the free slots, so they pin the order they read.
 */
const LEGACY_ORDER = { OPERADOR_RANK_BY: 'cost' }

/**
 * Ladder A, brought back from the environment: five chained rungs with their
 * volatility spacing and the liquidity brake, and one entry reserved. OFF in
 * production — every buy is a dip-bounce step — and these are the variables
 * that bring it back, so the dormant code is still tested on the path the
 * engine would run.
 */
const LADDER_A: Record<string, string> = {
  OPERADOR_DROP_LADDER: '1', OPERADOR_MAX_DCA: '5', OPERADOR_MAX_USD_PER_LEVEL: '10', OPERADOR_RESERVED_ENTRIES: '1',
  OPERADOR_DCA_ADAPTIVE: '1', OPERADOR_DCA_REALTIME: '1', OPERADOR_LIQUIDITY_BRAKE_PCT: '5',
  OPERADOR_STOP_MAX_LOSS_USD: '0',
}

/** The deep rung, brought back from the environment beside its own $15 entry. */
const DEEP_RUNG: Record<string, string> = { OPERADOR_DEEP_RUNG: '1', OPERADOR_MAX_USD_PER_LEVEL: '15', OPERADOR_MAX_DCA: '1', OPERADOR_RESERVED_ENTRIES: '1', OPERADOR_STOP_MAX_LOSS_USD: '0' }

const held: PersistedPosition = {
  id: 'solana:T:1', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, 0),
  quality: { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 },
  capitalUsd: 15.89, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
}

describe('the abandonment freeze at three hours, through the path the engine runs', () => {
  // *Las que no tengan barras en 2h, congelarlas y recuperar el dinero.* A
  // freeze with `exitOnFreeze` on sells the position and the release bans it.
  const quiet = (hoursSinceLastTrade: number) => ({
    observedAt: 0, source: 'test', sellQuote: 'ok' as const, liquidityUsd: 1_000_000, lpStatus: 'locked' as const,
    mintAuthorityActive: false, freezeAuthorityActive: false, safetyFailed: [], transfersBlocked: false,
    topHolderMovedPct: null, hoursSinceLastTrade,
  })

  it('freezes a position three hours without a trade again, as on 24/09', () => {
    // *Lo demás aplicalo como estaba en ese momento* (2026-10-08). With
    // `exitOnFreeze` a freeze is a sale.
    const policy = tickConfigFrom(runtime().cycleConfig).deathPolicy!
    expect(policy.abandonmentFreezeHours).toBe(3)
    expect(assessAssetHealth(startDeathWatch(1_000_000, 0), policy, quiet(2)).state.stage).toBe('healthy')
    expect(assessAssetHealth(startDeathWatch(1_000_000, 0), policy, quiet(3.5)).state.stage).toBe('frozen')
    expect(tickConfigFrom(runtime({ OPERADOR_ABANDON_FREEZE_HOURS: '1000' }).cycleConfig).deathPolicy!.abandonmentFreezeHours).toBe(1000)
  })

  it('takes another threshold from the environment', () => {
    expect(tickConfigFrom(runtime({ OPERADOR_ABANDON_FREEZE_HOURS: '3' }).cycleConfig).deathPolicy!.abandonmentFreezeHours).toBe(3)
  })
})

describe('the break-even, through the path the engine runs', () => {
  // *Sacá el break-even, pero poné un mínimo de ganancia del 20%.* The cycle's
  // sweeps and the loop's both read `exitLevelsFor(position, exitSizingFrom(cycleConfig))`.
  it('is OFF when nothing is set, through every path', () => {
    const { cycleConfig } = runtime()
    expect(cycleConfig.breakEven).toBe(false)
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).armAtPct).toBeNull()
  })

  it('comes back with both lines at 7.5 when the environment asks for it', () => {
    const { cycleConfig } = runtime({ OPERADOR_BREAK_EVEN: '1' })
    const levels = exitLevelsFor(held, exitSizingFrom(cycleConfig))
    expect(levels.armAtPct).toBe(7.5)
    expect(levels.breakEvenPct).toBe(7.5)
  })
})

describe('the gain lock, through the path the engine runs', () => {
  // *Si pasás el 20% de ganancia, break-even en el 10%.* On unless switched
  // off — and a switched-off rule must stay off through every path: the
  // cycle's sweeps and the loop's both read `exitLevelsFor(position, exitSizingFrom(cycleConfig))`.
  it('is OFF when nothing is set, as on 24/09 — OPERADOR_GAIN_LOCK=1 brings the staircase back', () => {
    expect(exitLevelsFor(held, exitSizingFrom(runtime().cycleConfig)).gainLock).toBeNull()
    expect(exitLevelsFor(held, exitSizingFrom(runtime({ OPERADOR_GAIN_LOCK: '1' }).cycleConfig)).gainLock).toEqual({ startPct: 20, stepPct: 20, firstFloorPct: 10, floorStepPct: 10 })
  })

  it('is OFF through every path when the environment switches it off', () => {
    const { cycleConfig } = runtime({ OPERADOR_GAIN_LOCK: '0' })
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).gainLock).toBeNull()
  })
})

describe('the strategy exit target, through the path the engine runs', () => {
  // *Bajalas a 10* — then *poné un TP fijo al 12.5% del promedio.* The
  // strategy's own exit still sells when the impulse dies — only never under
  // the fixed TP, which the sweep takes first.
  const tick = async (env: Record<string, string> = {}) => {
    const { deps, cycleConfig } = runtime(env)
    const bars = 300
    const flat = (price: number) => Array.from({ length: bars }, () => price)
    const candles: Candles = {
      time: Array.from({ length: bars }, (_, i) => i * 3_600_000),
      open: flat(1), high: flat(1.005), low: flat(0.995), close: flat(1), volume: flat(10_000),
    }
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: -1 }
    return tickPosition(
      { position: slot, candles, health: null, broker: await deps.brokerFor(slot), marketPriceUsd: 1 },
      tickConfigFrom(cycleConfig),
      new MemoryStore(), new RecordingAlerts(), new AlertThrottle(60_000),
    )
  }

  it('asks the exit for the toll-derived target, never under +2%, when nothing is set, as on 24/09', async () => {
    // The pool's round trip, kept under a third of the gain, lifts it past the floor.
    expect((await tick()).minProfitPct).toBeGreaterThan(2)
    expect((await tick({ OPERADOR_MAX_COST_SHARE_PCT: '0' })).minProfitPct).toBe(2)
  })

  it('takes another floor from the environment', async () => {
    expect((await tick({ OPERADOR_MIN_PROFIT_PCT: '20' })).minProfitPct).toBe(20)
  })
})

describe('the ladder, the reservation and the ban, as wired', () => {
  it('wires the dip-bounce as the ONE buyer: ONE $3 buy the moment a slot opens, and nothing after it', () => {
    // *Que compre inmediatamente que ingrese.*
    const { deps, cycleConfig } = runtime({ OPERADOR_CAPITAL_USD: '5000' })
    expect(deps.dipBounce?.policy).toEqual({ dipPct: 23, bouncePct: 12, maxSteps: 1, maxDipPct: 0, dipStepPct: 2, bounceStepPct: 1 })
    expect(deps.dipBounce?.stepUsd).toBe(3)
    expect(deps.dipBounce?.onSelection).toBe(true)
    expect(deps.dipBounce?.firstStepFromCapital).toBeUndefined()
    expect(deps.dipBounce?.fund).toBeDefined()
    expect(cycleConfig.maxOpenEntries).toBe(1)
  })

  it('wires the crash stop only when asked: more than 5% down in under a minute', () => {
    expect(runtime().deps.crashStop).toBeUndefined()
    expect(runtime({ OPERADOR_CRASH_STOP_PCT: '5' }).deps.crashStop).toMatchObject({ dropPct: 5, windowMs: 60_000 })
  })

  it('sizes by class and stops watching health only when asked', async () => {
    const DAY = 86_400_000
    const snap = (liquidityUsd: number, top: number) =>
      ({ liquidityUsd, observedAt: 100 * DAY, pairCreatedAt: 0, security: { topHoldersPct: top } }) as unknown as TokenSnapshot
    expect(runtime().cycleConfig.sizeFor).toBeUndefined()
    const tiered = runtime({ OPERADOR_TIERS: '1', OPERADOR_DEATH_WATCH: '0' })
    expect([snap(100_000, 10), snap(500_000, 10), snap(2_000_000, 10), snap(9_000_000, 10)].map((s) => tiered.cycleConfig.sizeFor!(s))).toEqual([0, 0, 125, 250])
    expect(tiered.deps.dipBounce?.firstStepFromCapital).toBe(true)
    expect(await tiered.deps.healthFor(held, { time: [], open: [], high: [], low: [], close: [], volume: [] })).toBeNull()
  })

  it('lets a pump turning over in — no door — and the pump-and-dump gate is one variable away', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).pumpDump).toEqual({ maxPumpPct: Infinity, maxHourFallPct: Infinity })
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', OPERADOR_MAX_PUMP_PCT: '100', OPERADOR_MAX_HOUR_FALL_PCT: '5' }).pumpDump).toEqual({ maxPumpPct: 100, maxHourFallPct: 5 })
  })

  it('wires the TP on buy pressure — in profit, on a 10% fall from its peak — and no other TP', () => {
    const { deps, cycleConfig } = runtime()
    expect(deps.pressureTp).toMatchObject({ armPct: 0, dropPct: 10 })
    expect(deps.pressureTp?.hourCounts).toBeDefined()
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).fixedTpPct).toBeNull()
    expect(runtime({ OPERADOR_PRESSURE_TP_DROP_PCT: '0' }).deps.pressureTp).toBeUndefined()
    expect(cycleConfig.params.useStrategyExit).toBe(false)
    expect(runtime({ OPERADOR_STRATEGY_EXIT: '1' }).cycleConfig.params.useStrategyExit).toBe(true)
  })

  it('never buys past a 20% fall unless the environment turns the ceiling off', () => {
    expect(runtime({ OPERADOR_MAX_DIP_PCT: '0' }).deps.dipBounce?.policy.maxDipPct).toBe(0)
    expect(runtime({ OPERADOR_MAX_DIP_PCT: '25' }).deps.dipBounce?.policy.maxDipPct).toBe(25)
  })

  it('takes the steps from the environment — zero is the flat rule', () => {
    expect(runtime({ OPERADOR_DIP_STEP_PCT: '0', OPERADOR_BOUNCE_STEP_PCT: '0' }).deps.dipBounce?.policy).toMatchObject({ dipStepPct: 0, bounceStepPct: 0 })
    expect(runtime({ OPERADOR_DIP_STEP_PCT: '3', OPERADOR_BOUNCE_STEP_PCT: '2' }).deps.dipBounce?.policy).toMatchObject({ dipStepPct: 3, bounceStepPct: 2 })
  })

  it('asks the pool before every step against the death watch’s OWN freeze line — the policy the tick runs, not a number of its own', () => {
    const { deps, cycleConfig } = runtime()
    expect(deps.dipBounce?.pool?.liquidity).toBeDefined()
    expect(deps.dipBounce?.pool?.deathPolicy).toBe(tickConfigFrom(cycleConfig).deathPolicy)
    expect(deps.dipBounce?.pool?.deathPolicy.liquidityFreezeRatio).toBe(0.5)
  })

  it('wires nothing else that could buy — each one a variable away', () => {
    const { deps, cycleConfig } = runtime()
    // The deep rung, the chained drop ladder — and with it the volatility
    // spacing and the liquidity brake that ride on it — and the pressure ladder.
    expect(deps.deepRung).toBeUndefined()
    expect(deps.dropLadder).toBeUndefined()
    expect(deps.pressureLadder).toBeUndefined()
    // The cascade's own doors and rungs: nothing bought on selection, no
    // classic drop, no trend re-entry, a separation no price can clear.
    expect(cycleConfig.params).toMatchObject({ useMomentumEntry: false, useClassicEntry: false, useTrendReentry: false, minGapPct: 100 })
  })

  it('brings the deep rung back from the environment', () => {
    const { deps } = runtime(DEEP_RUNG)
    expect(deps.deepRung?.policy).toEqual({ fallPct: 80, reboundPct: 10, maxEntries: 2 })
    expect(deps.deepRung?.usd).toBe(20)
    expect(deps.deepRung?.fund).toBeDefined()
  })

  it('brings ladder A back from the environment, beside the deep rung', () => {
    const { deps } = runtime(LADDER_A)
    expect(deps.dropLadder?.policy).toEqual({ maxEntries: 6, dropsPct: [10, 15, 20, 25, 30], from: 'previous' })
    expect(deps.dropLadder?.rungsUsd).toEqual([15, 20, 25, 30, 35])
    expect(deps.dropLadder?.fund).toBeDefined()
  })

  it('reserves the one $3 buy, with nothing grossed up', () => {
    const { cycleConfig } = runtime({ OPERADOR_CAPITAL_USD: '5000' })
    expect(cycleConfig.reservedEntries).toBe(1)
    expect(cycleConfig.params.maxUsdPerLevel).toBe(3)
    expect(cycleConfig.slotUsd).toBe(3)
    expect(cycleConfig.usdPerToken).toBe(3)
    expect(cycleConfig.portfolio.reservePct).toBe(0)
  })

  it('buys NOTHING through the cascade on the first tick of a slot — its doors stay shut; the first step is the dip-bounce’s', async () => {
    // The first buy on selection is a dip-bounce STEP the cycle buys (see "the
    // FIRST step is bought on selection"), never one of the cascade's doors.
    // The path the engine runs: the cycle's own tick rules, a slot of
    // `usdPerToken`, the broker `brokerFor` builds, over candles on which
    // every old door would open — a flat market inside a lateral zone, a new
    // position, nothing held.
    const { deps, cycleConfig } = runtime()
    const bars = 300
    const HOUR = 3_600_000
    const flat = (price: number) => Array.from({ length: bars }, () => price)
    const candles: Candles = {
      time: Array.from({ length: bars }, (_, i) => i * HOUR),
      open: flat(1), high: flat(1.005), low: flat(0.995), close: flat(1), volume: flat(10_000),
    }
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: -1 }
    const result = await tickPosition(
      { position: slot, candles, health: null, broker: await deps.brokerFor(slot), marketPriceUsd: 1 },
      tickConfigFrom(cycleConfig),
      new MemoryStore(), new RecordingAlerts(), new AlertThrottle(60_000),
    )
    expect(result.orders).toEqual([])
    expect(result.position.cascade.level).toBe(0)
  })

  it('funds the deep rung at its own size when it is brought back: both entries cost $35 grossed up', async () => {
    // At a $1 step the slot is $20, under what the two entries cost, so the
    // funder has to raise it — a $100 slot of $5 steps already covers both.
    const { deps, cycleConfig } = runtime({ ...DEEP_RUNG, ...LEGACY_LADDER, OPERADOR_STEP_USD: '1' })
    expect(cycleConfig.usdPerToken).toBe(20)
    const funded = await deps.deepRung!.fund!({ ...held, capitalUsd: cycleConfig.usdPerToken! }, 2)
    expect(funded?.capitalUsd).toBeCloseTo(capitalForFillsUsd([15, 20], 0.05), 9)
  })

  it('funds ladder A at its own sizes when it is brought back: six entries cost $135 grossed up', async () => {
    const { deps, cycleConfig } = runtime(LADDER_A)
    const funded = await deps.dropLadder!.fund!({ ...held, capitalUsd: cycleConfig.usdPerToken! }, 6)
    expect(funded?.capitalUsd).toBeCloseTo(capitalForFillsUsd([10, 15, 20, 25, 30, 35], 0.05), 9)
  })

  it('builds a broker that holds the one entry and refuses a second', async () => {
    const { deps } = runtime()
    const broker = await deps.brokerFor({ ...held, capitalUsd: 200 })
    const entries = Array.from({ length: 2 }, (_, i) => ({ kind: 'entry' as const, id: i === 0 ? 'Entry' : `DCA-${i}`, level: i, usd: 1, qty: 1, comment: 'x' }))
    expect(broker.execute(entries, 1, 0)).toHaveLength(1)
  })

  it('ticks on the live price by default, and reads candles only for a position idle six hours', () => {
    // *No quiero almacenar velas, nos movemos como lo habíamos diseñado antes, por precio.*
    expect(runtime().deps.liveBars?.staleAfterMs).toBe(6 * 3_600_000)
    expect(runtime({ OPERADOR_STALE_CHECK_HOURS: '3' }).deps.liveBars?.staleAfterMs).toBe(3 * 3_600_000)
    expect(runtime({ OPERADOR_LIVE_PRICE: '0' }).deps.liveBars).toBeUndefined()
  })

  it('does not blacklist a frozen token on release, as on 24/09, unless told to', () => {
    expect(runtime().cycleConfig.blacklistOnFreeze).toBe(false)
    expect(runtime({ OPERADOR_BLACKLIST_ON_FREEZE: '1' }).cycleConfig.blacklistOnFreeze).toBe(true)
  })

  it('rebuilds a position’s broker once a rung has raised its capital', async () => {
    // The paper broker refuses an entry its capital cannot cover, and the
    // first buy spent what a one-entry slot was given. A broker cached from
    // before the rung was funded would refuse the rung it was funded for.
    const { deps } = runtime()
    const before = await deps.brokerFor(held)
    const after = await deps.brokerFor({ ...held, capitalUsd: 31.73 })
    expect(after).not.toBe(before)
    expect(await deps.brokerFor({ ...held, capitalUsd: 31.73 })).toBe(after)
  })
})

describe('the rungs follow each token’s volatility, through the path the engine runs', () => {
  // *Aplicá el de en la línea, la propuesta.* The cycle's sweeps and the
  // loop's both read `deps.dropLadder`, so the switch is asked there — and
  // then the SAME sweep is run on a token moving 10% a bar, whose DCA-1 sits
  // at −5.2% of its first buy instead of −10%.
  const wild = { ...held, capitalUsd: 200, dcaScale: 0.52 }
  const sweepAt = async (env: Record<string, string>, price: number) => {
    const { deps, cycleConfig } = runtime(env)
    const store = new MemoryStore()
    await store.savePosition(wild)
    await store.recordFill({
      positionId: wild.id, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 10, costUsd: 0.01,
      comment: '🟢 Entry', idempotencyKey: `${wild.id}:0:Entry`,
    })
    // The runtime's own ladder, minus the free-capital funding that would ask
    // the (empty) database: the slot already holds enough for one rung.
    const { fund: _unfunded, ...ladder } = deps.dropLadder!
    await sweepStops(
      { ...deps, store, alerts: { send: async () => {} }, dropLadder: ladder },
      (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
      new AlertThrottle(0), [wild], new Map([['solana:T', price]]), 1_000,
    )
    return (await store.fillsFor(wild.id)).filter((f) => f.side === 'buy').map((f) => f.orderId)
  }

  it('is OFF when nothing is set — the whole drop ladder is', () => {
    expect(runtime().deps.dropLadder).toBeUndefined()
  })

  it('is ON with ladder A brought back: DCA-1 of a wild token at −5.3%', async () => {
    expect(runtime(LADDER_A).deps.dropLadder?.adaptive).toBe(true)
    expect(await sweepAt(LADDER_A, 0.947)).toEqual(['Entry', 'DCA-1'])
  })

  it('measures the scale over 15-minute bars: the tick is told the bar the engine trades', () => {
    // The day before the first buy counts only the bars that had CLOSED by
    // then, and which ones those are depends on how long a bar lasts.
    expect(tickConfigFrom(runtime().cycleConfig).barMs).toBe(15 * 60_000)
  })

  it('is OFF with OPERADOR_DCA_ADAPTIVE=0: the same token waits for the base −10%', async () => {
    const env = { ...LADDER_A, OPERADOR_DCA_ADAPTIVE: '0' }
    expect(runtime(env).deps.dropLadder?.adaptive).toBe(false)
    expect(await sweepAt(env, 0.947)).toEqual(['Entry'])
    expect(await sweepAt(env, 0.899)).toEqual(['Entry', 'DCA-1'])
  })
})

describe('the NEXT rung follows the token’s last hour, through the path the engine runs', () => {
  // *Que el próximo escalón DCA lo calcule por la cantidad de volatilidad que
  // tenga en ese preciso momento la moneda.* Then *tiempo real.* The cycle's
  // sweeps and the loop's both read `deps.dropLadder`, so the switch is asked
  // there — and the SAME sweep is run against a Jupiter answering a wild hour
  // of 5-minute bars, on a position measured calm-ish at the buy (DCA-1 at
  // −5.2%). The hour says −29%.
  const BAR = 5 * 60_000
  const wild = { ...held, capitalUsd: 200, dcaScale: 0.52 }
  const asked: string[] = []
  beforeEach(() => {
    asked.length = 0
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      if (!url.includes('/v2/charts/')) throw new Error('no network in this test')
      // Sixteen closed 5-minute bars swinging 20% every bar.
      const start = Math.floor(Date.now() / BAR) * BAR - 16 * BAR
      const candles = Array.from({ length: 16 }, (_, i) => {
        const close = i % 2 === 0 ? 1 : 1.2
        return { time: (start + i * BAR) / 1000, open: close, high: close, low: close, close, volume: 100 }
      })
      return new Response(JSON.stringify({ candles }), { status: 200 })
    })
  })

  // The hour of 5-minute bars, and only that: a rung that fires also asks the
  // pool's liquidity change for the brake, which is a different question.
  const barsAsked = () => asked.filter((url) => url.includes('/v2/charts/'))

  const sweepAt = async (env: Record<string, string>, price: number) => {
    const { deps, cycleConfig } = runtime(env)
    const store = new MemoryStore()
    await store.savePosition(wild)
    await store.recordFill({
      positionId: wild.id, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 10, costUsd: 0.01,
      comment: '🟢 Entry', idempotencyKey: `${wild.id}:0:Entry`,
    })
    const { fund: _unfunded, ...ladder } = deps.dropLadder!
    await sweepStops(
      { ...deps, store, alerts: { send: async () => {} }, dropLadder: ladder },
      (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
      new AlertThrottle(0), [wild], new Map([['solana:T', price]]), 1_000,
    )
    const [after] = await store.loadPositions()
    return { buys: (await store.fillsFor(wild.id)).filter((f) => f.side === 'buy').map((f) => f.orderId), after: after! }
  }

  it('is ON with ladder A brought back: the wild hour holds DCA-1 back, and asks Jupiter for 5-minute bars by mint', async () => {
    expect(runtime(LADDER_A).deps.dropLadder?.recentVolatility).toBeDefined()
    const { buys, after } = await sweepAt(LADDER_A, 0.9)
    expect(buys).toEqual(['Entry'])
    expect(asked.some((url) => url.includes('/v2/charts/T?interval=5_MINUTE'))).toBe(true)
    // Written down for the screen: sqrt(ln(1.2)×100 / 2.17) ≈ 2.9.
    expect(after.dcaScaleNow).toBeCloseTo(Math.sqrt((Math.log(1.2) * 100) / 2.17), 9)
  })

  it('is OFF with OPERADOR_DCA_REALTIME=0: the same token buys on the scale measured at the buy', async () => {
    const env = { ...LADDER_A, OPERADOR_DCA_REALTIME: '0' }
    expect(runtime(env).deps.dropLadder?.recentVolatility).toBeUndefined()
    const { buys } = await sweepAt(env, 0.9)
    expect(buys).toEqual(['Entry', 'DCA-1'])
    expect(barsAsked()).toEqual([])
  })

  it('scales nothing with OPERADOR_DCA_ADAPTIVE=0, real time included: the base −10%, and no hour asked', async () => {
    // Neither the −5.2% measured at the buy nor the −29% of the wild hour.
    const env = { ...LADDER_A, OPERADOR_DCA_ADAPTIVE: '0' }
    expect((await sweepAt(env, 0.93)).buys).toEqual(['Entry'])
    expect((await sweepAt(env, 0.899)).buys).toEqual(['Entry', 'DCA-1'])
    expect(barsAsked()).toEqual([])
  })
})

describe('the liquidity watch, through the path the engine runs', () => {
  // *Freno en tiempo real por cambio de liquidez inmediata que supere el 5%* —
  // *5 minutos o 1 hora* — and *siempre esperar la recuperación del 5% de
  // liquidez a partir del mínimo.* The cycle's sweeps and the loop's both read
  // `deps.dropLadder`, so the switch is asked there — and then the SAME sweep
  // is run against a Jupiter answering the pool, a minute apart each time, on
  // a book read back from the store the way production reads it.
  const flat = { ...held, capitalUsd: 200, lastPriceUsd: 0.9 }
  const searched: string[] = []
  let pool = { usd: 92_000, m5: -1, h1: -8 }
  beforeEach(() => {
    searched.length = 0
    pool = { usd: 92_000, m5: -1, h1: -8 }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.includes('/tokens/v2/search')) throw new Error('no network in this test')
      searched.push(url)
      const token = {
        id: 'T', name: 'T', symbol: 'T', decimals: 6, usdPrice: 0.9, liquidity: pool.usd,
        stats5m: { liquidityChange: pool.m5 }, stats1h: { liquidityChange: pool.h1 },
      }
      return new Response(JSON.stringify([token]), { status: 200 })
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const book = async (env: Record<string, string> = LADDER_A) => {
    const { deps, cycleConfig } = runtime(env)
    const store = new MemoryStore()
    await store.savePosition(flat)
    await store.recordFill({
      positionId: flat.id, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 10, costUsd: 0.01,
      comment: '🟢 Entry', idempotencyKey: `${flat.id}:0:Entry`,
    })
    const { fund: _unfunded, ...ladder } = deps.dropLadder!
    const sent: string[] = []
    const sweep = async (price: number, { later = true } = {}) => {
      await sweepStops(
        { ...deps, store, alerts: { send: async (a) => { sent.push(a.title) } }, dropLadder: ladder },
        (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
        new AlertThrottle(0), await store.loadPositions(), new Map([['solana:T', price]]), Date.now(),
      )
      if (later) vi.setSystemTime(Date.now() + 61_000)
    }
    const buys = async () => (await store.fillsFor(flat.id)).filter((f) => f.side === 'buy').map((f) => f.orderId)
    return { sweep, buys, sent }
  }

  it('is OFF when nothing is set — it rides on the drop ladder, which is off', () => {
    expect(runtime().deps.dropLadder).toBeUndefined()
  })

  it('is ON at 5% with ladder A brought back: a pool down 8% in the hour holds DCA-1 back at its line', async () => {
    expect(runtime(LADDER_A).deps.dropLadder?.liquidityBrakePct).toBe(5)
    expect(runtime(LADDER_A).deps.dropLadder?.liquidityChange).toBeDefined()
    const { sweep, buys, sent } = await book()
    await sweep(0.899)
    expect(await buys()).toEqual(['Entry'])
    expect(sent).toContain('🧊 T: escalón frenado')
    expect(searched.some((url) => url.includes('query=T'))).toBe(true)
  })

  it('buys the next rung on a 5% bounce off the minimum while still at a loss, above its line', async () => {
    const { sweep, buys, sent } = await book()
    await sweep(0.97)
    pool = { usd: 96_700, m5: 5, h1: -3 }
    await sweep(0.97)
    expect(await buys()).toEqual(['Entry', 'DCA-1'])
    expect(sent.some((title) => title.startsWith('🌱 T: la liquidez se recuperó 5% desde el mínimo'))).toBe(true)
  })

  it('asks Jupiter once a minute for the book, however many sweeps look', async () => {
    const { sweep } = await book()
    await sweep(0.95, { later: false })
    await sweep(0.95, { later: false })
    await sweep(0.95)
    expect(searched).toHaveLength(1)
    await sweep(0.95)
    expect(searched).toHaveLength(2)
  })

  it('is OFF with OPERADOR_LIQUIDITY_BRAKE_PCT=0: the same draining pool buys on the line, and nothing is asked', async () => {
    const env = { ...LADDER_A, OPERADOR_LIQUIDITY_BRAKE_PCT: '0' }
    expect(runtime(env).deps.dropLadder?.liquidityBrakePct).toBe(0)
    const { sweep, buys } = await book(env)
    await sweep(0.899)
    expect(await buys()).toEqual(['Entry', 'DCA-1'])
    expect(searched).toEqual([])
  })
})

describe('the deep rung, brought back, through the path the engine runs', () => {
  // *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay un
  // rebote de 10%, nueva compra DCA de $20.* OFF in production now; this is the
  // variable that brings it back, run through the SAME sweep the cycle and the
  // loop run, funder and brokers included — without the dip-bounce steps, so
  // the rung is the only thing that can buy.
  const book = async () => {
    const { deps: all, cycleConfig } = runtime(DEEP_RUNG)
    const { dipBounce: _steps, ...deps } = all
    const store = new MemoryStore()
    // A slot sized by the allocator: the $15 first buy alone.
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken! }
    await store.savePosition(slot)
    await store.recordFill({
      positionId: slot.id, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 15, costUsd: 0.05,
      comment: '🟢 Entry', idempotencyKey: `${slot.id}:0:Entry`,
    })
    const sent: { kind: string; title: string }[] = []
    let clock = 1_000
    // One sweep at a live price. The tick keeps the last candle close beside
    // the market, so the price guard sees the two agree, as it would live.
    const sweep = async (price: number) => {
      await sweepStops(
        { ...deps, store, alerts: { send: async (a) => { sent.push({ kind: a.kind, title: a.title }) } } },
        (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
        new AlertThrottle(0),
        (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })),
        new Map([['solana:T', price]]),
        (clock += 30_000),
      )
    }
    const buys = async () => (await store.fillsFor(slot.id)).filter((f) => f.side === 'buy')
    return { sweep, buys, sent }
  }

  for (const fall of [30, 50, 70]) {
    it(`buys NOTHING on a ${fall}% fall, however it bounces`, async () => {
      const { sweep, buys } = await book()
      const bottom = 1 - fall / 100
      for (const price of [0.95, 0.9, bottom, bottom * 1.1, bottom * 1.25, bottom]) await sweep(price)
      expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    })
  }

  it('buys EXACTLY one $20 rung on an 85% fall that rebounds 10% — and nothing after it', async () => {
    const { sweep, buys, sent } = await book()
    for (const price of [0.7, 0.4, 0.15]) await sweep(price)
    expect(await buys()).toHaveLength(1)
    await sweep(0.165)
    const bought = await buys()
    expect(bought.map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    expect(bought[1]!.qty).toBeCloseTo(20 / 0.165, 6)
    expect(sent.find((a) => a.kind === 'dca-filled')?.title)
      .toBe('🪜 T promedió — DCA-1 $20: cayó 85.0% desde la primera compra y rebotó 10.0% desde el mínimo')
    // A deeper fall and another rebound: the holding has had its one rung.
    for (const price of [0.05, 0.06, 0.1]) await sweep(price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })
})

/**
 * The production runtime on a book in MEMORY: its own dip-bounce policy, step
 * and gas, its own cycle rules — with the funder and the brokers rebuilt on the
 * test's store, because the runtime's own read the (empty) database.
 */
const onMemory = (env: Record<string, string> = {}) => {
  const { deps: built, cycleConfig } = runtime({ ...LEGACY_LADDER, ...LEGACY_ORDER, ...env })
  const store = new MemoryStore()
  const brokers = new Map<string, PaperBroker>()
  const brokerFor = async (p: PersistedPosition) => {
    const key = `${p.id}:${p.capitalUsd}`
    let broker = brokers.get(key)
    if (!broker) {
      broker = new PaperBroker({ gasUsdPerSwap: cycleConfig.gasUsdPerSwap!, initialCapital: p.capitalUsd, maxOpenEntries: cycleConfig.maxOpenEntries!, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      brokers.set(key, broker)
    }
    return broker
  }
  const deps: CycleDeps = {
    ...built,
    store,
    alerts: new RecordingAlerts(),
    brokerFor,
    dipBounce: {
      ...built.dipBounce!,
      fund: fundStepFromFreeCapital({ store, totalCapitalUsd: cycleConfig.portfolio.totalCapitalUsd, cashOf: async (p) => (await brokerFor(p)).equityCash }),
    },
  }
  return { deps, cycleConfig, store, brokerFor }
}

describe('only the dip-bounce buys, through the path the engine runs', () => {
  // *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
  // escalones de 1 USD con la misma regla.* And the lesson this project paid for
  // when a switched-off stop cut six positions: *a switched-off rule must stay
  // off through every path.* So these build the runtime from an EMPTY
  // environment — production's defaults — and run the SAME sweep the cycle and
  // the loop run, on a book read back from the store the way production reads it.
  // These follow a reservation whose FIRST dollar waits for a dip and a bounce
  // — the rule with buy-on-selection off. With it on, the sweep buys that first
  // step at once (see "the FIRST step is bought on selection").
  const book = async (env: Record<string, string> = {}) => {
    const { deps, cycleConfig, store } = onMemory({ OPERADOR_BUY_ON_SELECTION: '0', ...env })
    // A reservation the allocator sized and the tick has priced: nothing bought.
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0 }
    await store.savePosition(slot)
    let clock = 1_000
    const sweep = async (price: number) => {
      await sweepStops(
        deps,
        (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
        new AlertThrottle(0),
        (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })),
        new Map([['solana:T', price]]),
        (clock += 30_000),
      )
    }
    const buys = async () => (await store.fillsFor(slot.id)).filter((f) => f.side === 'buy')
    return { sweep, buys, store, slot, deps, cycleConfig }
  }

  it('with the ceiling brought back (OPERADOR_MAX_DIP_PCT=20), buys nothing on a −30%, −50% or −85% collapse — and never a $20 rung', async () => {
    // "If it fell more than 20% it is a collapse, not a dip: don't buy there.
    // Wait until it is back within 20%." Off in production since *sacá el
    // techo de derrumbe*; kept tested one variable away.
    const { sweep, buys } = await book({ OPERADOR_MAX_DIP_PCT: '20' })
    for (const price of [1, 0.96, 0.98, 0.7, 0.714, 0.5, 0.51, 0.15, 0.153]) await sweep(price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    for (const price of [0.8, 0.8 * 1.021]) await sweep(price)
    const bought = await buys()
    expect(bought.map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    // Each one $5, inside the same half percent a $1 step was held to — the
    // spread the fill pays over the quote scales with the step.
    for (const f of bought) expect((f.qty * f.price) / 5).toBeCloseTo(1, 2)
  })

  it('buys every dip and bounce on the old falls with the production defaults — there is no crash ceiling', async () => {
    // *Sacá el techo de derrumbe.* Each bounce as big as its DCA asks: 2% for
    // DCA 1, 3% for DCA 2, 4% for DCA 3. What still refuses a buy in a
    // collapse is the live pool check, tested on its own below.
    const { deps, cycleConfig, store } = onMemory()
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0 }
    await store.savePosition(slot)
    let clock = 1_000
    for (const price of [1, 0.96, 0.98, 0.7, 0.714, 0.5, 0.5155, 0.15, 0.15615]) {
      await sweepStops(
        deps, (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)), new AlertThrottle(0),
        (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })), new Map([['solana:T', price]]), (clock += 30_000),
      )
    }
    expect((await store.fillsFor(slot.id)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2', 'DCA-3'])
  })

  it('buys nothing on a price that only falls — the bounce is half the rule', async () => {
    const { sweep, buys } = await book()
    for (const price of [1, 0.9, 0.8, 0.7, 0.5, 0.3]) await sweep(price)
    expect(await buys()).toEqual([])
  })

  it('asks each DCA for 2 more points of dip and 1 more of bounce — and says what applied', async () => {
    // *3% suma 2%, el 2% suma 2% por cada DCA* — *el rebote dejalo que aumente
    // de 1%.* The first buy on a 4% dip; DCA 1 on 3% and 2%; DCA 2 waits past a
    // 4.1% dip and a 2.7% bounce for 5% and 3%; DCA 3 past 6.6% and 3.6% for 7% and 4%.
    const { sweep, buys, deps } = await book()
    const ids = async () => (await buys()).map((f) => f.orderId)
    for (const price of [1, 0.96, 0.98, 0.95, 0.97]) await sweep(price)
    expect(await ids()).toEqual(['Entry', 'DCA-1'])
    for (const price of [0.93, 0.95, 0.92, 0.945]) await sweep(price)
    expect(await ids()).toEqual(['Entry', 'DCA-1'])
    await sweep(0.948)
    expect(await ids()).toEqual(['Entry', 'DCA-1', 'DCA-2'])
    for (const price of [0.885, 0.88, 0.912]) await sweep(price)
    expect(await ids()).toEqual(['Entry', 'DCA-1', 'DCA-2'])
    await sweep(0.916)
    expect(await ids()).toEqual(['Entry', 'DCA-1', 'DCA-2', 'DCA-3'])
    const said = (deps.alerts as RecordingAlerts).sent.filter((a) => a.kind === 'dca-filled').map((a) => a.title)
    expect(said).toEqual([
      '🪜 T promedió — compra 2 de 20: cayó 3.1% (pedía 3%) y rebotó 2.1% (pedía 2%) — DCA 1',
      '🪜 T promedió — compra 3 de 20: cayó 5.2% (pedía 5%) y rebotó 3.0% (pedía 3%) — DCA 2',
      '🪜 T promedió — compra 4 de 20: cayó 7.2% (pedía 7%) y rebotó 4.1% (pedía 4%) — DCA 3',
    ])
  })

  it('reaches all twenty on a descent that gives each buy its own dip and bounce — the ceiling grows with the dip — and stops there', async () => {
    // *El techo del 20% crece 2 puntos por DCA, igual que la caída.* DCA 10
    // asks a 21% dip, past a fixed 20% ceiling; its own is 38%.
    const { sweep, buys, deps } = await book()
    const policy = deps.dipBounce!.policy
    let price = 1
    await sweep(price)
    for (let k = 1; k <= 25; k++) {
      const { dipPct, bouncePct } = dipBounceThresholds(k, policy)
      const low = price * (1 - (dipPct + 1) / 100)
      await sweep(low)
      price = low * (1 + (bouncePct + 1) / 100)
      await sweep(price)
    }
    const bought = await buys()
    expect(bought).toHaveLength(20)
    for (let i = 1; i < bought.length; i++) expect(bought[i]!.price).toBeLessThan(bought[i - 1]!.price)
    for (const f of bought) expect((f.qty * f.price) / 5).toBeCloseTo(1, 2)
  })

  it('sells the holding through the strategy exit only at +12.5% or more over the average of its $5 steps', async () => {
    const { sweep, buys, store, slot, cycleConfig, deps } = await book()
    for (const price of [1, 0.96, 0.98, 0.9, 0.92, 0.85, 0.876]) await sweep(price)
    expect(await buys()).toHaveLength(3)
    const avg = positionLedger(await store.fillsFor(slot.id)).avgCostUsd!

    // The tick the engine runs, on candles that climbed to +30% over that
    // average in the last twenty bars — the impulse the exit sells on.
    const tickAt = async (top: number) => {
      const bars = 300
      const time = Array.from({ length: bars }, (_, i) => i * 900_000)
      const close = time.map((_, i) => (i < bars - 20 ? avg : avg + ((top - avg) * (i - (bars - 21))) / 20))
      const candles: Candles = { time, open: close, high: close.map((c) => c * 1.001), low: close.map((c) => c * 0.999), close, volume: close.map(() => 10_000) }
      const [position] = await store.loadPositions()
      const ticked = await tickPosition(
        { position: { ...position!, lastBarTime: time[bars - 2]! }, candles, health: null, broker: await deps.brokerFor(position!), marketPriceUsd: top },
        tickConfigFrom(cycleConfig),
        store, new RecordingAlerts(), new AlertThrottle(60_000),
      )
      return { ticked, sells: (await store.fillsFor(slot.id)).filter((f) => f.side === 'sell') }
    }

    const early = await tickAt(avg * 1.09)
    expect(early.ticked.minProfitPct).toBe(12.5)
    expect(early.sells).toEqual([])

    const { ticked, sells } = await tickAt(avg * 1.3)
    expect(ticked.minProfitPct).toBe(12.5)
    expect(sells.length).toBe(3)
    for (const f of sells) expect(f.price).toBeGreaterThanOrEqual(avg * 1.125)
  })
})

describe('the $1.20 stop after the second buy, through the path the engine runs', () => {
  // *Si alguno luego del 2 DCA lleva perdiendo más de 1.2 USD, entonces SL.*
  // The production ladder and stop, every one of them unset: $3, then $9 on a
  // 23% dip and a 12% bounce, and the cut armed from the second buy.
  const DEFAULTS = Object.fromEntries(Object.keys(LEGACY_LADDER).map((k) => [k, '']))

  it('holds the first buy through the dip, then cuts the moment the two buys are more than $1.20 down', async () => {
    // The two-buy ladder and the stop as they ran, both a variable away now.
    const { deps, cycleConfig, store } = onMemory({ ...DEFAULTS, OPERADOR_STEP_USD: '3', OPERADOR_MAX_STEPS: '2', OPERADOR_STOP_MAX_LOSS_USD: '1.2', OPERADOR_PRESSURE_TP_DROP_PCT: '0', OPERADOR_CRASH_STOP_PCT: '0', OPERADOR_TIERS: '0', OPERADOR_DEATH_WATCH: '1' })
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0 }
    await store.savePosition(slot)
    let clock = 1_000
    const levels = (position: PersistedPosition) => exitLevelsFor(position, exitSizingFrom(cycleConfig))
    const sweep = async (price: number) =>
      sweepStops(deps, levels, new AlertThrottle(0), (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })), new Map([['solana:T', price]]), (clock += 30_000))
    // $3 at 1.00, then 30% down: $0.90 lost on one buy, and the stop waits.
    for (const price of [1, 0.7]) expect(await sweep(price)).toEqual([])
    // A 12% bounce off the low buys the $9 — now two buys, about $1 down.
    expect(await sweep(0.79)).toEqual([])
    const fills = async () => store.fillsFor(slot.id)
    expect((await fills()).filter((f) => f.side === 'buy').map((f) => Math.round(f.price * f.qty))).toEqual([3, 9])
    const { avgCostUsd, qty } = positionLedger(await fills())
    // Just under the line holds; just past it sells everything.
    expect(await sweep(avgCostUsd! - 1.19 / qty)).toEqual([])
    expect(await sweep(avgCostUsd! - 1.21 / qty)).toEqual([slot.id])
    expect((await fills()).filter((f) => f.side === 'sell').map((f) => f.comment)).toEqual(['🛑 Stop', '🛑 Stop'])
    expect(await store.loadPositions()).toEqual([])
  })

  it('cuts the one $3 buy the moment it is more than $0.60 down — *ponele un SL a 0.60* — with production’s own defaults', async () => {
    const { deps, cycleConfig, store } = onMemory(DEFAULTS)
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0 }
    await store.savePosition(slot)
    let clock = 1_000
    const levels = (position: PersistedPosition) => exitLevelsFor(position, exitSizingFrom(cycleConfig))
    const sweep = async (price: number) =>
      sweepStops(deps, levels, new AlertThrottle(0), (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })), new Map([['solana:T', price]]), (clock += 30_000))
    expect(await sweep(1)).toEqual([])
    const fills = async () => store.fillsFor(slot.id)
    const { avgCostUsd, qty } = positionLedger(await fills())
    expect(await sweep(avgCostUsd! - 0.59 / qty)).toEqual([])
    expect(await sweep(avgCostUsd! - 0.61 / qty)).toEqual([slot.id])
    expect((await fills()).filter((f) => f.side === 'sell').map((f) => f.comment)).toEqual(['🛑 Stop'])
  })
})

describe('the fixed TP at +12.5%, through the path the engine runs', () => {
  // *Poné un TP fijo al 12.5% del promedio* — sell everything the moment the
  // price reaches the average cost plus 12.5%, accepting that the big runs are
  // given up. Built from an EMPTY environment, the runtime's own sweep rules,
  // on a holding its own dip-bounce steps bought: three $5 buys, as in the
  // book above.
  const holding = async (env: Record<string, string> = {}) => {
    const { deps, cycleConfig, store } = onMemory(env)
    const slot = { ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0 }
    await store.savePosition(slot)
    let clock = 1_000
    const levels = (position: PersistedPosition) => exitLevelsFor(position, exitSizingFrom(cycleConfig))
    const sweepOn = async (book: readonly PersistedPosition[], price: number) =>
      sweepStops(deps, levels, new AlertThrottle(0), book.map((p) => ({ ...p, lastPriceUsd: price })), new Map([['solana:T', price]]), (clock += 30_000))
    const sweep = async (price: number) => sweepOn(await store.loadPositions(), price)
    for (const price of [1, 0.96, 0.98, 0.9, 0.92, 0.85, 0.876]) await sweep(price)
    const fills = async () => store.fillsFor(slot.id)
    expect((await fills()).filter((f) => f.side === 'buy')).toHaveLength(3)
    const ledger = positionLedger(await fills())
    const sells = async () => (await fills()).filter((f) => f.side === 'sell')
    return { deps, store, slot, sweep, sweepOn, sells, avg: ledger.avgCostUsd!, qty: ledger.qty }
  }

  it('is OFF when nothing is set — *sin TP fijo* — and 12.5 brings it back, through the levels the cycle and the loop read', () => {
    expect(exitLevelsFor(held, exitSizingFrom(runtime().cycleConfig)).fixedTpPct).toBeNull()
    expect(exitLevelsFor(held, exitSizingFrom(runtime({ OPERADOR_FIXED_TP_PCT: '12.5' }).cycleConfig)).fixedTpPct).toBe(12.5)
  })

  it('sells EVERYTHING the next sweep once the live price reaches the average × 1.125, under its own name', async () => {
    const { deps, store, slot, sweep, sells, avg, qty } = await holding()
    expect(await sweep(avg * 1.125)).toEqual([slot.id])
    const sold = await sells()
    expect(sold.map((f) => f.comment)).toEqual(['🎯 TP fijo', '🎯 TP fijo', '🎯 TP fijo'])
    expect(sold.reduce((q, f) => q + f.qty, 0)).toBeCloseTo(qty, 9)
    expect(await store.loadPositions()).toEqual([])
    const said = (deps.alerts as RecordingAlerts).sent.find((a) => a.title.startsWith('🎯'))
    expect(said?.level).toBe('info')
    expect(said?.title).toMatch(/^🎯 T vendida en su TP fijo: \+12\.5% sobre el promedio — ganó \$\d+\.\d\d$/)
  })

  it('does not sell at the average × 1.12', async () => {
    const { store, slot, sweep, sells, avg } = await holding()
    expect(await sweep(avg * 1.12)).toEqual([])
    expect(await sells()).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([slot.id])
  })

  it('sells nothing at +12.5% on the sweep with OPERADOR_FIXED_TP_PCT=0', async () => {
    const { store, slot, sweep, sells, avg } = await holding({ OPERADOR_FIXED_TP_PCT: '0' })
    expect(await sweep(avg * 1.125)).toEqual([])
    expect(await sweep(avg * 1.15)).toEqual([])
    expect(await sells()).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([slot.id])
  })

  it('never sells a position twice — the stale snapshot handed to the next sweep sells nothing', async () => {
    const { store, sweepOn, sells, avg } = await holding()
    const before = await store.loadPositions()
    await sweepOn(before, avg * 1.125)
    await sweepOn(before, avg * 1.13)
    expect(await sells()).toHaveLength(3)
  })

  it('leaves the gain lock working when the fixed TP is off: a floor at +20%, sold on the way back to +9%', async () => {
    const { slot, sweep, sells, avg } = await holding({ OPERADOR_FIXED_TP_PCT: '0' })
    expect(await sweep(avg * 1.25)).toEqual([])
    expect(await sweep(avg * 1.09)).toEqual([slot.id])
    expect(new Set((await sells()).map((f) => f.comment))).toEqual(new Set(['🔐 Piso de ganancia']))
  })

  it('and with the fixed TP on, the same jump to +25% leaves at the TP before any floor is set', async () => {
    const { slot, sweep, sells, avg } = await holding()
    expect(await sweep(avg * 1.25)).toEqual([slot.id])
    expect(new Set((await sells()).map((f) => f.comment))).toEqual(new Set(['🎯 TP fijo']))
  })
})

describe('the pool is asked live before every step, through the path the engine runs', () => {
  // YAP froze with "sell quote implausible · liquidity $52,380 = 26.6% of
  // entry" — assessed by the tick once a 15-minute bar, while the 30-second
  // sweep bought four more steps into the draining pool, 14:05 to 14:12. The
  // production runtime from an EMPTY environment, the SAME sweep the cycle and
  // the loop run, and Jupiter answering the pool the way the runtime asks it.
  const ENTRY = 196_917
  const searched: string[] = []
  let depth = ENTRY
  beforeEach(() => {
    searched.length = 0
    depth = ENTRY
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.includes('/tokens/v2/search')) throw new Error('no network in this test')
      searched.push(url)
      const token = { id: 'T', name: 'T', symbol: 'T', decimals: 6, usdPrice: 1, liquidity: depth, stats5m: {}, stats1h: {} }
      return new Response(JSON.stringify([token]), { status: 200 })
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const book = async () => {
    const { deps, cycleConfig, store } = onMemory({ OPERADOR_BUY_ON_SELECTION: '0' })
    // A reservation opened on a $196,917 pool: the death watch's own baseline.
    const slot = {
      ...held, capitalUsd: cycleConfig.usdPerToken!, lastBarTime: 0,
      deathWatch: startDeathWatch(ENTRY, 0), quality: { ...held.quality, liquidityUsd: ENTRY },
    }
    await store.savePosition(slot)
    const sent: string[] = []
    // One sweep at a live price, a minute apart: the runtime's reader holds an
    // answer for a minute, so each sweep sees the pool as it is now.
    const sweep = async (price: number) => {
      await sweepStops(
        { ...deps, alerts: { send: async (a) => { sent.push(a.title) } } },
        (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
        new AlertThrottle(0),
        (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })),
        new Map([['solana:T', price]]),
        Date.now(),
      )
      vi.setSystemTime(Date.now() + 61_000)
    }
    const buys = async () => (await store.fillsFor(slot.id)).filter((f) => f.side === 'buy').map((f) => f.orderId)
    return { sweep, buys, sent }
  }

  it('buys NOTHING into YAP’s pool at 26.6% of its entry liquidity, and says so once', async () => {
    const { sweep, buys, sent } = await book()
    depth = 52_380
    for (const price of [1, 0.96, 0.98, 0.985, 0.99]) await sweep(price)
    expect(await buys()).toEqual([])
    expect(sent.filter((t) => t.startsWith('🧊'))).toEqual(['🧊 T: el pool perdió liquidez (queda 26.6% de la entrada) — no compra'])
    expect(searched.some((url) => url.includes('query=T'))).toBe(true)
  })

  it('buys as before on a pool at 90% of its entry liquidity', async () => {
    const { sweep, buys, sent } = await book()
    depth = ENTRY * 0.9
    for (const price of [1, 0.96, 0.98]) await sweep(price)
    expect(await buys()).toEqual(['Entry'])
    expect(sent.filter((t) => t.startsWith('🧊'))).toEqual([])
  })

  it('buys as before when Jupiter does not answer — silence is not a drained pool', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('no network in this test') })
    const { sweep, buys } = await book()
    for (const price of [1, 0.96, 0.98]) await sweep(price)
    expect(await buys()).toEqual(['Entry'])
  })
})

describe('the rising door, brought back (OPERADOR_ENTRY_RISING=1), through the shelf the engine allocates from', () => {
  // *Hacé que la barrera de entrada sea solamente que los tokens suban, como
  // marca la barra de estudio de los 49 tokens.* The operator. `deps.recall` is
  // what a watch pass allocates from: the stored scan, re-ranked with the
  // production policy main.ts composes — gates, floors, order and the cut.
  const safe = {
    honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
    hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
  }
  // Measured by the scan that stored them: 2% every five minutes clears the
  // volatility door unless a token says otherwise.
  const token = (address: string, h1: number | null, liquidityUsd: number, vol: number | null | 'unmeasured' = 2): TokenSnapshot => ({
    ...(vol !== 'unmeasured' ? { volatility5mPct: vol } : {}),
    chain: 'solana', address, symbol: address, pairAddress: `pair-${address}`, observedAt: Date.now() - 60_000,
    priceUsd: 1, liquidityUsd, fdvUsd: 5_000_000,
    volumeUsd: { h1: 60_000, h6: 300_000, h24: 875_000 },
    priceChangePct: { h1, h6: 2, h24: 3 },
    txns: { h1: { buys: 70, sells: 25 }, h24: { buys: 900, sells: 850 } },
    pairCreatedAt: Date.now() - 30 * 24 * 3_600_000, historyBars: 1000, security: safe,
  })
  // Four risers, and three that are not — the three CHEAPEST to trade, so an
  // order or a cut applied before the door would pick them.
  const shelf = [
    token('R150', 5, 150_000), token('R300', 8, 300_000), token('R600', 1, 600_000), token('UP03', 0.3, 200_000),
    token('DOWN', -0.1, 5_000_000), token('FLAT', 0, 4_000_000), token('QUIET', null, 3_000_000),
    // Rising, cheap, and CALM — or never measured. The volatility door's.
    token('CALM', 5, 900_000, 0.4), token('BLIND', 4, 800_000, 'unmeasured'),
  ]
  const recalled = async (slots: number, env: Record<string, string> = {}) => {
    const sql: SqlClient = {
      query: async <T>(text: string) =>
        /FROM scans/.test(text)
          ? { rows: [{ scanned_at: String(Date.now() - 60_000), chain: 'solana', snapshots: shelf }] as T[] }
          : { rows: [] as T[] },
    }
    const { deps } = buildRuntime(loadConfig({ DATABASE_URL: 'postgres://user:secret@host:5432/db', OPERADOR_ENTRY_RISING: '1', OPERADOR_MIN_VOLATILITY_PCT: '1', OPERADOR_ENTRY_FLOORS: '0', ...LEGACY_ORDER, ...env }), {
      sql,
      postJson: async () => { throw new Error('no network in this test') },
    })
    const found = await deps.recall!(slots)
    return found!.candidates.map((c) => c.snapshot.address)
  }

  it('lets in a candidate rising by +0.3 in the hour, and nothing at −0.1, 0 or unreported', async () => {
    const found = await recalled(10)
    expect(found).toContain('UP03')
    for (const not of ['DOWN', 'FLAT', 'QUIET']) expect(found).not.toContain(not)
  })

  it('orders by cost efficiency and cuts to the free slots AFTER the door — the cheapest risers, not the cheapest tokens', async () => {
    expect(await recalled(10)).toEqual(['R600', 'R300', 'UP03', 'R150'])
    expect(await recalled(2)).toEqual(['R600', 'R300'])
  })

  it('refuses a riser that does not MOVE 1% every five minutes, or that nobody measured — OPERADOR_MIN_VOLATILITY_PCT', async () => {
    const found = await recalled(10)
    expect(found).not.toContain('CALM')
    expect(found).not.toContain('BLIND')
    const open = await recalled(10, { OPERADOR_MIN_VOLATILITY_PCT: '0' })
    expect(open).toContain('CALM')
    expect(open).toContain('BLIND')
  })

  it('takes the cheapest tokens again with the door off — OPERADOR_ENTRY_RISING=0', async () => {
    expect(await recalled(2, { OPERADOR_ENTRY_RISING: '0' })).toEqual(['DOWN', 'FLAT'])
  })
})

describe('the FIRST step is bought on selection, through the cycle the engine runs', () => {
  // *Y además que la primera compra entre automáticamente.* The operator. A
  // token that becomes a candidate and gets a slot buys its first $5 in the
  // SAME pass, at the live price — past the door's safety re-check, funded, and
  // keyed so it cannot happen twice. Every later buy is the dip-bounce rule.
  const quality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 }
  const HOUR = 3_600_000
  const T0 = 400 * 900_000
  const risingCandidate: Candidate = {
    snapshot: {
      chain: 'solana', address: 'NEW', symbol: 'NEW', pairAddress: 'pair-NEW', priceUsd: 1, liquidityUsd: 1_000_000,
      priceChangePct: { h1: 0.3, h6: 1, h24: 2 },
    } as TokenSnapshot,
    opportunity: { score: 60, components: { volumeExpansion: 0, buyPressure: 0, liquidityGrowth: 0, activity: 0, volatility: 0, momentum: 0, headroom: 1, costEfficiency: 0.8, risingHour: 1 } },
    marketQuality: quality,
  }
  // Flat candles at 1: the tick has a close on record, and it agrees with the
  // live price the pass asks for.
  const candles = (): Candles => {
    const bars = 300
    const time = Array.from({ length: bars }, (_, i) => T0 - (bars - i) * 900_000)
    const flat = (v: number) => time.map(() => v)
    return { time, open: flat(1), high: flat(1.001), low: flat(0.999), close: flat(1), volume: flat(10_000) }
  }
  const confirmed: string[] = []

  const pass = async (setup: ReturnType<typeof onMemory>, now: number, env: { price?: number } = {}) =>
    runCycle(
      {
        ...setup.deps,
        scan: async () => [risingCandidate],
        candlesFor: async () => candles(),
        healthFor: async () => null,
        marketPrices: async (positions) => new Map(positions.map((p) => [`${p.chain}:${p.tokenAddress}`, env.price ?? 1])),
        confirmEntry: async (snapshot) => { confirmed.push(snapshot.address); return { ok: true, snapshot } },
        now: () => now,
      },
      setup.cycleConfig,
      new AlertThrottle(0),
      'full',
    )

  it('buys exactly one $5 step in the pass that opened it — after the door’s safety re-check — and says so', async () => {
    confirmed.length = 0
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000' })
    const result = await pass(setup, T0)
    expect(result.opened.map((p) => p.tokenAddress)).toEqual(['NEW'])
    expect(confirmed).toEqual(['NEW'])
    const buys = (await setup.store.allFills()).filter((f) => f.side === 'buy')
    expect(buys.map((f) => f.orderId)).toEqual(['Entry'])
    expect((buys[0]!.qty * buys[0]!.price) / 5).toBeCloseTo(1, 2)
    const said = (setup.deps.alerts as RecordingAlerts).sent.find((a) => a.kind === 'position-opened')
    expect(said?.title).toBe('🟢 NEW compró $5 al entrar como candidata (compra 1 de 20)')
  })

  it('buys the first step on the next sweep when the opening pass could not — a reservation never waits for a dip to START', async () => {
    // The opening pass had no candle close for it — a provider refusing, a
    // price that could not be confirmed — so it saved the slot and bought
    // nothing. On 2026-09-30 fifty-four reservations sat like that, each
    // waiting for a 15% dip and an 8% bounce to buy its FIRST dollar.
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000' })
    // A reservation as that pass left it, once the next one put a close on record.
    const reserved = { ...held, id: 'solana:NEW:1', tokenAddress: 'NEW', pairAddress: 'pair-NEW', symbol: 'NEW', capitalUsd: 100, lastBarTime: T0 - 15 * 60_000, lastPriceUsd: 1 }
    await setup.store.savePosition(reserved)
    expect(await setup.store.fillsFor(reserved.id)).toEqual([])
    await sweepStops(
      setup.deps,
      (p) => exitLevelsFor(p, exitSizingFrom(setup.cycleConfig)),
      new AlertThrottle(0),
      await setup.store.loadPositions(),
      new Map([['solana:NEW', 1]]),
      T0 + 60_000,
    )
    expect((await setup.store.fillsFor(reserved.id)).map((f) => f.orderId)).toEqual(['Entry'])
  })

  it('buys the first $3 of a reservation on the next sweep with PRODUCTION’s own defaults', async () => {
    // Every legacy pin unset: what the engine runs today. 305 reservations sat
    // at $0 on 2026-10-09 — this is the path that must buy them.
    const production = Object.fromEntries([...Object.keys(LEGACY_LADDER), ...Object.keys(LEGACY_ORDER)].map((k) => [k, '']))
    const setup = onMemory({ ...production, OPERADOR_CAPITAL_USD: '5000' })
    const reserved = { ...held, id: 'solana:NEW:1', tokenAddress: 'NEW', pairAddress: 'pair-NEW', symbol: 'NEW', capitalUsd: 3, lastBarTime: T0 - 15 * 60_000, lastPriceUsd: 1 }
    await setup.store.savePosition(reserved)
    await sweepStops(
      setup.deps,
      (p) => exitLevelsFor(p, exitSizingFrom(setup.cycleConfig)),
      new AlertThrottle(0),
      await setup.store.loadPositions(),
      new Map([['solana:NEW', 1]]),
      T0 + 60_000,
    )
    const buys = (await setup.store.fillsFor(reserved.id)).filter((f) => f.side === 'buy')
    expect(buys.map((f) => f.orderId)).toEqual(['Entry'])
    expect(buys[0]!.qty * buys[0]!.price).toBeCloseTo(3, 1)
  })

  it('doubles each step: $1 on the first buy, $2 on the first DCA', async () => {
    // *Hacé que cada escalón sea 1, 2, 4, 8, 16, 32.* The operator.
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000', OPERADOR_STEP_USD: '1', OPERADOR_STEP_GROWTH: '2' })
    const reserved = { ...held, id: 'solana:NEW:1', tokenAddress: 'NEW', pairAddress: 'pair-NEW', symbol: 'NEW', capitalUsd: 63, lastBarTime: T0 - 15 * 60_000, lastPriceUsd: 1 }
    await setup.store.savePosition(reserved)
    let clock = T0
    const sweep = async (price: number) =>
      sweepStops(
        setup.deps,
        (p) => exitLevelsFor(p, exitSizingFrom(setup.cycleConfig)),
        new AlertThrottle(0),
        (await setup.store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })),
        new Map([['solana:NEW', price]]),
        (clock += 30_000),
      )
    await sweep(1)
    // A 4% dip and a bounce past 2%: DCA 1, under the legacy 3%/2% lines.
    for (const price of [0.96, 0.985]) await sweep(price)
    const spent = (await setup.store.fillsFor(reserved.id)).filter((f) => f.side === 'buy').map((f) => f.qty * f.price)
    expect(spent).toHaveLength(2)
    expect(spent[0]! / 1).toBeCloseTo(1, 2)
    expect(spent[1]! / 2).toBeCloseTo(1, 2)
  })

  it('never buys a second first step on the next pass — and the next buy needs a 3% dip under it and a 2% bounce', async () => {
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000' })
    await pass(setup, T0)
    await pass(setup, T0 + 15 * 60_000)
    const [position] = await setup.store.loadPositions()
    expect((await setup.store.fillsFor(position!.id)).map((f) => f.orderId)).toEqual(['Entry'])

    let clock = T0 + HOUR
    const sweep = async (price: number) =>
      sweepStops(
        setup.deps,
        (p) => exitLevelsFor(p, exitSizingFrom(setup.cycleConfig)),
        new AlertThrottle(0),
        (await setup.store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: price })),
        new Map([['solana:NEW', price]]),
        (clock += 30_000),
      )
    // A 2% dip and a bounce: not a step.
    for (const price of [0.98, 0.9996]) await sweep(price)
    expect((await setup.store.fillsFor(position!.id)).map((f) => f.orderId)).toEqual(['Entry'])
    // A 4% dip under the first buy and a 2.1% bounce off it: the second step.
    for (const price of [0.96, 0.96 * 1.021]) await sweep(price)
    expect((await setup.store.fillsFor(position!.id)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('buys nothing on selection with OPERADOR_BUY_ON_SELECTION=0: the first step waits for a dip and a bounce', async () => {
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000', OPERADOR_BUY_ON_SELECTION: '0' })
    const result = await pass(setup, T0)
    expect(result.opened).toHaveLength(1)
    expect(await setup.store.allFills()).toEqual([])
  })

  it('buys nothing on selection when the live price and the candle disagree — the sweep’s own guard', async () => {
    const setup = onMemory({ OPERADOR_CAPITAL_USD: '5000' })
    await pass(setup, T0, { price: 40 })
    expect(await setup.store.allFills()).toEqual([])
  })
})

describe('the book holds capital / $100 tokens and no other ceiling, through the path the engine runs', () => {
  // *No pongas tope, el tope son 5000 dividido 50, que es lo que tengo* — then
  // *disminuí los escalones a 20*, and *en vez de 1 USD que sean 5 por
  // escalón*: capital / $100. And *que de los tokens
  // candidatos elija los que tengan mejor eficiencia de costos*, *que no haya
  // más candidatos de los que el capital pueda tomar*.
  const COMPONENTS = { volumeExpansion: 0, buyPressure: 0, liquidityGrowth: 0, activity: 0, volatility: 0, momentum: 0, headroom: 0, risingHour: 1 }
  const quality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 }
  const candidate = (i: number, costEfficiency: number, score = 50): Candidate => ({
    snapshot: { chain: 'solana', address: `C${i}`, symbol: `C${i}`, pairAddress: `pair-C${i}`, priceUsd: 0.01 } as TokenSnapshot,
    opportunity: { score, components: { ...COMPONENTS, costEfficiency } },
    marketQuality: quality,
  })
  const open = (i: number, over: Partial<PersistedPosition> = {}): PersistedPosition => ({
    ...held, id: `solana:H${i}:1`, tokenAddress: `H${i}`, symbol: `H${i}`, capitalUsd: 100, lastBarTime: 0, openedAt: 0, ...over,
  })

  const cycle = async (options: { readonly capital: string; readonly opened: number; readonly candidates: readonly Candidate[] }) => {
    const { deps, cycleConfig, store } = onMemory({ OPERADOR_CAPITAL_USD: options.capital })
    // Opened this hour: a reservation is not judged before its three hours.
    for (let i = 0; i < options.opened; i++) await store.savePosition(open(i, { openedAt: 10 * 3_600_000 }))
    let asked: number | undefined
    const result = await runCycle(
      {
        ...deps,
        scan: async (_kind, _between, slots) => { asked = slots; return options.candidates },
        candlesFor: async () => null,
        healthFor: async () => null,
        marketPrices: async () => new Map(),
        confirmEntry: async (snapshot) => ({ ok: true, snapshot }),
        now: () => 10 * 3_600_000,
      },
      cycleConfig,
      new AlertThrottle(60_000),
      'full',
    )
    return { result, asked, store }
  }

  it('counts the free slots as capital over $3: $5,000 is 1,666', () => {
    const { cycleConfig: c } = runtime({ OPERADOR_CAPITAL_USD: '5000' })
    expect(freeSlots(bookCapital(c.portfolio.totalCapitalUsd, [], []), c.slotUsd!)).toBe(1666)
    const { cycleConfig } = runtime({ OPERADOR_CAPITAL_USD: '5000', OPERADOR_MAX_STEPS: '50', OPERADOR_STEP_USD: '5', OPERADOR_STEP_GROWTH: '1' })
    expect(freeSlots(bookCapital(cycleConfig.portfolio.totalCapitalUsd, [], []), cycleConfig.slotUsd!)).toBe(20)
  })

  it('opens exactly the free slots — the ones with the best cost efficiency — at $100 each, with 40 of 50 already open', async () => {
    const candidates = Array.from({ length: 150 }, (_, i) => candidate(i, ((i * 37) % 150) / 150, 100 - (i % 7)))
    const { result, asked } = await cycle({ capital: '5000', opened: 40, candidates })
    expect(asked).toBe(10)
    expect(result.opened).toHaveLength(10)
    const best = [...candidates]
      .sort((a, b) => b.opportunity.components.costEfficiency - a.opportunity.components.costEfficiency)
      .slice(0, 10).map((c) => c.snapshot.address).sort()
    expect(result.opened.map((p) => p.tokenAddress).sort()).toEqual(best)
    for (const p of result.opened) expect(p.capitalUsd).toBe(100)
  })

  it('opens all 30 when 50 fit and nothing is open — no ceiling but the capital', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(i, (i % 10) / 10))
    const { result, asked } = await cycle({ capital: '5000', opened: 0, candidates })
    expect(asked).toBe(50)
    expect(result.opened).toHaveLength(30)
  })

  it('tells the scan there is no free slot, and opens nothing, with 50 open', async () => {
    const { result, asked } = await cycle({ capital: '5000', opened: 50, candidates: [candidate(1, 0.9)] })
    expect(asked).toBe(0)
    expect(result.opened).toEqual([])
  })

  it('opens a position that holds nothing when no candle is on record: the first $5 needs a close to check its price against', async () => {
    const { result, store } = await cycle({ capital: '5000', opened: 0, candidates: [candidate(1, 0.9)] })
    expect(result.opened).toHaveLength(1)
    expect(await store.allFills()).toEqual([])
  })

  it('still hands a reservation that never bought to a candidate 10 points of efficiency better', async () => {
    const { deps, cycleConfig, store } = onMemory({ OPERADOR_CAPITAL_USD: '5000' })
    await store.savePosition(open(0))
    const result = await runCycle(
      {
        ...deps,
        scan: async () => [candidate(0, 0.5), candidate(1, 0.7)].map((c, i) => (i === 0 ? { ...c, snapshot: { ...c.snapshot, address: 'H0' } } : c)),
        candlesFor: async () => null,
        healthFor: async () => null,
        marketPrices: async () => new Map(),
        confirmEntry: async (snapshot) => ({ ok: true, snapshot }),
        now: () => 4 * 3_600_000,
      },
      cycleConfig,
      new AlertThrottle(60_000),
      'full',
    )
    expect(result.releasedIds).toEqual(['solana:H0:1'])
    const said = (deps.alerts as RecordingAlerts).sent.find((a) => a.kind === 'token-retired')
    expect(said?.body).toContain('hay un candidato 20 puntos de eficiencia de costos mejor esperando')
  })
})

describe('with no free slot, the scan reads nothing new — through the scan the engine runs', () => {
  it('asks no provider and no registry, and returns no candidate', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => { fetched.push(url); throw new Error('no network in this test') })
    const queries: string[] = []
    const recording: SqlClient = { query: async (sql: string) => { queries.push(sql); return { rows: [] } } }
    const { deps } = buildRuntime(loadConfig({ DATABASE_URL: 'postgres://user:secret@host:5432/db' }), {
      sql: recording,
      postJson: async () => { throw new Error('no network in this test') },
    })
    const found = await deps.scan('full', undefined, 0)
    expect(found).toEqual([])
    expect(fetched).toEqual([])
    expect(queries.some((sql) => sql.includes('solana_cache'))).toBe(false)
  })
})

describe('the fill tape and the book are read ONCE per process, through the path the engine runs', () => {
  // 5156a9b holds up to 250 positions buying up to twenty $1 steps, and the
  // sweep read every held position's fills from Postgres every thirty seconds
  // while the cycle re-read the whole tape about three times a pass — gigabytes
  // a day against a 5 GB monthly allowance. The engine is the only writer of
  // fills, so after start-up the tape answers from memory.
  const BOOK = 40
  const FIRST_BUY = 1_000_000
  // Each holding one $1 step, its watch armed at a 4% dip with the low at 0.96:
  // a live price of 0.98 is the 2% bounce that buys the next step. The capital
  // is the first step and its gas, spent, so the next step's fees come out of
  // the free capital — the funding that reads the whole tape.
  const book: PersistedPosition[] = Array.from({ length: BOOK }, (_, i) => ({
    ...held, id: `solana:T${i}:1`, tokenAddress: `T${i}`, pairAddress: `P${i}`, symbol: `T${i}`, capitalUsd: 1.05,
    dipWatch: { reference: 1, low: 0.96, armed: true, at: FIRST_BUY + 1, holdingSince: FIRST_BUY },
  }))
  const tape = book.map((p) => ({
    idempotency_key: `${p.id}:${FIRST_BUY}:Step-1`, position_id: p.id, order_id: 'Step-1', side: 'buy',
    time: FIRST_BUY, price: '1', qty: '1', cost_usd: '0.05', comment: 'step',
  }))
  const wired = () => {
    const queries: string[] = []
    const sql: SqlClient = {
      query: async <T>(text: string, params: readonly unknown[] = []) => {
        queries.push(text)
        if (/SELECT \* FROM fills WHERE position_id/.test(text)) return { rows: tape.filter((r) => r.position_id === params[0]) as T[] }
        if (/SELECT \* FROM fills/.test(text)) return { rows: tape as T[] }
        return { rows: [] as T[] }
      },
    }
    const { deps, cycleConfig } = buildRuntime(
      loadConfig({ DATABASE_URL: 'postgres://user:secret@host:5432/db', ...LEGACY_LADDER, OPERADOR_CAPITAL_USD: '5000' }),
      { sql, postJson: async () => { throw new Error('no network in this test') } },
    )
    const sweep = (price: number, at: number) =>
      sweepStops(
        { ...deps, alerts: { send: async () => {} } },
        (position) => exitLevelsFor(position, exitSizingFrom(cycleConfig)),
        new AlertThrottle(0), book, new Map(book.map((p) => [`solana:${p.tokenAddress}`, price])), at,
      )
    return {
      deps, sweep,
      /** Every read of the fills table — `allFills`, `fillsFor` and `hasFill` alike. */
      fillReads: () => queries.filter((q) => /\bFROM fills\b/.test(q)).length,
      inserts: () => queries.filter((q) => /INSERT INTO fills/.test(q)).length,
      /** Every read of the positions table. */
      bookReads: () => queries.filter((q) => q.includes('FROM positions')).length,
    }
  }

  it('a quiet sweep over the book reads no fill from the database after start-up', async () => {
    const { deps, sweep, fillReads } = wired()
    await deps.store.allFills()
    expect(fillReads()).toBe(1)

    for (let pass = 1; pass <= 3; pass++) await sweep(1, FIRST_BUY + pass * 30_000)

    expect(fillReads()).toBe(1)
  })

  it('and a sweep that BUYS a step on every position reads none either — the funding, the broker and the check after the buy', async () => {
    const { deps, sweep, fillReads, inserts } = wired()
    await deps.store.allFills()

    await sweep(0.98, FIRST_BUY + 30_000)

    expect(inserts()).toBe(BOOK)
    expect(fillReads()).toBe(1)
    // What it bought is on the tape the next reader sees, without asking.
    expect(await deps.store.allFills()).toHaveLength(2 * BOOK)
    expect(await deps.store.fillsFor(book[0]!.id)).toHaveLength(2)
    expect(fillReads()).toBe(1)
  })

  it('reads the book from the database once, however many sweeps and passes ask for it', async () => {
    // *Sólo los datos que nos sirvan, que no pesen nada.* The sweep asked for
    // the whole book every thirty seconds and the pass six to eight times more.
    const { deps, bookReads } = wired()
    for (let i = 0; i < 5; i++) await deps.store.loadPositions()
    await deps.store.savePosition(book[0]!)
    expect((await deps.store.loadPositions()).map((p) => p.id)).toEqual([book[0]!.id])
    expect(bookReads()).toBe(1)
  })
})
