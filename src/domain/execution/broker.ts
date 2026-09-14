import { type Order, type PositionSnapshot } from '../strategy/state.js'

/**
 * The execution port. The strategy emits orders at a bar's close; a broker
 * turns them into fills at some later moment and reports the position back.
 *
 * Two implementations are planned: a TradingView-faithful simulator for the
 * parity harness and paper trading, and the live DEX adapters. The state
 * machine never knows which one it is talking to.
 */

export interface OpenTrade {
  readonly id: string
  readonly entryTime: number
  readonly entryPrice: number
  readonly qty: number
  readonly entryCommission: number
  readonly comment: string
}

export interface ClosedTrade extends OpenTrade {
  readonly exitTime: number
  readonly exitPrice: number
  readonly exitCommission: number
  /** Net of both commissions — matches TradingView's trade list "Profit". */
  readonly profit: number
  readonly exitComment: string
}

export interface Fill {
  readonly time: number
  readonly id: string
  readonly side: 'buy' | 'sell'
  readonly price: number
  readonly qty: number
  readonly commission: number
  readonly comment: string
}

export interface Rejection {
  readonly time: number
  readonly order: Order
  readonly reason: 'pyramiding' | 'capital' | 'flat'
}

export interface BrokerPort {
  /** Execute pending orders at this bar's open. Returns what actually filled. */
  execute(orders: readonly Order[], open: number, time: number): readonly Fill[]
  /** The position as the strategy must see it on this bar, marked at `close`. */
  snapshot(close: number): PositionSnapshot
  readonly openTrades: readonly OpenTrade[]
  readonly closedTrades: readonly ClosedTrade[]
  readonly rejections: readonly Rejection[]
}
