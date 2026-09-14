import { type Alert, type AlertPort } from '../../domain/notifications/alerts.js'
import { type StatePort } from '../../domain/persistence/store.js'

/**
 * The alert channel, written to durable state instead of pushed down a wire.
 *
 * Telegram was a PIPE: the engine pushed, and whatever was not delivered was
 * gone. A phone that was off, out of signal, or not yet installed missed the
 * death exit entirely, and nothing recorded that it had. This is a LOG. The
 * app reads it from a cursor and catches up, so being asleep costs latency
 * rather than the message.
 *
 * Two guarantees, and the second is the reason this class exists at all
 * rather than a one-line lambda:
 *
 * 1. **Sending never throws into the engine.** A notification channel that can
 *    stop trading is a worse problem than a missed notification.
 * 2. **A CRITICAL that failed to land is retried.** Swallowing the error is
 *    right for a heartbeat and wrong for a death exit — that one message is
 *    what the whole channel exists for, and "the database blinked" is not a
 *    reason to lose it.
 */
export class StoredAlertSink implements AlertPort {
  /** Criticals that could not be written yet, oldest first. */
  private readonly spool: Alert[] = []

  constructor(
    private readonly store: Pick<StatePort, 'recordAlert'>,
    private readonly onError: (error: unknown) => void = () => {},
    /** Bound on the spool: an outage must not become a memory leak. */
    private readonly spoolLimit = 50,
  ) {}

  async send(alert: Alert): Promise<void> {
    // Drain first, so a recovered database receives the backlog in the order
    // the events actually happened rather than after the newest one.
    await this.drain()
    await this.write(alert)
  }

  private async drain(): Promise<void> {
    while (this.spool.length > 0) {
      const pending = this.spool[0]!
      try {
        await this.store.recordAlert(pending)
        this.spool.shift()
      } catch {
        return // Still down. Keep the backlog; the next alert tries again.
      }
    }
  }

  private async write(alert: Alert): Promise<void> {
    try {
      await this.store.recordAlert(alert)
    } catch (error) {
      this.onError(error)
      if (alert.level !== 'critical') return
      this.spool.push(alert)
      // Drop the OLDEST when full: during a rolling collapse the most recent
      // verdicts are the ones that still describe the world.
      if (this.spool.length > this.spoolLimit) this.spool.shift()
    }
  }
}
