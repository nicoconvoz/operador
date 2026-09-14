import { describe, it, expect } from 'vitest'
import { DEFAULT_LOSS_LIMITS as L, disengageKillSwitch, engageKillSwitch, killSwitchStatus, shouldEngage } from './kill-switch.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/telegram.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

describe('kill switch — lives in the store, not in the process', () => {
  it('survives a restart: a new engine reads it as engaged', async () => {
    const store = new MemoryStore()
    await engageKillSwitch(store, new RecordingAlerts(), 'manual', 'stopped from a phone', NOW)
    // A "new process" is just another reader of the same store.
    expect(await killSwitchStatus(store)).toEqual({ engaged: true, since: NOW })
  })

  it('preserves the checkpoint bar, so stopping does not lose progress', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: NOW - HOUR, lastCompletedBar: 12_345, killSwitchEngaged: false })
    await engageKillSwitch(store, new RecordingAlerts(), 'manual', 'x', NOW)
    expect((await store.loadCheckpoint())?.lastCompletedBar).toBe(12_345)
  })

  it('engaging always alerts, and always as critical', async () => {
    const alerts = new RecordingAlerts()
    await engageKillSwitch(new MemoryStore(), alerts, 'loss-limit', 'drawdown', NOW)
    expect(alerts.sent[0]).toMatchObject({ kind: 'kill-switch', level: 'critical' })
    expect(alerts.sent[0]!.data).toMatchObject({ reason: 'loss-limit' })
  })

  it('releasing is a separate, explicit act', async () => {
    const store = new MemoryStore()
    const alerts = new RecordingAlerts()
    await engageKillSwitch(store, alerts, 'manual', 'x', NOW)
    await disengageKillSwitch(store, alerts, NOW + HOUR)
    expect(await killSwitchStatus(store)).toEqual({ engaged: false, since: null })
    expect(alerts.sent).toHaveLength(2)
  })

  it('an untouched store reports not engaged', async () => {
    expect(await killSwitchStatus(new MemoryStore())).toEqual({ engaged: false, since: null })
  })
})

describe('shouldEngage — the automatic limits', () => {
  const healthy = { startingCapitalUsd: 1_000, equityUsd: 1_000, deathTimes: [] as number[] }

  it('stays out of the way while nothing is wrong', () => {
    expect(shouldEngage(healthy, L, NOW).engage).toBe(false)
    expect(shouldEngage({ ...healthy, equityUsd: 900 }, L, NOW).engage).toBe(false)
  })

  it('engages on drawdown past the limit', () => {
    const verdict = shouldEngage({ ...healthy, equityUsd: 650 }, L, NOW)
    expect(verdict.engage).toBe(true)
    expect(verdict.reason).toBe('loss-limit')
    expect(verdict.detail).toContain('35%')
  })

  it('engages when several tokens die at once — that is rarely a coincidence', () => {
    const deaths = [NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR]
    const verdict = shouldEngage({ ...healthy, deathTimes: deaths }, L, NOW)
    expect(verdict.engage).toBe(true)
    expect(verdict.detail).toContain('gates are letting rugs through')
  })

  it('only counts deaths inside the window', () => {
    const old = [NOW - 30 * HOUR, NOW - 40 * HOUR, NOW - 50 * HOUR]
    expect(shouldEngage({ ...healthy, deathTimes: old }, L, NOW).engage).toBe(false)
  })

  it('does not divide by zero on an empty wallet', () => {
    expect(shouldEngage({ startingCapitalUsd: 0, equityUsd: 0, deathTimes: [] }, L, NOW).engage).toBe(false)
  })

  it('a profitable portfolio never trips the drawdown limit', () => {
    expect(shouldEngage({ ...healthy, equityUsd: 5_000 }, L, NOW).engage).toBe(false)
  })
})
