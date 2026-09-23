import { describe, it, expect } from 'vitest'
import { sweepStops, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'

/**
 * *Agregá 5 escalones de DCA, pero pedí un piso lateral de 5 velas de 1 minuto
 * antes de volver a comprar la bajada y promediar. Cada escalón de 15 dólares.
 * Tener en cuenta la ganancia total del token a lo largo del tiempo, y si la
 * ganancia es mayor a la pérdida también SL y rotar; si no, no salir en
 * pérdida.* The operator.
 */

const MIN = 60_000
const AT = 100 * MIN
const ID = 'solana:T:1'
const quality: MarketQuality = { liquidityUsd: 5_000_000, spreadPct: 0.1, slippagePct: 0.01, referenceUsd: 100, observedAt: 0 }

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: ID, chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
  cascade: initialState(), deathWatch: startDeathWatch(1, 0), quality, capitalUsd: 100,
  lastBarTime: 0, lastPriceUsd: 0.94, pendingOrders: [], openedAt: 0, updatedAt: 0,
  ...over,
})

const buy = (positionId: string, price: number, time: number) => ({
  positionId, orderId: 'Entry', side: 'buy' as const, time, price, qty: 15 / price, costUsd: 0.05,
  comment: 'Entry', idempotencyKey: `${positionId}:buy:${time}`,
})
const sell = (positionId: string, price: number, qty: number, time: number) => ({
  positionId, orderId: 'Exit', side: 'sell' as const, time, price, qty, costUsd: 0.05,
  comment: '🏁 Exit', idempotencyKey: `${positionId}:sell:${time}`,
})


const DOLLAR_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0.1 }

const rig = async (options: {
  readonly held?: PersistedPosition
  readonly history?: readonly ReturnType<typeof buy | typeof sell>[]
  readonly stop?: ExitLevels['stop']
  /** The hour's counts each sweep sees, in order; the last repeats. Null: nobody answered. */
  readonly counts?: readonly ({ buys: number; sells: number } | null)[]
  readonly ladder?: boolean
  readonly levels?: ExitLevels
} = {}) => {
  const store = new MemoryStore()
  const held = options.held ?? position()
  await store.savePosition(held)
  await store.recordFill(buy(ID, 1, 0))
  for (const fill of options.history ?? []) await store.recordFill(fill)

  const sent: Alert[] = []
  let countRequests = 0
  const brokers = new Map<string, PaperBroker>()
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor: async (p) => {
      let broker = brokers.get(p.id)
      if (!broker) {
        broker = new PaperBroker({ gasUsdPerSwap: 0.05, initialCapital: p.capitalUsd, maxOpenEntries: 6, quality: () => p.quality })
        broker.seed(await store.fillsFor(p.id))
        brokers.set(p.id, broker)
      }
      return broker
    },
    now: () => AT,
    ...(options.ladder === false
      ? {}
      : {
          pressureLadder: {
            policy: { maxEntries: 6, threshold: 0.01 },
            rungUsd: 15,
            hourCounts: async () => {
              const seen = options.counts ?? [{ buys: 50, sells: 50 }, { buys: 60, sells: 40 }]
              return seen[Math.min(countRequests++, seen.length - 1)]!
            },
            previous: new Map<string, number>(),
          },
        }),
  }
  const levels: ExitLevels = options.levels ?? { stop: options.stop ?? { ...DOLLAR_STOP, onlyWhenHistoryCovers: true }, armAtPct: null, breakEvenPct: 0 }
  const run = (price: number) =>
    sweepStops(deps, () => levels, new AlertThrottle(0), [held], new Map([['solana:T', price]]), AT)
  return { store, sent, run, countRequests: () => countRequests }
}

describe('the stop, when the token has paid for the loss — and only then', () => {
  it('HOLDS a loss the token has never earned back: no history, no sale', async () => {
    const { store, run } = await rig({ ladder: false })
    // 0.94 against 1.00 on fifteen dollars: 90 cents down, the stop is 10.
    expect(await run(0.94)).toEqual([])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'sell')).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([ID])
  })

  it('SELLS when the token has already made more than this loss', async () => {
    // An earlier round in the same token: bought at 1, sold at 1.2 — three
    // dollars, less two fees.
    const { store, run } = await rig({
      ladder: false,
      history: [buy('solana:T:0', 1, -10 * MIN), sell('solana:T:0', 1.2, 15, -5 * MIN)],
    })
    expect(await run(0.94)).toEqual([ID])
    expect((await store.fillsFor(ID)).find((f) => f.side === 'sell')?.comment).toBe('🛑 Stop')
  })

  it('HOLDS when the token made something, but less than this loss', async () => {
    const { run } = await rig({
      ladder: false,
      history: [buy('solana:T:0', 1, -10 * MIN), sell('solana:T:0', 1.02, 15, -5 * MIN)],
    })
    // Thirty cents made, less fees, against ninety lost.
    expect(await run(0.94)).toEqual([])
  })

  it('is the plain dollar stop when the rule is off', async () => {
    const { run } = await rig({ ladder: false, stop: DOLLAR_STOP })
    expect(await run(0.94)).toEqual([ID])
  })
})

describe('the ladder, bought when buyers push through 1%', () => {
  // *Aplicalo para el DCA también — nada de escalones, esa regla.* A $15 rung
  // each time buy pressure CROSSES 1% upward: an even hour, then buyers.
  const buys = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')

  it('buys a fifteen-dollar rung on the sweep that sees buy pressure cross 1%', async () => {
    const { store, sent, run } = await rig()
    await run(0.97)
    expect(await buys(store)).toHaveLength(1)
    await run(0.97)
    const rung = (await store.fillsFor(ID)).find((f) => f.orderId === 'DCA-1')
    expect(rung?.side).toBe('buy')
    expect(rung!.price * rung!.qty).toBeCloseTo(15, 0)
    expect(sent.some((a) => a.title.includes('DCA-1') && a.body.includes('$15.00'))).toBe(true)
  })

  it('buys ONE rung per crossing, not one per sweep while it stays above', async () => {
    const { store, run } = await rig({ counts: [{ buys: 50, sells: 50 }, { buys: 60, sells: 40 }, { buys: 70, sells: 30 }] })
    for (let i = 0; i < 4; i++) await run(0.97)
    expect(await buys(store)).toHaveLength(2)
  })

  it('buys nothing on a silent hour, and a silent hour does not fake a crossing', async () => {
    const { store, run } = await rig({ counts: [{ buys: 60, sells: 40 }, null, { buys: 0, sells: 0 }, { buys: 60, sells: 40 }] })
    for (let i = 0; i < 4; i++) await run(0.97)
    expect(await buys(store)).toHaveLength(1)
  })

  it('buys nothing into a FROZEN position — a freeze blocks new capital', async () => {
    const held = position({ lastPriceUsd: 0.97, deathWatch: { ...startDeathWatch(1, 0), stage: 'frozen' } })
    const { store, run } = await rig({ held })
    await run(0.97)
    await run(0.97)
    expect(await buys(store)).toHaveLength(1)
  })

  it('buys nothing at a price the candle feed does not confirm', async () => {
    // The same guard the stop runs on: a unit nobody agreed on is not a price.
    const { store, run } = await rig({ held: position({ lastPriceUsd: 0.000001 }) })
    await run(0.97)
    await run(0.97)
    expect(await buys(store)).toHaveLength(1)
  })
})

describe('the break-even never closes in the red', () => {
  // *No cierres en negativo.* Three break-evens closed between −$0.10 and
  // −$0.18 the morning the price stop was switched off.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const armed = position({ breakEvenArmed: true, lastPriceUsd: 0.99 })

  it('holds an armed position whose sale would land under its cost — and keeps it open', async () => {
    const { store, run } = await rig({ held: armed, ladder: false, levels: { stop: NO_STOP, armAtPct: 3, breakEvenPct: 0.5 } })
    expect(await run(0.99)).toEqual([])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'sell')).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([ID])
  })

  it('still sells an armed position back at its cost, once leaving nets at least that', async () => {
    const { store, run } = await rig({ held: position({ breakEvenArmed: true, lastPriceUsd: 1.004 }), ladder: false, levels: { stop: NO_STOP, armAtPct: 3, breakEvenPct: 0.5 } })
    expect(await run(1.004)).toEqual([ID])
    expect((await store.fillsFor(ID)).find((f) => f.side === 'sell')?.comment).toBe('🔒 Break-even')
  })
})
