/**
 * The deep rung: the ONE DCA buy a holding may make after its first.
 *
 * *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay un
 * rebote de 10%, nueva compra DCA de $20.* The operator.
 *
 * It fires only when all three hold:
 *
 * - **(a) armed** — the lowest live price seen since the holding's first buy is
 *   MORE than `fallPct` (80) under that first buy. Exactly 80 does not arm: the
 *   operator said *más de*.
 * - **(b) rebounded** — the live price is at least `reboundPct` (10) over that
 *   low. The low keeps falling while armed, and the rebound is always measured
 *   from where it is now, never from where it armed.
 * - **(c) at a loss** — the live price is under the average cost, as in every
 *   rung rule he has given. A rebound that put the position back in profit has
 *   nothing left to average.
 *
 * And once it has bought, nothing more is ever bought for that holding: it
 * fires only while the holding holds its first buy alone.
 *
 * ## Why the low is a state
 *
 * The rebound is measured from a price the sweep saw minutes or hours ago, so
 * the low has to outlive the sweep and the process. It belongs to the HOLDING
 * — the time of its first buy — so a position that sold and bought back starts
 * a new low from its new entry instead of inheriting a crash it never lived
 * through. See `PriceLow` and `keepPriceLow`.
 *
 * Pure; the caller brings the prices, the low and the buys.
 */

/** The lowest live price a holding has seen, and which holding it belongs to. */
export interface PriceLow {
  /** The lowest live price seen since the holding's first buy. */
  readonly price: number
  /** When it was seen, in epoch milliseconds. */
  readonly at: number
  /** The time of the holding's first buy — which holding this low belongs to. */
  readonly holdingSince: number
}

export interface DeepRungPolicy {
  /** How far under the first buy, in percent, the low must go — strictly — to arm the rung. */
  readonly fallPct: number
  /** How far over the low, in percent, the live price must come back to buy it. */
  readonly reboundPct: number
  /** Entries the venue holds: the first buy plus this rung. Under two, the rung never fires. */
  readonly maxEntries: number
}

/** More than 80% down, a 10% rebound, and the first buy plus one rung. */
export const DEFAULT_DEEP_RUNG_POLICY: DeepRungPolicy = { fallPct: 80, reboundPct: 10, maxEntries: 2 }

/**
 * Rounding room on a price computed from a percentage, relative. Far below any
 * move a real price makes, and enough that exactly 80% is 80% and exactly 10%
 * is 10% however the float rounded.
 */
const EPSILON = 1e-9

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/** The price the low must fall UNDER to arm the rung: the first buy less `fallPct`. */
export const deepRungLine = (firstBuyPrice: number, policy: DeepRungPolicy): number =>
  (firstBuyPrice * (100 - policy.fallPct)) / 100

/** The price the live price must reach to buy: the low plus `reboundPct`. */
export const reboundLine = (lowPrice: number, policy: DeepRungPolicy): number =>
  (lowPrice * (100 + policy.reboundPct)) / 100

/** Whether the low is MORE than `fallPct` under the first buy. No low, or no first buy, never is. */
export function deepRungArmed(firstBuyPrice: number, lowPrice: number | null, policy: DeepRungPolicy): boolean {
  if (!positive(firstBuyPrice) || !positive(lowPrice)) return false
  return lowPrice < deepRungLine(firstBuyPrice, policy) * (1 - EPSILON)
}

/** The rung to buy now — always `1`, `DCA-1` — or null to wait. */
export function nextDeepRung(
  input: {
    /** Buys the holding holds: the first buy alone is one. */
    readonly entries: number
    readonly firstBuyPrice: number
    /** The holding's low, as the sweep has seen it; null before any. */
    readonly lowPrice: number | null
    readonly priceUsd: number
    /** The holding's average cost; null when it holds nothing. */
    readonly avgCostUsd: number | null
  },
  policy: DeepRungPolicy,
): 1 | null {
  const { entries, firstBuyPrice, lowPrice, priceUsd, avgCostUsd } = input
  if (entries !== 1 || policy.maxEntries < 2) return null
  if (!positive(priceUsd) || !positive(avgCostUsd) || !positive(lowPrice)) return null
  if (!deepRungArmed(firstBuyPrice, lowPrice, policy)) return null
  if (priceUsd < reboundLine(lowPrice, policy) * (1 - EPSILON)) return null
  return priceUsd < avgCostUsd ? 1 : null
}

/**
 * One live price folded into a holding's low. A low belonging to another
 * holding is ignored — the new holding starts its own — and a price that is not
 * a price changes nothing: silence is not a fall.
 */
export function nextPriceLow(
  stored: PriceLow | null | undefined,
  priceUsd: number,
  holding: { readonly since: number; readonly at: number },
): PriceLow | null {
  const current = stored && stored.holdingSince === holding.since ? stored : null
  if (!positive(priceUsd)) return current
  if (current !== null && priceUsd >= current.price) return current
  return { price: priceUsd, at: holding.at, holdingSince: holding.since }
}

/**
 * Whether a low is worth writing over the stored one: a first low, a new
 * holding's, or a lower price. Never the clock alone — every write is the whole
 * position row, and a low rewritten every thirty seconds is a write nobody
 * reads.
 */
export function priceLowMoved(stored: PriceLow | null | undefined, next: PriceLow | null): boolean {
  if (next === null) return false
  if (!stored || stored.holdingSince !== next.holdingSince) return true
  return next.price < stored.price
}

/**
 * Whether a low is worth writing at all: it moved, AND it is under the arming
 * line.
 *
 * Every write is the whole position row, and what once ran this project out of
 * its free tier was NETWORK, not storage. Above the line no decision reads the
 * low — the rung is not armed — and once it is armed, the low it rebounds from
 * is under the line by construction, because it only ever falls. So a low
 * above the line can be dropped without changing a single decision, and one
 * under it is written every time it falls: the rebound is measured exactly.
 */
export function priceLowWorthWriting(
  stored: PriceLow | null | undefined,
  next: PriceLow | null,
  firstBuyPrice: number,
  policy: DeepRungPolicy,
): boolean {
  return next !== null && deepRungArmed(firstBuyPrice, next.price, policy) && priceLowMoved(stored, next)
}

/**
 * What the store keeps when a low is written. Every step of the cycle writes
 * the whole row back from a snapshot read before the sweep moved the low, and
 * none of those may RAISE it — raised, a crash the holding lived through would
 * be forgotten and the rebound measured from somewhere it never was. So: the
 * same holding keeps the lower price, a newer holding's low replaces it whole,
 * and a write with an older holding's low, or none, keeps what is stored.
 */
export function keepPriceLow(
  stored: PriceLow | null | undefined,
  written: PriceLow | null | undefined,
): PriceLow | null {
  if (!written) return stored ?? null
  if (!stored || written.holdingSince > stored.holdingSince) return written
  if (written.holdingSince === stored.holdingSince && written.price < stored.price) return written
  return stored
}
