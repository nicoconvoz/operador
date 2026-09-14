import { describe, it, expect } from 'vitest'
import { AlertThrottle, alert } from './alerts.js'
import { TelegramAlerts, RecordingAlerts } from '../../infrastructure/notifications/telegram.js'

const T = 1_800_000_000_000

describe('alert levels — what is allowed to scream', () => {
  it('risk events are critical, trading events are not', () => {
    expect(alert('death-exit', 't', 'b', T).level).toBe('critical')
    expect(alert('position-halted', 't', 'b', T).level).toBe('critical')
    expect(alert('kill-switch', 't', 'b', T).level).toBe('critical')
    expect(alert('position-opened', 't', 'b', T).level).toBe('info')
    expect(alert('dca-filled', 't', 'b', T).level).toBe('info')
    expect(alert('ladder-frozen', 't', 'b', T).level).toBe('warn')
  })
})

describe('AlertThrottle — protects attention, never at the cost of risk', () => {
  it('suppresses a repeated non-critical alert inside the window', () => {
    const throttle = new AlertThrottle(60_000)
    expect(throttle.shouldSend(alert('provider-degraded', 't', 'b', T))).toBe(true)
    expect(throttle.shouldSend(alert('provider-degraded', 't', 'b', T + 30_000))).toBe(false)
    expect(throttle.shouldSend(alert('provider-degraded', 't', 'b', T + 61_000))).toBe(true)
  })

  it('NEVER suppresses a critical, however often it fires', () => {
    const throttle = new AlertThrottle(60 * 60 * 1000)
    for (let i = 0; i < 10; i++) {
      expect(throttle.shouldSend(alert('death-exit', 't', 'b', T + i))).toBe(true)
    }
  })

  it('throttles per key, so one noisy token does not mute another', () => {
    const throttle = new AlertThrottle(60_000)
    expect(throttle.shouldSend(alert('ladder-frozen', 't', 'b', T), 'TOKEN-A')).toBe(true)
    expect(throttle.shouldSend(alert('ladder-frozen', 't', 'b', T), 'TOKEN-B')).toBe(true)
    expect(throttle.shouldSend(alert('ladder-frozen', 't', 'b', T + 1), 'TOKEN-A')).toBe(false)
  })
})

describe('TelegramAlerts — formatting and failure', () => {
  it('formats with an icon, the detail and the system name', () => {
    const text = TelegramAlerts.format(alert('death-exit', 'DEAD: BONK', 'sell path broken', T, { liquidity: 1200 }))
    expect(text).toContain('🚨')
    expect(text).toContain('<b>DEAD: BONK</b>')
    expect(text).toContain('sell path broken')
    expect(text).toContain('<code>liquidity</code>: 1200')
    expect(text).toContain('Operador by Open Doors')
  })

  it('escapes HTML so a token symbol cannot break the message', () => {
    const text = TelegramAlerts.format(alert('position-opened', '<b>evil</b> & co', 'x', T))
    expect(text).toContain('&lt;b&gt;evil&lt;/b&gt; &amp; co')
  })

  it('sends info silently and criticals with notification', async () => {
    const bodies: Record<string, unknown>[] = []
    const telegram = new TelegramAlerts({ botToken: 'tok', chatId: '42' }, async (_url, body) => {
      bodies.push(body as Record<string, unknown>)
      return { status: 200 }
    })
    await telegram.send(alert('heartbeat', 'alive', 'ok', T))
    await telegram.send(alert('kill-switch', 'STOPPED', 'loss limit', T))
    expect(bodies[0]!.disable_notification).toBe(true)
    expect(bodies[1]!.disable_notification).toBe(false)
    expect(bodies[1]!.chat_id).toBe('42')
  })

  it('a failing channel never throws into the engine', async () => {
    const errors: unknown[] = []
    const down = new TelegramAlerts({ botToken: 't', chatId: 'c' }, async () => { throw new Error('ECONNRESET') }, (e) => errors.push(e))
    await expect(down.send(alert('death-exit', 't', 'b', T))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)

    const rejecting = new TelegramAlerts({ botToken: 't', chatId: 'c' }, async () => ({ status: 429 }), (e) => errors.push(e))
    await rejecting.send(alert('heartbeat', 't', 'b', T))
    expect(errors).toHaveLength(2)
  })
})

describe('RecordingAlerts — for tests and dry runs', () => {
  it('collects instead of sending', async () => {
    const recorder = new RecordingAlerts()
    await recorder.send(alert('engine-started', 'up', 'ok', T))
    expect(recorder.sent).toHaveLength(1)
    expect(recorder.sent[0]!.kind).toBe('engine-started')
  })
})
