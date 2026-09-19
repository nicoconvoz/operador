/**
 * What the engine tells a human, and how loudly.
 *
 * "Unattended" does not mean "unobservable". A silent engine and a dead engine
 * look identical from outside, so this contract exists to make the difference
 * visible — and to make sure the messages that matter are not buried under the
 * ones that do not.
 */

export type AlertLevel = 'info' | 'warn' | 'critical'

export type AlertKind =
  // Trading
  | 'position-opened'
  | 'position-closed'
  | 'dca-filled'
  // Risk — these are why the channel exists
  | 'death-exit'
  | 'ladder-frozen'
  | 'position-halted'
  | 'kill-switch'
  | 'token-retired'
  | 'token-rotated'
  | 'token-stopped'
  // Operations
  | 'engine-started'
  | 'heartbeat'
  | 'scan-empty'
  | 'provider-degraded'
  | 'entry-refused'
  | 'order-refused'
  | 'resynced'

export interface Alert {
  readonly kind: AlertKind
  readonly level: AlertLevel
  readonly at: number
  readonly title: string
  readonly body: string
  /** Structured detail for the dashboard and the audit log. */
  readonly data?: Readonly<Record<string, unknown>>
}

export interface AlertPort {
  send(alert: Alert): Promise<void>
}

/**
 * Level per kind. Deliberately conservative about what counts as critical:
 * an alert channel where everything screams is a channel nobody reads, and
 * the one night it matters the message will be lost in the noise.
 */
const LEVELS: Readonly<Record<AlertKind, AlertLevel>> = {
  'position-opened': 'info',
  'position-closed': 'info',
  'dca-filled': 'info',
  'death-exit': 'critical',
  'ladder-frozen': 'warn',
  'position-halted': 'critical',
  'kill-switch': 'critical',
  // A person reached in and took a token off the board. Critical is not about
  // danger here, it is about never being throttled: this is the one event the
  // log must carry even if it repeats, because it is the only kind the system
  // did not decide for itself.
  'token-retired': 'critical',
  // CRITICAL, and never throttled into silence. Real money left a position at
  // whatever price existed, possibly at a loss — the operator asked for that
  // outcome and must still be told each time it happens.
  'token-rotated': 'critical',
  // A stop is money leaving at a LOSS, decided by the engine with nobody
  // watching. That is exactly the class of event the channel exists for, and
  // the operator has to be able to see it happen rather than find it in the
  // tape tomorrow.
  'token-stopped': 'critical',
  'engine-started': 'info',
  heartbeat: 'info',
  'scan-empty': 'warn',
  'provider-degraded': 'warn',
  // INFO. A repair is not an incident: the engine found a ladder anchored to a
  // price its position never paid, re-derived it from the fills, and carried
  // on. Worth reading in the morning, never worth a buzz at three.
  resynced: 'info',
  // INFO, and the level is the point. A refused entry is an opportunity not
  // taken: nothing was bought, no money is at stake, and nothing needs doing
  // tonight. It arrived as a `warn` per token, so a cycle that declined a
  // dozen candidates buzzed a dozen times — and a phone that buzzes for
  // opportunities is a phone whose notifications get turned off, after which
  // the death exit does not arrive either.
  'entry-refused': 'info',
  // WARN, not info. This one is the engine trying to trade and being turned
  // away — a decision that was made, written down, and then did not happen.
  // Thirty positions carried a pending order for over an hour with zero fills
  // and nothing anywhere said why: the broker recorded the reason and nobody
  // read it. An engine that looks busy and is completely still is the failure
  // this project keeps paying for.
  'order-refused': 'warn',
}

export const alert = (kind: AlertKind, title: string, body: string, at: number, data?: Record<string, unknown>): Alert => ({
  kind,
  level: LEVELS[kind],
  at,
  title,
  body,
  ...(data ? { data } : {}),
})

/**
 * Suppresses repeats of the same alert within a window, EXCEPT criticals.
 *
 * A degraded provider can fire every minute for an hour; a death exit fires
 * once and must never be swallowed. Rate limiting protects attention, and
 * attention is only worth protecting for things that can wait.
 */
export class AlertThrottle {
  private readonly lastSent = new Map<string, number>()

  constructor(private readonly windowMs: number = 30 * 60 * 1000) {}

  /**
   * @param key what counts as "the same alert". Defaults to the kind; pass a
   *        token to throttle per position, so one noisy market cannot mute
   *        the others.
   */
  shouldSend(alert: Alert, key: string = alert.kind): boolean {
    if (alert.level === 'critical') return true
    const last = this.lastSent.get(key)
    if (last !== undefined && alert.at - last < this.windowMs) return false
    this.lastSent.set(key, alert.at)
    return true
  }
}
