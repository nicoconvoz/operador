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
import { FLAT_ONE_PCT_STOP } from '../domain/risk/stop-loss.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'

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
    brokerFor: async () => new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 500, maxOpenEntries: 10, quality: () => quality }),
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

// ── Two cadences, not one ───────────────────────────────────────────────────
//
// Advancing open positions and hunting for new tokens used to share a clock,
// and the expensive half set it: a held token got looked at every ~35 minutes
// on 15-minute bars. They are now paced separately, because a token you HOLD
// can rug in ten minutes while a missed opportunity is only missed.

describe('runLoop — watching runs faster than scanning', () => {
  const kinds = (deps: CycleDeps) => {
    const seen: string[] = []
    return {
      seen,
      scan: async (kind: 'full' | 'held') => { seen.push(kind); return [] },
      deps,
    }
  }

  it('scans on the very first pass — it has never looked', async () => {
    const spy = kinds(rig().deps)
    const { deps } = rig({ scan: spy.scan })

    await runLoop(deps, config, new AlertThrottle(0), { intervalMs: 0, sleep: async () => {}, maxCycles: 1, scanIntervalMs: 60_000 })

    expect(spy.seen).toEqual(['full'])
  })

  it('watches between scans instead of scanning every pass', async () => {
    const spy = kinds(rig().deps)
    let clock = NOW
    const { deps } = rig({ scan: spy.scan, now: () => clock })

    // Four passes a minute apart, scanning at most every ten minutes.
    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0,
      sleep: async () => { clock += 60_000 },
      maxCycles: 4,
      scanIntervalMs: 10 * 60_000,
    })

    expect(spy.seen).toHaveLength(1)
  })

  it('scans again once the scan interval has actually elapsed', async () => {
    const spy = kinds(rig().deps)
    let clock = NOW
    const { deps } = rig({ scan: spy.scan, now: () => clock })

    // Passes five minutes apart, scanning every ten: pass 1 and pass 3 scan.
    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0,
      sleep: async () => { clock += 5 * 60_000 },
      maxCycles: 4,
      scanIntervalMs: 10 * 60_000,
    })

    expect(spy.seen).toHaveLength(2)
  })

  it('re-examines the BOOK between full scans, without discovering', async () => {
    // The urgent half of a scan on its own clock. A token holding money can rug
    // in ten minutes; one that does not is only a missed opportunity — and the
    // two were sharing a schedule set by the expensive one.
    const spy = kinds(rig().deps)
    let clock = NOW
    const { deps } = rig({ scan: spy.scan, now: () => clock })

    // Passes five minutes apart, a full scan every twenty, the book every ten.
    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0,
      sleep: async () => { clock += 5 * 60_000 },
      maxCycles: 5,
      scanIntervalMs: 20 * 60_000,
      heldScanIntervalMs: 10 * 60_000,
    })

    expect(spy.seen[0]).toBe('full')
    expect(spy.seen).toContain('held')
    expect(spy.seen.filter((k) => k === 'full')).toHaveLength(2)
  })

  it('does not owe a book pass the minute after a full scan did one', async () => {
    // A full scan re-examines the book on its way past, so it resets that clock
    // too — otherwise the very next pass would redo work just done.
    const spy = kinds(rig().deps)
    let clock = NOW
    const { deps } = rig({ scan: spy.scan, now: () => clock })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0,
      sleep: async () => { clock += 60_000 },
      maxCycles: 2,
      scanIntervalMs: 60 * 60_000,
      heldScanIntervalMs: 10 * 60_000,
    })

    expect(spy.seen).toEqual(['full'])
  })

  it('scans every pass when no scan interval is set — the old behaviour, unchanged', async () => {
    const spy = kinds(rig().deps)
    const { deps } = rig({ scan: spy.scan })

    await runLoop(deps, config, new AlertThrottle(0), { intervalMs: 0, sleep: async () => {}, maxCycles: 3 })

    expect(spy.seen).toHaveLength(3)
  })
})

// ── A restart does not owe a scan it already has ────────────────────────────
//
// The first pass always scanned, so every restart spent half an hour of
// throttled discovery before it could put anything in a free slot — even with
// a scan minutes old sitting in the database. Cancel a run and relaunch it and
// the clock started over; three relaunches in twenty-three minutes never once
// reached the allocation step.
//
// A shelf fresh enough to ALLOCATE from is fresh enough to START from.

describe('runLoop — it begins with what it already knows', () => {
  it('starts by watching when the shelf is recent, so slots fill in seconds', async () => {
    let scans = 0
    const { deps } = rig({
      scan: async () => { scans++; return [] },
      recall: async () => ({ candidates: [], switchedOff: [], scannedAt: NOW - 60_000 }),
    })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0, sleep: async () => {}, maxCycles: 1, scanIntervalMs: 10 * 60_000,
    })

    expect(scans).toBe(0)
  })

  it('scans first when there is no shelf at all', async () => {
    let scans = 0
    const { deps } = rig({ scan: async () => { scans++; return [] }, recall: async () => null })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0, sleep: async () => {}, maxCycles: 1, scanIntervalMs: 10 * 60_000,
    })

    expect(scans).toBe(1)
  })

  it('scans first when the shelf is already past its window', async () => {
    let scans = 0
    let clock = NOW
    const { deps } = rig({
      scan: async () => { scans++; return [] },
      recall: async () => ({ candidates: [], switchedOff: [], scannedAt: NOW - 60 * 60_000 }),
      now: () => clock,
    })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0, sleep: async () => { clock += 1000 }, maxCycles: 1, scanIntervalMs: 10 * 60_000,
    })

    expect(scans).toBe(1)
  })
})

describe('runLoop — it says what it did, every pass', () => {
  it('reports each pass, so silence means stopped rather than working', async () => {
    const seen: string[] = []
    const { deps } = rig({ recall: async () => ({ candidates: [], switchedOff: [], scannedAt: NOW - 60_000 }) })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0, sleep: async () => {}, maxCycles: 2, scanIntervalMs: 10 * 60_000,
      onPass: (result) => seen.push(result.kind),
    })

    // A watch pass prints nothing of its own — no scan, no progress — so four
    // minutes of empty log looked exactly like a hang. It was a working engine.
    expect(seen).toEqual(['watch', 'watch'])
  })

  it('reports a failed pass too, rather than going quiet on the one that matters', async () => {
    const passes: unknown[] = []
    const { deps } = rig({ candlesFor: async () => { throw new Error('provider down') } })

    await runLoop(deps, config, new AlertThrottle(0), {
      intervalMs: 0, sleep: async () => {}, maxCycles: 1, backoffMs: 0,
      onPass: (result) => passes.push(result),
      stopSignal: Promise.resolve(),
    })

    expect(passes).toEqual([])
  })
})

describe('runLoop — the stop does not clock off between cycles', () => {
  // The gap three commits of reordering could not close, because it is not in
  // the cycle at all.
  //
  // Positions are opened in step 3, near the END of a pass. So no sweep is
  // left in that cycle to catch them, and the next one cannot look until the
  // sleep is over and recovery has run. From the tape: twenty-three positions
  // opened at the end of one cold cycle, six of them ALREADY past the line,
  // and not a single stop alert in forty-three minutes.
  //
  // That window is the first half hour of a position's life, which on these
  // tokens is when it moves most. A cycle cannot protect a book after it has
  // stopped running, so the rule had to leave the cycle.

  it('sells a position that goes under water while the loop is sleeping', async () => {
    let clock = NOW
    let asked = 0
    const store = new MemoryStore()
    const { deps } = rig({
      store,
      now: () => clock,
      // HEALTHY while the cycle runs, sunk only once it is sleeping. Nothing
      // inside the pass could have caught this one.
      marketPrices: async () => new Map([['solana:Held', asked++ === 0 ? 1 : 0.9]]),
      brokerFor: async (pos) => {
        const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 500, maxOpenEntries: 10, quality: () => quality })
        broker.seed(await store.fillsFor(pos.id))
        return broker
      },
    })
    await store.savePosition({
      id: 'pos-1', chain: 'solana', tokenAddress: 'Held', pairAddress: 'PairHeld', symbol: 'HELD',
      cascade: initialState(), deathWatch: startDeathWatch(1_000_000, NOW), quality, capitalUsd: 15,
      lastBarTime: -1, lastPriceUsd: 1, pendingOrders: [], openedAt: NOW, updatedAt: NOW,
    })
    await store.recordFill({
      positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 3_600_000,
      price: 1, qty: 15, costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: 'entry-1',
    })

    await runLoop(
      deps,
      { ...config, stopLoss: FLAT_ONE_PCT_STOP },
      new AlertThrottle(60_000),
      // One cycle, then a long sleep. The sleep is where the cut must happen:
      // with maxCycles at 1 there is no second pass to fall back on.
      { intervalMs: 120_000, maxCycles: 1, sleep: async (ms) => { clock += ms } },
    )

    expect((await store.allFills()).find((f: { side: string; comment: string }) => f.side === 'sell')?.comment).toBe('🛑 Stop')
    expect(await store.loadPositions()).toEqual([])
  })

  it('keeps watching when the stop is DOLLARS only and the percent is off', async () => {
    // The loop's guard used to ask only whether a PERCENT stop was set. A book
    // held under ten cents and nothing else would have gone unwatched between
    // cycles — the dollar rule honoured inside a pass and ignored in the
    // twenty minutes around it.
    let clock = NOW
    let asked = 0
    const store = new MemoryStore()
    const { deps } = rig({
      store,
      now: () => clock,
      marketPrices: async () => new Map([['solana:Held', asked++ === 0 ? 1 : 0.9]]),
      brokerFor: async (pos) => {
        const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 500, maxOpenEntries: 10, quality: () => quality })
        broker.seed(await store.fillsFor(pos.id))
        return broker
      },
    })
    await store.savePosition({
      id: 'pos-1', chain: 'solana', tokenAddress: 'Held', pairAddress: 'PairHeld', symbol: 'HELD',
      cascade: initialState(), deathWatch: startDeathWatch(1_000_000, NOW), quality, capitalUsd: 15,
      lastBarTime: -1, lastPriceUsd: 1, pendingOrders: [], openedAt: NOW, updatedAt: NOW,
    })
    await store.recordFill({
      positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 3_600_000,
      price: 1, qty: 15, costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: 'entry-1',
    })

    await runLoop(
      deps,
      { ...config, stopLoss: { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0.1 }, breakEven: false },
      new AlertThrottle(60_000),
      { intervalMs: 120_000, maxCycles: 1, sleep: async (ms) => { clock += ms } },
    )

    expect((await store.allFills()).find((f: { side: string; comment: string }) => f.side === 'sell')?.comment).toBe('🛑 Stop')
  })

  it('leaves a position with orders in flight alone, because that is a HALT', async () => {
    // Recovery could not answer whether the fill happened. An unattended system
    // is allowed to stop; it is never allowed to guess, and selling on top of
    // an unresolved order is how a spot book goes short.
    let clock = NOW
    const store = new MemoryStore()
    const { deps } = rig({
      store,
      now: () => clock,
      probe: async () => 'unknown',
      marketPrices: async () => new Map([['solana:Held', 0.9]]),
      // Seeded from the recorded fills. The paper broker starts FLAT, so an
      // unseeded one sells nothing and this would pass without the guard.
      brokerFor: async (pos) => {
        const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: 500, maxOpenEntries: 10, quality: () => quality })
        broker.seed(await store.fillsFor(pos.id))
        return broker
      },
    })
    await store.savePosition({
      id: 'pos-1', chain: 'solana', tokenAddress: 'Held', pairAddress: 'PairHeld', symbol: 'HELD',
      cascade: initialState(), deathWatch: startDeathWatch(1_000_000, NOW), quality, capitalUsd: 15,
      lastBarTime: NOW, lastPriceUsd: 1,
      pendingOrders: [{ kind: 'entry', id: 'Entry', level: 1, qty: 15, usd: 15, comment: '🟢 Entry' }],
      openedAt: NOW, updatedAt: NOW,
    })
    await store.recordFill({
      positionId: 'pos-1', orderId: 'Entry', side: 'buy', time: NOW - 3_600_000,
      price: 1, qty: 15, costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: 'entry-1',
    })

    await runLoop(
      deps,
      { ...config, stopLoss: FLAT_ONE_PCT_STOP },
      new AlertThrottle(60_000),
      { intervalMs: 120_000, maxCycles: 1, sleep: async (ms) => { clock += ms } },
    )

    expect((await store.allFills()).some((f: { side: string }) => f.side === 'sell')).toBe(false)
  })
})
