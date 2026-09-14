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
  /**
   * Quantity step of the contract. TradingView TRUNCATES `strategy.entry`
   * quantities to it: 1000 / 0.01374 = 72780.2038… filled as 72780.203.
   * Not in `syminfo` for Pine to log; read it off the trade list.
   */
  readonly qtyStep: number
  /** `slippage = 1` in the strategy() header. */
  readonly slippageTicks: number
  /** `commission_value = 0.1` with `commission.percent`. */
  readonly commissionPct: number
  /** `pyramiding = 10`: max open entries in one direction. */
  readonly pyramiding: number
  /** `initial_capital = 10000`. */
  readonly initialCapital: number
  /**
   * How TradingView decides an entry is unaffordable.
   *
   *  - 'none'   — never rejects for funds.
   *  - 'cash'   — rejects when notional + commission exceeds free cash.
   *  - 'margin' — Pine v5+ default `margin_long = 100`: an entry is rejected
   *               when its notional exceeds AVAILABLE FUNDS, i.e. equity
   *               (cash + open position marked at the fill bar's open) minus
   *               the margin already used by open trades (their cost).
   *
   * The BLESS trade list settles it: DCA-4 ($5,000) filled with $11,200
   * already deployed against $10,000 initial capital — so not 'cash' — and
   * DCA-5..8 were signalled but never filled once price fell and equity no
   * longer covered them — so not 'none'. That is exactly 'margin'.
   */
  readonly capitalRule: 'none' | 'cash' | 'margin'
}

export const DCA_PINE_SIM_CONFIG: Omit<TradingViewSimConfig, 'mintick' | 'qtyStep'> = {
  slippageTicks: 1,
  commissionPct: 0.1,
  pyramiding: 10,
  initialCapital: 10_000,
  capitalRule: 'margin',
}

/** Floors to a multiple of `step`, guarding against 0.1 + 0.2 style drift. */
export function truncateToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(decimals))
}

export interface MarginState {
  readonly cash: number
  readonly openQty: number
  readonly usedMargin: number
  readonly equity: number
  readonly available: number
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

  /**
   * Resume from a known cash balance — a paper session restarting from
   * persisted state, or a parity replay picking up TradingView's realised
   * P&L at a resync point. Only meaningful while flat: with trades open the
   * balance and the position would disagree about what equity is.
   */
  seedCash(cash: number): void {
    if (this.open.length > 0) throw new Error('seedCash: cannot reseed cash with open trades')
    this.cash = cash
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
        const qty = truncateToStep(order.qty, this.config.qtyStep)
        const notional = price * qty
        const commission = notional * feeRate
        if (!this.affordable(notional + commission, open)) {
          this.rejected.push({ time, order, reason: 'capital' })
          continue
        }
        this.cash -= notional + commission
        this.open.push({
          id: order.id,
          entryTime: time,
          entryPrice: price,
          qty,
          entryCommission: commission,
          comment: order.comment,
        })
        fills.push({ time, id: order.id, side: 'buy', price, qty, commission, comment: order.comment })
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

  /** Equity, used margin and available funds with the open position marked at `markPrice`. */
  marginState(markPrice: number): MarginState {
    let openQty = 0
    let usedMargin = 0
    for (const trade of this.open) {
      openQty += trade.qty
      usedMargin += trade.entryPrice * trade.qty
    }
    const equity = this.cash + openQty * markPrice
    return { cash: this.cash, openQty, usedMargin, equity, available: equity - usedMargin }
  }

  private affordable(cost: number, markPrice: number): boolean {
    switch (this.config.capitalRule) {
      case 'none':
        return true
      case 'cash':
        return this.cash >= cost
      case 'margin':
        return this.marginState(markPrice).available >= cost
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
