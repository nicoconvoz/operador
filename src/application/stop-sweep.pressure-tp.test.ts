import { describe, it, expect } from 'vitest'
import { sweepStops, type ExitLevels, type StopSweepDeps, type PressureTp } from './stop-sweep.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * *Sin TP fijo; sólo cuando haya más ganancia que 12% empieza a correr el TP
 * de la presión compradora* — and it sells on a 10% fall of buyers' share from
 * its peak. The rig reads the book back before every sweep, as production does.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }

const position = (): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 15,
  lastBarTime: 0, lastPriceUsd: 1.1, pendingOrders: [], openedAt: 0, updatedAt: 0,
})

const entry: PersistedFill = {
  positionId: ID, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 15, costUsd: 0.05,
  comment: 'Entry', idempotencyKey: `${ID}:buy:0`,
}

const rig = async () => {
  const store = new MemoryStore()
  await store.savePosition(position())
  await store.recordFill(entry)
  const sent: Alert[] = []
  let hour: { buys: number; sells: number } | null = { buys: 60, sells: 40 }
  let asked = 0
  const pressureTp: PressureTp = {
    armPct: 12, dropPct: 10, gasUsdPerSwap: 0.05,
    hourCounts: async () => { asked++; return hour },
    peaks: new Map(), armed: new Set(),
  }
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor: async (p) => {
      const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 1, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      return broker
    },
    now: () => AT,
    pressureTp,
  }
  const levels: ExitLevels = { stop: NO_STOP, armAtPct: null, breakEvenPct: 0, gainLock: null, fixedTpPct: null }
  const run = async (price: number, buys: number | null = 60) => {
    hour = buys === null ? null : { buys, sells: 100 - buys }
    return sweepStops(deps, () => levels, new AlertThrottle(0), await store.loadPositions(), new Map([['solana:T', price]]), AT)
  }
  const sells = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'sell')
  return { run, sells, sent, asked: () => asked }
}

describe('the TP on buy pressure, running only past +12%', () => {
  it('does not run — nor even ask the hour — while the gain is 12% or less', async () => {
    const { run, sells, asked } = await rig()
    expect(await run(1.11, 70)).toEqual([])
    expect(await run(1.1, 20)).toEqual([])
    expect(await sells()).toEqual([])
    expect(asked()).toBe(0)
  })

  it('past +12%, sells everything once buyers fall 10% from their peak', async () => {
    const { run, sells, sent } = await rig()
    expect(await run(1.13, 60)).toEqual([])
    expect(await run(1.2, 70)).toEqual([])
    // 70% → 64%: under 10% off the peak.
    expect(await run(1.2, 64)).toEqual([])
    // 70% → 63%: the 10%.
    expect(await run(1.18, 63)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual(['📉 TP por presión'])
    expect(sent.some((a) => a.title.includes('TP por presión'))).toBe(true)
  })

  it('keeps running once armed, even back under +12%, while still in profit', async () => {
    const { run } = await rig()
    expect(await run(1.15, 70)).toEqual([])
    expect(await run(1.05, 62)).toEqual([ID])
  })

  it('disarms out of profit: the old peak is forgotten and must be earned again', async () => {
    const { run } = await rig()
    expect(await run(1.15, 70)).toEqual([])
    expect(await run(0.95, 70)).toEqual([])
    // Back in profit, but under +12%: not running.
    expect(await run(1.05, 30)).toEqual([])
  })

  it('a silent hour sells nothing and keeps the peak', async () => {
    const { run } = await rig()
    expect(await run(1.15, 70)).toEqual([])
    expect(await run(1.15, null)).toEqual([])
    expect(await run(1.15, 63)).toEqual([ID])
  })
})
