import { describe, it, expect } from 'vitest'
import { sweepStops, type DipBounce, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { fundStepFromFreeCapital } from './free-capital.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { DEFAULT_DIP_BOUNCE_POLICY } from '../domain/strategy/dip-bounce.js'

/**
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla* — then *disminuí los escalones a 20.*
 *
 * The rule is pure and tested in `domain/strategy/dip-bounce.ts`. These ask the
 * SWEEP that runs it every thirty seconds: that it watches a reservation from
 * the first price it sees and buys its FIRST dollar on the rule, then every
 * later one; that it writes the watch down only when it moved; and that every
 * guard the sweep applies to a buy still applies to this one.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const GAS = 0.05

/** A reservation: twenty dollars, nothing bought, a candle close on record. */
const reservation = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 20,
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  ...over,
})

const NO_STOP: ExitLevels = { stop: { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }, armAtPct: null, breakEvenPct: 0, gainLock: null }

const rig = async (options: { readonly held?: PersistedPosition; readonly bookUsd?: number; readonly others?: readonly PersistedPosition[] } = {}) => {
  const store = new MemoryStore()
  await store.savePosition(options.held ?? reservation())
  for (const other of options.others ?? []) await store.savePosition(other)
  let writes = 0
  // The same store, counting its position writes: a write is the whole row,
  // and the network it costs is what this project once ran out of.
  const counting = new Proxy(store, {
    get: (target, key) => {
      if (key === 'savePosition') return async (p: PersistedPosition) => { writes++; return target.savePosition(p) }
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  const sent: Alert[] = []
  const brokers = new Map<string, PaperBroker>()
  const brokerFor = async (p: PersistedPosition) => {
    const key = `${p.id}:${p.capitalUsd}`
    let broker = brokers.get(key)
    if (!broker) {
      broker = new PaperBroker({ gasUsdPerSwap: GAS, initialCapital: p.capitalUsd, maxOpenEntries: 20, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      brokers.set(key, broker)
    }
    return broker
  }
  const dipBounce: DipBounce = {
    policy: DEFAULT_DIP_BOUNCE_POLICY,
    stepUsd: 1,
    gasUsdPerSwap: GAS,
    fund: fundStepFromFreeCapital({
      store,
      totalCapitalUsd: options.bookUsd ?? 1_000,
      cashOf: async (p) => (await brokerFor(p)).equityCash,
    }),
  }
  const deps: StopSweepDeps = {
    store: counting,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor,
    now: () => AT,
    dipBounce,
  }
  let sweeps = 0
  /** One sweep at a live price, the last candle close beside it as the tick would have left it. */
  const run = async (price: number, close: number = price) =>
    sweepStops(
      deps, () => NO_STOP, new AlertThrottle(0),
      (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: close })),
      new Map([['solana:T', price]]),
      AT + MIN * sweeps++,
    )
  const buys = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')
  const watch = async () => (await store.loadPositions())[0]?.dipWatch ?? null
  return { store, sent, run, buys, watch, writes: () => writes, deps }
}

/** Walks the price down one full step: a 4% dip, then a 2.1% bounce off it. */
const oneStep = async (run: (price: number) => Promise<unknown>, from: number) => {
  await run(from * 0.96)
  await run(from * 0.96 * 1.021)
  return from * 0.96 * 1.021
}

describe('the dip-bounce ladder, through the sweep — the FIRST buy', () => {
  it('buys nothing when a reservation becomes a position: it starts watching at the first price it sees', async () => {
    const { run, buys, watch } = await rig()
    await run(1)
    expect(await buys()).toEqual([])
    expect(await watch()).toMatchObject({ reference: 1, armed: false, low: null, holdingSince: null })
  })

  it('buys its first dollar on a 3% dip under the high and a 2% bounce off the low — and says so', async () => {
    const { run, buys, watch, sent } = await rig()
    for (const price of [1, 1.05, 1.03, 1.04]) await run(price)
    expect(await buys()).toEqual([])
    const high = 1.05
    await run(high * 0.96)
    expect(await watch()).toMatchObject({ armed: true, low: high * 0.96 })
    await run(high * 0.96 * 1.021)
    const bought = await buys()
    expect(bought.map((f) => f.orderId)).toEqual(['Entry'])
    expect(bought[0]!.qty).toBeCloseTo(1 / (high * 0.96 * 1.021), 9)
    expect(sent.find((a) => a.kind === 'position-opened')?.title).toBe('🟢 T compró $1 — cayó 4.0% y rebotó 2.1% (compra 1 de 20)')
    expect(sent.find((a) => a.kind === 'position-opened')?.level).toBe('info')
    // The buy is the reference now, unarmed, and the holding is named.
    expect(await watch()).toMatchObject({ reference: high * 0.96 * 1.021, armed: false, low: null, holdingSince: bought[0]!.time })
  })
})

describe('the dip-bounce ladder, through the sweep — every later buy', () => {
  it('buys the next dollar on a fresh 3% dip under the LAST buy and a fresh 2% bounce, and says which one it is', async () => {
    const { run, buys, sent } = await rig()
    await run(1)
    let price = await oneStep(run, 1)
    price = await oneStep(run, price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    const averaged = sent.filter((a) => a.kind === 'dca-filled').map((a) => a.title)
    expect(averaged).toEqual(['🪜 T promedió — compra 2 de 20: cayó 4.0% y rebotó 2.1%'])
    expect(sent.find((a) => a.kind === 'dca-filled')?.level).toBe('info')
    void price
  })

  it('stops at twenty, the first buy included — every one a dollar, every one under the last', async () => {
    const { run, buys } = await rig()
    await run(1)
    let price = 1
    for (let i = 0; i < 25; i++) price = await oneStep(run, price)
    const bought = await buys()
    expect(bought).toHaveLength(20)
    for (let i = 1; i < bought.length; i++) expect(bought[i]!.price).toBeLessThan(bought[i - 1]!.price)
  })

  it('pays the fees of the last steps out of the free capital, never out of the step', async () => {
    // Twenty dollars reserved, and each $1 step costs its spread and $0.05 of
    // gas on top: the last steps find the cash short and ask the free pool for
    // the difference — the step itself stays a dollar.
    const { run, buys, store } = await rig({ bookUsd: 1_000 })
    await run(1)
    let price = 1
    for (let i = 0; i < 20; i++) price = await oneStep(run, price)
    expect(await buys()).toHaveLength(20)
    for (const f of await buys()) expect(f.qty * f.price).toBeCloseTo(1 * (1 + 0.1 / 100), 3)
    const [held] = await store.loadPositions()
    expect(held!.capitalUsd).toBeGreaterThan(20)
    expect(held!.capitalUsd).toBeLessThan(22)
  })

  it('says a step found no free capital for its fees, and buys nothing — the step is never shrunk', async () => {
    // A book of exactly one slot: nothing is free past it.
    const { run, buys, sent } = await rig({ bookUsd: 20 })
    await run(1)
    let price = 1
    for (let i = 0; i < 20; i++) price = await oneStep(run, price)
    const bought = await buys()
    expect(bought.length).toBeGreaterThan(15)
    expect(bought.length).toBeLessThan(20)
    for (const f of bought) expect(f.qty * f.price).toBeCloseTo(1 * (1 + 0.1 / 100), 3)
    expect(sent.some((a) => a.kind === 'entry-refused' && a.title.startsWith('💤 T sin capital libre para la compra'))).toBe(true)
  })
})

describe('the dip-bounce ladder, through the sweep — every guard a buy has', () => {
  const armedAt = async (held: Partial<PersistedPosition>) => {
    const r = await rig({ held: reservation(held) })
    await r.run(1)
    await r.run(0.96)
    return r
  }

  it('never buys into a position the death watch froze or condemned', async () => {
    for (const stage of ['frozen', 'dead'] as const) {
      const deathWatch: DeathWatchState = { ...startDeathWatch(1, 0), stage }
      const { run, buys } = await armedAt({ deathWatch })
      await run(0.99)
      expect(await buys(), stage).toEqual([])
    }
  })

  it('never buys into one with no candle close on record', async () => {
    const { run, buys, watch } = await rig({ held: reservation({ lastBarTime: -1 }) })
    for (const price of [1, 0.96, 0.99]) await run(price)
    expect(await buys()).toEqual([])
    expect(await watch()).toBeNull()
  })

  it('never buys when the live price and the last close disagree past the band', async () => {
    const { run, buys, sent } = await rig()
    await run(1)
    await run(0.96)
    await run(0.99, 0.1)
    expect(await buys()).toEqual([])
    expect(sent.some((a) => a.kind === 'position-halted')).toBe(true)
  })

  it('never buys on top of an order in flight', async () => {
    const { run, buys, watch } = await rig({ held: reservation({ pendingOrders: [{ kind: 'closeAll', comment: '🏁 Exit' }] }) })
    for (const price of [1, 0.96, 0.99]) await run(price)
    expect(await buys()).toEqual([])
    expect(await watch()).toBeNull()
  })

  it('never buys the same step twice off one sweep run again', async () => {
    const { run, buys, deps, store } = await rig()
    await run(1)
    await run(0.96)
    const book = await store.loadPositions()
    const once = () => sweepStops(deps, () => NO_STOP, new AlertThrottle(0), book.map((p) => ({ ...p, lastPriceUsd: 0.99 })), new Map([['solana:T', 0.99]]), AT + 9 * MIN)
    await once()
    await once()
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
  })
})

describe('the dip-bounce ladder, through the sweep — what it writes', () => {
  it('writes nothing when the price moves under a tenth of a percent — and writes the watch when it moves more', async () => {
    const { run, writes } = await rig()
    await run(1)
    const first = writes()
    await run(1.0005)
    await run(0.9998)
    expect(writes()).toBe(first)
    await run(1.002)
    expect(writes()).toBe(first + 1)
  })

  it('keeps an armed watch across sweeps and processes: the low it bounces off is the one it saw', async () => {
    const { run, buys, watch } = await rig()
    await run(1)
    await run(0.96)
    await run(0.95)
    expect(await watch()).toMatchObject({ armed: true, low: 0.95 })
    await run(0.968)
    expect(await buys()).toEqual([])
    await run(0.97)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
  })
})
