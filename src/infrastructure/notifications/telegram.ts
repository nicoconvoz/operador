import { type Alert, type AlertPort } from '../../domain/notifications/alerts.js'

/**
 * Telegram — free, reachable from a phone, and the place the kill switch gets
 * announced. Uses the Bot API's sendMessage endpoint.
 *
 * Sending must never throw into the engine's loop: a notification channel that
 * can stop trading is a worse problem than a missed notification.
 */

export interface TelegramConfig {
  readonly botToken: string
  readonly chatId: string
  readonly baseUrl?: string
}

export type HttpPost = (url: string, body: unknown) => Promise<{ status: number }>

const ICONS: Readonly<Record<Alert['level'], string>> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' }

export class TelegramAlerts implements AlertPort {
  private readonly base: string

  constructor(
    private readonly config: TelegramConfig,
    private readonly post: HttpPost,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.base = config.baseUrl ?? 'https://api.telegram.org'
  }

  async send(alert: Alert): Promise<void> {
    try {
      const response = await this.post(`${this.base}/bot${this.config.botToken}/sendMessage`, {
        chat_id: this.config.chatId,
        text: TelegramAlerts.format(alert),
        parse_mode: 'HTML',
        disable_notification: alert.level === 'info',
      })
      if (response.status !== 200) this.onError(new Error(`telegram sendMessage: HTTP ${response.status}`))
    } catch (error) {
      // Swallowed on purpose: the engine keeps trading even when it cannot talk.
      this.onError(error)
    }
  }

  static format(alert: Alert): string {
    const when = new Date(alert.at).toISOString().replace('T', ' ').slice(0, 16)
    const lines = [`${ICONS[alert.level]} <b>${escapeHtml(alert.title)}</b>`, escapeHtml(alert.body)]
    if (alert.data) {
      for (const [key, value] of Object.entries(alert.data)) lines.push(`<code>${escapeHtml(key)}</code>: ${escapeHtml(String(value))}`)
    }
    lines.push(`<i>${when} UTC · Operador by Open Doors</i>`)
    return lines.join('\n')
  }
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Collects alerts instead of sending them. For tests and dry runs. */
export class RecordingAlerts implements AlertPort {
  readonly sent: Alert[] = []
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert)
  }
}
