import { describe, it, expect } from 'vitest'
import { replay, type Candles } from './replay.js'
import { TradingViewSim, DCA_PINE_SIM_CONFIG } from '../infrastructure/brokers/tradingview-sim.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { bars, column, dense } from '../domain/indicators/__golden__/harness.js'

/**
 * End-to-end replay over the golden BLESS 1H window with the TradingView
 * broker simulator. These tests pin the execution model wiring; the trade-
 * for-trade comparison against TradingView's own list lives in parity.test.ts.
 */

const candles: Candles = {
  time: dense(column(bars, 'time')),
  open: dense(column(bars, 'open')),
  high: dense(column(bars, 'high')),
  low: dense(column(bars, 'low')),
  close: dense(column(bars, 'close')),
  volume: dense(column(bars, 'volume')),
}

// BLESS quotes to 6 decimals in the fixture; the real mintick comes from the
// SYMINFO line of the trade log. Until then, a plausible tick.
const sim = () => new TradingViewSim({ ...DCA_PINE_SIM_CONFIG, mintick: 0.000001, qtyStep: 0.001 })

describe('replay — execution model wiring', () => {
  const result = replay(candles, DEFAULT_PARAMS, sim())

  it('walks every bar and keeps a state per bar', () => {
    expect(result.states).toHaveLength(bars.length)
    expect(result.orders).toHaveLength(bars.length)
  })

  it('the strategy trades at all on this window', () => {
    expect(result.fills.length).toBeGreaterThan(0)
  })

  it('every fill lands one bar after its order, at that bar’s open plus/minus a tick', () => {
    for (let i = 0; i < bars.length - 1; i++) {
      for (const order of result.orders[i]!) {
        const nextTime = candles.time[i + 1]!
        const fill = result.fills.find((f) => f.time === nextTime && (order.kind === 'closeAll' ? f.side === 'sell' : f.id === order.id))
        if (!fill) continue // rejected (pyramiding) — verified separately
        const open = candles.open[i + 1]!
        if (fill.side === 'buy') expect(fill.price).toBeCloseTo(open + 0.000001, 12)
        else expect(fill.price).toBeCloseTo(open - 0.000001, 12)
      }
    }
  })

  it('never holds more than pyramiding entries', () => {
    let openCount = 0
    let maxOpen = 0
    for (const fill of result.fills) {
      if (fill.side === 'buy') openCount++
      else openCount = 0
      maxOpen = Math.max(maxOpen, openCount)
    }
    expect(maxOpen).toBeLessThanOrEqual(DCA_PINE_SIM_CONFIG.pyramiding)
  })

  it('the state machine sees the position the bar after the fill, not before', () => {
    // Find the first entry order; on that bar the machine was flat, on the next
    // bar the broker reports the position and was_in_trade flips.
    const i = result.orders.findIndex((os) => os.some((o) => o.kind === 'entry'))
    expect(i).toBeGreaterThan(0)
    expect(result.states[i]!.level).toBe(1)
    expect(result.states[i]!.wasInTrade).toBe(false)
    expect(result.states[i + 1]!.wasInTrade).toBe(true)
  })

  it('a close_all resets the cycle on the next bar — and that bar may already re-enter', () => {
    // Pine evaluates the reset before the entry doors on the same bar, so the
    // bar after an exit is either flat with the re-entry door open, or already
    // in a fresh level-1 position anchored at that bar's close.
    let resets = 0
    let sameBarReentries = 0
    for (let i = 0; i < bars.length - 1; i++) {
      if (!result.orders[i]!.some((o) => o.kind === 'closeAll')) continue
      resets++
      const next = result.states[i + 1]!
      const reentered = result.orders[i + 1]!.some((o) => o.kind === 'entry')
      if (reentered) {
        sameBarReentries++
        expect(next.level, `bar ${i + 1}`).toBe(1)
        expect(next.ep1, `bar ${i + 1}`).toBe(candles.close[i + 1])
        expect(next.awaitReentry, `bar ${i + 1}`).toBe(false)
      } else {
        expect(next.level, `bar ${i + 1}`).toBe(0)
        expect(next.awaitReentry, `bar ${i + 1}`).toBe(true)
      }
    }
    expect(resets).toBeGreaterThan(0)
    expect(sameBarReentries).toBeGreaterThan(0) // it happens on this window (bar 288)
  })
})
