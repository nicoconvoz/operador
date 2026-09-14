import { type BrokerPort, type Fill } from '../domain/execution/broker.js'
import { type DenseSeries } from '../domain/indicators/series.js'
import { stepCascade } from '../domain/strategy/cascade.js'
import { type CascadeParams, assertParams } from '../domain/strategy/params.js'
import { computeSignals, type Signals } from '../domain/strategy/signals.js'
import { initialState, type CascadeState, type Order } from '../domain/strategy/state.js'

export interface Candles {
  readonly time: DenseSeries
  readonly open: DenseSeries
  readonly high: DenseSeries
  readonly low: DenseSeries
  readonly close: DenseSeries
  readonly volume: DenseSeries
}

export interface ReplayResult {
  readonly signals: Signals
  /** State AFTER each bar was processed. */
  readonly states: readonly CascadeState[]
  /** Orders emitted at each bar's close (executed at the next bar's open). */
  readonly orders: readonly (readonly Order[])[]
  readonly fills: readonly Fill[]
  readonly broker: BrokerPort
}

/**
 * Replays the strategy over historical candles with a broker.
 *
 * The bar loop is the TradingView execution model made explicit:
 *
 *   for each bar i:
 *     1. the broker executes the orders emitted at bar i-1, at bar i's OPEN
 *     2. the strategy sees the resulting position, marked at bar i's CLOSE
 *     3. the strategy evaluates bar i and emits orders for bar i+1
 *
 * Nothing in this loop is specific to backtesting: the live engine runs the
 * same three steps per closed bar with a DEX adapter as the broker.
 */
export interface ReplayHooks {
  /** Runs before bar `i` is processed — before pending orders execute. */
  readonly beforeBar?: (i: number, time: number, broker: BrokerPort) => void
}

export function replay(
  candles: Candles,
  params: CascadeParams,
  broker: BrokerPort,
  hooks: ReplayHooks = {},
): ReplayResult {
  assertParams(params)
  const n = candles.close.length
  const signals = computeSignals(candles, params)

  const states: CascadeState[] = new Array<CascadeState>(n)
  const orders: (readonly Order[])[] = new Array<readonly Order[]>(n)
  const fills: Fill[] = []

  let state = initialState()
  let pending: readonly Order[] = []

  for (let i = 0; i < n; i++) {
    const time = candles.time[i]!
    hooks.beforeBar?.(i, time, broker)
    if (pending.length > 0) {
      fills.push(...broker.execute(pending, candles.open[i]!, time))
    }

    const position = broker.snapshot(candles.close[i]!)
    const bar = {
      open: candles.open[i]!,
      high: candles.high[i]!,
      low: candles.low[i]!,
      close: candles.close[i]!,
    }
    const result = stepCascade(state, params, bar, signals.contexts[i]!, position)

    state = result.state
    pending = result.orders
    states[i] = state
    orders[i] = result.orders
  }

  return { signals, states, orders, fills, broker }
}
