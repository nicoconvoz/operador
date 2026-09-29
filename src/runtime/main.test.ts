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

const held: PersistedPosition = {
  id: 'solana:T:1', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1_000_000, 0),
  quality: { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 },
  capitalUsd: 15.89, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
}

describe('abandonment freezes at TWO hours, through the path the engine runs', () => {
  // *Las que no tengan barras en 2h, congelarlas y recuperar el dinero.* A
  // freeze with `exitOnFreeze` on sells the position and the release bans it.
  const quiet = (hoursSinceLastTrade: number) => ({
    observedAt: 0, source: 'test', sellQuote: 'ok' as const, liquidityUsd: 1_000_000, lpStatus: 'locked' as const,
    mintAuthorityActive: false, freezeAuthorityActive: false, safetyFailed: [], transfersBlocked: false,
    topHolderMovedPct: null, hoursSinceLastTrade,
  })

  it('freezes a position whose token has not traded for two hours', () => {
    const policy = tickConfigFrom(runtime().cycleConfig).deathPolicy!
    expect(policy.abandonmentFreezeHours).toBe(2)
    expect(assessAssetHealth(startDeathWatch(1_000_000, 0), policy, quiet(1.9)).state.stage).toBe('healthy')
    expect(assessAssetHealth(startDeathWatch(1_000_000, 0), policy, quiet(2)).state.stage).toBe('frozen')
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
  it('is ON when nothing is set, with the operator’s staircase', () => {
    const { cycleConfig } = runtime()
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).gainLock).toEqual({ startPct: 20, stepPct: 20, firstFloorPct: 10, floorStepPct: 10 })
  })

  it('is OFF through every path when the environment switches it off', () => {
    const { cycleConfig } = runtime({ OPERADOR_GAIN_LOCK: '0' })
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).gainLock).toBeNull()
  })
})

describe('the take-profit waits for +10%, through the path the engine runs', () => {
  // *Bajalas a 10.* The strategy's own exit still sells when the impulse
  // dies — only never under +10% over the average cost.
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

  it('asks the exit for at least +10% when nothing is set', async () => {
    expect((await tick()).minProfitPct).toBe(10)
  })

  it('takes another floor from the environment', async () => {
    expect((await tick({ OPERADOR_MIN_PROFIT_PCT: '20' })).minProfitPct).toBe(20)
  })
})

describe('the ladder, the reservation and the ban, as wired', () => {
  it('buys ladder A: five rungs of $15..$35 at −10..−30% of the first buy, each funded from the free capital', () => {
    // *Arriesguémonos, activá la A.*
    const { deps, cycleConfig } = runtime()
    expect(deps.dropLadder?.policy).toEqual({ maxEntries: 6, dropsPct: [10, 15, 20, 25, 30], from: 'previous' })
    expect(deps.dropLadder?.rungsUsd).toEqual([15, 20, 25, 30, 35])
    expect(deps.dropLadder?.fund).toBeDefined()
    expect(cycleConfig.maxOpenEntries).toBe(6)
  })

  it('reserves one entry a slot, and the slot is exactly what one $10 buy needs', () => {
    const { cycleConfig } = runtime()
    expect(cycleConfig.reservedEntries).toBe(1)
    expect(cycleConfig.params.maxUsdPerLevel).toBe(10)
    expect(cycleConfig.usdPerToken).toBeCloseTo(ladderCapitalUsd({ ...DEFAULT_PARAMS, maxUsdPerLevel: 10 }, 1, 0.05), 9)
  })

  it('buys exactly ten dollars on the first tick of a slot the allocator sized', async () => {
    // The path the engine runs: the cycle's own tick rules, a slot of
    // `usdPerToken`, the broker `brokerFor` builds. Flat candles are enough —
    // production enters on selection, with no indicator condition.
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
    const entry = result.orders.find((o) => o.kind === 'entry')
    expect(entry && entry.kind === 'entry' ? entry.usd : 0).toBeCloseTo(10, 6)
  })

  it('funds a rung at its own size: all six entries of ladder A cost $135 grossed up', async () => {
    const { deps, cycleConfig } = runtime()
    const funded = await deps.dropLadder!.fund!({ ...held, capitalUsd: cycleConfig.usdPerToken! }, 6)
    expect(funded?.capitalUsd).toBeCloseTo(capitalForFillsUsd([10, 15, 20, 25, 30, 35], 0.05), 9)
  })

  it('builds a broker that holds six entries — the first buy and five rungs — and refuses a seventh', async () => {
    const { deps } = runtime()
    const broker = await deps.brokerFor({ ...held, capitalUsd: 200 })
    const entries = Array.from({ length: 7 }, (_, i) => ({ kind: 'entry' as const, id: i === 0 ? 'Entry' : `DCA-${i}`, level: i, usd: 10, qty: 10, comment: 'x' }))
    expect(broker.execute(entries, 1, 0)).toHaveLength(6)
  })

  it('blacklists a frozen token on release unless told not to', () => {
    expect(runtime().cycleConfig.blacklistOnFreeze).toBe(true)
    expect(runtime({ OPERADOR_BLACKLIST_ON_FREEZE: '0' }).cycleConfig.blacklistOnFreeze).toBe(false)
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

  it('is ON when nothing is set: DCA-1 of a wild token at −5.3%', async () => {
    expect(runtime().deps.dropLadder?.adaptive).toBe(true)
    expect(await sweepAt({}, 0.947)).toEqual(['Entry', 'DCA-1'])
  })

  it('measures the scale over 15-minute bars: the tick is told the bar the engine trades', () => {
    // The day before the first buy counts only the bars that had CLOSED by
    // then, and which ones those are depends on how long a bar lasts.
    expect(tickConfigFrom(runtime().cycleConfig).barMs).toBe(15 * 60_000)
  })

  it('is OFF with OPERADOR_DCA_ADAPTIVE=0: the same token waits for the base −10%', async () => {
    expect(runtime({ OPERADOR_DCA_ADAPTIVE: '0' }).deps.dropLadder?.adaptive).toBe(false)
    expect(await sweepAt({ OPERADOR_DCA_ADAPTIVE: '0' }, 0.947)).toEqual(['Entry'])
    expect(await sweepAt({ OPERADOR_DCA_ADAPTIVE: '0' }, 0.899)).toEqual(['Entry', 'DCA-1'])
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

  it('is ON when nothing is set: the wild hour holds DCA-1 back, and asks Jupiter for 5-minute bars by mint', async () => {
    expect(runtime().deps.dropLadder?.recentVolatility).toBeDefined()
    const { buys, after } = await sweepAt({}, 0.9)
    expect(buys).toEqual(['Entry'])
    expect(asked.some((url) => url.includes('/v2/charts/T?interval=5_MINUTE'))).toBe(true)
    // Written down for the screen: sqrt(ln(1.2)×100 / 2.17) ≈ 2.9.
    expect(after.dcaScaleNow).toBeCloseTo(Math.sqrt((Math.log(1.2) * 100) / 2.17), 9)
  })

  it('is OFF with OPERADOR_DCA_REALTIME=0: the same token buys on the scale measured at the buy', async () => {
    expect(runtime({ OPERADOR_DCA_REALTIME: '0' }).deps.dropLadder?.recentVolatility).toBeUndefined()
    const { buys } = await sweepAt({ OPERADOR_DCA_REALTIME: '0' }, 0.9)
    expect(buys).toEqual(['Entry', 'DCA-1'])
    expect(barsAsked()).toEqual([])
  })

  it('scales nothing with OPERADOR_DCA_ADAPTIVE=0, real time included: the base −10%, and no hour asked', async () => {
    // Neither the −5.2% measured at the buy nor the −29% of the wild hour.
    expect((await sweepAt({ OPERADOR_DCA_ADAPTIVE: '0' }, 0.93)).buys).toEqual(['Entry'])
    expect((await sweepAt({ OPERADOR_DCA_ADAPTIVE: '0' }, 0.899)).buys).toEqual(['Entry', 'DCA-1'])
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

  const book = async (env: Record<string, string> = {}) => {
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

  it('is ON at 5% when nothing is set: a pool down 8% in the hour holds DCA-1 back at its line', async () => {
    expect(runtime().deps.dropLadder?.liquidityBrakePct).toBe(5)
    expect(runtime().deps.dropLadder?.liquidityChange).toBeDefined()
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
    expect(runtime({ OPERADOR_LIQUIDITY_BRAKE_PCT: '0' }).deps.dropLadder?.liquidityBrakePct).toBe(0)
    const { sweep, buys } = await book({ OPERADOR_LIQUIDITY_BRAKE_PCT: '0' })
    await sweep(0.899)
    expect(await buys()).toEqual(['Entry', 'DCA-1'])
    expect(searched).toEqual([])
  })
})
