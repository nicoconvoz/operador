import { describe, it, expect } from 'vitest'
import {
  liquidityBrakes,
  nextLiquidityWatch,
  liquidityWatchMoved,
  keepLiquidityWatch,
  DEFAULT_LIQUIDITY_BRAKE_PCT,
  DEFAULT_LIQUIDITY_WATCH_POLICY,
  type LiquidityReading,
  type LiquidityWatch,
} from './liquidity-brake.js'

/**
 * *Freno en tiempo real por cambio de liquidez inmediata que supere el 5%* —
 * then *5 minutos o 1 hora.* The operator, the day PAID froze with its pool at
 * 41% of its entry liquidity after the ladder had bought DCA-2 and DCA-3 into it.
 */
describe('liquidityBrakes — a pool draining right now holds the next rung back', () => {
  it('is five percent by default', () => {
    expect(DEFAULT_LIQUIDITY_BRAKE_PCT).toBe(5)
  })

  it('brakes on the hour: −5.1% in the last hour', () => {
    expect(liquidityBrakes({ m5: 0, h1: -5.1 }, 5)).toBe(true)
  })

  it('does not brake at −4.9% — the line is five', () => {
    expect(liquidityBrakes({ m5: -4.9, h1: -4.9 }, 5)).toBe(false)
  })

  it('brakes on the five minutes alone, with the hour flat', () => {
    expect(liquidityBrakes({ m5: -6, h1: 0 }, 5)).toBe(true)
  })

  it('brakes at exactly the threshold', () => {
    expect(liquidityBrakes({ m5: null, h1: -5 }, 5)).toBe(true)
  })

  it('never brakes on a pool that GREW, however much', () => {
    expect(liquidityBrakes({ m5: 40, h1: 300 }, 5)).toBe(false)
  })

  it('never brakes on silence — an unreported window, or no answer at all', () => {
    // CAKE lost 19% in an hour while never more than 5% in any five minutes:
    // the hour alone must be able to brake, and a missing five minutes must not
    // stop it. But a window nobody reported is not a drain.
    expect(liquidityBrakes({ m5: null, h1: null }, 5)).toBe(false)
    expect(liquidityBrakes({ m5: null, h1: -19.3 }, 5)).toBe(true)
    expect(liquidityBrakes(null, 5)).toBe(false)
    expect(liquidityBrakes({ m5: Number.NaN, h1: Number.NEGATIVE_INFINITY }, 5)).toBe(false)
  })

  it('never brakes with the switch off', () => {
    expect(liquidityBrakes({ m5: -50, h1: -90 }, 0)).toBe(false)
  })
})

describe('nextLiquidityWatch — braked on a drain, and a rung bought on the bounce', () => {
  // *Si la liquidez cayó y luego desde el punto más bajo la liquidez aumenta un
  // 5%, activar la compra del escalón si está en negativo todavía… pero siempre
  // esperar la recuperación del 5% de liquidez a partir del mínimo.* The operator
  // — and then *lo del 15 era un ejemplo*: every recovery buys, whatever the
  // depth. Whether the position is still at a loss is the sweep's question.
  const policy = DEFAULT_LIQUIDITY_WATCH_POLICY
  const HOLDING = 1_000
  const flat = (usd: number): LiquidityReading => ({ usd, m5: 0, h1: 0 })
  /** Folds readings one sweep a minute apart, returning every step. */
  const walk = (readings: (LiquidityReading | null)[], start: LiquidityWatch | null = null) => {
    let watch = start
    const steps = readings.map((reading, i) => {
      const step = nextLiquidityWatch(watch, reading, policy, { since: HOLDING, at: 60_000 * (i + 1) })
      watch = step.watch
      return step
    })
    return { watch, steps, actions: steps.map((s) => s.action) }
  }

  it('is five down to brake and five up to buy', () => {
    expect(policy).toEqual({ brakePct: 5, recoverPct: 5 })
  })

  it('brakes when the pool drains, waits out the low, and buys on the first 5% off the minimum', () => {
    const { actions, steps, watch } = walk([
      flat(100_000),
      { usd: 84_000, m5: -2, h1: -8 },
      { usd: 82_000, m5: -1, h1: -10 },
      { usd: 86_000, m5: 4, h1: -9 }, // +4.9% off the low: still braked
      { usd: 86_200, m5: 5, h1: -9 }, // +5.1%: the bounce
    ])
    expect(actions).toEqual(['none', 'brake', 'none', 'none', 'buy'])
    expect(steps[2]!.watch).toMatchObject({ peakUsd: 100_000, minUsd: 82_000, braked: true })
    expect(steps[3]!.watch!.braked).toBe(true)
    // Said in the alert: it had fallen 18% from its peak before it bounced.
    expect(steps[4]!.fellPct).toBeCloseTo(18, 9)
    expect(watch).toEqual({ peakUsd: 86_200, minUsd: 86_200, braked: false, holdingSince: HOLDING, at: 300_000 })
  })

  it('buys on the bounce whatever the depth — a 10% fall recovering 5% buys too', () => {
    const { actions, steps } = walk([flat(100_000), { usd: 90_000, m5: -1, h1: -10 }, { usd: 94_500, m5: 5, h1: -6 }])
    expect(actions).toEqual(['none', 'brake', 'buy'])
    expect(steps[2]!.fellPct).toBeCloseTo(10, 9)
  })

  it('stays braked however deep the fall goes, until the bounce', () => {
    const { actions } = walk([
      flat(100_000), { usd: 94_000, m5: -6, h1: -6 },
      { usd: 70_000, m5: -9, h1: -30 }, { usd: 50_000, m5: -9, h1: -50 }, { usd: 52_000, m5: 4, h1: -48 },
    ])
    expect(actions).toEqual(['none', 'brake', 'none', 'none', 'none'])
  })

  it('does not brake again on the hour it already answered — only on a NEW 5% fall from the bounce', () => {
    // Jupiter's hour lags: minutes after the bounce it still reads the drain.
    // Braking on it again would hold every rung until another 5% bounce that a
    // pool gone flat never gives.
    const bounced = walk([flat(100_000), { usd: 90_000, m5: -1, h1: -10 }, { usd: 94_500, m5: 5, h1: -6 }]).watch
    const after = walk([{ usd: 94_000, m5: 0, h1: -7 }, { usd: 89_700, m5: -2, h1: -9 }], bounced)
    expect(after.actions).toEqual(['none', 'brake'])
  })

  it('brakes on the very first look at a pool already draining — the hour says where it was', () => {
    const { actions, watch } = walk([{ usd: 92_000, m5: -1, h1: -8 }])
    expect(actions).toEqual(['brake'])
    expect(watch!.peakUsd).toBeCloseTo(100_000, 6)
    expect(watch!.minUsd).toBe(92_000)
  })

  it('brakes at exactly five on a first look, whatever the floating point makes of it', () => {
    expect(walk([{ usd: 95_000, m5: 0, h1: -5 }]).actions).toEqual(['brake'])
  })

  it('tracks the peak while nothing brakes', () => {
    const { actions, watch } = walk([flat(100_000), flat(120_000), { usd: 115_000, m5: -1, h1: 2 }])
    expect(actions).toEqual(['none', 'none', 'none'])
    expect(watch).toMatchObject({ peakUsd: 120_000, braked: false })
  })

  it('never brakes on a slow bleed the windows do not see', () => {
    // *Cambio de liquidez inmediata.* Twenty percent over a day, never 5% in
    // an hour, is not what the brake is for.
    const { actions } = walk([flat(100_000), { usd: 90_000, m5: -0.5, h1: -4 }, { usd: 80_000, m5: -0.5, h1: -4.9 }])
    expect(actions).toEqual(['none', 'none', 'none'])
  })

  it('changes nothing on an unknown reading — silence is not evidence', () => {
    const braked = walk([flat(100_000), { usd: 90_000, m5: -1, h1: -10 }]).watch!
    const silences: (LiquidityReading | null)[] = [null, { usd: null, m5: -9, h1: -9 }, { usd: 0, m5: 0, h1: 0 }, { usd: Number.NaN, m5: 0, h1: 0 }]
    for (const silent of silences) {
      expect(nextLiquidityWatch(braked, silent, policy, { since: HOLDING, at: 999_000 })).toEqual({ watch: braked, action: 'none', fellPct: null })
    }
    expect(nextLiquidityWatch(null, null, policy, { since: HOLDING, at: 1 })).toEqual({ watch: null, action: 'none', fellPct: null })
  })

  it('starts a fresh watch for a new holding, whatever the old one said', () => {
    const old = walk([flat(100_000), { usd: 90_000, m5: -1, h1: -10 }]).watch!
    const step = nextLiquidityWatch(old, flat(95_000), policy, { since: HOLDING + 5, at: 999_000 })
    expect(step.action).toBe('none')
    expect(step.watch).toEqual({ peakUsd: 95_000, minUsd: 95_000, braked: false, holdingSince: HOLDING + 5, at: 999_000 })
    // And a new holding's silence does not inherit the old holding's brake.
    expect(nextLiquidityWatch(old, null, policy, { since: HOLDING + 5, at: 999_000 }).watch).toBeNull()
  })
})

describe('liquidityWatchMoved — written when it matters, not every minute', () => {
  // Every write is the whole position row, and the free tier's real limit is
  // NETWORK: a write per position per minute is fifty thousand rows a day.
  const base: LiquidityWatch = { peakUsd: 100_000, minUsd: 100_000, braked: false, holdingSince: 1, at: 1 }

  it('writes a first watch, a new holding, and every change of the brake', () => {
    expect(liquidityWatchMoved(null, base)).toBe(true)
    expect(liquidityWatchMoved(undefined, base)).toBe(true)
    expect(liquidityWatchMoved(base, { ...base, holdingSince: 2 })).toBe(true)
    expect(liquidityWatchMoved(base, { ...base, braked: true })).toBe(true)
    expect(liquidityWatchMoved({ ...base, braked: true }, base)).toBe(true)
  })

  it('writes a peak that rose 1% or more, and not the ones under it', () => {
    expect(liquidityWatchMoved(base, { ...base, peakUsd: 100_900, at: 9 })).toBe(false)
    expect(liquidityWatchMoved(base, { ...base, peakUsd: 101_000, at: 9 })).toBe(true)
  })

  it('writes a braked minimum that fell 1% or more — and ignores the minimum of an unbraked watch', () => {
    const braked = { ...base, braked: true, minUsd: 90_000 }
    expect(liquidityWatchMoved(braked, { ...braked, minUsd: 89_200, at: 9 })).toBe(false)
    expect(liquidityWatchMoved(braked, { ...braked, minUsd: 89_100, at: 9 })).toBe(true)
    expect(liquidityWatchMoved(base, { ...base, minUsd: 80_000, at: 9 })).toBe(false)
  })

  it('never writes for the clock alone', () => {
    expect(liquidityWatchMoved(base, { ...base, at: 99 })).toBe(false)
  })
})

describe('keepLiquidityWatch — the newer watch wins, and a stale snapshot never reverts it', () => {
  const watch = (at: number, braked = false): LiquidityWatch => ({ peakUsd: 1, minUsd: 1, braked, holdingSince: 1, at })

  it('keeps the one with the later time', () => {
    expect(keepLiquidityWatch(watch(1), watch(2, true))).toEqual(watch(2, true))
    expect(keepLiquidityWatch(watch(2, true), watch(1))).toEqual(watch(2, true))
  })

  it('keeps what is stored against a write carrying none', () => {
    expect(keepLiquidityWatch(watch(2, true), null)).toEqual(watch(2, true))
    expect(keepLiquidityWatch(watch(2, true), undefined)).toEqual(watch(2, true))
    expect(keepLiquidityWatch(undefined, watch(1))).toEqual(watch(1))
    expect(keepLiquidityWatch(null, null)).toBeNull()
  })
})
