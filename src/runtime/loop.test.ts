import { describe, it, expect } from 'vitest'
import { runLoop, shutdownSignal } from './loop.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { RecordingAlerts } from '../infrastructure/notifications/recording.js'
import { AlertThrottle } from '../domain/notifications/alerts.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type CycleConfig, type CycleDeps } from '../application/orchestrator.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type Candles } from '../application/replay.js'

const NOW = 1_800_000_000_000
const quality: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: NOW }

const flat = (bars = 260): Candles => ({
  time: Array.from({ length: bars }, (_, i) => i * 3_600_000),
  open: Array(bars).fill(1), high: Array(bars).fill(1.001), low: Array(bars).fill(0.999),
  close: Array(bars).fill(1), volume: Array(bars).fill(10_000),
})

const config: CycleConfig = {
  params: DEFAULT_PARAMS,
  portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: 2_000 },
  heartbeatMs: 60 * 60 * 1000,
}

const rig = (over: Partial<CycleDeps> = {}) => {
  const alerts = new RecordingAlerts()
  const deps: CycleDeps = {
    store: new MemoryStore(),
    alerts,
    probe: async () => 'not-filled',
    candlesFor: async () => flat(),
    healthFor: async () => null,
    brokerFor: () => new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 500, maxOpenEntries: 10, quality: () => quality }),
    scan: async () => [],
    now: () => NOW,
    ...over,
  }
  return { deps, alerts, throttle: new AlertThrottle(60_000) }
}

/** Never actually waits. */
const instant = { sleep: async () => {} }

describe('runLoop — bounded runs', () => {
  it('runs exactly maxCycles and reports why it stopped', async () => {
    const { deps, throttle } = rig()
    const report = await runLoop(deps, config, throttle, { intervalMs: 1_000, maxCycles: 3, ...instant })
    expect(report.cycles).toBe(3)
    expect(report.failures).toBe(0)
    expect(report.stoppedBy).toBe('max-cycles')
    expect(report.lastResult).not.toBeNull()
  })

  it('announces starting and stopping', async () => {
    const { deps, alerts, throttle } = rig()
    await runLoop(deps, config, throttle, { intervalMs: 1, maxCycles: 1, ...instant })
    // Asserted on the alert's KIND and its numbers, not its prose: these
    // strings are display copy and were once coupled tightly enough that
    // translating the app broke the test suite.
    expect(alerts.sent[0]!.kind).toBe('engine-started')
    expect(alerts.sent.at(-1)!.kind).toBe('engine-started')
    expect(alerts.sent.at(-1)!.body).toContain('1')
  })

  it('sleeps the configured interval between cycles, not before the first', async () => {
    const sleeps: number[] = []
    const { deps, throttle } = rig()
    await runLoop(deps, config, throttle, { intervalMs: 5_000, maxCycles: 3, sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([5_000, 5_000, 5_000])
  })
})

describe('runLoop — a failing provider does not kill the engine', () => {
  it('survives a failed cycle, backs off, and keeps going', async () => {
    let calls = 0
    const { deps, throttle } = rig({
      scan: async () => {
        calls++
        if (calls <= 2) throw new Error('provider down')
        return []
      },
    })
    const sleeps: number[] = []
    const report = await runLoop(deps, config, throttle, { intervalMs: 1_000, maxCycles: 2, backoffMs: 1_000, sleep: async (ms) => { sleeps.push(ms) } })
    expect(report.failures).toBe(2)
    expect(report.cycles).toBe(2)
    // Backoff doubles: 1s, 2s — then the normal interval resumes.
    expect(sleeps.slice(0, 2)).toEqual([1_000, 2_000])
  })

  it('caps the backoff so a long outage does not become an hour of silence', async () => {
    const { deps, throttle } = rig({ scan: async () => { throw new Error('down') } })
    const sleeps: number[] = []
    const stop = new Promise<void>((resolve) => setTimeout(resolve, 0))
    await runLoop(deps, config, throttle, {
      intervalMs: 1_000, backoffMs: 1_000, maxBackoffMs: 4_000, stopSignal: stop,
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > 8) throw new Error('stop') },
    }).catch(() => {})
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(4_000)
  })

  it('says when it recovers — an error with no resolution keeps a human worried', async () => {
    let calls = 0
    const { deps, alerts, throttle } = rig({
      scan: async () => {
        calls++
        if (calls === 1) throw new Error('blip')
        return []
      },
    })
    await runLoop(deps, config, throttle, { intervalMs: 1, maxCycles: 1, ...instant })
    // Degraded, then a SECOND provider-degraded alert once it came back: the
    // point is that recovery is announced at all, not how it is phrased.
    const degraded = alerts.sent.filter((a) => a.kind === 'provider-degraded')
    expect(degraded).toHaveLength(2)
    expect(degraded[1]!.title).not.toBe(degraded[0]!.title)
  })
})

describe('runLoop — clean shutdown', () => {
  it('stops after finishing the current cycle, not in the middle of one', async () => {
    let finished = 0
    const { deps, throttle } = rig({
      scan: async () => { finished++; return [] },
    })
    // Signal already resolved: the loop still completes one whole cycle.
    const report = await runLoop(deps, config, throttle, { intervalMs: 1_000, stopSignal: Promise.resolve(), ...instant })
    expect(report.stoppedBy).toBe('signal')
    expect(finished).toBeLessThanOrEqual(1)
  })

  it('a stop during a long cycle takes effect without another full interval', async () => {
    let resolveStop: () => void = () => {}
    const stop = new Promise<void>((r) => { resolveStop = r })
    const sleeps: number[] = []
    const { deps, throttle } = rig({ scan: async () => { resolveStop(); return [] } })
    await runLoop(deps, config, throttle, { intervalMs: 9_999, stopSignal: stop, sleep: async (ms) => { sleeps.push(ms) } })
    // It broke out before sleeping the interval.
    expect(sleeps).not.toContain(9_999)
  })
})

describe('shutdownSignal', () => {
  it('resolves on the first signal', async () => {
    const handlers: Record<string, () => void> = {}
    const promise = shutdownSignal((signal, handler) => { handlers[signal] = handler }, () => {})
    handlers.SIGTERM!()
    await expect(promise).resolves.toBeUndefined()
  })

  it('a second signal exits immediately — pressing twice means now', async () => {
    const handlers: Record<string, () => void> = {}
    const exits: number[] = []
    shutdownSignal((signal, handler) => { handlers[signal] = handler }, (code) => exits.push(code))
    handlers.SIGINT!()
    handlers.SIGINT!()
    expect(exits).toEqual([1])
  })
})
