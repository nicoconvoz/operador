import { describe, it, expect } from 'vitest'
import { sweepStops, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PriceMark } from '../domain/risk/crash-stop.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * *Si una moneda baja más de 5% del precio en menos de un minuto, SL.* The rig
 * reads the book back before every sweep and advances the clock thirty seconds
 * a sweep, as production does.
 */

const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }

const entry: PersistedFill = {
  positionId: ID, orderId: 'Entry', side: 'buy', time: 0, price: 1, qty: 15, costUsd: 0.05,
  comment: 'Entry', idempotencyKey: `${ID}:buy:0`,
}

const rig = async (stage: 'healthy' | 'frozen' = 'healthy') => {
  const store = new MemoryStore()
  await store.savePosition({
    id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
    cascade: initialState(), deathWatch: { ...startDeathWatch(1, 0), stage }, quality, capitalUsd: 15,
    lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  })
  await store.recordFill(entry)
  const sent: Alert[] = []
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor: async (p) => {
      const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 1, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      return broker
    },
    now: () => 0,
    crashStop: { windowMs: 60_000, dropPct: 5, marks: new Map<string, readonly PriceMark[]>() },
  }
  const levels: ExitLevels = { stop: NO_STOP, armAtPct: null, breakEvenPct: 0, gainLock: null, fixedTpPct: null }
  let clock = 0
  const run = async (price: number) =>
    sweepStops(deps, () => levels, new AlertThrottle(0), await store.loadPositions(), new Map([['solana:T', price]]), (clock += 30_000))
  const sells = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'sell')
  return { run, sells, sent }
}

describe('the crash stop, through the sweep', () => {
  it('sells everything, at a loss, on a fall of more than 5% inside a minute', async () => {
    const { run, sells, sent } = await rig()
    expect(await run(1)).toEqual([])
    expect(await run(0.94)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual(['⚡ Caída rápida'])
    expect(sent.some((a) => a.title.includes('caída rápida'))).toBe(true)
  })

  it('holds a fall of 5% or less', async () => {
    const { run, sells } = await rig()
    await run(1)
    expect(await run(0.96)).toEqual([])
    expect(await sells()).toEqual([])
  })

  it('holds the same fall taken over more than a minute', async () => {
    const { run } = await rig()
    for (const price of [1, 0.98, 0.96]) expect(await run(price)).toEqual([])
    // 1.00 is a minute old now: 0.94 is 4.1% under the 0.98 of the last minute.
    expect(await run(0.94)).toEqual([])
  })

  it('sells a frozen holding too — a crash is not waited out', async () => {
    const { run } = await rig('frozen')
    await run(1)
    expect(await run(0.9)).toEqual([ID])
  })
})
