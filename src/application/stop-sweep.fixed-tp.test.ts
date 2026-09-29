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
 * *Poné un TP fijo al 12.5% del promedio.* The operator — sell everything the
 * moment the live price reaches the average cost plus 12.5%, with no wait for
 * any impulse or bar, accepting that the big runs are given up.
 *
 * The rig reads the book back from the store before every sweep, as the cycle
 * and the loop both do.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }
const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
const TP = '🎯 TP fijo'

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 100,
  // The candle close the tick last acted on. Every price below is within the
  // agreement band of it, so the second-source guard lets them all through.
  lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  ...over,
})

const buy = (price: number, time: number, id = time === 0 ? 'Entry' : 'DCA-1'): PersistedFill => ({
  positionId: ID, orderId: id, side: 'buy', time, price, qty: 15 / price, costUsd: 0.05,
  comment: id, idempotencyKey: `${ID}:buy:${time}`,
})

const rig = async (options: {
  readonly held?: PersistedPosition
  /** Fills after the $15 first buy at 1.00, time zero. */
  readonly history?: readonly PersistedFill[]
  /** The TP in percent; null is off, as `OPERADOR_FIXED_TP_PCT=0` leaves it. */
  readonly tp?: number | null
  /** The gain lock beside it. Off unless asked. */
  readonly lock?: boolean
} = {}) => {
  const store = new MemoryStore()
  const held = options.held ?? position()
  await store.savePosition(held)
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
  }
  const levels: ExitLevels = {
    stop: NO_STOP,
    armAtPct: null,
    breakEvenPct: 0,
    gainLock: options.lock === true ? DEFAULT_GAIN_LOCK_POLICY : null,
    fixedTpPct: options.tp === undefined ? 12.5 : options.tp,
  }
  const run = async (price: number, book?: readonly PersistedPosition[]) =>
    sweepStops(deps, () => levels, new AlertThrottle(0), book ?? (await store.loadPositions()), new Map([['solana:T', price]]), AT)
  const sells = async () => (await store.fillsFor(ID)).filter((f) => f.side === 'sell')
  const open = async () => (await store.loadPositions()).map((p) => p.id)
  return { store, sent, run, sells, open, held }
}

describe('the fixed TP — sell everything at the average cost plus 12.5%', () => {
  it('sells the whole position the sweep the live price reaches +12.5%, under its own name, and closes it', async () => {
    const { store, run, sells, open } = await rig()
    expect(await run(1.125)).toEqual([ID])
    const sold = await sells()
    expect(sold.map((f) => f.comment)).toEqual([TP])
    expect(sold.reduce((q, f) => q + f.qty, 0)).toBeCloseTo(15, 9)
    expect(await open()).toEqual([])
    expect((await store.fillsFor(ID)).length).toBe(2)
  })

  it('says it, at INFO, with what the sale made', async () => {
    const { sent, run, sells } = await rig()
    await run(1.125)
    const made = (await sells()).reduce((sum, f) => sum + f.qty * (f.price - 1), 0)
    const said = sent.find((a) => a.kind === 'position-closed')
    expect(said?.level).toBe('info')
    expect(said?.title).toBe(`🎯 T vendida en su TP fijo: +12.5% sobre el promedio — ganó $${made.toFixed(2)}`)
    expect(made).toBeGreaterThan(1.5)
  })

  it('sells a price that jumped past the line at the live price, not at the line', async () => {
    const { run, sells } = await rig()
    expect(await run(1.4)).toEqual([ID])
    expect((await sells())[0]!.price).toBeGreaterThan(1.39)
  })

  it('does not sell at +12% — the line is +12.5%', async () => {
    const { sent, run, sells, open } = await rig()
    expect(await run(1.12)).toEqual([])
    expect(await sells()).toEqual([])
    expect(await open()).toEqual([ID])
    expect(sent).toEqual([])
  })

  it('measures from the AVERAGE of the holding, never from the first buy', async () => {
    // $15 at 1.00 and $15 at 0.80: the average is 0.8889 and the line 1.0000,
    // while the first buy's +12.5% would be 1.125.
    const { run, sells } = await rig({ history: [buy(0.8, MIN)] })
    expect(await run(0.995)).toEqual([])
    expect(await run(1.001)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual([TP, TP])
  })

  it('never sells twice: the same stale snapshot handed to a second sweep collides with its own key', async () => {
    const { run, sells, held } = await rig()
    expect(await run(1.125, [held])).toEqual([ID])
    expect(await run(1.13, [held])).toEqual([])
    expect(await sells()).toHaveLength(1)
  })

  it('is inert when switched off — nothing sells at +12.5% or at +50%', async () => {
    const { run, sells, open } = await rig({ tp: null })
    expect(await run(1.125)).toEqual([])
    expect(await run(1.5)).toEqual([])
    expect(await sells()).toEqual([])
    expect(await open()).toEqual([ID])
  })

  it('leaves a position with orders in flight alone — that is a halt, not a TP', async () => {
    const pending = [{ kind: 'entry' as const, id: 'DCA-1', level: 1, usd: 15, qty: 15, comment: 'DCA-1' }]
    const { run, sells } = await rig({ held: position({ pendingOrders: pending }) })
    expect(await run(1.2)).toEqual([])
    expect(await sells()).toEqual([])
  })

  it('never sells at a live price the candle close does not confirm', async () => {
    // Twelve times the last close: a unit nobody agreed on, not a TP.
    const { run, sells } = await rig({ held: position({ lastPriceUsd: 0.1 }) })
    expect(await run(1.2)).toEqual([])
    expect(await sells()).toEqual([])
  })

  it('leaves a frozen or dead position to the freeze and death exits', async () => {
    for (const stage of ['frozen', 'dead'] as const) {
      const { run, sells, open } = await rig({ held: position({ deathWatch: { ...startDeathWatch(1, 0), stage } }) })
      expect(await run(1.2), stage).toEqual([])
      expect(await sells(), stage).toEqual([])
      expect(await open(), stage).toEqual([ID])
    }
  })

  it('is refused under cost by the no-loss guard, and then the position is held — never closed with tokens in it', async () => {
    // A pool whose exit costs 15%: +12.5% on the quote receives less than cost.
    const { run, sells, open } = await rig({ held: position({ quality: { ...quality, spreadPct: 15 } }) })
    expect(await run(1.125)).toEqual([])
    expect(await sells()).toEqual([])
    expect(await open()).toEqual([ID])
  })

  it('sells before the gain lock ever sets a floor: a jump to +25% leaves at the TP', async () => {
    const { store, run, sells } = await rig({ lock: true })
    expect(await run(1.25)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual([TP])
    expect((await store.loadPositions())).toEqual([])
  })

  it('leaves the gain lock working as it did when the TP is off', async () => {
    const { run, sells } = await rig({ tp: null, lock: true })
    expect(await run(1.25)).toEqual([])
    expect(await run(1.09)).toEqual([ID])
    expect((await sells()).map((f) => f.comment)).toEqual(['🔐 Piso de ganancia'])
  })
})
