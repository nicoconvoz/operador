/**
 * Which way the universe went in the last hour, as one number on a bar.
 *
 * *Si la mayoría están subiendo en la última hora, ponelo según la cantidad del
 * lado verde de la barra, y si la mayoría está bajando, ponelo del lado de la
 * barra tirando a rojo o naranja, dependiendo de cuántas sean.* The operator,
 * replacing a canvas that drew every token as a glowing body — which, at 250
 * tokens, is a phone that stalls.
 *
 * Pure and free of the DOM, so the client imports it and the tests pin it —
 * the same arrangement as `resultAt` in the day log.
 */

import { risingInTheHour } from '../domain/scanner/momentum.js'

export interface MarketBreadth {
  /** Rose in the last hour. */
  readonly up: number
  /** Fell in the last hour. */
  readonly down: number
  /** Reported, and exactly zero. */
  readonly flat: number
  /** Not reported, or not a number anybody could read. */
  readonly unknown: number
  /** Every token asked about, whatever it answered. */
  readonly total: number
  /** Of the tokens that MOVED, the share that rose: 0..1, and 0.5 when none moved. */
  readonly upShare: number
  /** Where the marker sits, in percent: 0 is all falling (red), 50 even, 100 all rising (green). */
  readonly at: number
}

/**
 * Counts the hour's changes and places the marker.
 *
 * The share is taken over the tokens that MOVED, so a flat token does not drag
 * the marker toward the middle: three rising against one falling reads 75%
 * whether or not a dozen others sat still. They are counted, and said, apart.
 *
 * Silence is not evidence — the rule the whole scanner runs on. An unreported
 * hour is neither a rise nor a fall, and neither is a number that is not finite:
 * a feed that sent garbage has not said which way the token went. With nothing
 * that moved the marker sits in the middle, never at NaN.
 *
 * "Rising" is `risingInTheHour`, the entry door's own predicate: *que la
 * barrera de entrada sea solamente que los tokens suban, como marca la barra.*
 * One definition, so the bar counts exactly what the engine lets in.
 */
export function marketBreadth(changes1h: readonly (number | null | undefined)[]): MarketBreadth {
  let up = 0
  let down = 0
  let flat = 0
  let unknown = 0
  for (const change of changes1h) {
    if (typeof change !== 'number' || !Number.isFinite(change)) unknown += 1
    else if (risingInTheHour(change)) up += 1
    else if (change < 0) down += 1
    else flat += 1
  }
  const moved = up + down
  const upShare = moved === 0 ? 0.5 : up / moved
  return { up, down, flat, unknown, total: changes1h.length, upShare, at: upShare * 100 }
}
