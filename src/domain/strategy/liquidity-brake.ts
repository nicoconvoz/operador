/**
 * The liquidity brake: a DCA rung is not bought into a pool that is draining
 * right now.
 *
 * *Freno en tiempo real por cambio de liquidez inmediata que supere el 5%* —
 * then, asked which window, *5 minutos o 1 hora.* The operator.
 *
 * ## Why
 *
 * PAID froze on 2026-09-28 with its pool at 41% of the liquidity it had at
 * entry — AFTER the ladder had bought DCA-2 and DCA-3 into it, −$16.96. The
 * death watch saw the drain and froze the position; the ladder, which reads
 * only the price, had already read that same drain as a dip worth averaging
 * into. A falling price on a pool that is emptying is not a dip, it is the
 * exit in progress, and the rung is the one order that buys more of it.
 *
 * ## Why BOTH windows
 *
 * Pools drain in steps. CAKE lost 19% of its liquidity in an hour while never
 * losing more than 5% in any five minutes: a five-minute brake alone would
 * never have fired on it. The five minutes catches the pull that happens all
 * at once; the hour catches the one that happens a slice at a time.
 *
 * Measured on the 37 held tokens the day it was decided: none fell more than
 * 5% in five minutes (worst −4.7%, median 0.0%), and four fell more than 5% in
 * the hour — CAKE −19.3%, JEANPHIL −6.9%, TOAD −5.4%, MINI −5.1%. A brake that
 * holds four rungs out of a book of thirty-seven is a brake, not a wall.
 *
 * ## What it is not
 *
 * - **Not a price rule.** It reads the POOL, never the chart — the same kind
 *   of fact the death watch reads, and it only ever holds a BUY back. Nothing
 *   is sold on it.
 * - **Not a verdict.** A braked rung is asked again on the next sweep, and
 *   bought the first sweep the drain has stopped, if the price is still there.
 * - **Silence is not evidence.** A window nobody reported never brakes: the
 *   rung is bought as it was before this existed. Reading silence as a drain
 *   would hold every rung the day Jupiter has a bad minute.
 */

/** A pool's liquidity change, in percent, over the last five minutes and the last hour. Null: unreported. */
export interface LiquidityChange {
  readonly m5: number | null
  readonly h1: number | null
}

/** One look at a token's pools: the change over both windows, and how deep they are now in dollars. */
export interface LiquidityReading extends LiquidityChange {
  /** The liquidity now, in USD, across the token's pools. Null: unreported. */
  readonly usd: number | null
}

/**
 * Five percent, in either window. The operator's number; zero turns it off.
 */
export const DEFAULT_LIQUIDITY_BRAKE_PCT = 5

/** Whether a window fell by the threshold or more. Unreported, or not a number, never did. */
export const liquidityFell = (pct: number | null, thresholdPct: number): boolean =>
  pct !== null && Number.isFinite(pct) && pct <= -thresholdPct

/**
 * True when the pool lost `thresholdPct` or more of its liquidity over the last
 * five minutes OR over the last hour. False for an unknown change, an
 * unreported window, and a threshold of zero — the switch off.
 */
export function liquidityBrakes(change: LiquidityChange | null, thresholdPct: number): boolean {
  if (change === null || !(thresholdPct > 0)) return false
  return liquidityFell(change.m5, thresholdPct) || liquidityFell(change.h1, thresholdPct)
}

/**
 * The brake as a STATE, per holding, with the rung it buys on the way out.
 *
 * *Si la liquidez cayó y luego desde el punto más bajo la liquidez aumenta un
 * 5%, activar la compra del escalón si está en negativo todavía… pero siempre
 * esperar la recuperación del 5% de liquidez a partir del mínimo.* Then, of
 * the fifteen he had used to illustrate it, *era un ejemplo*: every recovery
 * buys, whatever the depth.
 *
 * - **Braked** when the pool drains 5% — the rule above. While braked no rung
 *   is bought on the price line, however far the price and the pool fall.
 * - **The minimum** is followed down while braked, and the brake lifts ONLY on
 *   a bounce of 5% off it — never on a window going quiet. A pool that stopped
 *   draining and did not come back has not given the signal.
 * - **The bounce buys** the next rung ('buy'); whether the position is still
 *   at a loss, which decides if it is actually bought, is the sweep's
 *   question, because only the sweep knows the price.
 *
 * Two things the rule as stated needed to work on the live feed, both decided
 * here:
 *
 * - **A first look reads where the pool WAS.** A fresh watch starts its peak at
 *   the highest level Jupiter's own windows imply — the liquidity five minutes
 *   and an hour ago, from the changes it reports — so a pool already draining
 *   when the watch begins is braked on the first look, and "había caído" counts
 *   the drain that happened before it.
 * - **A bounce is not braked again by the hour it answered.** Jupiter's hour
 *   lags: minutes after the bounce it still reads the drain. Braking on that
 *   again would hold every rung until a second bounce a pool gone flat never
 *   gives. So a watch that is already tracking brakes only when the windows
 *   say 5% AND the pool is 5% under the peak this watch has seen — which,
 *   after a bounce, is the bounce itself.
 */
export interface LiquidityWatch {
  /** The highest liquidity seen since the watch began or last bounced, in USD. */
  readonly peakUsd: number
  /** While braked, the lowest liquidity seen since the brake; otherwise the last reading. */
  readonly minUsd: number
  /** Whether rungs on the price line are held back. */
  readonly braked: boolean
  /** The time of the holding's first buy — which holding this watch belongs to. */
  readonly holdingSince: number
  /** When it was last moved, in epoch milliseconds. The store keeps the newer. */
  readonly at: number
}

export interface LiquidityWatchPolicy {
  /** The drain, in percent over either window, that brakes. Zero: never. */
  readonly brakePct: number
  /** The bounce off the minimum, in percent, that lifts the brake and buys. */
  readonly recoverPct: number
}

/** Five down to brake, five up to buy. The operator's two numbers. */
export const DEFAULT_LIQUIDITY_WATCH_POLICY: LiquidityWatchPolicy = {
  brakePct: DEFAULT_LIQUIDITY_BRAKE_PCT,
  recoverPct: 5,
}

export interface LiquidityWatchStep {
  /** The watch after this reading; null only when there is none and nothing to start one from. */
  readonly watch: LiquidityWatch | null
  /** 'brake' on the reading that braked; 'buy' on the bounce; otherwise 'none'. */
  readonly action: 'none' | 'brake' | 'buy'
  /** On a bounce, how far the pool had fallen from its peak to its minimum, in percent. */
  readonly fellPct: number | null
}

/** Rounding room on a percentage computed back from a percentage, so exactly five is five. */
const EPSILON_PCT = 1e-9

/** The level a window's change implies the pool was at when the window began. */
const before = (usd: number, pct: number | null): number =>
  pct !== null && Number.isFinite(pct) && pct > -100 ? usd / (1 + pct / 100) : usd

/**
 * One reading folded into a holding's watch. Pure: the sweep persists the
 * result and acts on the action.
 *
 * An unknown reading — none, or no liquidity in dollars — changes nothing.
 * Silence is not evidence, in either direction: it neither brakes a pool nor
 * counts as its bounce. A watch belonging to another holding is ignored; the
 * new holding starts its own.
 */
export function nextLiquidityWatch(
  watch: LiquidityWatch | null,
  reading: LiquidityReading | null,
  policy: LiquidityWatchPolicy,
  holding: { readonly since: number; readonly at: number },
): LiquidityWatchStep {
  const current = watch !== null && watch.holdingSince === holding.since ? watch : null
  const usd = reading?.usd ?? null
  if (reading === null || usd === null || !Number.isFinite(usd) || !(usd > 0)) {
    return { watch: current, action: 'none', fellPct: null }
  }
  const stamp = { holdingSince: holding.since, at: holding.at }

  if (current === null || !current.braked) {
    const peakUsd = current === null
      ? Math.max(usd, before(usd, reading.h1), before(usd, reading.m5))
      : Math.max(current.peakUsd, usd)
    const underPeakPct = ((peakUsd - usd) / peakUsd) * 100
    if (liquidityBrakes(reading, policy.brakePct) && underPeakPct >= policy.brakePct - EPSILON_PCT) {
      return { watch: { peakUsd, minUsd: usd, braked: true, ...stamp }, action: 'brake', fellPct: null }
    }
    return { watch: { peakUsd, minUsd: usd, braked: false, ...stamp }, action: 'none', fellPct: null }
  }

  const minUsd = Math.min(current.minUsd, usd)
  if (usd >= minUsd * (1 + policy.recoverPct / 100)) {
    const fellPct = ((current.peakUsd - minUsd) / current.peakUsd) * 100
    return { watch: { peakUsd: usd, minUsd: usd, braked: false, ...stamp }, action: 'buy', fellPct }
  }
  return { watch: { ...current, minUsd, ...stamp }, action: 'none', fellPct: null }
}

/**
 * The smallest move of the peak, or of a braked minimum, worth a write: 1%.
 *
 * Every write is the whole position row, and what ran this project out of its
 * free tier once was NETWORK, not storage. A watch rewritten on every new
 * reading is a write per position per minute — fifty thousand rows a day on a
 * book of forty. Skipping the smaller moves errs the safe way on both: a peak
 * kept a little low measures a shallower fall, and a minimum kept a little
 * high asks a little MORE than 5% of bounce, never less.
 */
export const LIQUIDITY_WATCH_WRITE_STEP_PCT = 1

/**
 * Whether a new watch is worth writing over the stored one: a first watch, a
 * new holding, the brake engaging or lifting, the peak up 1%, or — braked — the
 * minimum down 1%. Never the clock alone, and never the minimum of an unbraked
 * watch, which decides nothing.
 */
export function liquidityWatchMoved(stored: LiquidityWatch | null | undefined, next: LiquidityWatch): boolean {
  if (!stored || stored.holdingSince !== next.holdingSince || stored.braked !== next.braked) return true
  const step = LIQUIDITY_WATCH_WRITE_STEP_PCT / 100
  if (next.peakUsd >= stored.peakUsd * (1 + step)) return true
  return next.braked && next.minUsd <= stored.minUsd * (1 - step)
}

/**
 * What the store keeps when a watch is written: the one with the NEWER time.
 * Every step of the cycle writes the whole row back from a snapshot read
 * before the sweep moved the watch, and none of those may put an older watch,
 * or none, over it. The same rule as the real-time DCA scale.
 */
export function keepLiquidityWatch(
  stored: LiquidityWatch | null | undefined,
  written: LiquidityWatch | null | undefined,
): LiquidityWatch | null {
  if (!written) return stored ?? null
  if (!stored || written.at > stored.at) return written
  return stored
}
