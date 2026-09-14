import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DEATH_EXIT_POLICY as P,
  applyDeathVerdict,
  assessAssetHealth,
  evaluateSignals,
  startDeathWatch,
  type AssetHealthObservation,
  type DeathWatchState,
} from './death-exit.js'
import { type Order } from '../strategy/state.js'

const ENTRY_LIQ = 100_000

const healthy = (over: Partial<AssetHealthObservation> = {}): AssetHealthObservation => ({
  observedAt: 0,
  source: 'test-monitor',
  sellQuote: 'ok',
  liquidityUsd: ENTRY_LIQ,
  lpStatus: 'burned',
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  transfersBlocked: false,
  topHolderMovedPct: 0,
  hoursSinceLastTrade: 0,
  ...over,
})

/** Feed a sequence of observations, returning every verdict and the final state. */
const run = (observations: AssetHealthObservation[], start = startDeathWatch(ENTRY_LIQ, 0)) => {
  const verdicts: string[] = []
  let state: DeathWatchState = start
  observations.forEach((obs, i) => {
    const out = assessAssetHealth(state, P, { ...obs, observedAt: i })
    verdicts.push(out.verdict)
    state = out.state
  })
  return { verdicts, state }
}

describe('death exit — the guardrail', () => {
  it('an observation cannot carry a price, even by accident', () => {
    // @ts-expect-error price is not a health signal — this must not compile
    const smuggled: AssetHealthObservation = { ...healthy(), price: 0.001 }
    // @ts-expect-error nor can drawdown
    const smuggled2: AssetHealthObservation = { ...healthy(), drawdownPct: -80 }
    expect(smuggled).toBeDefined()
    expect(smuggled2).toBeDefined()
  })

  it('a healthy observation produces no signal, no verdict and no evidence', () => {
    const { verdicts, state } = run([healthy()])
    expect(verdicts).toEqual(['none'])
    expect(state.stage).toBe('healthy')
    expect(state.evidence).toEqual([])
  })
})

describe('death exit — stage 1, freeze on suspicion', () => {
  it('freezes on a single observation when liquidity halves', () => {
    const { verdicts, state } = run([healthy({ liquidityUsd: ENTRY_LIQ * 0.4 })])
    expect(verdicts).toEqual(['freeze'])
    expect(state.stage).toBe('frozen')
    expect(state.evidence[0]!.signals).toEqual([
      expect.objectContaining({ kind: 'liquidityCollapse', stage: 1 }),
    ])
  })

  it('freezes on a top-holder dump', () => {
    expect(run([healthy({ topHolderMovedPct: 15 })]).verdicts).toEqual(['freeze'])
  })

  it('freezes after abandonment_freeze_hours without a trade', () => {
    expect(run([healthy({ hoursSinceLastTrade: 8 })]).verdicts).toEqual(['freeze'])
  })

  it('stage-1 evidence never accumulates into an exit, however long it persists', () => {
    const dump = Array.from({ length: 20 }, () => healthy({ topHolderMovedPct: 50 }))
    const { verdicts, state } = run(dump)
    expect(verdicts).not.toContain('exit')
    expect(state.stage).toBe('frozen')
  })
})

describe('death exit — stage 2, exit on confirmation', () => {
  it('a broken sell path on 3 consecutive observations kills the watch', () => {
    const { verdicts, state } = run([
      healthy({ sellQuote: 'failed' }),
      healthy({ sellQuote: 'failed' }),
      healthy({ sellQuote: 'failed' }),
    ])
    expect(verdicts).toEqual(['freeze', 'none', 'exit'])
    expect(state.stage).toBe('dead')
  })

  it('a single broken quote freezes but does not kill — one RPC is not proof', () => {
    const { verdicts, state } = run([healthy({ sellQuote: 'failed' })])
    expect(verdicts).toEqual(['freeze'])
    expect(state.stage).toBe('frozen')
    expect(state.exitEvidence).toBe(1)
  })

  it('a positive sell quote between failures resets the exit evidence', () => {
    const { state } = run([
      healthy({ sellQuote: 'failed' }),
      healthy({ sellQuote: 'failed' }),
      healthy(),
      healthy({ sellQuote: 'failed' }),
    ])
    expect(state.stage).toBe('frozen')
    expect(state.exitEvidence).toBe(1)
  })

  it('LP removal, reinstated authorities, blocked transfers and long abandonment are all exit evidence', () => {
    const cases: Partial<AssetHealthObservation>[] = [
      { lpStatus: 'removed' },
      { lpStatus: 'unlocked' },
      { mintAuthorityActive: true },
      { freezeAuthorityActive: true },
      { transfersBlocked: true },
      { hoursSinceLastTrade: 30 },
      { liquidityUsd: ENTRY_LIQ * 0.1 },
      { liquidityUsd: P.liquidityFloorUsd - 1 },
    ]
    for (const c of cases) {
      const { verdicts } = run([healthy(c), healthy(c), healthy(c)])
      expect(verdicts, JSON.stringify(c)).toEqual(['freeze', 'none', 'exit'])
    }
  })

  it('mixed stage-2 signals still count as consecutive evidence', () => {
    const { verdicts } = run([
      healthy({ sellQuote: 'implausible' }),
      healthy({ lpStatus: 'removed' }),
      healthy({ transfersBlocked: true }),
    ])
    expect(verdicts.at(-1)).toBe('exit')
  })

  it('dead is terminal: clean observations never resurrect it', () => {
    const dead = run([healthy({ sellQuote: 'failed' }), healthy({ sellQuote: 'failed' }), healthy({ sellQuote: 'failed' })]).state
    const after = run(Array.from({ length: 50 }, () => healthy()), dead)
    expect(after.verdicts.every((v) => v === 'none')).toBe(true)
    expect(after.state.stage).toBe('dead')
  })
})

describe('death exit — clearing and inconclusive data', () => {
  it('lifts a freeze after clear_observations consecutive clean looks', () => {
    const { verdicts, state } = run([
      healthy({ liquidityUsd: ENTRY_LIQ * 0.4 }),
      ...Array.from({ length: P.clearObservations }, () => healthy()),
    ])
    expect(verdicts.at(-1)).toBe('resume')
    expect(state.stage).toBe('healthy')
    expect(verdicts.slice(1, -1).every((v) => v === 'none')).toBe(true)
  })

  it('an unknown sell quote is inconclusive: it neither confirms nor clears', () => {
    const frozen = run([healthy({ sellQuote: 'failed' }), healthy({ sellQuote: 'failed' })]).state
    const { verdicts, state } = run(Array.from({ length: 10 }, () => healthy({ sellQuote: 'unknown' })), frozen)
    expect(verdicts.every((v) => v === 'none')).toBe(true)
    expect(state.stage).toBe('frozen')
    expect(state.exitEvidence).toBe(2)
    expect(state.cleanStreak).toBe(0)
  })

  it('null readings are not signals', () => {
    const blind = healthy({ liquidityUsd: null, lpStatus: 'unknown', mintAuthorityActive: null, topHolderMovedPct: null, hoursSinceLastTrade: null })
    expect(evaluateSignals(blind, startDeathWatch(ENTRY_LIQ, 0), P)).toEqual([])
  })
})

describe('death exit — evidence chain', () => {
  it('records source, signals, resulting stage and verdict for every consequential observation', () => {
    const { state } = run([
      healthy({ source: 'helius', sellQuote: 'failed' }),
      healthy({ source: 'jupiter', sellQuote: 'failed' }),
      healthy({ source: 'helius', sellQuote: 'failed' }),
    ])
    expect(state.evidence.map((e) => [e.source, e.signals[0]!.kind, e.stageAfter, e.verdict])).toEqual([
      ['helius', 'sellPathBroken', 'frozen', 'freeze'],
      ['jupiter', 'sellPathBroken', 'frozen', 'none'],
      ['helius', 'sellPathBroken', 'dead', 'exit'],
    ])
  })
})

describe('death exit — what the executor does with the strategy orders', () => {
  const entry: Order = { kind: 'entry', id: 'DCA-3', level: 3, usd: 4600, qty: 1, comment: 'DCA-3' }
  const exit: Order = { kind: 'closeAll', comment: '🏁 Exit' }

  it('healthy: orders pass through', () => {
    expect(applyDeathVerdict([entry, exit], 'healthy', true)).toEqual([entry, exit])
  })

  it('frozen: entries are dropped, the strategy exit still passes', () => {
    expect(applyDeathVerdict([entry, exit], 'frozen', true)).toEqual([exit])
    expect(applyDeathVerdict([entry], 'frozen', true)).toEqual([])
  })

  it('dead in position: the only order is the death exit, whatever the strategy said', () => {
    expect(applyDeathVerdict([entry], 'dead', true)).toEqual([{ kind: 'closeAll', comment: '☠️ Death Exit' }])
    expect(applyDeathVerdict([exit], 'dead', true)).toEqual([{ kind: 'closeAll', comment: '☠️ Death Exit' }])
    expect(applyDeathVerdict([], 'dead', true)).toEqual([{ kind: 'closeAll', comment: '☠️ Death Exit' }])
  })

  it('dead and flat: never enters again', () => {
    expect(applyDeathVerdict([entry], 'dead', false)).toEqual([])
  })
})

describe('death exit — policy sanity', () => {
  it('freeze fires on one look; exit needs at least two', () => {
    expect(P.exitConfirmations).toBeGreaterThanOrEqual(2)
  })
  it('exit thresholds are strictly worse than freeze thresholds', () => {
    expect(P.liquidityExitRatio).toBeLessThan(P.liquidityFreezeRatio)
    expect(P.abandonmentExitHours).toBeGreaterThan(P.abandonmentFreezeHours)
  })
})
