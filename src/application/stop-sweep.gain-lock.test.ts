import { describe, it, expect } from 'vitest'
import { sweepStops, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { DEFAULT_GAIN_LOCK_POLICY } from '../domain/risk/gain-lock.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * *Si pasás el 20% de ganancia, break-even en el 10%; con cada aumento de 20%,
 * aumentar el break-even 10% — por si algo es muy volátil y vuela para arriba,
 * lo podemos atrapar si baja a toda velocidad.* The operator.
 *
 * The rig reads the book back from the store before every sweep, as the cycle
 * and the loop both do — so a lock the sweep raised is only there next time if
 * the store kept it.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
const LOCK = '🔐 Piso de ganancia'

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 100,
  // The candle close the tick last acted on. Every price below is within the
  // agreement band of it, so the second-source guard lets them all through.
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  ...over,
})

const buy = (price: number, time: number, usd = 15): PersistedFill => ({
  positionId: ID, orderId: 'Entry', side: 'buy', time, price, qty: usd / price, costUsd: 0.05,
  comment: 'Entry', idempotencyKey: `${ID}:buy:${time}`,
})
const sell = (price: number, qty: number, time: number): PersistedFill => ({
  positionId: ID, orderId: 'Exit', side: 'sell', time, price, qty, costUsd: 0.05,
  comment: '🏁 Exit', idempotencyKey: `${ID}:sell:${time}`,
})

const rig = async (options: {
  readonly held?: PersistedPosition
  /** Fills after the $15 first buy at 1.00, time zero. */
  readonly history?: readonly PersistedFill[]
  /** Three $15 rungs at −10/−20/−30% of the first buy. */
  readonly drop?: boolean
  /** False: the lock switched off, as `OPERADOR_GAIN_LOCK=0` leaves it. */
  readonly lock?: boolean
} = {}) => {
  const store = new MemoryStore()
  await store.savePosition(options.held ?? position())
  await store.recordFill(buy(1, 0))
  for (const fill of options.history ?? []) await store.recordFill(fill)

  const sent: Alert[] = []
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor: async (p) => {
      const broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 6, quality: () => p.quality })
      broker.seed(await store.fillsFor(p.id))
      return broker
    },
    now: () => AT,
    ...(options.drop ? { dropLadder: { policy: { maxEntries: 4, dropsPct: [10, 20, 30] }, rungsUsd: [15, 15, 15] } } : {}),
  }
  const levels: ExitLevels = {
    stop: NO_STOP,
    armAtPct: null,
    breakEvenPct: 0,
    gainLock: options.lock === false ? null : DEFAULT_GAIN_LOCK_POLICY,
    // The fixed TP off: these pin the lock alone, at gains the TP would take first.
    fixedTpPct: null,
  }
  const run = async (price: number) =>
    sweepStops(deps, () => levels, new AlertThrottle(0), await store.loadPositions(), new Map([['solana:T', price]]), AT)
  const lock = async () => (await store.loadPositions())[0]?.gainLock ?? null
  const sells = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'sell')
  const open = async () => (await store.loadPositions()).map((p) => p.id)
  return { store, sent, run, lock, sells, open }
}

describe('the gain lock — a floor under a winner, raised as it flies', () => {
  it('sets a +10% floor at +25%, and sells nothing', async () => {
    const { run, lock, sells } = await rig()
    expect(await run(1.25)).toEqual([])
    expect(await lock()).toEqual({ pct: 10, since: 0 })
    expect(await sells()).toEqual([])
  })

  it('sets nothing under +20%', async () => {
    const { run, lock } = await rig()
    await run(1.19)
    expect(await lock()).toBeNull()
  })

  it('holds a position still above its floor', async () => {
    const { run, sells, open } = await rig()
    await run(1.25)
    expect(await run(1.11)).toEqual([])
    expect(await sells()).toEqual([])
    expect(await open()).toEqual([ID])
  })

  it('then sells the whole position at +9%, under its own name, and closes it', async () => {
    const { store, sent, run, sells, open } = await rig()
    await run(1.25)
    expect(await run(1.09)).toEqual([ID])
    const sold = await sells()
    expect(sold.map((f) => f.comment)).toEqual([LOCK])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'sell').reduce((q, f) => q + f.qty, 0)).toBeCloseTo(15, 9)
    expect(await open()).toEqual([])
    const said = sent.find((a) => a.kind === 'position-closed')
    expect(said?.title).toContain('T')
    expect(said?.body).toContain('+20%')
    expect(said?.body).toContain('+10%')
  })

  it('raises the floor to +20% at +45%, and a fall to +19% sells', async () => {
    const { run, lock, sells } = await rig()
    await run(1.45)
    expect(await lock()).toEqual({ pct: 20, since: 0 })
    expect(await run(1.19)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual([LOCK])
  })

  it('never lowers the floor while the same holding lives', async () => {
    const { sent, run, lock } = await rig()
    await run(1.45)
    // +25% would only earn +10% on its own; the +20% already earned stays.
    expect(await run(1.25)).toEqual([])
    expect(await lock()).toEqual({ pct: 20, since: 0 })
    expect(await run(1.19)).toEqual([ID])
    expect(sent.find((a) => a.kind === 'position-closed')?.body).toContain('+40%')
  })

  it('never sells a price that keeps climbing — only a fall to the floor does', async () => {
    const { run, lock, sells } = await rig()
    for (const price of [1.1, 1.25, 1.45, 1.7, 2.3, 3.1]) expect(await run(price)).toEqual([])
    expect(await sells()).toEqual([])
    // +210% keeps 100 of it: *por si algo vuela para arriba*.
    expect(await lock()).toEqual({ pct: 100, since: 0 })
  })

  it('ignores a floor the OLD holding earned once the position sold and bought back', async () => {
    // Sold the first holding at 1.50, bought back at 2.00: a new holding, with
    // a floor of +20% from the old one still on the row.
    const { run, lock, sells } = await rig({
      held: position({ gainLock: { pct: 20, since: 0 }, lastPriceUsd: 2 }),
      history: [sell(1.5, 15, MIN), buy(2, 2 * MIN)],
    })
    // +5% on the new holding: above cost, so nothing but the stale floor could sell it.
    expect(await run(2.1)).toEqual([])
    expect((await sells()).map((f) => f.comment)).toEqual(['🏁 Exit'])
    // At +25% the new holding earns its own floor, and the store takes it whole.
    await run(2.5)
    expect(await lock()).toEqual({ pct: 10, since: 2 * MIN })
  })

  it('is refused under cost when a crash gaps through the floor — held, never closed with tokens in it', async () => {
    const { run, lock, sells, open } = await rig({ drop: true })
    await run(1.25)
    // Straight from +25% to −20%: the floor would sell, the no-loss guard refuses.
    expect(await run(0.8)).toEqual([])
    expect((await sells()).filter((f) => f.comment === LOCK)).toEqual([])
    expect(await open()).toEqual([ID])
    expect(await lock()).toEqual({ pct: 10, since: 0 })
  })

  it('lets the ladder average down a position whose lock sale was refused', async () => {
    const { store, run } = await rig({ drop: true })
    await run(1.25)
    await run(0.8)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy').map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('is inert when switched off', async () => {
    const { run, lock, sells } = await rig({ lock: false })
    await run(1.45)
    expect(await run(1.09)).toEqual([])
    expect(await sells()).toEqual([])
    expect(await lock()).toBeNull()
  })
})
