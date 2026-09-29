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
 * ## A fall of more than `maxDipPct` is a collapse, not a dip
 *
 * "If it fell more than 20% it is a collapse, not a dip: don't buy there. Wait
 * until it is back within 20%." The operator, on the first hour and a half at
 * $5 a step: every token doing well bought on falls of 3% to 15.6%, and the
 * losers bought on 22% to 37% — YAP and BAGSPAY on 31–34%, −$35 of the −$52
 * lost between them.
 *
 * So an armed watch whose low goes MORE than `maxDipPct` under the reference
 * is CRASHED, and a crashed watch buys on no bounce. Once the live price is
 * back within `maxDipPct` of the reference, the collapse clears and the low
 * starts again at that price — still armed if it is still a 3% dip — so a buy
 * then needs a 2% bounce off the NEW low, and the dip that buys is always
 * between `dipPct` and `maxDipPct`. The same for the first buy, off the high,
 * and for every later one, off the last buy. A token that collapsed and never
 * comes back within the line simply never buys again: nothing is sold, it
 * stops adding.
 *
 * Exactly `maxDipPct` still buys — "more than" is what blocks — and zero turns
 * the ceiling off. A walk that never falls past it produces the very same
 * watches and the very same buys as the rule without it, field for field: the
 * crashed flag is only ever written while true.
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
  /**
   * The deepest dip that still buys, in percent under the reference: a low
   * MORE than this under it is a collapse, and nothing is bought until the
   * price is back within it. Zero: no ceiling.
   */
  readonly maxDipPct: number
}

/** A 3% dip, a 2% bounce, twenty buys, and nothing bought past a 20% fall. The operator's four numbers. */
export const DEFAULT_DIP_BOUNCE_POLICY: DipBouncePolicy = { dipPct: 3, bouncePct: 2, maxSteps: 20, maxDipPct: 20 }

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
  /**
   * True while the armed low is more than `maxDipPct` under the reference and
   * the price has not come back within it: no bounce buys. Only ever present
   * while true — a watch without it, every row written before it existed
   * included, is not crashed.
   */
  readonly crashed?: true
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
  /**
   * On the look the watch COLLAPSED — and only on that one: how far the low
   * fell under the reference, in percent. Null on every other look, so the
   * caller says it once per collapse, never once per sweep.
   */
  readonly crashedPct: number | null
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

/**
 * The collapse line: the reference less `maxDipPct`. A low strictly under it
 * is a collapse; a price back at or over it is within the ceiling again.
 */
export const crashLine = (reference: number, policy: DipBouncePolicy): number =>
  (reference * (100 - policy.maxDipPct)) / 100

/** Whether a low is a collapse rather than a dip: MORE than `maxDipPct` under the reference. Never, with the ceiling off. */
const collapsed = (low: number, reference: number, policy: DipBouncePolicy): boolean =>
  policy.maxDipPct > 0 && low < crashLine(reference, policy) * (1 - EPSILON)

/** How far a low fell under the reference, in percent. */
const fallPct = (low: number, reference: number): number => (1 - low / reference) * 100

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
  const none = (watch: DipWatch | null, crashedPct: number | null = null): DipBounceStep =>
    ({ watch, action: 'none', step, fellPct: null, bouncedPct: null, crashedPct })
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

  /**
   * A watch that has just armed at this price — which is its low — and, if
   * that price is already past the ceiling, collapsed on the same look: a gap
   * straight through the line is the same collapse as a slide.
   */
  const armedAt = (reference: number): DipBounceStep =>
    collapsed(price, reference, policy)
      ? none({ reference, low: price, armed: true, at: stamp, holdingSince, crashed: true }, fallPct(price, reference))
      : none({ reference, low: price, armed: true, at: stamp, holdingSince })

  if (current === null) {
    // A fresh watch: what the last buy paid, or the first price seen.
    const reference = last?.price ?? price
    if (price <= dipArmLine(reference, policy) * (1 + EPSILON)) return armedAt(reference)
    return none({ reference, low: null, armed: false, at: stamp, holdingSince })
  }

  if (!current.armed) {
    // Before the first buy the reference is the HIGH, and it follows the price
    // up; after it, the reference is the last buy and never moves.
    const reference = firstBuy ? Math.max(current.reference, price) : current.reference
    if (price <= dipArmLine(reference, policy) * (1 + EPSILON)) return armedAt(reference)
    if (reference === current.reference) return none(current)
    return none({ reference, low: null, armed: false, at: stamp, holdingSince })
  }

  // Armed, and the price is back at or over the reference: the dip was undone
  // between two looks, not bounced. Disarmed, never bought — a buy here would
  // be above the last one. A collapse is undone with it.
  if (price >= current.reference) {
    const reference = firstBuy ? Math.max(current.reference, price) : current.reference
    return none({ reference, low: null, armed: false, at: stamp, holdingSince })
  }

  if (current.crashed === true) {
    // Collapsed, and still past the line: no bounce buys. The low goes on
    // being followed, so the screen can say how deep it went.
    if (price < crashLine(current.reference, policy) * (1 - EPSILON)) {
      const low = Math.min(current.low ?? price, price)
      return none(low === current.low ? current : { ...current, low, at: stamp })
    }
    // Back within the ceiling: the collapse clears, and the low starts again
    // HERE — so the bounce that buys is measured off a price inside the line,
    // never off the bottom of the collapse. Still armed while it is a dip.
    const { reference } = current
    if (price <= dipArmLine(reference, policy) * (1 + EPSILON)) {
      return none({ reference, low: price, armed: true, at: stamp, holdingSince })
    }
    return none({ reference, low: null, armed: false, at: stamp, holdingSince })
  }

  const low = Math.min(current.low ?? price, price)
  // The low slid past the ceiling: a collapse, said on this look, and no buy.
  if (collapsed(low, current.reference, policy)) {
    return none({ ...current, low, at: stamp, crashed: true }, fallPct(low, current.reference))
  }
  const watch: DipWatch = low === current.low ? current : { ...current, low, at: stamp }
  if (price < bounceLine(low, policy) * (1 - EPSILON)) return none(watch)
  return {
    watch,
    action: 'buy',
    step,
    fellPct: fallPct(low, current.reference),
    bouncedPct: (price / low - 1) * 100,
    crashedPct: null,
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
 * another holding's, a stale one, the watch arming or disarming, collapsing or
 * clearing, the reference changing, or the high or the armed low moving 0.1%
 * or more. Never the clock alone.
 */
export function dipWatchWorthWriting(
  stored: DipWatch | null | undefined,
  next: DipWatch | null,
  /** The time of the holding's last buy; null while nothing is held. */
  lastBuyTime: number | null,
): boolean {
  if (next === null) return false
  if (!stored || stored.holdingSince !== next.holdingSince || stored.armed !== next.armed) return true
  if ((stored.crashed === true) !== (next.crashed === true)) return true
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
