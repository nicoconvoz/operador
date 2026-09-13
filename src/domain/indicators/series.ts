/**
 * A Pine Script series: an ordered sequence of bar-indexed values where a value
 * may be absent.
 *
 * `null` is this codebase's representation of Pine's `na`. We deliberately do
 * NOT use `NaN`: `NaN !== NaN` makes accidental equality bugs silent, and in
 * code that moves money a silent comparison failure is unacceptable.
 */
export type Series = readonly (number | null)[]

/** A series with no gaps — every bar has a value. */
export type DenseSeries = readonly number[]

export class IndicatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndicatorError'
  }
}

/** Guards the `length` parameter shared by every windowed indicator. */
export function assertLength(length: number, label = 'length'): void {
  if (!Number.isInteger(length) || length < 1) {
    throw new IndicatorError(`${label} must be a positive integer, received ${length}`)
  }
}
