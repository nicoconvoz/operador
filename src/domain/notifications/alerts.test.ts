import { describe, it, expect } from 'vitest'
import { AlertThrottle, alert } from './alerts.js'
import { RecordingAlerts } from '../../infrastructure/notifications/recording.js'

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
