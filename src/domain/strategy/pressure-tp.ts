import { type CloseAllOrder } from './state.js'

/**
 * The take-profit on BUY PRESSURE, and the only one: once a holding is more
 * than 12% up, sell it the moment buyers' share of the hour falls 10% from the
 * highest it reached since.
 *
 * *Que el operador tenga como TP cuando haya un 10% de caída de la presión
 * compradora, cuando ya estamos en ganancias* — counted *desde el pico* — and
 * then: *sin TP fijo; sólo cuando haya más ganancia que 12% empieza a correr
 * el TP de la presión compradora.* The fall is RELATIVE: 70% of the hour's
 * trades being buys, then 63%, is the 10%.
 *
 * The caller says whether it is RUNNING: armed past +12%, and disarmed — the
 * peak forgotten — once the holding is no longer in profit. A peak set before
 * a fall says nothing about the next run. The first reading never sells: a
 * fall needs a before. A silent hour keeps the peak and sells nothing.
 *
 * Pure; the caller keeps the peak.
 */

/** Its own name on the tape, so the day log can say what it earned. */
export const PRESSURE_TP_COMMENT = '📉 TP por presión' as CloseAllOrder['comment']

/** Buyers' share of the hour's trades, 0..1; null on a silent hour. */
export function buyShare(buys: number, sells: number): number | null {
  const trades = buys + sells
  return trades > 0 ? buys / trades : null
}

export interface PressureTpStep {
  readonly peak: number | null
  readonly sell: boolean
}

export function stepPressureTp(peak: number | null, share: number | null, running: boolean, dropPct: number): PressureTpStep {
  if (!(dropPct > 0) || !running) return { peak: null, sell: false }
  if (share === null) return { peak, sell: false }
  if (peak === null) return { peak: share, sell: false }
  return { peak: Math.max(peak, share), sell: share <= peak * (1 - dropPct / 100) }
}
