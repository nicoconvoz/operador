/**
 * The dip-bounce ladder: EVERY buy of a holding, the first one included, on one
 * rule.
 *
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla.* The operator — then *disminuí los
 * escalones a 20.*
 *
 * - **The reference.** For the FIRST buy, the highest live price seen since the
 *   watch began — it starts at the first price it sees. For every later buy,
 *   the price of the LAST buy of the holding.
 * - **Armed** once the live price is at or below the reference less `dipPct`.
 *   While armed, the lowest price is tracked.
 * - **Buy** once the live price is at or above that low plus `bouncePct` —
 *   and still under the reference. The buy becomes the reference and the watch
 *   is unarmed: the next buy needs a fresh dip under it and a fresh bounce off
 *   a fresh low.
 * - **At most `maxSteps` buys per holding**, the first included. A new holding
 *   — after a sale that emptied it — starts over.
 *
 * ## Every buy is under the one before, so no at-a-loss check is needed
 *
 * A buy fires only while armed, and only strictly under the reference; after
 * it, the reference is that buy's price. So each buy is strictly under the
 * last, every earlier buy paid at least what the last one did, and the average
 * cost of the holding is always ABOVE the next buy. Asking "is the position at
 * a loss" before buying would ask a question whose answer is always yes.
 *
 * The "still under the reference" is the one condition the operator did not
 * state, and it is what keeps that true on a live feed. The sweep looks every
 * thirty seconds, and a price can gap from under the arming line straight back
 * over the reference between two looks. That is not a 2% bounce — the dip was
 * undone — and buying there would buy ABOVE the last buy. So it disarms
 * instead, and the next buy waits for a new dip.
 *
 * ## Why the watch is a state
 *
 * The high and the low are prices the sweep saw minutes or hours ago, so they
 * have to outlive the sweep and the process. The watch belongs to the HOLDING
 * — the time of its first buy, or `null` while nothing is held — so a position
 * that sold and buys again starts from the price it sees, not from a high it
 * no longer lives under. And a watch older than the holding's last buy is
 * stale: a sweep that bought and died before writing its watch left the old
 * one behind, and the reference is then what that buy PAID.
 *
 * Pure; the caller brings the price, the stored watch and the holding's buys.
 */

export interface DipBouncePolicy {
  /** How far under the reference, in percent, the price must fall to arm the watch. */
  readonly dipPct: number
  /** How far over the tracked low, in percent, the price must come back to buy. */
  readonly bouncePct: number
  /** Buys per holding, the first included. */
  readonly maxSteps: number
}

/** A 3% dip, a 2% bounce, twenty buys. The operator's three numbers. */
export const DEFAULT_DIP_BOUNCE_POLICY: DipBouncePolicy = { dipPct: 3, bouncePct: 2, maxSteps: 20 }

/** One holding's watch, as the store keeps it. */
export interface DipWatch {
  /** The price the dip is measured from: the high before the first buy, the last buy after it. */
  readonly reference: number
  /** While armed, the lowest price seen since it armed; null otherwise. */
  readonly low: number | null
  readonly armed: boolean
  /** When it was last moved, in epoch milliseconds. The store keeps the newer. */
  readonly at: number
  /** The time of the holding's first buy — which holding this is — or null before any. */
  readonly holdingSince: number | null
}

export interface DipBounceInput {
  readonly priceUsd: number
  readonly at: number
  /** The holding's buys, oldest first: when, and the price paid. Empty while nothing is held. */
  readonly buys: readonly { readonly time: number; readonly price: number }[]
}

export interface DipBounceStep {
  /** The watch after this price; null only when there is none and nothing to start one from. */
  readonly watch: DipWatch | null
  /** 'buy': the next step is due, now, at this price. */
  readonly action: 'none' | 'buy'
  /** Which buy this would be, counting from one — the first buy is 1. */
  readonly step: number
  /** On a buy: how far the low fell under the reference, in percent. */
  readonly fellPct: number | null
  /** On a buy: how far the price came back off the low, in percent. */
  readonly bouncedPct: number | null
}

/**
 * Rounding room on a price computed from a percentage, relative. Far below any
 * move a real price makes, and enough that exactly 3% is 3% and exactly 2% is
 * 2% however the float rounded.
 */
const EPSILON = 1e-9

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/** The price the watch arms at: the reference less `dipPct`. */
export const dipArmLine = (reference: number, policy: DipBouncePolicy): number =>
  (reference * (100 - policy.dipPct)) / 100

/** The price an armed watch buys at: the low plus `bouncePct`. */
export const bounceLine = (low: number, policy: DipBouncePolicy): number =>
  (low * (100 + policy.bouncePct)) / 100

/** A moved watch is stamped after the one it replaces, so the store's newer-wins merge always takes it. */
const stampAfter = (at: number, stored: DipWatch | null | undefined): number =>
  stored ? Math.max(at, stored.at + 1) : at

/** One live price folded into the holding's watch — and whether it buys. */
export function nextDipBounce(
  stored: DipWatch | null | undefined,
  input: DipBounceInput,
  policy: DipBouncePolicy,
): DipBounceStep {
  const { priceUsd: price, at, buys } = input
  const step = buys.length + 1
  const none = (watch: DipWatch | null): DipBounceStep => ({ watch, action: 'none', step, fellPct: null, bouncedPct: null })
  // Silence is not a dip: a price that is not a price moves nothing.
  if (!positive(price)) return none(stored ?? null)

  const holdingSince = buys[0]?.time ?? null
  const last = buys[buys.length - 1] ?? null
  // The ladder is full: nothing left to watch for this holding.
  if (buys.length >= policy.maxSteps) return none(stored ?? null)

  // Only THIS holding's watch, and only if it saw the last buy.
  const current =
    stored && stored.holdingSince === holdingSince && (last === null || stored.at >= last.time) ? stored : null
  const stamp = stampAfter(at, stored)
  const firstBuy = last === null

  if (current === null) {
    // A fresh watch: what the last buy paid, or the first price seen.
    const reference = last?.price ?? price
    const armed = price <= dipArmLine(reference, policy) * (1 + EPSILON)
    return none({ reference, low: armed ? price : null, armed, at: stamp, holdingSince })
  }

  if (!current.armed) {
    // Before the first buy the reference is the HIGH, and it follows the price
    // up; after it, the reference is the last buy and never moves.
    const reference = firstBuy ? Math.max(current.reference, price) : current.reference
    const armed = price <= dipArmLine(reference, policy) * (1 + EPSILON)
    if (!armed && reference === current.reference) return none(current)
    return none({ reference, low: armed ? price : null, armed, at: stamp, holdingSince })
  }

  // Armed, and the price is back at or over the reference: the dip was undone
  // between two looks, not bounced. Disarmed, never bought — a buy here would
  // be above the last one.
  if (price >= current.reference) {
    const reference = firstBuy ? Math.max(current.reference, price) : current.reference
    return none({ reference, low: null, armed: false, at: stamp, holdingSince })
  }

  const low = Math.min(current.low ?? price, price)
  const watch: DipWatch = low === current.low ? current : { ...current, low, at: stamp }
  if (price < bounceLine(low, policy) * (1 - EPSILON)) return none(watch)
  return {
    watch,
    action: 'buy',
    step,
    fellPct: (1 - low / current.reference) * 100,
    bouncedPct: (price / low - 1) * 100,
  }
}

/**
 * The watch after a buy: the buy's price is the reference, unarmed — the next
 * buy needs a fresh dip under it. `boughtAt` is the time the fill was recorded
 * under, so the watch is never older than the buy it describes.
 */
export function watchAfterBuy(
  price: number,
  boughtAt: number,
  holdingSince: number,
  stored: DipWatch | null | undefined,
): DipWatch {
  return { reference: price, low: null, armed: false, at: stampAfter(boughtAt, stored), holdingSince }
}

/**
 * The smallest move of the high, or of an armed low, worth a write: 0.1%.
 *
 * Every write is the whole position row, and what ran this project out of its
 * free tier once was NETWORK, not storage. A tenth of a percent is finer than
 * both lines — a 3% dip and a 2% bounce — so skipping the smaller moves changes
 * no decision a real price makes.
 */
export const DIP_WATCH_WRITE_STEP_PCT = 0.1

/**
 * Whether a new watch is worth writing over the stored one: a first watch,
 * another holding's, a stale one, the watch arming or disarming, the reference
 * changing, or the high or the armed low moving 0.1% or more. Never the clock
 * alone.
 */
export function dipWatchWorthWriting(
  stored: DipWatch | null | undefined,
  next: DipWatch | null,
  /** The time of the holding's last buy; null while nothing is held. */
  lastBuyTime: number | null,
): boolean {
  if (next === null) return false
  if (!stored || stored.holdingSince !== next.holdingSince || stored.armed !== next.armed) return true
  if (lastBuyTime !== null && stored.at < lastBuyTime) return true
  const step = DIP_WATCH_WRITE_STEP_PCT / 100 - 1e-12
  if (Math.abs(next.reference / stored.reference - 1) >= step) return true
  return next.armed && next.low !== null && stored.low !== null && 1 - next.low / stored.low >= step
}

/**
 * What the store keeps when a watch is written: the one with the NEWER time.
 * Every step of the cycle writes the whole row back from a snapshot read before
 * the sweep moved the watch, and none of those may put an older watch, or none,
 * over it. The same rule as the liquidity watch.
 */
export function keepDipWatch(
  stored: DipWatch | null | undefined,
  written: DipWatch | null | undefined,
): DipWatch | null {
  if (!written) return stored ?? null
  if (!stored || written.at > stored.at) return written
  return stored
}
