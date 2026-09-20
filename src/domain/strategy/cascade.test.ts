import { describe, it, expect } from 'vitest'
import { stepCascade, decayBarsFor } from './cascade.js'
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

describe('decayBarsFor — the more there is to lose, the less it waits', () => {
  it('keeps the reference patience on an ordinary gain', () => {
    // The exit wants the impulse DEAD, which is `decayBarsRequired` consecutive
    // falling VWM bars. On a normal winner that is the right trade: it lets the
    // move finish instead of selling the first red candle.
    expect(decayBarsFor(3, DEFAULT_PARAMS)).toBe(DEFAULT_PARAMS.decayBarsRequired)
  })

  it('waits one bar less once the gain is worth protecting', () => {
    expect(decayBarsFor(12, { ...DEFAULT_PARAMS, impatientProfitPct: 10, urgentProfitPct: 25 })).toBe(1)
  })

  it('does not wait at all on a gain large enough to lose', () => {
    // Measured on a live position: priceless ran to +84% in half an hour and
    // the rule waited two falling bars before selling — by which time it was
    // +30%. Two thirds of the gain spent on patience the size of the move did
    // not justify.
    expect(decayBarsFor(46, { ...DEFAULT_PARAMS, impatientProfitPct: 10, urgentProfitPct: 25 })).toBe(0)
  })

  it('is the reference exactly when neither threshold is set', () => {
    // DEFAULT_PARAMS is what TradingView ran and the parity harness asserts it.
    // Impatience is a PRODUCTION choice composed on top, never a new default.
    expect(DEFAULT_PARAMS.impatientProfitPct).toBeNull()
    expect(DEFAULT_PARAMS.urgentProfitPct).toBeNull()
    expect(decayBarsFor(500, DEFAULT_PARAMS)).toBe(DEFAULT_PARAMS.decayBarsRequired)
  })

  it('never asks for MORE patience than the reference', () => {
    // Monotone by construction: a bigger gain can only ever shorten the wait.
    const impatient = { ...DEFAULT_PARAMS, impatientProfitPct: 10, urgentProfitPct: 25 }
    for (const pct of [0, 5, 9.9, 10, 24.9, 25, 100]) {
      expect(decayBarsFor(pct, impatient)).toBeLessThanOrEqual(DEFAULT_PARAMS.decayBarsRequired)
    }
  })
})

describe('door 3 — the scanner already decided, so just buy', () => {
  // The operator's momentum strategy, and this door exists because of a
  // CONTRADICTION rather than a preference.
  //
  // The scanner now selects tokens that are RISING: up more than 5% on the day
  // and still positive in the hour. Door 1 requires `close <= swingHigh(20)`,
  // which refuses a bar making a new twenty-bar high — and a token that ran 5%
  // today usually is. So the scanner was choosing exactly what the executor
  // refuses, and the measured result was FIVE positions opened out of sixteen
  // candidates.
  //
  // It asks nothing but that we are flat and the price is real. Everything
  // deciding WHETHER to be in this token happened in the scanner; re-asking it
  // here in the language of indicators is what cost those eleven entries.

  const momentum = { ...P, useMomentumEntry: true }

  it('buys a token making a NEW HIGH, which door 1 refuses', () => {
    // The exact case. The bar closes above the swing high, so the classic door
    // says no; the momentum door does not ask.
    
    const out = stepCascade(initialState(), momentum, bar(119, 121, 118, 120), ctx({ swingHigh: 100 }), FLAT)
    expect(out.orders.map((o) => o.comment)).toContain('🟢 Entry')
  })

  it('and door 1 alone would have refused exactly that bar', () => {
    
    const out = stepCascade(initialState(), P, bar(119, 121, 118, 120), ctx({ swingHigh: 100 }), FLAT)
    expect(out.orders).toEqual([])
  })

  it('needs no indicators at all — a brand new pool can be bought', () => {
    // Which is what makes the `age` and `history` gates unnecessary for these
    // tokens: there is nothing to warm up. A swing high of null and no trend is
    // the shape of a pool born this morning.
    
    const out = stepCascade(initialState(), momentum, bar(1, 1, 1, 1), ctx({ swingHigh: null, isLateral: false }), FLAT)
    expect(out.orders.map((o) => o.comment)).toContain('🟢 Entry')
  })

  it('still only buys when FLAT', () => {
    // One position per token. The door opens at level 0 and nowhere else.
    const held = { ...initialState(), level: 1, ep1: 100, totalInvested: 15 }
    
    const out = stepCascade(held, momentum, bar(119, 121, 118, 120), ctx({ swingHigh: 100 }), FLAT)
    expect(out.orders.filter((o) => o.comment === '🟢 Entry')).toEqual([])
  })

  it('refuses a price of zero, which is not a price', () => {
    
    const out = stepCascade(initialState(), momentum, bar(0, 0, 0, 0), ctx({ swingHigh: 100 }), FLAT)
    expect(out.orders).toEqual([])
  })

  it('is OFF in the reference params, so the parity harness is untouched', () => {
    // The harness asserts DEFAULT_PARAMS are the backtest's own inputs. This is
    // composed in production beside the ladder cap and the entry drop.
    expect(DEFAULT_PARAMS.useMomentumEntry).toBe(false)
  })
})
