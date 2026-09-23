/**
 * The CASCADE DCA state machine contract.
 *
 * Everything here is serialisable on purpose: an unattended engine WILL
 * crash, and a position must be reconstructable from persisted state alone.
 * No class instances, no closures, no hidden fields.
 */

/**
 * Persistent strategy state — the `var` block of DCA.pine, name for name.
 *
 * `level`: 0 = flat. 1..maxLevels = position open, next DCA to arm is
 * `level`. maxLevels + 1 = ladder exhausted.
 */
export interface CascadeState {
  readonly level: number
  /** Anchor entry price — every DCA trigger is measured from here. */
  readonly ep1: number | null
  /** Nominal USD committed so far in this cycle (usd(n) sums, not fills). */
  readonly totalInvested: number
  /** Detects a real position close, to reset the cycle exactly once. */
  readonly wasInTrade: boolean
  /** Lowest low since the last fill — the "bottom" the rebound is measured from. */
  readonly cycleLow: number | null
  /** Signal close of the last fill (entry or DCA). Pine uses close, not the fill price. */
  readonly lastFill: number | null
  /** The pending DCA level touched its trigger and is waiting for the rebound. */
  readonly dcaArmed: boolean
  /** Rescue mode has armed the breakeven exit. */
  readonly breakevenArmed: boolean
  /** Bars elapsed without a new cycle low. */
  readonly barsSinceLow: number
  /** A sell just happened: the trend re-entry door is open, once. */
  readonly awaitReentry: boolean
  /** Consecutive bars of falling VWM. Global — survives cycle resets. */
  readonly decayCount: number
}

export function initialState(): CascadeState {
  return {
    level: 0,
    ep1: null,
    totalInvested: 0,
    wasInTrade: false,
    cycleLow: null,
    lastFill: null,
    dcaArmed: false,
    breakevenArmed: false,
    barsSinceLow: 0,
    awaitReentry: false,
    decayCount: 0,
  }
}

/** The bar being evaluated — always a CLOSED bar. */
export interface Bar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

/**
 * Indicator-derived facts for this bar. Computed outside the state machine
 * from the proven indicator layer, so the machine itself never touches a
 * series and stays trivially testable.
 */
export interface BarContext {
  /** `is_lateral` — BBW/ADX consolidation filter. */
  readonly isLateral: boolean
  /** `ta.highest(high, swing_lb)` — na during warmup. */
  readonly swingHigh: number | null
  /** `trend_bullish` — the composite trend re-entry gate. */
  readonly trendBullish: boolean
  /** `ta.crossover(st_dir, 0)` — Supertrend just turned bearish. */
  readonly stBearFlip: boolean
  /** `vwm`, `vwm[1]`, `vwm[decay_req]` — for the decay counter and impulse check. */
  readonly vwm: number | null
  readonly vwmPrev: number | null
  readonly vwmLagged: number | null
}

/**
 * What the BROKER says the position is — `strategy.position_size`,
 * `strategy.position_avg_price`, `strategy.openprofit`.
 *
 * This comes from fills, not from the state machine's own bookkeeping, and
 * the two legitimately disagree: Pine sets `ep1 := close` on the signal bar
 * while the fill lands at the next bar's open. Exit and rescue logic read the
 * broker's numbers, exactly as the reference does.
 */
export interface PositionSnapshot {
  /** Units held. 0 when flat. */
  readonly size: number
  /** Average fill price, null when flat. */
  readonly avgPrice: number | null
  /** Unrealised P&L in quote currency. */
  readonly openProfit: number
}

export const FLAT: PositionSnapshot = { size: 0, avgPrice: null, openProfit: 0 }

export type EntryOrder = {
  readonly kind: 'entry'
  /** Pine order id: 'Entry' for level 0 (both doors), 'DCA-n' for level n. */
  readonly id: string
  readonly level: number
  readonly usd: number
  /** `usd / close` — Pine sizes in units at the signal close. */
  readonly qty: number
  readonly comment: string
}

export type CloseAllOrder = {
  readonly kind: 'closeAll'
  /**
   * The two strategy exits, plus the risk layer's THREE (see domain/risk).
   *
   * A union rather than a string, so the no-loss guard can tell them apart in
   * the TYPE system: a strategy exit may not fill below average cost, and the
   * risk layer's must, because they leave for a reason that is not the
   * strategy's own profit target.
   *
   * `🔁 Rotación` is the ALLOCATOR's, and it is the one the operator added
   * against the reference outright: the opportunity floors went off on a
   * position holding money, so the money leaves and buys something that
   * qualifies — *aunque se pierda*. It is NOT a death exit and never
   * blacklists the token, which is exactly why it needs a name of its own
   * instead of borrowing one.
   */
  readonly comment: '🏁 Exit' | '⚖️ BE Exit' | '☠️ Death Exit' | '❄️ Salida por congelamiento' | '🔁 Rotación' | '🛑 Stop' | '🔄 Cambio' | '🔒 Break-even' | '📉 Presión vendedora'
}

export type Order = EntryOrder | CloseAllOrder

export interface StepResult {
  readonly state: CascadeState
  readonly orders: readonly Order[]
}
