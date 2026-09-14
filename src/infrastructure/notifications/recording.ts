import { type Alert, type AlertPort } from '../../domain/notifications/alerts.js'

/**
 * Collects alerts instead of delivering them. For tests and dry runs.
 *
 * It used to live beside the Telegram adapter. When Telegram was removed the
 * whole test suite would have gone with it — which is the tell that a test
 * double was sharing a file with a delivery mechanism it never depended on.
 */
export class RecordingAlerts implements AlertPort {
  readonly sent: Alert[] = []

  async send(alert: Alert): Promise<void> {
    this.sent.push(alert)
  }
}
