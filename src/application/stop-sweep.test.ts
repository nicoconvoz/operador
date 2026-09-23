import { describe, it, expect } from 'vitest'
import { exitLevelsFor, type ExitSizing } from './stop-sweep.js'
import { exitSizingFrom } from './orchestrator.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { FLAT_ONE_PCT_STOP } from '../domain/risk/stop-loss.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * *El operador pierde de a mucho, no funciona el SL.*
 *
 * It worked, and it was sized from the wrong number. The sweep's own alerts
 * printed the stop it had derived: fomopay cut at −50.7% with **24%**, Stamp
 * with **15%**. The rule was meant to land near 9%.
 *
 * Two defects compounding. The toll was computed from the impact of a $100
 * quote applied to a $15 fill — six and a half times too big on the impact
 * term, where the paper broker had always scaled it — and the 1:4 derivation
 * multiplies the toll by about seven, with nothing to stop it.
 *
 * | pool | stop before | after the toll fix |
 * |---|---|---|
 * | deep (0.05% @ $100) | 9.0% | 8.4% |
 * | fomopay (1.1%) | **24.0%** | 10.7% |
 * | thin (3%) | **51.0%** | 14.7% |
 * | high fee (1% spread) | 26.1% | 20.1% |
 *
 * The first row is the proof the diagnosis is right rather than plausible:
 * the old arithmetic reproduces the 24% the sweep printed, to the decimal.
 */

const quality = (spreadPct: number, slippagePct: number): MarketQuality => ({
  liquidityUsd: 100_000, spreadPct, slippagePct, referenceUsd: 100, observedAt: 0,
})

const position = (q: MarketQuality): PersistedPosition => ({
  id: 'p', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality: q, capitalUsd: 15,
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
})

const sizing: ExitSizing = {
  stop: FLAT_ONE_PCT_STOP,
  rewardRiskRatio: 4,
  maxCostSharePct: 33,
  gasUsdPerSwap: 0.05,
  floorPct: 2,
  breakEven: true,
  maxStopPct: 10,
}

describe('exitLevelsFor — the stop is sized from the toll the broker actually charges', () => {
  it('lands fomopay near ten percent, not the twenty-four it was cut with', () => {
    const { stop } = exitLevelsFor(position(quality(0.25, 1.1)), { ...sizing, maxStopPct: undefined })
    expect(stop.minStopPct).toBeCloseTo(10.66, 1)
  })

  it('leaves an ordinary deep pool where the operator put it', () => {
    // The ceiling is for runaways. On the pool the 1:4 was calibrated on it
    // must not bind, or the rule would have quietly stopped being 1:4.
    const { stop } = exitLevelsFor(position(quality(0.25, 0.05)), sizing)
    expect(stop.minStopPct).toBeCloseTo(8.41, 1)
    expect(stop.minStopPct).toBeLessThan(sizing.maxStopPct!)
  })
})

describe('exitLevelsFor — a CEILING, because the ratio has none of its own', () => {
  // Even with the toll right, a thin pool derives 14.7% and a high-fee one
  // 20.1%. The formula is honest about the pool; it is not what the operator
  // asked for. *No quiero quedarme con ninguna posición que baje eso.*

  it('caps a thin pool at the ceiling', () => {
    const { stop } = exitLevelsFor(position(quality(0.25, 3)), sizing)
    expect(stop.minStopPct).toBe(10)
    expect(stop.maxStopPct).toBe(10)
  })

  it('caps a high-fee pool at the ceiling', () => {
    const { stop } = exitLevelsFor(position(quality(1, 0.5)), sizing)
    expect(stop.minStopPct).toBe(10)
  })

  it('has no ceiling when none is configured, rather than inventing one', () => {
    const { stop } = exitLevelsFor(position(quality(0.25, 3)), { ...sizing, maxStopPct: undefined })
    expect(stop.minStopPct).toBeGreaterThan(14)
  })
})

describe('exitLevelsFor — the ratchet reads the same corrected toll', () => {
  it('arms and floors from the real round trip, not the inflated one', () => {
    // The break-even floor IS the round trip. Sized from the inflated toll, an
    // armed position on fomopay would have "broken even" at +3.37% — which is
    // a sale refused for a profit, not a floor.
    const levels = exitLevelsFor(position(quality(0.25, 1.1)), sizing)
    expect(levels.breakEvenPct).toBeCloseTo(1.50, 2)
    expect(levels.armAtPct).toBeCloseTo(4.54, 2)
  })
})

describe('exitSizingFrom — the ceiling reaches the sweep', () => {
  // A wiring test, for the reason every one in this project exists: the sweep
  // honours a ceiling it is handed, and a builder that forgets to hand it over
  // leaves the stop uncapped while every unit test of the sweep stays green.
  it('carries the ceiling from the cycle config into the sizing', () => {
    const config = { params: DEFAULT_PARAMS, portfolio: DEFAULT_PORTFOLIO_POLICY, heartbeatMs: 1, maxStopPct: 10 }
    expect(exitSizingFrom(config).maxStopPct).toBe(10)
  })
})

describe('exitLevelsFor — a dollar stop is passed through untouched', () => {
  // The 1:4 derivation builds a fresh percent policy, and a fresh object would
  // drop the dollar limit on the floor — the operator's rule deleted by the
  // arithmetic he told us not to run. *No quiero que mires el porcentaje.*
  it('keeps the dollar limit and derives no percentage at all', () => {
    const tenCents = { ...FLAT_ONE_PCT_STOP, maxLossUsd: 0.1 }
    const { stop } = exitLevelsFor(position(quality(0.25, 3)), { ...sizing, stop: tenCents })
    expect(stop.maxLossUsd).toBe(0.1)
    expect(stop).toEqual(tenCents)
  })
})

