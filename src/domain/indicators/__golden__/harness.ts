import { expect } from 'vitest'
import fixture from './bless-1h.json' with { type: 'json' }

/**
 * Shared harness for golden parity tests against TradingView's own values.
 *
 * Golden values are an EXTERNAL ORACLE. They are never regenerated from this
 * codebase's output — doing so would turn every test here into a mirror that
 * confirms whatever we already compute.
 */

export type GoldenBar = Record<string, number | null | undefined>

export const bars = fixture.bars as GoldenBar[]
export const seed = fixture.seed as GoldenBar[]

/**
 * The exporter formats values with 15 decimal places (the first capture used
 * 10, and its residual floor was exactly that rounding — see git history).
 *
 * Parity is asserted against the EXPORT GRID rather than against a fuzzy
 * percentage: a correct implementation lands on the same grid point, and a
 * wrong one misses by orders of magnitude (a mis-seeded EMA-200 was off by
 * 0.36%, roughly ten orders above this floor).
 */
export const GOLDEN_DECIMALS = 15
const GRID = 10 ** -GOLDEN_DECIMALS

/**
 * Tolerance is the coarser of the export grid and a relative floor for
 * floating-point accumulation noise.
 *
 * At 15 decimals the grid is finer than the arithmetic: two IEEE-754
 * implementations summing the same window in a different order, or carrying
 * an EMA-200 through two thousand recursions, land ~1e-11 apart. Observed:
 * 5e-12 on EMA-200, 1.4e-12 on BBW, 2e-11 on a tiny stdev. None of it is
 * semantic — a mis-seeded EMA-200 sits at 4e-3, seven orders above.
 *
 * 1e-9 relative is therefore the honest line: loose enough to ignore float
 * noise, tight enough that no formula or seeding error can hide under it.
 */
const FLOAT_NOISE_RELATIVE = 1e-9
const tolerance = (expected: number) =>
  Math.max(1.5 * GRID, Math.abs(expected) * FLOAT_NOISE_RELATIVE)

export function expectGolden(
  actual: number | null | undefined,
  expected: number | null | undefined,
  at: string,
): void {
  if (expected === null || expected === undefined) {
    expect(actual ?? null, `${at}: expected na`).toBeNull()
    return
  }
  expect(actual ?? null, `${at}: expected a value, got na`).not.toBeNull()
  const delta = Math.abs(actual! - expected)
  expect(
    delta <= tolerance(expected),
    `${at}: got ${actual}, want ${expected} (delta ${delta.toExponential(3)})`,
  ).toBe(true)
}

/** Column as a Series, with missing cells normalised to `na`. */
export const column = (rows: GoldenBar[], key: string): (number | null)[] =>
  rows.map((row) => row[key] ?? null)

/**
 * OHLCV columns must have no gaps — a hole there is a broken pipeline, not a
 * legitimate `na`. Fail at fixture load rather than deep inside an indicator.
 */
export const dense = (series: readonly (number | null)[]): number[] =>
  series.map((value, i) => {
    if (value === null) throw new Error(`golden fixture has a gap at bar ${i}`)
    return value
  })

/** Single cell, normalised to `na`. */
export const cell = (rows: GoldenBar[], i: number, key: string): number | null =>
  rows[i]?.[key] ?? null
