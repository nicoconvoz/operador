import { type Candles } from './replay.js'

/**
 * How long since anybody traded this pool, measured from its own candles.
 *
 * The death watch has carried an `abandonment` signal since it was built — six
 * hours freezes the ladder, twenty-four condemns the token — and the runtime
 * reported `hoursSinceLastTrade: null` on every observation, so it never once
 * fired. The reason given was that the system measures volume, not the time of
 * the last trade.
 *
 * That was wrong, and the candles were sitting right there. A bar with volume
 * IS a trade, and the newest one with volume is when trading last happened.
 * Fifteen-minute resolution, which is far finer than a six-hour threshold
 * needs. Nothing is invented: this is a measurement from a source the engine
 * already fetches for every position on every tick.
 *
 * NULL when no bar ever traded, and that distinction matters. Returning zero
 * would tell the abandonment signal the pool is lively, which is the exact
 * opposite of what an all-empty series means — and the death watch treats an
 * unknown reading as neither confirming nor clearing, which is the honest
 * answer to a series that says nothing.
 */
export function hoursSinceLastTrade(candles: Candles, now: number): number | null {
  for (let i = candles.volume.length - 1; i >= 0; i--) {
    if ((candles.volume[i] ?? 0) <= 0) continue
    // Bars are stamped by their OPEN, so trading happened somewhere inside
    // this bar. Measuring from the open is the conservative direction: it
    // reports slightly MORE idleness than the truth, and over-reporting
    // idleness only ever makes the watch more careful.
    const at = candles.time[i] ?? 0
    return Math.max(0, (now - at) / 3_600_000)
  }
  return null
}
