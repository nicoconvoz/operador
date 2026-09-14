import { describe, it, expect } from 'vitest'
import { handleCommand, type BotContext } from './telegram-bot.js'
import { MemoryStore } from '../persistence/memory-store.js'
import { RecordingAlerts } from './telegram.js'
import { killSwitchStatus } from '../../application/kill-switch.js'
import { initialState } from '../../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../../domain/risk/death-exit.js'
import { type PersistedPosition } from '../../domain/persistence/store.js'

const NOW = 1_800_000_000_000
const CHAT = '123456'

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'DREGG',
  cascade: { ...initialState(), level: 3 },
  deathWatch: startDeathWatch(100_000, NOW),
  quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.2, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 475, lastBarTime: NOW, lastPriceUsd: 1, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const rig = (equityUsd = 1_100) => {
  const store = new MemoryStore()
  const alerts = new RecordingAlerts()
  const context: BotContext = {
    store, alerts, authorisedChatId: CHAT, now: () => NOW,
    equity: async () => ({ equityUsd, startingCapitalUsd: 1_000 }),
  }
  return { store, alerts, context }
}

const send = (text: string, context: BotContext, chatId = CHAT) => handleCommand({ chatId, text }, context)

describe('telegram bot — authorisation', () => {
  it('a stranger gets NOTHING, not even an error', async () => {
    const { context, store } = rig()
    const reply = await send('/stop', context, '999')
    expect(reply).toEqual({ text: '', handled: false })
    // And above all: the switch was not touched.
    expect((await killSwitchStatus(store)).engaged).toBe(false)
  })

  it('silence is the point — an error would confirm the bot exists', async () => {
    const { context } = rig()
    for (const command of ['/status', '/start', '/positions', '/help']) {
      expect((await send(command, context, 'intruder')).text).toBe('')
    }
  })
})

describe('telegram bot — the kill switch from a phone', () => {
  it('/stop engages it and says what that does NOT stop', async () => {
    const { context, store, alerts } = rig()
    const reply = await send('/stop', context)
    expect(reply.handled).toBe(true)
    expect(reply.text).toContain('ENGAGED')
    expect(reply.text).toContain('death watch')
    expect((await killSwitchStatus(store)).engaged).toBe(true)
    expect(alerts.sent.some((a) => a.kind === 'kill-switch' && a.level === 'critical')).toBe(true)
  })

  it('/stop twice is harmless', async () => {
    const { context, alerts } = rig()
    await send('/stop', context)
    const again = await send('/stop', context)
    expect(again.text).toContain('Already stopped')
    expect(alerts.sent.filter((a) => a.kind === 'kill-switch')).toHaveLength(1)
  })

  it('/start releases it, and only when it was engaged', async () => {
    const { context, store } = rig()
    expect((await send('/start', context)).text).toContain('Already running')
    await send('/stop', context)
    expect((await send('/start', context)).text).toContain('released')
    expect((await killSwitchStatus(store)).engaged).toBe(false)
  })

  it('accepts the @botname suffix Telegram adds in groups', async () => {
    const { context, store } = rig()
    await send('/stop@operador_bot', context)
    expect((await killSwitchStatus(store)).engaged).toBe(true)
  })
})

describe('telegram bot — reading the system from a phone', () => {
  it('/status reports state, equity and the blacklist', async () => {
    const { context, store } = rig(1_250)
    await store.savePosition(position())
    await store.blacklist('solana', 'Dead1', 'LP removed', NOW)
    const reply = await send('/status', context)
    expect(reply.text).toContain('▶️ Running')
    expect(reply.text).toContain('Positions: 1')
    expect(reply.text).toContain('$1250.00')
    expect(reply.text).toContain('+250.00')
    expect(reply.text).toContain('25.0%')
    expect(reply.text).toContain('Blacklisted tokens: 1')
  })

  it('/status shows a loss without pretending', async () => {
    const { context } = rig(700)
    expect((await send('/status', context)).text).toContain('-300.00')
  })

  it('/status shows the stop when it is engaged', async () => {
    const { context } = rig()
    await send('/stop', context)
    expect((await send('/status', context)).text).toContain('🛑 STOPPED')
  })

  it('/positions lists each position with its DCA depth and death stage', async () => {
    const { context, store } = rig()
    const frozen: DeathWatchState = { ...startDeathWatch(100_000, NOW), stage: 'frozen' }
    await store.savePosition(position())
    await store.savePosition(position({ id: 'pos-2', symbol: 'TROLL', deathWatch: frozen, capitalUsd: 300 }))
    const reply = await send('/positions', context)
    expect(reply.text).toContain('DREGG · $475 · 2 DCA')
    expect(reply.text).toContain('TROLL ❄️ · $300 · 2 DCA')
  })

  it('/positions says so plainly when there are none', async () => {
    const { context } = rig()
    expect((await send('/positions', context)).text).toBe('No open positions.')
  })

  it('/help lists every command', async () => {
    const { context } = rig()
    const reply = await send('/help', context)
    for (const command of ['/status', '/stop', '/start', '/positions']) expect(reply.text).toContain(command)
  })

  it('an unknown command is not handled', async () => {
    const { context } = rig()
    expect(await send('/rugpull', context)).toEqual({ text: '', handled: false })
  })
})
