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
  // Operations
  | 'engine-started'
  | 'heartbeat'
  | 'scan-empty'
  | 'provider-degraded'

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
  'engine-started': 'info',
  heartbeat: 'info',
  'scan-empty': 'warn',
  'provider-degraded': 'warn',
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
