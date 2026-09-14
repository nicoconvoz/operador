import { describe, it, expect } from 'vitest'
import { stepCascade } from './cascade.js'
import { DEFAULT_PARAMS, type CascadeParams } from './params.js'
import { usdForLevel } from './ladder.js'
import {
  FLAT,
  initialState,
  type Bar,
  type BarContext,
  type CascadeState,
  type PositionSnapshot,
} from './state.js'

/**
 * Scenario tests for the CASCADE DCA state machine, one per transition in
 * DCA.pine. Each scenario states its Pine condition in the name.
 *
 * `confirmBars` is 1 in most scenarios so a bottom confirms on the next bar;
 * the reference default of 20 only makes sequences longer, not different.
 */

const P: CascadeParams = { ...DEFAULT_PARAMS, confirmBars: 1 }

const bar = (open: number, high: number, low: number, close: number): Bar => ({ open, high, low, close })

const ctx = (over: Partial<BarContext> = {}): BarContext => ({
  isLateral: true,
  swingHigh: null,
  trendBullish: false,
  stBearFlip: false,
  vwm: null,
  vwmPrev: null,
  vwmLagged: null,
  ...over,
})

const long = (avgPrice: number, openProfit = 0, size = 10): PositionSnapshot => ({
  size,
  avgPrice,
  openProfit,
})

/** A position at `level` anchored at `ep1`, as it looks the bar after its fill. */
const inTrade = (level: number, ep1: number, over: Partial<CascadeState> = {}): CascadeState => ({
  ...initialState(),
  level,
  ep1,
  lastFill: ep1,
  totalInvested: usdForLevel(P, 0),
  wasInTrade: true,
  ...over,
})

describe('cascade — quiet bar', () => {
  it('flat with no signal: no orders, state untouched', () => {
    const { state, orders } = stepCascade(initialState(), P, bar(1, 1, 1, 1), ctx(), FLAT)
    expect(orders).toEqual([])
    expect(state).toEqual(initialState())
  })
})

describe('cascade — initial entry (ini_cond)', () => {
  it('fires on a 10% drop from swing high inside a lateral zone', () => {
    const { state, orders } = stepCascade(
      initialState(), P, bar(91, 92, 89, 90), ctx({ swingHigh: 100 }), FLAT,
    )
    expect(orders).toEqual([
      { kind: 'entry', id: 'Entry', level: 0, usd: 1000, qty: 1000 / 90, comment: '🟢 Entry' },
    ])
    expect(state).toMatchObject({
      level: 1, ep1: 90, totalInvested: 1000, lastFill: 90,
      cycleLow: null, dcaArmed: false, barsSinceLow: 0, awaitReentry: false,
    })
  })

  it('the drop is inclusive: exactly drop_init% qualifies', () => {
    const { orders } = stepCascade(initialState(), P, bar(90, 90, 90, 90), ctx({ swingHigh: 100 }), FLAT)
    expect(orders).toHaveLength(1)
  })

  it('does not fire on a 9% drop', () => {
    const { orders } = stepCascade(initialState(), P, bar(91, 91, 91, 91), ctx({ swingHigh: 100 }), FLAT)
    expect(orders).toEqual([])
  })

  it('does not fire outside a lateral zone', () => {
    const { orders } = stepCascade(
      initialState(), P, bar(90, 90, 90, 90), ctx({ swingHigh: 100, isLateral: false }), FLAT,
    )
    expect(orders).toEqual([])
  })

  it('does not fire while swing high is still na (warmup)', () => {
    const { orders } = stepCascade(initialState(), P, bar(90, 90, 90, 90), ctx({ swingHigh: null }), FLAT)
    expect(orders).toEqual([])
  })

  it('consumes the trend re-entry flag when it wins the race', () => {
    const armed = { ...initialState(), awaitReentry: true }
    const { state } = stepCascade(armed, P, bar(90, 90, 90, 90), ctx({ swingHigh: 100 }), FLAT)
    expect(state.awaitReentry).toBe(false)
  })
})

describe('cascade — trend re-entry (tr_cond)', () => {
  const armed = { ...initialState(), awaitReentry: true }

  it('fires once after a sell when the trend is clearly bullish', () => {
    const { state, orders } = stepCascade(
      armed, P, bar(49, 51, 48, 50), ctx({ trendBullish: true, isLateral: false }), FLAT,
    )
    expect(orders).toEqual([
      { kind: 'entry', id: 'Entry', level: 0, usd: 1000, qty: 1000 / 50, comment: '🚀 Re-Entry' },
    ])
    expect(state).toMatchObject({ level: 1, ep1: 50, lastFill: 50, awaitReentry: false })
  })

  it('is closed until a sell arms it', () => {
    const { orders } = stepCascade(
      initialState(), P, bar(50, 50, 50, 50), ctx({ trendBullish: true, isLateral: false }), FLAT,
    )
    expect(orders).toEqual([])
  })

  it('is disabled by use_trend_reentry = false', () => {
    const off = { ...P, useTrendReentry: false }
    const { orders } = stepCascade(
      armed, off, bar(50, 50, 50, 50), ctx({ trendBullish: true, isLateral: false }), FLAT,
    )
    expect(orders).toEqual([])
  })

  it('never opens a second position: requires level 0', () => {
    const open = { ...inTrade(1, 100), awaitReentry: true }
    const { orders } = stepCascade(
      open, P, bar(50, 50, 50, 50), ctx({ trendBullish: true, isLateral: false }), long(100),
    )
    expect(orders).toEqual([])
  })
})

describe('cascade — cycle reset when the position closes', () => {
  it('marks was_in_trade once the broker reports a position', () => {
    const { state } = stepCascade(inTrade(1, 100, { wasInTrade: false }), P, bar(1, 1, 1, 1), ctx(), long(100))
    expect(state.wasInTrade).toBe(true)
  })

  it('resets every cycle field and opens the re-entry door — but keeps decay_count', () => {
    const dirty: CascadeState = {
      level: 3, ep1: 100, totalInvested: 6600, wasInTrade: true, cycleLow: 80,
      lastFill: 90, dcaArmed: true, breakevenArmed: true, barsSinceLow: 5,
      awaitReentry: false, decayCount: 3,
    }
    // vwm falling keeps the global decay counter alive through the reset.
    const { state, orders } = stepCascade(dirty, P, bar(1, 1, 1, 1), ctx({ vwm: 1, vwmPrev: 2 }), FLAT)
    expect(orders).toEqual([])
    expect(state).toEqual({ ...initialState(), awaitReentry: true, decayCount: 4 })
  })

  it('does not reset a position that was never filled (level > 0 but not yet in trade)', () => {
    // The signal bar: level is 1, the fill lands next open, size is still 0.
    const signalled = inTrade(1, 100, { wasInTrade: false })
    const { state } = stepCascade(signalled, P, bar(1, 1, 1, 1), ctx(), FLAT)
    expect(state.level).toBe(1)
  })
})

describe('cascade — cycle low tracking', () => {
  it('records the lowest low since the last fill and counts bars without a new one', () => {
    let s = inTrade(1, 100)
    s = stepCascade(s, P, bar(99, 99, 97, 98), ctx(), long(100)).state
    expect(s).toMatchObject({ cycleLow: 97, barsSinceLow: 0 })
    s = stepCascade(s, P, bar(98, 99, 98, 98.5), ctx(), long(100)).state
    expect(s).toMatchObject({ cycleLow: 97, barsSinceLow: 1 })
    s = stepCascade(s, P, bar(98, 98, 96, 97), ctx(), long(100)).state
    expect(s).toMatchObject({ cycleLow: 96, barsSinceLow: 0 })
  })

  it('does not track while flat', () => {
    const { state } = stepCascade(initialState(), P, bar(99, 99, 97, 98), ctx(), FLAT)
    expect(state.cycleLow).toBeNull()
  })
})

describe('cascade — arming (locks 1 and 2)', () => {
  it('the min_gap lock dominates the first trigger: -1% is not enough, -5% is', () => {
    // trigger(1) = 99. gap: cycle low must be <= last_fill * 0.95 = 95.
    const touched = stepCascade(inTrade(1, 100), P, bar(97, 97, 96, 97), ctx(), long(100)).state
    expect(touched.dcaArmed).toBe(false)

    const gapped = stepCascade(inTrade(1, 100), P, bar(95, 95, 94, 95), ctx(), long(100)).state
    expect(gapped.dcaArmed).toBe(true)
  })

  it('arming requires a position', () => {
    const { state } = stepCascade(inTrade(1, 100, { wasInTrade: false }), P, bar(94, 94, 94, 94), ctx(), FLAT)
    expect(state.dcaArmed).toBe(false)
  })

  it('does not arm past the last level', () => {
    const exhausted = inTrade(P.maxLevels + 1, 100)
    const { state } = stepCascade(exhausted, P, bar(50, 50, 50, 50), ctx(), long(100))
    expect(state.dcaArmed).toBe(false)
  })
})

describe('cascade — DCA fill (locks 3, 4, 5)', () => {
  const armed = inTrade(1, 100, { cycleLow: 94, dcaArmed: true, barsSinceLow: 1 })

  it('fires on a confirmed bottom, a 2.5% rebound and a green candle', () => {
    // 94 * 1.025 = 96.35; close 96.5 > open 95.
    const { state, orders } = stepCascade(armed, P, bar(95, 97, 95, 96.5), ctx(), long(100))
    expect(orders).toEqual([
      { kind: 'entry', id: 'DCA-1', level: 1, usd: 2200, qty: 2200 / 96.5, comment: 'DCA-1' },
    ])
    expect(state).toMatchObject({
      level: 2, totalInvested: 3200, lastFill: 96.5,
      dcaArmed: false, cycleLow: null, barsSinceLow: 0,
    })
  })

  it('waits for the rebound', () => {
    const { orders } = stepCascade(armed, P, bar(95, 96.3, 95, 96.3), ctx(), long(100))
    expect(orders).toEqual([])
  })

  it('waits for a green candle when require_green is on', () => {
    const { orders } = stepCascade(armed, P, bar(97, 97.5, 95, 96.5), ctx(), long(100))
    expect(orders).toEqual([])
  })

  it('ignores candle colour when require_green is off', () => {
    const { orders } = stepCascade(armed, { ...P, requireGreen: false }, bar(97, 97.5, 95, 96.5), ctx(), long(100))
    expect(orders).toHaveLength(1)
  })

  it('waits for the bottom to age confirm_bars', () => {
    const fresh = { ...armed, barsSinceLow: 0 }
    const slow = { ...P, confirmBars: 3 }
    const { orders } = stepCascade(fresh, slow, bar(95, 97, 95, 96.5), ctx(), long(100))
    expect(orders).toEqual([])
  })

  it('still requires the lateral filter', () => {
    const { orders } = stepCascade(armed, P, bar(95, 97, 95, 96.5), ctx({ isLateral: false }), long(100))
    expect(orders).toEqual([])
  })

  it('fills at most ONE level per bar, however deep the bottom', () => {
    const deep = inTrade(1, 100, { cycleLow: 50, dcaArmed: true, barsSinceLow: 1 })
    const { state, orders } = stepCascade(deep, P, bar(51, 53, 51, 52), ctx(), long(100))
    expect(orders).toHaveLength(1)
    expect(state.level).toBe(2)
  })

  it('classic mode (use_rebound off): fills when close touches the trigger', () => {
    const classic = { ...P, useRebound: false }
    const hit = stepCascade(inTrade(1, 100), classic, bar(99, 99, 98, 98.5), ctx(), long(100))
    expect(hit.orders.map((o) => o.kind)).toEqual(['entry'])
    const miss = stepCascade(inTrade(1, 100), classic, bar(99.5, 99.5, 99.5, 99.5), ctx(), long(100))
    expect(miss.orders).toEqual([])
  })

  it('stops after the last level', () => {
    const exhausted = inTrade(P.maxLevels + 1, 100, { cycleLow: 50, dcaArmed: true, barsSinceLow: 1 })
    const { orders } = stepCascade(exhausted, P, bar(51, 53, 51, 52), ctx(), long(100))
    expect(orders).toEqual([])
  })
})

describe('cascade — normal exit (VWM impulse death / Supertrend flip)', () => {
  const profitable = long(100, 30)

  it('counts consecutive falling VWM bars and resets on a rise or na', () => {
    let s = initialState()
    s = stepCascade(s, P, bar(1, 1, 1, 1), ctx({ vwm: 1, vwmPrev: 2 }), FLAT).state
    expect(s.decayCount).toBe(1)
    s = stepCascade(s, P, bar(1, 1, 1, 1), ctx({ vwm: 0.5, vwmPrev: 1 }), FLAT).state
    expect(s.decayCount).toBe(2)
    s = stepCascade(s, P, bar(1, 1, 1, 1), ctx({ vwm: 0.7, vwmPrev: 0.5 }), FLAT).state
    expect(s.decayCount).toBe(0)
    s = stepCascade(s, P, bar(1, 1, 1, 1), ctx({ vwm: null, vwmPrev: 0.5 }), FLAT).state
    expect(s.decayCount).toBe(0)
  })

  it('exits when in profit and the impulse has died', () => {
    const s = inTrade(2, 100, { decayCount: 1 })
    const { orders } = stepCascade(
      s, P, bar(103, 103, 103, 103), ctx({ vwm: 1, vwmPrev: 1.5, vwmLagged: 0.5 }), profitable,
    )
    expect(orders).toEqual([{ kind: 'closeAll', comment: '🏁 Exit' }])
  })

  it('needs min_profit: 1% above average cost is not enough', () => {
    const s = inTrade(2, 100, { decayCount: 1 })
    const { orders } = stepCascade(
      s, P, bar(101, 101, 101, 101), ctx({ vwm: 1, vwmPrev: 1.5, vwmLagged: 0.5 }), long(100, 10),
    )
    expect(orders).toEqual([])
  })

  it('needs the lagged VWM above the impulse threshold', () => {
    const s = inTrade(2, 100, { decayCount: 1 })
    const { orders } = stepCascade(
      s, P, bar(103, 103, 103, 103), ctx({ vwm: 1, vwmPrev: 1.5, vwmLagged: 0.2 }), profitable,
    )
    expect(orders).toEqual([])
  })

  it('exits on a Supertrend bearish flip when in profit', () => {
    const { orders } = stepCascade(inTrade(2, 100), P, bar(103, 103, 103, 103), ctx({ stBearFlip: true }), profitable)
    expect(orders).toEqual([{ kind: 'closeAll', comment: '🏁 Exit' }])
  })

  it('ignores the Supertrend flip when use_st_exit is off', () => {
    const off = { ...P, useSupertrendExit: false }
    const { orders } = stepCascade(inTrade(2, 100), off, bar(103, 103, 103, 103), ctx({ stBearFlip: true }), profitable)
    expect(orders).toEqual([])
  })

  it('never exits at a loss on price alone', () => {
    const { orders } = stepCascade(
      inTrade(2, 100, { decayCount: 5 }), P, bar(80, 80, 80, 80),
      ctx({ vwm: 1, vwmPrev: 1.5, vwmLagged: 0.5, stBearFlip: true }), long(100, -200),
    )
    expect(orders).toEqual([])
  })
})

describe('cascade — rescue mode breakeven', () => {
  const R: CascadeParams = { ...P, rescueLevels: 2 }

  it('arms once filled DCAs reach rescue_levels and price clears avg cost by be_arm_pct', () => {
    // level 3 → filled_dcas = 2. 100 * 1.01 = 101.
    const { state, orders } = stepCascade(inTrade(3, 100), R, bar(101.5, 101.5, 101.5, 101.5), ctx(), long(100, 5))
    expect(orders).toEqual([])
    expect(state.breakevenArmed).toBe(true)
  })

  it('does not arm below rescue_levels', () => {
    const { state } = stepCascade(inTrade(2, 100), R, bar(101.5, 101.5, 101.5, 101.5), ctx(), long(100, 5))
    expect(state.breakevenArmed).toBe(false)
  })

  it('once armed, closes everything the moment open P&L returns to zero', () => {
    const armed = inTrade(3, 100, { breakevenArmed: true })
    const { orders } = stepCascade(armed, R, bar(100, 100, 99.9, 99.9), ctx(), long(100, -0.5))
    expect(orders).toEqual([{ kind: 'closeAll', comment: '⚖️ BE Exit' }])
  })

  it('the normal exit takes precedence over the breakeven exit', () => {
    const armed = inTrade(3, 100, { breakevenArmed: true })
    const { orders } = stepCascade(
      armed, R, bar(103, 103, 103, 103), ctx({ stBearFlip: true }), long(100, 0),
    )
    expect(orders).toEqual([{ kind: 'closeAll', comment: '🏁 Exit' }])
  })
})
