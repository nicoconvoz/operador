import { assertLength, type DenseSeries } from './series.js'
import { rma } from './rma.js'
import { assertAligned, trueRange } from './tr.js'

export interface Dmi {
  /** +DI — upward directional index, 0..100. */
  readonly plus: readonly (number | null)[]
  /** -DI — downward directional index, 0..100. */
  readonly minus: readonly (number | null)[]
  /** ADX — trend strength regardless of direction, 0..100. */
  readonly adx: readonly (number | null)[]
}

/**
 * Directional Movement Index — Pine Script `ta.dmi(diLength, adxSmoothing)`,
 * transcribed from the reference implementation in the Pine documentation.
 *
 *   up      = change(high)          down    = -change(low)
 *   +DM     = up > down and up > 0 ? up : 0
 *   -DM     = down > up and down > 0 ? down : 0
 *   +DI     = 100 * rma(+DM, diLength) / rma(tr, diLength)
 *   -DI     = 100 * rma(-DM, diLength) / rma(tr, diLength)
 *   DX      = |+DI - -DI| / (+DI + -DI)        (denominator 1 when the sum is 0)
 *   ADX     = 100 * rma(DX, adxSmoothing)
 *
 * Two Pine details that matter for parity:
 *  - `ta.tr` here is called WITHOUT `handle_na`, so bar 0 is `na` (unlike ATR).
 *    Together with `change()` being `na` on bar 0, every RMA seeds one bar later.
 *  - `fixnan()` wraps +DI and -DI: if the smoothed true range is ever zero the
 *    division yields `na`, and Pine carries the previous value forward.
 *
 * Golden data: +DI, -DI and ADX all match to ~1e-9 once converged.
 */
export function dmi(
  high: DenseSeries,
  low: DenseSeries,
  close: DenseSeries,
  diLength: number,
  adxLength: number,
): Dmi {
  assertAligned(high, low, close)
  assertLength(diLength, 'diLength')
  assertLength(adxLength, 'adxLength')

  const n = high.length
  const plusDM: (number | null)[] = new Array<number | null>(n).fill(null)
  const minusDM: (number | null)[] = new Array<number | null>(n).fill(null)
  for (let i = 1; i < n; i++) {
    const up = high[i]! - high[i - 1]!
    const down = low[i - 1]! - low[i]!
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }

  // ta.tr without handle_na: first bar has no previous close → na.
  const tr: (number | null)[] = trueRange(high, low, close)
  tr[0] = null

  const smoothedTr = rma(tr, diLength)
  const smoothedPlus = rma(plusDM, diLength)
  const smoothedMinus = rma(minusDM, diLength)

  const plus: (number | null)[] = new Array<number | null>(n).fill(null)
  const minus: (number | null)[] = new Array<number | null>(n).fill(null)
  const dx: (number | null)[] = new Array<number | null>(n).fill(null)

  // fixnan() state: the last non-na +DI / -DI.
  let lastPlus: number | null = null
  let lastMinus: number | null = null

  for (let i = 0; i < n; i++) {
    const trValue = smoothedTr[i]
    const plusValue = smoothedPlus[i]
    const minusValue = smoothedMinus[i]

    if (trValue != null && plusValue != null && minusValue != null && trValue !== 0) {
      lastPlus = (100 * plusValue) / trValue
      lastMinus = (100 * minusValue) / trValue
    }
    if (lastPlus === null || lastMinus === null) continue

    plus[i] = lastPlus
    minus[i] = lastMinus
    const sum = lastPlus + lastMinus
    dx[i] = Math.abs(lastPlus - lastMinus) / (sum === 0 ? 1 : sum)
  }

  const adx = rma(dx, adxLength).map((value) => (value === null ? null : 100 * value))

  return { plus, minus, adx }
}
