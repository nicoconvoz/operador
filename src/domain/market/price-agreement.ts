/**
 * Do two independent prices for the same token agree?
 *
 * The engine reads a price from CANDLES and the scanner reads one from the
 * MARKET feed, and twice now they have disagreed by four orders of magnitude on
 * a token holding money:
 *
 * | | ZCAT | USDF |
 * |---|---|---|
 * | market | $0.1318 | — |
 * | candles | $1,429.49 | $0.0000021879 |
 * | bought at | — | $0.031564 |
 * | ratio | **10,846×** | **14,426×** |
 *
 * Neither was a rug and neither was a crash: it is a UNIT nobody agreed on.
 * ZCAT converted $15.11 into a hundredth of the tokens it should have bought;
 * USDF was sold by a freeze exit at the candle price and turned $15.06 into a
 * tenth of a cent.
 *
 * **One definition, used in both places.** The gate refuses such a token at the
 * door and the engine refuses to TRADE one it already holds — and if those two
 * computed the ratio differently, the screen and the machine would eventually
 * disagree about which tokens are safe, which is the failure the read model
 * exists to prevent.
 *
 * Symmetric on purpose: which of the two is wrong is unknowable from here, and
 * a check that only fires one way would pass half the cases.
 */
export function priceRatio(a: number, b: number): number | null {
  if (!(a > 0) || !(b > 0)) return null
  return Math.max(a / b, b / a)
}

/**
 * True only on a MEASURED disagreement.
 *
 * A missing price, a zero or a NaN is silence, and silence is not evidence —
 * the rule the whole scanner runs on. Reading an absent second opinion as a
 * mismatch would halt every position the feed happened to be quiet about.
 */
export function pricesDisagree(a: number | null | undefined, b: number | null | undefined, maxRatio: number): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  const ratio = priceRatio(a, b)
  return ratio !== null && ratio > maxRatio
}
