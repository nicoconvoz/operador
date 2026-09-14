import { describe, it, expect } from 'vitest'
import { botApiTransport, pollCommands, type PollerTransport, type TelegramUpdate } from './telegram-poller.js'
import { type BotContext } from './telegram-bot.js'
import { MemoryStore } from '../persistence/memory-store.js'
import { RecordingAlerts } from './telegram.js'
import { killSwitchStatus } from '../../application/kill-switch.js'

const NOW = 1_800_000_000_000
const CHAT = '4242'

const rig = () => {
  const store = new MemoryStore()
  const context: BotContext = {
    store,
    alerts: new RecordingAlerts(),
    authorisedChatId: CHAT,
    now: () => NOW,
    equity: async () => ({ equityUsd: 1_000, startingCapitalUsd: 1_000 }),
  }
  return { store, context }
}

const update = (id: number, text: string, chatId: string | number = CHAT): TelegramUpdate => ({
  update_id: id,
  message: { chat: { id: chatId }, text },
})

/** Serves queued batches, records what it was asked and what it replied. */
const transport = (batches: TelegramUpdate[][]) => {
  const offsets: number[] = []
  const replies: { chatId: string; text: string }[] = []
  let call = 0
  const port: PollerTransport = {
    async getUpdates(offset) {
      offsets.push(offset)
      return batches[call++] ?? []
    },
    async reply(chatId, text) {
      replies.push({ chatId, text })
    },
  }
  return { port, offsets, replies }
}

const instant = { sleep: async () => {} }

describe('pollCommands — the wire between a phone and the kill switch', () => {
  it('executes /stop and replies', async () => {
    const { store, context } = rig()
    const t = transport([[update(1, '/stop')]])
    const report = await pollCommands(t.port, context, { maxPolls: 1, ...instant })

    expect(report.handled).toBe(1)
    expect((await killSwitchStatus(store)).engaged).toBe(true)
    expect(t.replies[0]!.text).toContain('ENGAGED')
  })

  it('ignores a command from an unauthorised chat, and replies nothing', async () => {
    const { store, context } = rig()
    const t = transport([[update(1, '/stop', '999')]])
    const report = await pollCommands(t.port, context, { maxPolls: 1, ...instant })

    expect(report.handled).toBe(0)
    expect(t.replies).toEqual([])
    expect((await killSwitchStatus(store)).engaged).toBe(false)
  })

  it('handles several updates in one batch, in order', async () => {
    const { store, context } = rig()
    const t = transport([[update(1, '/stop'), update(2, '/status'), update(3, '/start')]])
    await pollCommands(t.port, context, { maxPolls: 1, ...instant })

    expect(t.replies).toHaveLength(3)
    // /stop then /start leaves it running.
    expect((await killSwitchStatus(store)).engaged).toBe(false)
  })
})

describe('pollCommands — the offset only advances past what was processed', () => {
  it('acknowledges by update_id + 1', async () => {
    const { context } = rig()
    const t = transport([[update(7, '/help')], [update(9, '/help')], []])
    await pollCommands(t.port, context, { maxPolls: 3, ...instant })
    expect(t.offsets).toEqual([0, 8, 10])
  })

  it('never goes backwards on out-of-order ids', async () => {
    const { context } = rig()
    const t = transport([[update(9, '/help'), update(3, '/help')], []])
    await pollCommands(t.port, context, { maxPolls: 2, ...instant })
    expect(t.offsets).toEqual([0, 10])
  })

  it('an unhandled message still advances the offset — it is not retried forever', async () => {
    const { context } = rig()
    const t = transport([[update(5, 'good morning')], []])
    const report = await pollCommands(t.port, context, { maxPolls: 2, ...instant })
    expect(report.handled).toBe(0)
    expect(t.offsets).toEqual([0, 6])
  })

  it('skips an update with no text or no chat without breaking the batch', async () => {
    const { context } = rig()
    const t = transport([[{ update_id: 1 }, update(2, '/help')]])
    const report = await pollCommands(t.port, context, { maxPolls: 1, ...instant })
    expect(report.handled).toBe(1)
  })
})

describe('pollCommands — the channel that stops trading must outlive a bad network', () => {
  it('survives a failing poll and keeps listening', async () => {
    const { store, context } = rig()
    let call = 0
    const errors: unknown[] = []
    const port: PollerTransport = {
      async getUpdates() {
        call++
        if (call === 1) throw new Error('ETIMEDOUT')
        return call === 2 ? [update(1, '/stop')] : []
      },
      async reply() {},
    }
    const report = await pollCommands(port, context, { maxPolls: 3, onError: (e) => errors.push(e), ...instant })

    expect(report.errors).toBe(1)
    expect(errors).toHaveLength(1)
    // The command still landed after the failure.
    expect((await killSwitchStatus(store)).engaged).toBe(true)
  })

  it('stops when told to', async () => {
    const { context } = rig()
    const t = transport([[], [], []])
    const report = await pollCommands(t.port, context, { stopSignal: Promise.resolve(), ...instant })
    expect(report.polls).toBe(0)
  })
})

describe('botApiTransport', () => {
  it('builds the getUpdates URL with offset and timeout, and unwraps result', async () => {
    const urls: string[] = []
    const port = botApiTransport(
      'tok',
      async (url) => { urls.push(url); return { result: [update(1, '/help')] } },
      async () => ({ status: 200 }),
    )
    const updates = await port.getUpdates(5, 30)
    expect(urls[0]).toContain('/bottok/getUpdates?offset=5&timeout=30')
    expect(updates).toHaveLength(1)
  })

  it('tolerates a response with no result', async () => {
    const port = botApiTransport('tok', async () => ({}), async () => ({ status: 200 }))
    expect(await port.getUpdates(0, 1)).toEqual([])
  })

  it('posts replies to sendMessage', async () => {
    const posted: { url: string; body: unknown }[] = []
    const port = botApiTransport('tok', async () => ({}), async (url, body) => { posted.push({ url, body }); return { status: 200 } })
    await port.reply('42', 'hello')
    expect(posted[0]!.url).toContain('/bottok/sendMessage')
    expect(posted[0]!.body).toEqual({ chat_id: '42', text: 'hello' })
  })
})
