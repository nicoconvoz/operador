import { describe, it, expect } from 'vitest'
import { sma } from './sma.js'
import golden from './__golden__/bless-1h.json' with { type: 'json' }

/**
 * Golden parity for ta.sma against TradingView's own values over a 301-bar
 * 1H window, using two independent columns:
 *
 *   bb_basis — ta.bb's basis, which IS ta.sma(close, 50)
 *   vol_ma   — ta.sma(volume, 10)
 *
 * Volume is in the tens of millions and price in the thousandths, so these are
 * compared RELATIVELY. An absolute tolerance that is strict for 0.008 is
 * meaningless for 47,286,856, and one that fits volume would let a price error
 * through untouched.
 */

type Bar = Record<string, number | null | undefined>
const bars = golden.bars as Bar[]

/** Indexed access under noUncheckedIndexedAccess widens to `undefined`; a
 *  missing column and an explicit `na` are the same thing to these tests. */
const column = (key: string): (number | null)[] => bars.map((bar) => bar[key] ?? null)
const cell = (i: number, key: string): number | null => bars[i]?.[key] ?? null

/** Relative tolerance — 1e-9 is far tighter than any real divergence. */
const expectRelClose = (actual: number | null, expected: number | null, at: string) => {
  if (expected === null) {
    expect(actual, at).toBeNull()
    return
  }
  expect(actual, at).not.toBeNull()
  const rel = Math.abs(actual! - expected) / Math.abs(expected)
  expect(rel, `${at} (got ${actual}, want ${expected})`).toBeLessThan(1e-9)
}

describe('sma — golden parity against TradingView', () => {
  it('has a usable export window', () => {
    expect(bars.length).toBeGreaterThan(100)
  })

  it('matches ta.sma(close, 50) via the Bollinger basis', () => {
    const actual = sma(column('close'), 50)
    // Bars before index 49 cannot be reproduced: TradingView warmed them up on
    // history that precedes this window.
    for (let i = 49; i < bars.length; i++) {
      expectRelClose(actual[i] ?? null, cell(i, 'bb_basis'), `close sma@${i}`)
    }
  })

  it('matches ta.sma(volume, 10) exactly', () => {
    const actual = sma(column('volume'), 10)
    for (let i = 9; i < bars.length; i++) {
      expectRelClose(actual[i] ?? null, cell(i, 'vol_ma'), `volume sma@${i}`)
    }
  })

  it('PROVES ta.bb returns [basis, upper, lower], not [upper, mid, lower]', () => {
    // The evidence that DCA.pine mislabels the tuple. Two independent checks:
    // the basis is the SMA, and the bands sit symmetrically around it.
    const mid = bars.length >> 1
    const basis = cell(mid, 'bb_basis')!
    const upper = cell(mid, 'bb_upper')!
    const lower = cell(mid, 'bb_lower')!
    expect(lower).toBeLessThan(basis)
    expect(basis).toBeLessThan(upper)

    const below = basis - lower
    const above = upper - basis
    expect(Math.abs(above - below) / below).toBeLessThan(1e-9)
  })
})
