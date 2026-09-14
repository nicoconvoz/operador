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

/** A recorded fill, as the store keeps it. Structural, so the broker stays free of the persistence types. */
export interface SeedFill {
  readonly orderId: string
  readonly side: 'buy' | 'sell'
  readonly time: number
  readonly price: number
  readonly qty: number
  readonly costUsd: number
  readonly comment: string
}

export interface PaperCosts {
  readonly spreadUsd: number
  readonly impactUsd: number
  readonly gasUsd: number
}

/**
 * An open trade plus the MID price it was filled against.
 *
 * Slippage is already inside `entryPrice`, so charging it again as a
 * commission would count it twice. Keeping the mid lets the books state both
 * truths at once: what the position cost against an untouched price (gross),
 * and what actually left the wallet (net).
 */
interface PaperOpenTrade extends OpenTrade {
  readonly entryMid: number
}

export class PaperBroker implements BrokerPort {
  private readonly open: PaperOpenTrade[] = []
  private readonly closed: ClosedTrade[] = []
  private readonly rejected: Rejection[] = []
  private cash: number
  private costs: PaperCosts = { spreadUsd: 0, impactUsd: 0, gasUsd: 0 }
  private grossUsd = 0

  constructor(private readonly config: PaperBrokerConfig) {
    this.cash = config.initialCapital
  }

  /**
   * Rebuilds the position from the fills that were recorded.
   *
   * The engine runs as a one-shot process — wake, advance one bar, write
   * everything down, exit — so a broker that keeps its position in memory is
   * FLAT on every wake-up and the strategy never sees what it opened fifteen
   * minutes ago. The fills are the facts; this reads them back.
   *
   * What it reconstructs exactly: open trades, cash, and therefore the
   * snapshot the strategy reads and the pyramiding count a restart must
   * respect. What it cannot: `realisedGrossUsd`, which needs the untouched mid
   * of each entry and that is not in a fill. Seeded trades report their entry
   * price as their mid, so gross reads as net for them — stated here rather
   * than silently wrong, and the number is a report, not a decision.
   */
  seed(fills: readonly SeedFill[]): void {
    // Sorted, because a store returns rows and rows are not a queue.
    const ordered = [...fills].sort((a, b) => a.time - b.time)
    let lastSellTime: number | null = null

    for (const fill of ordered) {
      if (fill.side === 'buy') {
        this.cash -= fill.price * fill.qty + this.config.gasUsdPerSwap
        this.open.push({
          id: fill.orderId,
          entryTime: fill.time,
          entryPrice: fill.price,
          entryMid: fill.price,
          qty: fill.qty,
          entryCommission: fill.costUsd,
          comment: fill.comment,
        })
        continue
      }

      // A close sells EVERYTHING in one swap, so its fills share a timestamp
      // and one gas charge between them.
      this.cash += fill.price * fill.qty
      if (lastSellTime !== fill.time) {
        this.cash -= this.config.gasUsdPerSwap
        lastSellTime = fill.time
      }
      const index = this.open.findIndex((trade) => trade.id === fill.orderId)
      if (index >= 0) this.open.splice(index, 1)
    }
  }

  get openTrades(): readonly OpenTrade[] {
    return this.open
  }

  /**
   * Realised P&L measured mid-to-mid: what the price move alone was worth,
   * before the chain took its cut. `gross − every commission = net`, exactly.
   */
  get realisedGrossUsd(): number {
    return this.grossUsd
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
          entryMid: open,
          qty: order.qty,
          // Cost of this fill measured against the untouched price: the
          // slippage baked into `price`, plus the gas that was not.
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
        // Cash truth: the two fill prices already carry their slippage, so only
        // gas is subtracted on top. This equals mid-to-mid minus BOTH
        // commissions — the identity the summary relies on.
        const gasEntry = this.config.gasUsdPerSwap
        const profit = (price - trade.entryPrice) * trade.qty - gasEntry - gas * share
        this.grossUsd += (open - trade.entryMid) * trade.qty
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
