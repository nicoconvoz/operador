import { describe, it, expect } from 'vitest'
import { sweepStops, type DeepRung, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { DEFAULT_DEEP_RUNG_POLICY } from '../domain/strategy/deep-rung.js'
import { fundRungsFromFreeCapital } from './free-capital.js'
import { capitalForFillsUsd } from './paper-run.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'

/**
 * *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay un
 * rebote de 10%, nueva compra DCA de $20.* The operator.
 *
 * The rule is pure and tested in `domain/strategy/deep-rung.ts`. These ask the
 * SWEEP that runs it every thirty seconds: that it follows the low and writes
 * it down, that it buys the one rung at the live price and never another, and
 * that every guard the sweep already applied to a rung still applies to this
 * one.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const PARAMS = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
/** What the first buy and the rung need together, gas and headroom included. */
const BOTH = capitalForFillsUsd([15, 20], 0.05)

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: BOTH,
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  ...over,
})

const fill = (side: 'buy' | 'sell', price: number, time: number, qty: number, orderId = side === 'buy' ? 'Entry' : 'Exit'): PersistedFill => ({
  positionId: ID, orderId, side, time, price, qty, costUsd: 0.05,
  comment: orderId, idempotencyKey: `${ID}:${side}:${time}`,
})

/** The first buy: $15 at 1.00. */
const ENTRY = fill('buy', 1, 0, 15)

const NO_STOP: ExitLevels = { stop: { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }, armAtPct: null, breakEvenPct: 0, gainLock: null, fixedTpPct: null }

const rig = async (options: {
  readonly held?: PersistedPosition
  readonly history?: readonly PersistedFill[]
  /** The book's capital, when the rung asks the free pool for its own. Absent: the position already holds it. */
  readonly bookUsd?: number
  readonly store?: MemoryStore
} = {}) => {
  const store = options.store ?? new MemoryStore()
  if (!options.store) {
    await store.savePosition(options.held ?? position())
    for (const f of options.history ?? [ENTRY]) await store.recordFill(f)
  }
  const sent: Alert[] = []
  const brokers = new Map<string, PaperBroker>()
  const deepRung: DeepRung = {
    policy: DEFAULT_DEEP_RUNG_POLICY,
    usd: 20,
    ...(options.bookUsd !== undefined
      ? { fund: fundRungsFromFreeCapital({ store, totalCapitalUsd: options.bookUsd, params: PARAMS, gasUsdPerSwap: 0.05, rungsUsd: [20] }) }
      : {}),
  }
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    // Keyed by the capital too, the way production rebuilds a broker once a
    // rung has raised it.
    brokerFor: async (p) => {
      const key = `${p.id}:${p.capitalUsd}`
      let broker = brokers.get(key)
      if (!broker) {
        broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 2, quality: () => p.quality })
        broker.seed(await store.fillsFor(p.id))
        brokers.set(key, broker)
      }
      return broker
    },
    now: () => AT,
    deepRung,
  }
  let sweeps = 0
  /**
   * One sweep at a live price, on the book as the store holds it — the way
   * production reads it — with the last candle close beside the live price,
   * as the tick would have left it. `close` overrides that close.
   */
  const run = async (price: number, close: number = price) =>
    sweepStops(
      deps, () => NO_STOP, new AlertThrottle(0),
      (await store.loadPositions()).map((p) => ({ ...p, lastPriceUsd: close })),
      new Map([['solana:T', price]]),
      AT + MIN * sweeps++,
    )
  const buys = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')
  const low = async () => (await store.loadPositions())[0]?.priceLow ?? null
  return { store, sent, run, buys, low }
}

describe('the deep rung, through the sweep — the low', () => {
  it('writes nothing while the low is above the arming line — no decision reads it there', async () => {
    const { run, low } = await rig()
    await run(0.9)
    await run(0.4)
    await run(0.21)
    expect(await low()).toBeNull()
  })

  it('writes the low down once it is under the line, and every lower one after it', async () => {
    const { run, low } = await rig()
    await run(0.5)
    await run(0.19)
    expect(await low()).toEqual({ price: 0.19, at: AT + MIN, holdingSince: 0 })
    await run(0.25)
    await run(0.12)
    await run(0.14)
    expect(await low()).toEqual({ price: 0.12, at: AT + 3 * MIN, holdingSince: 0 })
  })

  it('keeps the low across a restart: a new sweep on the same store buys off it', async () => {
    const first = await rig()
    await first.run(0.15)
    // A new process: new deps, new brokers, new throttle — only the store is kept.
    const restarted = await rig({ store: first.store })
    await restarted.run(0.165)
    expect((await restarted.buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('starts a NEW low for a new holding: a crash the last holding lived through buys nothing', async () => {
    // Bought at 1, fell to 0.1, sold; bought again at 1 at t=20. The old low
    // belongs to the old holding.
    const { run, buys, low } = await rig({
      held: position({ priceLow: { price: 0.1, at: 5, holdingSince: 0 } }),
      history: [ENTRY, fill('sell', 1.2, 10, 15), fill('buy', 1, 20, 15)],
    })
    await run(0.11)
    expect((await buys()).map((f) => f.time)).toEqual([0, 20])
    expect(await low()).toMatchObject({ price: 0.11, holdingSince: 20 })
  })

  it('does not move the low on a price the last candle does not confirm', async () => {
    // A unit nobody agreed on: 0.0001 live against a close of 1. Read as a
    // low, every real price after it would be a rebound of ten thousand times.
    const { run, low, buys } = await rig()
    await run(0.0001, 1)
    expect(await low()).toBeNull()
    expect(await buys()).toHaveLength(1)
  })
})

describe('the deep rung, through the sweep — what it buys', () => {
  for (const fall of [30, 50, 70]) {
    it(`buys NOTHING on a ${fall}% fall that rebounds 10%`, async () => {
      const { run, buys } = await rig()
      const bottom = 1 - fall / 100
      await run(bottom)
      await run(bottom * 1.1)
      await run(bottom * 1.3)
      expect(await buys()).toHaveLength(1)
    })
  }

  it('buys nothing at the bottom of an 85% fall — it has not rebounded yet', async () => {
    const { run, buys } = await rig()
    await run(0.15)
    expect(await buys()).toHaveLength(1)
  })

  it('buys ONE $20 rung once an 85% fall rebounds 10%, at the live price', async () => {
    const { run, buys, sent } = await rig()
    await run(0.15)
    await run(0.165)
    const bought = await buys()
    expect(bought.map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    // Twenty dollars at the live price, less what the venue takes.
    expect(bought[1]!.qty * 0.165).toBeCloseTo(20, 0)
    expect(bought[1]!.qty).toBeCloseTo(20 / 0.165, 6)
    const alerted = sent.find((a) => a.kind === 'dca-filled')!
    expect(alerted.level).toBe('info')
    expect(alerted.title).toBe('🪜 T promedió — DCA-1 $20: cayó 85.0% desde la primera compra y rebotó 10.0% desde el mínimo')
  })

  it('never buys again for that holding — not on a deeper fall, not on another rebound', async () => {
    const { run, buys } = await rig()
    await run(0.15)
    await run(0.165)
    await run(0.165)
    await run(0.05)
    await run(0.06)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('measures the rebound from the NEW low when it keeps falling while armed', async () => {
    const { run, buys } = await rig()
    await run(0.18)
    await run(0.12)
    // 10% over 0.18 would have been 0.198; over 0.12 it is 0.132.
    await run(0.13)
    expect(await buys()).toHaveLength(1)
    await run(0.132)
    expect(await buys()).toHaveLength(2)
  })

  it('buys nothing when the rebound put the position back over its cost', async () => {
    const { run, buys } = await rig()
    await run(0.15)
    await run(1.2, 1.2)
    expect(await buys()).toHaveLength(1)
  })
})

describe('the deep rung, through the sweep — every guard a rung already had', () => {
  it('never buys into a position the death watch froze', async () => {
    const frozen: DeathWatchState = { ...startDeathWatch(1, 0), stage: 'frozen' }
    const { run, buys } = await rig({ held: position({ deathWatch: frozen }) })
    await run(0.15)
    await run(0.165)
    expect(await buys()).toHaveLength(1)
  })

  it('never buys into a position the death watch condemned', async () => {
    const dead: DeathWatchState = { ...startDeathWatch(1, 0), stage: 'dead' }
    const { run, buys } = await rig({ held: position({ deathWatch: dead }) })
    await run(0.15)
    await run(0.165)
    expect(await buys()).toHaveLength(1)
  })

  it('never buys on a price the last candle close does not confirm', async () => {
    // Armed honestly at 0.15, then a live 0.165 against a close of 1: more
    // than the 5× band apart. Nothing is bought until the two agree.
    const { run, buys } = await rig()
    await run(0.15)
    await run(0.165, 1)
    expect(await buys()).toHaveLength(1)
    await run(0.165)
    expect(await buys()).toHaveLength(2)
  })

  it('never touches a position with orders in flight', async () => {
    const pending = position({ pendingOrders: [{ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 15, comment: 'Entry' }] })
    const { run, buys, low } = await rig({ held: pending })
    await run(0.15)
    await run(0.165)
    expect(await buys()).toHaveLength(1)
    expect(await low()).toBeNull()
  })

  it('asks the book’s FREE capital for the $20, and waits a sweep when there is none', async () => {
    // The slot holds the first buy alone; the rung pays for itself or waits.
    const slot = position({ capitalUsd: capitalForFillsUsd([15], 0.05) })
    const broke = await rig({ held: slot, bookUsd: slot.capitalUsd })
    await broke.run(0.15)
    await broke.run(0.165)
    expect(await broke.buys()).toHaveLength(1)
    expect(broke.sent.some((a) => a.title === '💤 T sin capital libre para el escalón DCA-1')).toBe(true)

    const funded = await rig({ held: slot, bookUsd: 1_000 })
    await funded.run(0.15)
    await funded.run(0.165)
    expect((await funded.buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    expect((await funded.store.loadPositions())[0]!.capitalUsd).toBeCloseTo(BOTH, 9)
  })

  it('buys once however many times the same sweep runs — idempotent on the bar', async () => {
    const { store, run, buys } = await rig()
    await run(0.15)
    // The same holding, two sweeps racing at the same price.
    await Promise.all([run(0.165), run(0.165)])
    expect(await buys()).toHaveLength(2)
    expect(new Set((await store.fillsFor(ID)).map((f) => f.idempotencyKey)).size).toBe(2)
  })
})
