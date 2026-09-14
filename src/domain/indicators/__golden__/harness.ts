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
 * The exporter formats values with `"#.##########"` — 10 decimal places. On a
 * price near 0.0105 that quantises to roughly 5e-7 percent, which is exactly
 * the residual floor observed when the implementation is otherwise perfect.
 *
 * So parity is asserted against the EXPORT GRID rather than against a fuzzy
 * percentage: a correct implementation lands on the same grid point, and a
 * wrong one misses by orders of magnitude (a mis-seeded EMA-200 was off by
 * 0.36%, roughly six orders above this floor).
 */
export const GOLDEN_DECIMALS = 10
const GRID = 10 ** -GOLDEN_DECIMALS

/**
 * Tolerance is the coarser of the export grid and float64's own resolution at
 * this magnitude. Volume runs to tens of millions, where 1e-10 absolute is far
 * below what a double can even represent.
 */
const tolerance = (expected: number) =>
  Math.max(1.5 * GRID, Math.abs(expected) * 1e-12)

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

/** Single cell, normalised to `na`. */
export const cell = (rows: GoldenBar[], i: number, key: string): number | null =>
  rows[i]?.[key] ?? null
