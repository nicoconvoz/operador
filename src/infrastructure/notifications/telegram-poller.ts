import { handleCommand, type BotContext } from './telegram-bot.js'

/**
 * Telegram long-polling.
 *
 * The commands already existed; without this nobody calls them, which means
 * the kill switch is a button not wired to anything. This is the wire.
 *
 * Deliberately long-polling rather than webhooks: a webhook needs a public
 * URL and a TLS certificate on a box whose whole appeal is that it is free and
 * unexposed. Polling costs one idle connection and opens no ports.
 */

export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: { readonly chat?: { readonly id: number | string }; readonly text?: string }
}

export interface PollerTransport {
  /** Long-poll for updates after `offset`, waiting up to `timeoutSeconds`. */
  getUpdates(offset: number, timeoutSeconds: number): Promise<readonly TelegramUpdate[]>
  reply(chatId: string, text: string): Promise<void>
}

export interface PollerOptions {
  readonly timeoutSeconds?: number
  /** Resolves when polling should stop. */
  readonly stopSignal?: Promise<void>
  /** Bounded polls, for tests. */
  readonly maxPolls?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly onError?: (error: unknown) => void
}

export interface PollerReport {
  readonly polls: number
  readonly handled: number
  readonly errors: number
}

/**
 * Polls until stopped.
 *
 * Two properties that matter more than they look:
 *
 *  - **The offset only advances past an update that was processed.** Telegram
 *    replays anything not acknowledged, so a crash mid-command means the
 *    command is retried rather than lost. For `/stop` that is exactly right.
 *  - **A failure never ends the loop.** The channel that stops trading must
 *    outlive a bad network, or it is not a safety control.
 */
export async function pollCommands(
  transport: PollerTransport,
  context: BotContext,
  options: PollerOptions = {},
): Promise<PollerReport> {
  const timeoutSeconds = options.timeoutSeconds ?? 30
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  let stop = false
  options.stopSignal?.then(() => { stop = true })

  let offset = 0
  let polls = 0
  let handled = 0
  let errors = 0

  for (;;) {
    // Let pending microtasks settle so a stop signal that has ALREADY resolved
    // is seen before another long poll begins — otherwise shutdown waits out a
    // 30-second poll for no reason.
    await Promise.resolve()
    if (stop) break
    if (options.maxPolls !== undefined && polls >= options.maxPolls) break

    try {
      const updates = await transport.getUpdates(offset, timeoutSeconds)
      polls++

      for (const update of updates) {
        const chatId = update.message?.chat?.id
        const text = update.message?.text
        if (chatId !== undefined && text) {
          const reply = await handleCommand({ chatId: String(chatId), text }, context)
          if (reply.handled) {
            await transport.reply(String(chatId), reply.text)
            handled++
          }
        }
        // Advance only after the update is done with, so an interrupted
        // command comes back on the next poll instead of vanishing.
        offset = Math.max(offset, update.update_id + 1)
      }
    } catch (error) {
      errors++
      polls++
      options.onError?.(error)
      // A brief pause, then keep listening. Going quiet here would leave the
      // engine running with no way to stop it.
      await sleep(5_000)
    }
  }

  return { polls, handled, errors }
}

/** Bot API transport. Split out so the loop above is testable without a network. */
export function botApiTransport(
  botToken: string,
  fetchJson: (url: string) => Promise<unknown>,
  post: (url: string, body: unknown) => Promise<{ status: number }>,
  baseUrl = 'https://api.telegram.org',
): PollerTransport {
  const base = `${baseUrl}/bot${botToken}`
  return {
    async getUpdates(offset, timeoutSeconds) {
      const body = (await fetchJson(`${base}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}`)) as { result?: TelegramUpdate[] }
      return body.result ?? []
    },
    async reply(chatId, text) {
      await post(`${base}/sendMessage`, { chat_id: chatId, text })
    },
  }
}
