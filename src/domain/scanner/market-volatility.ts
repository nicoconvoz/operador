import { type WindowedChangePct } from './snapshot.js'

/**
 * How much a token moves every five minutes, in percent, from the price
 * changes the market feed already reports — no candle, no request.
 *
 * *No quiero velas.* The operator. Each window is scaled to five minutes the
 * way a random walk scales — the five-minute move as it is, the hour's divided
 * by √12, the six hours' by √72 — and the ones reported are averaged. A fall
 * moves as much as a rise. The day is left out: it is too long a window to say
 * anything about the next five minutes.
 *
 * Null when none of the three was reported: silence is not calm.
 */
export function marketVolatilityPct(changes: WindowedChangePct): number | null {
  const per5m: number[] = []
  const add = (change: number | null | undefined, steps: number) => {
    if (typeof change === 'number' && Number.isFinite(change)) per5m.push(Math.abs(change) / Math.sqrt(steps))
  }
  add(changes.m5, 1)
  add(changes.h1, 12)
  add(changes.h6, 72)
  return per5m.length === 0 ? null : per5m.reduce((sum, v) => sum + v, 0) / per5m.length
}
