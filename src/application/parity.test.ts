import { describe, it, expect } from 'vitest'
import { replay, type Candles } from './replay.js'
import { TradingViewSim, DCA_PINE_SIM_CONFIG } from '../infrastructure/brokers/tradingview-sim.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { bars, column, dense } from '../domain/indicators/__golden__/harness.js'
import trades from '../domain/indicators/__golden__/bless-1h.trades.json' with { type: 'json' }

/**
 * THE acceptance test of the executor: the port must reproduce TradingView's
 * Strategy Tester trade list on the same candles, trade for trade.
 *
 * The trade list was captured from tools/DCA-logged.pine on BLESSUSDT.P 1H
 * over the full chart history. The indicator fixture covers the last 4001
 * bars of it, so the comparison is restricted to trades entered inside that
 * window, after a resync point where both sides are flat and the port's
 * recursive indicators have converged.
 */

type TvClosed = {
  id: string; entryTime: number; entryPrice: number; exitTime: number
  exitPrice: number; size: number; profit: number; commission: number; exitComment: string
}

const candles: Candles = {
  time: dense(column(bars, 'time')),
  open: dense(column(bars, 'open')),
  high: dense(column(bars, 'high')),
  low: dense(column(bars, 'low')),
  close: dense(column(bars, 'close')),
  volume: dense(column(bars, 'volume')),
}

const { mintick, initial_capital: initialCapital } = trades.syminfo as { mintick: number; initial_capital: number }
const QTY_STEP = 0.001 // every size in the trade list has at most 3 decimals
const newSim = () => new TradingViewSim({ ...DCA_PINE_SIM_CONFIG, mintick, qtyStep: QTY_STEP, initialCapital })

const windowStart = candles.time[0]!
const iso = (t: number) => new Date(t).toISOString().slice(0, 13)

/**
 * Pass 1 — find the resync point: the first TradingView entry inside the
 * window that opens a NEW cycle (id 'Entry'), late enough for EMA-200 to
 * have converged (bar ≥ 2200), on a bar where the port also opens an Entry.
 */
const tvClosed = (trades.closed as TvClosed[]).filter((t) => t.entryTime >= windowStart)
const barIndexOf = (time: number) => candles.time.indexOf(time)
const CONVERGED_BAR = 2200
const pass1 = replay(candles, DEFAULT_PARAMS, newSim())
const resync = tvClosed.find((t) => {
  const i = barIndexOf(t.entryTime)
  return t.id === 'Entry' && i >= CONVERGED_BAR && pass1.broker.closedTrades.some((s) => s.entryTime === t.entryTime && s.id === 'Entry')
})

/**
 * Pass 2 — the comparison run. TradingView's margin rule looks at EQUITY,
 * which carries every realised trade since January; the fixture window only
 * starts in April. So at the resync bar (both sides flat) the simulator is
 * seeded with TradingView's own cash: initial capital plus every profit it
 * had realised by then. From there the two must walk in lockstep.
 */
const tvCashAt = (time: number) =>
  initialCapital + (trades.closed as TvClosed[]).filter((t) => t.exitTime <= time).reduce((sum, t) => sum + t.profit, 0)

const sim = newSim()
const result = replay(candles, DEFAULT_PARAMS, sim, {
  beforeBar: (_i, time, broker) => {
    if (resync && time === resync.entryTime) {
      expect(broker.openTrades, 'port must be flat at the resync bar').toHaveLength(0)
      sim.seedCash(tvCashAt(time))
    }
  },
})

const key = (t: { id: string; entryTime: number }) => `${iso(t.entryTime)} ${t.id}`

describe('parity — TradingView trade list vs the port', () => {
  it('the inputs TradingView ran with are exactly DEFAULT_PARAMS', () => {
    const inputs = trades.inputs as Record<string, unknown>
    expect(inputs.max_levels).toBe(DEFAULT_PARAMS.maxLevels)
    expect(inputs.confirm_bars).toBe(DEFAULT_PARAMS.confirmBars)
    expect(inputs.min_gap_pct).toBe(DEFAULT_PARAMS.minGapPct)
    expect(inputs.bbw_max).toBe(DEFAULT_PARAMS.bbwMax)
    expect(inputs.rescue_levels).toBe(DEFAULT_PARAMS.rescueLevels)
  })

  it('finds a resync point inside the converged window', () => {
    expect(resync, 'no common fresh Entry after convergence').toBeDefined()
  })

  it('matches every trade from the resync point on: entry, exit, size and profit', () => {
    const from = resync!.entryTime
    const tv = tvClosed.filter((t) => t.entryTime >= from).sort((a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id))
    const port = result.broker.closedTrades.filter((t) => t.entryTime >= from).sort((a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id))

    const tvKeys = tv.map(key)
    const portKeys = port.map(key)
    const firstDiff = tvKeys.findIndex((k, i) => k !== portKeys[i])
    expect(
      portKeys,
      `first divergence at #${firstDiff}: tv=${tvKeys[firstDiff]} port=${portKeys[firstDiff]}\n` +
        `tv (${tv.length}): ${tvKeys.slice(Math.max(0, firstDiff - 2), firstDiff + 4).join(' | ')}\n` +
        `port (${port.length}): ${portKeys.slice(Math.max(0, firstDiff - 2), firstDiff + 4).join(' | ')}`,
    ).toEqual(tvKeys)

    for (let i = 0; i < tv.length; i++) {
      const a = tv[i]!
      const b = port[i]!
      const at = `${key(a)}`
      expect(b.exitTime, `${at} exit time`).toBe(a.exitTime)
      expect(b.entryPrice, `${at} entry price`).toBeCloseTo(a.entryPrice, 9)
      expect(b.exitPrice, `${at} exit price`).toBeCloseTo(a.exitPrice, 9)
      expect(b.qty, `${at} size`).toBeCloseTo(a.size, 6)
      expect(b.profit, `${at} profit`).toBeCloseTo(a.profit, 6)
      expect(b.exitComment, `${at} exit comment`).toBe(a.exitComment)
    }
  })

  it('the still-open position at the end matches: same entries, same prices', () => {
    const closedKeys = new Set((trades.closed as TvClosed[]).map((t) => `${t.entryTime}|${t.id}`))
    const tvOpen = (trades.entries as { time: number; id: string; price: number; size: number }[])
      .filter((e) => !closedKeys.has(`${e.time}|${e.id}`))
      .sort((a, b) => a.time - b.time)
    const portOpen = [...result.broker.openTrades].sort((a, b) => a.entryTime - b.entryTime)
    expect(portOpen.map((t) => `${iso(t.entryTime)} ${t.id}`)).toEqual(tvOpen.map((t) => `${iso(t.time)} ${t.id}`))
    tvOpen.forEach((e, i) => {
      expect(portOpen[i]!.entryPrice, `${e.id} price`).toBeCloseTo(e.price, 9)
      expect(portOpen[i]!.qty, `${e.id} size`).toBeCloseTo(e.size, 6)
    })
  })
})
