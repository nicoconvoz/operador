import { type DenseSeries } from './series.js'
import { atr } from './atr.js'
import { assertAligned } from './tr.js'

/**
 * Pine's direction encoding, kept verbatim for parity:
 *
 *   -1 → UPTREND   (price above the line, line is the lower band)
 *   +1 → DOWNTREND (price below the line, line is the upper band)
 *
 * It reads backwards. It is also what the strategy's own code assumes:
 * `st_dir < 0` means bullish, and `ta.crossover(st_dir, 0)` is the bearish
 * flip that triggers the safety exit. Renaming it would be friendlier and
 * would break parity — so it stays, loudly documented.
 */
export type SupertrendDirection = -1 | 1

export interface Supertrend {
  readonly line: readonly (number | null)[]
  readonly direction: readonly (SupertrendDirection | null)[]
}

/**
 * Supertrend — Pine Script `ta.supertrend(factor, atrPeriod)`, transcribed
 * from the reference implementation in the Pine documentation.
 *
 * Both bands ratchet: the lower band may only rise (unless price closed below
 * it) and the upper band may only fall (unless price closed above it). The
 * line is whichever band the current direction selects, and the direction
 * flips when price closes through the band it is currently tracking.
 *
 * Golden data confirms it: over 3001 converged bars, the line matches to the
 * export grid and the direction has zero disagreements.
 */
export function supertrend(
  high: DenseSeries,
  low: DenseSeries,
  close: DenseSeries,
  factor: number,
  atrLength: number,
): Supertrend {
  assertAligned(high, low, close)

  const atrSeries = atr(high, low, close, atrLength)
  const n = high.length
  const line: (number | null)[] = new Array<number | null>(n).fill(null)
  const direction: (SupertrendDirection | null)[] = new Array<SupertrendDirection | null>(n).fill(null)

  // Previous bar's FINAL band values and line — Pine's `upperBand[1]` refers to
  // the reassigned variable, not the raw `src + factor * atr` of that bar.
  let previousUpper: number | null = null
  let previousLower: number | null = null
  let previousLine: number | null = null

  for (let i = 0; i < n; i++) {
    const currentAtr = atrSeries[i]
    if (currentAtr === null || currentAtr === undefined) continue

    const source = (high[i]! + low[i]!) / 2
    let upper = source + factor * currentAtr
    let lower = source - factor * currentAtr

    // nz(band[1]) → 0 before the first computed bar.
    const priorUpper = previousUpper ?? 0
    const priorLower = previousLower ?? 0
    // close[1] is na on bar 0; in Pine a comparison against na is false.
    const previousClose = i > 0 ? close[i - 1]! : null

    lower =
      lower > priorLower || (previousClose !== null && previousClose < priorLower)
        ? lower
        : priorLower
    upper =
      upper < priorUpper || (previousClose !== null && previousClose > priorUpper)
        ? upper
        : priorUpper

    let currentDirection: SupertrendDirection
    const previousAtr = i > 0 ? atrSeries[i - 1] : null
    if (previousAtr === null || previousAtr === undefined) {
      currentDirection = 1
    } else if (previousLine === priorUpper) {
      currentDirection = close[i]! > upper ? -1 : 1
    } else {
      currentDirection = close[i]! < lower ? 1 : -1
    }

    const currentLine = currentDirection === -1 ? lower : upper
    line[i] = currentLine
    direction[i] = currentDirection

    previousUpper = upper
    previousLower = lower
    previousLine = currentLine
  }

  return { line, direction }
}
