import {
  type BrokerPort,
  type ClosedTrade,
  type Fill,
  type OpenTrade,
  type Rejection,
} from '../../domain/execution/broker.js'
import { type Order, type PositionSnapshot } from '../../domain/strategy/state.js'

export interface TradingViewSimConfig {
  /** `syminfo.mintick` — slippage is expressed in ticks. */
  readonly mintick: number
  /** `slippage = 1` in the strategy() header. */
  readonly slippageTicks: number
  /** `commission_value = 0.1` with `commission.percent`. */
  readonly commissionPct: number
  /** `pyramiding = 10`: max open entries in one direction. */
  readonly pyramiding: number
  /** `initial_capital = 10000`. */
  readonly initialCapital: number
  /**
   * Whether an entry that exceeds available cash is rejected. TradingView's
   * behaviour here depends on margin settings and is not certain from the
   * script alone — the parity diff against the real trade list decides it.
   */
  readonly enforceCapital: boolean
}

export const DCA_PINE_SIM_CONFIG: Omit<TradingViewSimConfig, 'mintick'> = {
  slippageTicks: 1,
  commissionPct: 0.1,
  pyramiding: 10,
  initialCapital: 10_000,
  enforceCapital: false,
}

/**
 * TradingView's strategy broker emulator, as configured by DCA.pine.
 *
 * Execution model (no `process_orders_on_close`, no `calc_on_every_tick`):
 *  - An order placed on bar i executes at bar i+1's OPEN.
 *  - Buys fill at open + slippage ticks, sells at open − slippage ticks.
 *  - Commission is a percent of notional on every fill, entry and exit.
 *  - Each `strategy.entry` is its own trade; `close_all` closes every open
 *    trade at the same exit price, producing one closed trade per entry —
 *    exactly how the Strategy Tester's trade list reads.
 *  - `pyramiding` caps open entries; extra entries are rejected, not queued.
 *
 * `position_avg_price` is the qty-weighted average of open entry fill prices
 * (slippage included, commission excluded). `openprofit` is marked at the
 * bar's close and excludes commission.
 */
export class TradingViewSim implements BrokerPort {
  private readonly open: OpenTrade[] = []
  private readonly closed: ClosedTrade[] = []
  private readonly rejected: Rejection[] = []
  private cash: number

  constructor(private readonly config: TradingViewSimConfig) {
    this.cash = config.initialCapital
  }

  get openTrades(): readonly OpenTrade[] {
    return this.open
  }

  get closedTrades(): readonly ClosedTrade[] {
    return this.closed
  }

  get rejections(): readonly Rejection[] {
    return this.rejected
  }

  get equityCash(): number {
    return this.cash
  }

  execute(orders: readonly Order[], open: number, time: number): readonly Fill[] {
    const fills: Fill[] = []
    const slip = this.config.slippageTicks * this.config.mintick
    const feeRate = this.config.commissionPct / 100

    for (const order of orders) {
      if (order.kind === 'entry') {
        if (this.open.length >= this.config.pyramiding) {
          this.rejected.push({ time, order, reason: 'pyramiding' })
          continue
        }
        const price = open + slip
        const notional = price * order.qty
        const commission = notional * feeRate
        if (this.config.enforceCapital && this.cash < notional + commission) {
          this.rejected.push({ time, order, reason: 'capital' })
          continue
        }
        this.cash -= notional + commission
        this.open.push({
          id: order.id,
          entryTime: time,
          entryPrice: price,
          qty: order.qty,
          entryCommission: commission,
          comment: order.comment,
        })
        fills.push({ time, id: order.id, side: 'buy', price, qty: order.qty, commission, comment: order.comment })
        continue
      }

      // closeAll
      if (this.open.length === 0) {
        this.rejected.push({ time, order, reason: 'flat' })
        continue
      }
      const price = open - slip
      for (const trade of this.open) {
        const notional = price * trade.qty
        const exitCommission = notional * feeRate
        const profit = (price - trade.entryPrice) * trade.qty - trade.entryCommission - exitCommission
        this.cash += notional - exitCommission
        this.closed.push({
          ...trade,
          exitTime: time,
          exitPrice: price,
          exitCommission,
          profit,
          exitComment: order.comment,
        })
        fills.push({ time, id: trade.id, side: 'sell', price, qty: trade.qty, commission: exitCommission, comment: order.comment })
      }
      this.open.length = 0
    }

    return fills
  }

  snapshot(close: number): PositionSnapshot {
    if (this.open.length === 0) return { size: 0, avgPrice: null, openProfit: 0 }
    let size = 0
    let cost = 0
    let openProfit = 0
    for (const trade of this.open) {
      size += trade.qty
      cost += trade.entryPrice * trade.qty
      openProfit += (close - trade.entryPrice) * trade.qty
    }
    return { size, avgPrice: cost / size, openProfit }
  }
}
