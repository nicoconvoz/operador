import { type AlertPort } from '../../domain/notifications/alerts.js'
import { type StatePort } from '../../domain/persistence/store.js'
import { disengageKillSwitch, engageKillSwitch, killSwitchStatus } from '../../application/kill-switch.js'

/**
 * The Telegram command surface — the kill switch, reachable from a phone.
 *
 * Commands are parsed and executed here; polling for them belongs to the
 * runtime. Split that way, the part that can stop trading is testable without
 * a network.
 *
 * Every command is authorised against a single chat id. A bot token in a leaked
 * log is enough to send messages to the bot; only the chat check stops a
 * stranger from stopping — or restarting — a system that holds money.
 */

export interface BotContext {
  readonly store: StatePort
  readonly alerts: AlertPort
  readonly authorisedChatId: string
  readonly now: () => number
  /** Read-only view for /status. */
  readonly equity: () => Promise<{ equityUsd: number; startingCapitalUsd: number }>
}

export interface Command {
  readonly chatId: string
  readonly text: string
}

export interface CommandReply {
  readonly text: string
  readonly handled: boolean
}

const HELP = [
  'Operador by Open Doors',
  '',
  '/status — positions, equity, kill switch',
  '/stop — engage the kill switch (no new positions)',
  '/start — release the kill switch',
  '/positions — what is open right now',
  '/help — this message',
].join('\n')

export async function handleCommand(command: Command, context: BotContext): Promise<CommandReply> {
  // An unauthorised chat gets NOTHING — not an error, not a hint that the bot
  // exists for something. Anything else is a free reconnaissance signal.
  if (command.chatId !== context.authorisedChatId) return { text: '', handled: false }

  const verb = command.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '') ?? ''
  const at = context.now()

  switch (verb) {
    case '/stop': {
      const status = await killSwitchStatus(context.store)
      if (status.engaged) return { text: '🛑 Already stopped. Open positions keep their death watch.', handled: true }
      await engageKillSwitch(context.store, context.alerts, 'manual', 'Stopped from Telegram.', at)
      return { text: '🛑 Kill switch ENGAGED.\nNo new positions will open.\nOpen positions keep their death watch.', handled: true }
    }

    case '/start': {
      const status = await killSwitchStatus(context.store)
      if (!status.engaged) return { text: '▶️ Already running.', handled: true }
      await disengageKillSwitch(context.store, context.alerts, at)
      return { text: '▶️ Kill switch released. New positions may open again.', handled: true }
    }

    case '/status': {
      const [positions, status, blacklist, equity] = await Promise.all([
        context.store.loadPositions(),
        killSwitchStatus(context.store),
        context.store.blacklisted(),
        context.equity(),
      ])
      const pnl = equity.equityUsd - equity.startingCapitalUsd
      const pct = equity.startingCapitalUsd > 0 ? (pnl / equity.startingCapitalUsd) * 100 : 0
      return {
        text: [
          status.engaged ? '🛑 STOPPED' : '▶️ Running',
          `Positions: ${positions.length}`,
          `Equity: $${equity.equityUsd.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}, ${pct.toFixed(1)}%)`,
          `Blacklisted tokens: ${blacklist.size}`,
        ].join('\n'),
        handled: true,
      }
    }

    case '/positions': {
      const positions = await context.store.loadPositions()
      if (positions.length === 0) return { text: 'No open positions.', handled: true }
      const lines = positions.map((p) => {
        const filled = p.cascade.level > 0 ? p.cascade.level - 1 : 0
        const flag = p.deathWatch.stage === 'frozen' ? ' ❄️' : p.deathWatch.stage === 'dead' ? ' ☠️' : ''
        return `${p.symbol}${flag} · $${p.capitalUsd.toFixed(0)} · ${filled} DCA`
      })
      return { text: lines.join('\n'), handled: true }
    }

    case '/help':
      return { text: HELP, handled: true }

    default:
      return { text: '', handled: false }
  }
}
