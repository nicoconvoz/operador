import {
  type BrokerPort,
  type ClosedTrade,
  type Fill,
  type OpenTrade,
  type Rejection,
} from '../../domain/execution/broker.js'
import { effectiveDepth } from '../../domain/economics/sizing.js'
import { type MarketQuality } from '../../domain/market/market-quality.js'
import { type Order, type PositionSnapshot } from '../../domain/strategy/state.js'

/**
 * Paper broker — the honest simulator.
 *
 * The TradingView simulator reproduces a backtest. This one reproduces a
 * CHAIN: every fill pays the venue spread, the price impact its own size
 * causes, and gas. Those three are the difference between a backtest that
 * looks profitable and a wallet that is not.
 *
 * It is deliberately pessimistic where it is uncertain:
 *  - impact is charged on the way IN and again on the way OUT
 *  - gas is charged per swap, whatever the swap's size
 *  - a sell that cannot be routed does not happen (the caller sees it)
 *
 * Paper results from this broker are the input to the project's real open
 * question: what is the minimum capital at which this strategy works at all?
 */

export interface PaperBrokerConfig {
  /** Fixed cost of one swap, in USD. Solana priority fees live around $0.01–0.20. */
  readonly gasUsdPerSwap: number
  readonly initialCapital: number
  /** Max simultaneous entries. Mirrors the validated `pyramiding = 10`. */
  readonly maxOpenEntries: number
  /** Current market quality for the token being traded, at fill time. */
  readonly quality: () => MarketQuality
}

export interface PaperCosts {
  readonly spreadUsd: number
  readonly impactUsd: number
  readonly gasUsd: number
}

export class PaperBroker implements BrokerPort {
  private readonly open: OpenTrade[] = []
  private readonly closed: ClosedTrade[] = []
  private readonly rejected: Rejection[] = []
  private cash: number
  private costs: PaperCosts = { spreadUsd: 0, impactUsd: 0, gasUsd: 0 }

  constructor(private readonly config: PaperBrokerConfig) {
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

  /** Everything the chain took, split by cause. */
  get totalCosts(): PaperCosts {
    return this.costs
  }

  /**
   * Impact of an order of `usd` against the token's usable depth, in percent.
   * Depth comes from a measured quote when there is one — reported TVL
   * overstates what a concentrated pool can actually absorb.
   */
  private impactPctFor(usd: number): number {
    const depth = effectiveDepth(this.config.quality()).usd
    return depth > 0 ? (usd / (depth / 2)) * 100 : Infinity
  }

  execute(orders: readonly Order[], open: number, time: number): readonly Fill[] {
    const fills: Fill[] = []
    const quality = this.config.quality()

    for (const order of orders) {
      if (order.kind === 'entry') {
        if (this.open.length >= this.config.maxOpenEntries) {
          this.rejected.push({ time, order, reason: 'pyramiding' })
          continue
        }
        const notional = order.qty * open
        const costPct = quality.spreadPct + this.impactPctFor(notional)
        const price = open * (1 + costPct / 100)
        const spent = order.qty * price
        const gas = this.config.gasUsdPerSwap

        if (this.cash < spent + gas) {
          this.rejected.push({ time, order, reason: 'capital' })
          continue
        }

        this.cash -= spent + gas
        this.chargeCosts(notional, quality.spreadPct, spent - notional, gas)
        this.open.push({
          id: order.id,
          entryTime: time,
          entryPrice: price,
          qty: order.qty,
          entryCommission: spent - notional + gas,
          comment: order.comment,
        })
        fills.push({ time, id: order.id, side: 'buy', price, qty: order.qty, commission: spent - notional + gas, comment: order.comment })
        continue
      }

      // closeAll — one swap for the whole position, so impact is charged on
      // the TOTAL. This is what the exit budget in sizing.ts protects against.
      if (this.open.length === 0) {
        this.rejected.push({ time, order, reason: 'flat' })
        continue
      }
      const totalQty = this.open.reduce((sum, trade) => sum + trade.qty, 0)
      const notional = totalQty * open
      const costPct = quality.spreadPct + this.impactPctFor(notional)
      const price = open * (1 - costPct / 100)
      const gas = this.config.gasUsdPerSwap
      const received = totalQty * price

      this.cash += received - gas
      this.chargeCosts(notional, quality.spreadPct, notional - received, gas)

      for (const trade of this.open) {
        // Gas is one swap for the whole exit; split it by share of the position.
        const share = trade.qty / totalQty
        const exitCommission = (notional - received) * share + gas * share
        const profit = (price - trade.entryPrice) * trade.qty - trade.entryCommission - gas * share
        this.closed.push({ ...trade, exitTime: time, exitPrice: price, exitCommission, profit, exitComment: order.comment })
        fills.push({ time, id: trade.id, side: 'sell', price, qty: trade.qty, commission: exitCommission, comment: order.comment })
      }
      this.open.length = 0
    }

    return fills
  }

  private chargeCosts(notional: number, spreadPct: number, totalSlipUsd: number, gasUsd: number): void {
    const spreadUsd = (notional * spreadPct) / 100
    this.costs = {
      spreadUsd: this.costs.spreadUsd + spreadUsd,
      impactUsd: this.costs.impactUsd + Math.max(0, totalSlipUsd - spreadUsd),
      gasUsd: this.costs.gasUsd + gasUsd,
    }
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
