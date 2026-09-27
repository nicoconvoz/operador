import { describe, it, expect } from 'vitest'
import { buildRuntime } from './main.js'
import { loadConfig } from './config.js'
import { exitLevelsFor } from '../application/stop-sweep.js'
import { exitSizingFrom } from '../application/orchestrator.js'
import { ladderCapitalUsd } from '../application/paper-run.js'
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

describe('the break-even at 7.5, through the path the engine runs', () => {
  // *Poné el break-even en 7.5.* Arms at +7.5% over the average cost; once
  // armed, sells on a fall back to +7.5%. The cycle's sweeps and the loop's
  // both read `exitLevelsFor(position, exitSizingFrom(cycleConfig))`.
  it('is ON with both lines at 7.5 when nothing is set', () => {
    const { cycleConfig } = runtime()
    const levels = exitLevelsFor(held, exitSizingFrom(cycleConfig))
    expect(levels.armAtPct).toBe(7.5)
    expect(levels.breakEvenPct).toBe(7.5)
  })

  it('stays OFF through every path when the environment turns it off', () => {
    const { cycleConfig } = runtime({ OPERADOR_BREAK_EVEN: '0' })
    expect(cycleConfig.breakEven).toBe(false)
    expect(exitLevelsFor(held, exitSizingFrom(cycleConfig)).armAtPct).toBeNull()
  })
})

describe('the ladder, the reservation and the ban, as wired', () => {
  it('buys three rungs at −10, −20, −30% of the first buy, each funded from the free capital', () => {
    const { deps, cycleConfig } = runtime()
    expect(deps.dropLadder?.policy).toEqual({ maxEntries: 4, dropsPct: [10, 20, 30] })
    expect(deps.dropLadder?.rungUsd).toBe(15)
    expect(deps.dropLadder?.fund).toBeDefined()
    expect(cycleConfig.maxOpenEntries).toBe(4)
  })

  it('reserves one entry a slot, and the slot is exactly what one $15 buy needs', () => {
    const { cycleConfig } = runtime()
    expect(cycleConfig.reservedEntries).toBe(1)
    expect(cycleConfig.usdPerToken).toBeCloseTo(ladderCapitalUsd({ ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }, 1, 0.05), 9)
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
