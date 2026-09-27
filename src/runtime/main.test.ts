import { describe, it, expect } from 'vitest'
import { buildRuntime } from './main.js'
import { loadConfig } from './config.js'
import { exitLevelsFor } from '../application/stop-sweep.js'
import { exitSizingFrom, tickConfigFrom } from '../application/orchestrator.js'
import { capitalForFillsUsd, ladderCapitalUsd } from '../application/paper-run.js'
import { tickPosition } from '../application/engine.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { type Candles } from '../application/replay.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
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
 */
const quiet: SqlClient = { query: async () => ({ rows: [] }) }
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

describe('the take-profit waits for +20%, through the path the engine runs', () => {
  // *Poné un mínimo de ganancia del 20%.* The strategy's own exit still sells
  // when the impulse dies — only never under +20% over the average cost.
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

  it('asks the exit for at least +20% when nothing is set', async () => {
    expect((await tick()).minProfitPct).toBe(20)
  })

  it('takes another floor from the environment', async () => {
    expect((await tick({ OPERADOR_MIN_PROFIT_PCT: '12' })).minProfitPct).toBe(12)
  })
})

describe('the ladder, the reservation and the ban, as wired', () => {
  it('buys ladder A: five rungs of $15..$35 at −10..−30% of the first buy, each funded from the free capital', () => {
    // *Arriesguémonos, activá la A.*
    const { deps, cycleConfig } = runtime()
    expect(deps.dropLadder?.policy).toEqual({ maxEntries: 6, dropsPct: [10, 15, 20, 25, 30] })
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
