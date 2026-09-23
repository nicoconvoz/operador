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

/** Fell to 0.94 and has held it for five one-minute candles since. */
const FLOOR = { time: [1, 2, 3, 4, 5, 6, 7].map((m) => AT - (8 - m) * MIN), low: [0.97, 0.94, 0.942, 0.943, 0.944, 0.941, 0.945] }
/** Still printing a new low every minute. */
const KNIFE = { time: FLOOR.time, low: [0.97, 0.96, 0.955, 0.95, 0.947, 0.946, 0.945] }

const DOLLAR_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0.1 }

const rig = async (options: {
  readonly held?: PersistedPosition
  readonly history?: readonly ReturnType<typeof buy | typeof sell>[]
  readonly stop?: ExitLevels['stop']
  readonly bars?: { time: number[]; low: number[] } | null
  readonly ladder?: boolean
  readonly levels?: ExitLevels
} = {}) => {
  const store = new MemoryStore()
  const held = options.held ?? position()
  await store.savePosition(held)
  await store.recordFill(buy(ID, 1, 0))
  for (const fill of options.history ?? []) await store.recordFill(fill)

  const sent: Alert[] = []
  let barRequests = 0
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
          floorLadder: {
            policy: { maxEntries: 6, gapPct: 5, floorBars: 5 },
            rungUsd: 15,
            minuteBars: async () => { barRequests++; return options.bars === undefined ? FLOOR : options.bars },
          },
        }),
  }
  const levels: ExitLevels = options.levels ?? { stop: options.stop ?? { ...DOLLAR_STOP, onlyWhenHistoryCovers: true }, armAtPct: null, breakEvenPct: 0 }
  const run = (price: number) =>
    sweepStops(deps, () => levels, new AlertThrottle(0), [held], new Map([['solana:T', price]]), AT)
  return { store, sent, run, barRequests: () => barRequests }
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

describe('the ladder, bought on a floor of one-minute candles', () => {
  it('buys a fifteen-dollar rung once the dip has held its low for five minutes', async () => {
    const { store, sent, run } = await rig()
    await run(0.945)
    const rung = (await store.fillsFor(ID)).find((f) => f.orderId === 'DCA-1')
    expect(rung?.side).toBe('buy')
    expect(rung!.price * rung!.qty).toBeCloseTo(15, 0)
    expect(sent.some((a) => a.title.includes('DCA-1'))).toBe(true)
  })

  it('waits while it is still making new lows', async () => {
    const { store, run } = await rig({ bars: KNIFE })
    await run(0.945)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(1)
  })

  it('does not even ask for the minutes until the dip is deep enough', async () => {
    const { store, run, barRequests } = await rig()
    await run(0.99)
    expect(barRequests()).toBe(0)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(1)
  })

  it('buys nothing into a FROZEN position — a freeze blocks new capital', async () => {
    const held = position({ deathWatch: { ...startDeathWatch(1, 0), stage: 'frozen' } })
    const { store, run } = await rig({ held })
    await run(0.945)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(1)
  })

  it('buys nothing at a price the candle feed does not confirm', async () => {
    // The same guard the stop runs on: a unit nobody agreed on is not a dip.
    const { store, run } = await rig({ held: position({ lastPriceUsd: 0.000001 }) })
    await run(0.945)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(1)
  })

  it('buys nothing when it cannot see the minutes', async () => {
    const { store, run } = await rig({ bars: null })
    await run(0.945)
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(1)
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
