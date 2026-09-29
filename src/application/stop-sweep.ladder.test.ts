import { describe, it, expect } from 'vitest'
import { sweepStops, type DropLadder, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { type LiquidityReading } from '../domain/strategy/liquidity-brake.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { fundRungsFromFreeCapital } from './free-capital.js'
import { capitalForFillsUsd, ladderCapitalUsd } from './paper-run.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { productionLadder } from './production-ladder.js'
import { dcaScale, MEDIAN_VOL_5M_PCT } from '../domain/strategy/dca-scale.js'
import { type RecentVolatility } from './recent-volatility.js'

const FLAT_15 = { ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }
/** Ladder A, exactly as production reads it with no environment set. */
const A = productionLadder({})
const PARAMS_A = { ...DEFAULT_PARAMS, maxUsdPerLevel: A.maxUsdPerLevel }

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

const buy = (positionId: string, price: number, time: number, usd = 15) => ({
  positionId, orderId: 'Entry', side: 'buy' as const, time, price, qty: usd / price, costUsd: 0.05,
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
  /**
   * The price ladder instead of the pressure ladder: `true` is an explicit
   * three $15 rungs at −10/−20/−30% of the first buy; `'A'` is production's
   * own, read from `productionLadder({})`, with its $10 first buy.
   */
  readonly drop?: boolean | 'A'
  /**
   * The book's capital, when each rung must ask the free pool for its own
   * capital. Absent: the rung is bought out of what the position holds.
   */
  readonly bookUsd?: number
  /**
   * Whether ladder A's drops follow each position's `dcaScale`. Absent: what
   * production reads with nothing set, `A.dcaAdaptive`.
   */
  readonly adaptive?: boolean
  /**
   * The last hour's volatility of the token, as the runtime wires it when the
   * real-time spacing is on. Absent: the switch is off.
   */
  readonly recentVolatility?: (position: PersistedPosition) => Promise<RecentVolatility | null>
  /**
   * The book's pool readings, one call a sweep, as the runtime wires them for
   * the liquidity watch. Absent: no brake, every caller that predates it.
   */
  readonly liquidityChange?: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>
  /** The brake's threshold in percent; zero is off. Absent: the operator's five. */
  readonly liquidityBrakePct?: number
  /** One throttle for every sweep of the rig. Absent: a fresh one per sweep, which sends everything. */
  readonly throttle?: AlertThrottle
  /**
   * Each sweep reads the book from the store, as production does, so what one
   * sweep saved — the liquidity watch — is what the next one sees. Absent: the
   * position the rig was built with, every sweep.
   */
  readonly reload?: boolean
} = {}) => {
  const store = new MemoryStore()
  const held = options.held ?? position()
  await store.savePosition(held)
  await store.recordFill(buy(ID, 1, 0, options.drop === 'A' ? A.maxUsdPerLevel : 15))
  for (const fill of options.history ?? []) await store.recordFill(fill)

  const sent: Alert[] = []
  let countRequests = 0
  let fundCalls = 0
  // Counted, so a test can say the free capital was never even ASKED — not
  // only that nothing moved.
  const counted = (fund: NonNullable<DropLadder['fund']>): NonNullable<DropLadder['fund']> => async (p, entries) => {
    fundCalls++
    return fund(p, entries)
  }
  // Keyed by the CAPITAL as well as the id, the way production rebuilds a
  // broker once a rung has raised it: a broker built for the old capital
  // refuses the rung for funds.
  const brokers = new Map<string, PaperBroker>()
  const deps: StopSweepDeps = {
    store,
    alerts: { send: async (a) => { sent.push(a) } },
    brokerFor: async (p) => {
      const key = `${p.id}:${p.capitalUsd}`
      let broker = brokers.get(key)
      if (!broker) {
        broker = new PaperBroker({
          gasUsdPerSwap: 0.05,
          initialCapital: p.capitalUsd,
          maxOpenEntries: options.drop === 'A' ? A.maxOpenEntries : 6,
          quality: () => p.quality,
        })
        broker.seed(await store.fillsFor(p.id))
        brokers.set(key, broker)
      }
      return broker
    },
    now: () => AT,
    ...(options.drop === 'A'
      ? {
          dropLadder: {
            policy: { maxEntries: A.maxOpenEntries, dropsPct: A.dcaDropsPct, from: A.dcaFrom },
            rungsUsd: A.dcaRungsUsd,
            adaptive: options.adaptive ?? A.dcaAdaptive,
            ...(options.recentVolatility ? { recentVolatility: options.recentVolatility } : {}),
            ...(options.liquidityChange ? { liquidityChange: options.liquidityChange } : {}),
            ...(options.liquidityBrakePct !== undefined ? { liquidityBrakePct: options.liquidityBrakePct } : {}),
            ...(options.bookUsd !== undefined
              ? { fund: counted(fundRungsFromFreeCapital({ store, totalCapitalUsd: options.bookUsd, params: PARAMS_A, gasUsdPerSwap: 0.05, rungsUsd: A.dcaRungsUsd })) }
              : {}),
          },
        }
      : options.drop
      ? {
          dropLadder: {
            policy: { maxEntries: 4, dropsPct: [10, 20, 30] },
            rungsUsd: [15, 15, 15],
            ...(options.bookUsd !== undefined
              ? { fund: fundRungsFromFreeCapital({ store, totalCapitalUsd: options.bookUsd, params: FLAT_15, gasUsdPerSwap: 0.05 }) }
              : {}),
          },
        }
      : {}),
    ...(options.ladder === false || options.drop
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
            gone: new Set<string>(),
            gasUsdPerSwap: 0.05,
            ...(options.bookUsd !== undefined
              ? { fund: fundRungsFromFreeCapital({ store, totalCapitalUsd: options.bookUsd, params: FLAT_15, gasUsdPerSwap: 0.05 }) }
              : {}),
          },
        }),
  }
  const levels: ExitLevels = options.levels ?? { stop: options.stop ?? { ...DOLLAR_STOP, onlyWhenHistoryCovers: true }, armAtPct: null, breakEvenPct: 0, gainLock: null }
  let sweeps = 0
  const run = async (price: number) =>
    sweepStops(
      deps, () => levels, options.throttle ?? new AlertThrottle(0),
      options.reload === true ? await store.loadPositions() : [held],
      new Map([['solana:T', price]]),
      // A minute apart, the way the watch sees the pool move.
      options.reload === true ? AT + MIN * sweeps++ : AT,
    )
  return { store, sent, run, countRequests: () => countRequests, fundCalls: () => fundCalls }
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

describe('the sale when buyers fall through 1% — only with a positive margin', () => {
  // *La venta se va a realizar si la presión compradora cae 1%* — and then:
  // *asegurate que haya margen positivo, para que no tengamos pérdidas ni
  // comisiones innecesarias.* Measured on the first eight: all eight closed in
  // the red. So the buyers leaving MARKS the position, and it is sold once it
  // is up by more than its whole round trip — about 0.77% here: the fee paid
  // entering, the spread and impact of leaving, one swap of gas.
  const sells = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'sell')
  const fell = [{ buys: 60, sells: 40 }, { buys: 50, sells: 50 }]

  it('HOLDS a position under water when its buyers fall through — no loss, no needless fee', async () => {
    const { store, run } = await rig({ counts: fell })
    await run(0.94)
    expect(await run(0.94)).toEqual([])
    expect(await sells(store)).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([ID])
  })

  it('holds one up by LESS than its round trip — the fees would eat the gain', async () => {
    const { store, run } = await rig({ counts: fell })
    await run(1.005)
    await run(1.005)
    expect(await sells(store)).toEqual([])
  })

  it('sells at once when the gain already clears the whole round trip', async () => {
    const { store, sent, run } = await rig({ counts: fell })
    await run(1.02)
    expect(await run(1.02)).toEqual([ID])
    expect((await sells(store))[0]?.comment).toBe('📉 Sin compradores')
    expect(sent.some((a) => a.title.includes('sin compradores'))).toBe(true)
  })

  it('sells a marked position LATER, once the gain clears the trip and the buyers are still gone', async () => {
    const { store, run } = await rig({ counts: [...fell, { buys: 50, sells: 50 }] })
    await run(0.94)
    await run(0.94)
    expect(await run(1.02)).toEqual([ID])
    expect((await sells(store))[0]!.price).toBeGreaterThan(1)
  })

  it('clears the mark when buyers come back — they did not leave after all', async () => {
    const { store, run } = await rig({ counts: [...fell, { buys: 60, sells: 40 }, { buys: 60, sells: 40 }] })
    await run(0.94)
    await run(0.94)
    await run(0.94)
    await run(1.02)
    expect(await sells(store)).toEqual([])
    // *En el peor de los casos tenemos el DCA para promediar.* The buyers came
    // back at 0.94, so the rung bought there — averaging down, as intended.
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy')).toHaveLength(2)
  })

  it('does NOT sell a position whose buyers never led — the first buy does not read buy pressure', async () => {
    const { store, run } = await rig({ counts: [{ buys: 50, sells: 50 }, { buys: 40, sells: 60 }] })
    await run(1.02)
    await run(1.02)
    expect(await sells(store)).toEqual([])
  })

  it('does NOT sell at a price the candle feed does not confirm', async () => {
    const { store, run } = await rig({ held: position({ lastPriceUsd: 0.000001 }), counts: fell })
    await run(1.02)
    await run(1.02)
    expect(await sells(store)).toEqual([])
  })
})

describe('the break-even never closes in the red', () => {
  // *No cierres en negativo.* Three break-evens closed between −$0.10 and
  // −$0.18 the morning the price stop was switched off.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const armed = position({ breakEvenArmed: true, lastPriceUsd: 0.99 })

  it('holds an armed position whose sale would land under its cost — and keeps it open', async () => {
    const { store, run } = await rig({ held: armed, ladder: false, levels: { stop: NO_STOP, armAtPct: 3, breakEvenPct: 0.5, gainLock: null } })
    expect(await run(0.99)).toEqual([])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'sell')).toEqual([])
    expect((await store.loadPositions()).map((p) => p.id)).toEqual([ID])
  })

  it('still sells an armed position back at its cost, once leaving nets at least that', async () => {
    const { store, run } = await rig({ held: position({ breakEvenArmed: true, lastPriceUsd: 1.004 }), ladder: false, levels: { stop: NO_STOP, armAtPct: 3, breakEvenPct: 0.5, gainLock: null } })
    expect(await run(1.004)).toEqual([ID])
    expect((await store.fillsFor(ID)).find((f) => f.side === 'sell')?.comment).toBe('🔒 Break-even')
  })

  it('an ARMED position that falls through its first buy still buys its rung', async () => {
    // The ratchet is on by default and an armed position stays armed for
    // life, so a winner that turned came through the refused sale on every
    // sweep — and the price ladder, one step further down, never got a look.
    const { store, run } = await rig({
      held: position({ breakEvenArmed: true, lastPriceUsd: 0.9 }),
      drop: true,
      levels: { stop: NO_STOP, armAtPct: 7.5, breakEvenPct: 7.5, gainLock: null },
    })
    expect(await run(0.9)).toEqual([])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'sell')).toEqual([])
    expect((await store.fillsFor(ID)).filter((f) => f.side === 'buy').map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })
})

describe('the price ladder, on an explicit policy: three rungs at −10, −20 and −30% of the FIRST buy', () => {
  // The mechanism, on a policy stated here rather than production's: three $15
  // rungs, the shape that ran before ladder A. The first buy in this rig is $15
  // at 1.00.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const at = (price: number, over: Partial<PersistedPosition> = {}) => position({ lastPriceUsd: price, ...over })
  const buys = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')
  const rungAt = (id: string, price: number, time: number) => ({
    ...buy(ID, price, time), orderId: id, comment: id, idempotencyKey: `${ID}:${id}`,
  })

  it('buys a fifteen-dollar DCA-1 once the price is 10% under the first buy', async () => {
    const { store, sent, run } = await rig({ held: at(0.9), drop: true, stop: NO_STOP })
    await run(0.9)
    const rung = (await store.fillsFor(ID)).find((f) => f.orderId === 'DCA-1')
    expect(rung?.side).toBe('buy')
    expect(rung!.price * rung!.qty).toBeCloseTo(15, 0)
    const said = sent.find((a) => a.title.includes('DCA-1'))
    expect(said?.body).toContain('10.0% desde la primera compra')
  })

  it('waits above the line', async () => {
    const { store, run } = await rig({ held: at(0.91), drop: true, stop: NO_STOP })
    await run(0.91)
    expect(await buys(store)).toHaveLength(1)
  })

  it('asks DCA-2 for 20% under the FIRST buy, not 10% under the last', async () => {
    // 0.85 is 5.6% under the rung bought at 0.90 and only 15% under the first:
    // a ladder measured from the last fill would chase it; this one waits.
    const { store, run } = await rig({ held: at(0.85), drop: true, stop: NO_STOP, history: [rungAt('DCA-1', 0.9, MIN)] })
    await run(0.85)
    expect(await buys(store)).toHaveLength(2)
    await run(0.8)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2'])
  })

  it('climbs ONE rung per sweep when the price gaps straight past −30%, and stops at three', async () => {
    const { store, run } = await rig({ held: at(0.5), drop: true, stop: NO_STOP })
    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      await run(0.5)
      counts.push((await buys(store)).length)
    }
    expect(counts).toEqual([2, 3, 4, 4])
  })

  it('starts again from the NEW entry after the position sold and bought back', async () => {
    // Live, the first day: FONE and CALI re-entered above their first cycle,
    // fell 20% from the new entry, and bought nothing — the ladder counted the
    // old cycle's buys as rungs and measured from the old first price.
    const { store, run } = await rig({
      held: at(1.8),
      drop: true,
      stop: NO_STOP,
      history: [rungAt('DCA-1', 0.9, MIN), sell(ID, 1.1, 15 + 15 / 0.9, 2 * MIN), buy(ID, 2, 3 * MIN)],
    })
    await run(1.9)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'Entry'])
    await run(1.8)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'Entry', 'DCA-1'])
  })

  it('buys nothing into a FROZEN position', async () => {
    const { store, run } = await rig({ held: at(0.5, { deathWatch: { ...startDeathWatch(1, 0), stage: 'frozen' } }), drop: true, stop: NO_STOP })
    await run(0.5)
    expect(await buys(store)).toHaveLength(1)
  })

  it('buys nothing at a price the candle feed does not confirm', async () => {
    const { store, run } = await rig({ held: at(0.000001), drop: true, stop: NO_STOP })
    await run(0.5)
    expect(await buys(store)).toHaveLength(1)
  })
})

describe('a rung pays for itself, out of the free capital', () => {
  // A position is allocated its FIRST buy only. Live, before this: $2,887
  // committed against $1,395 deployed — half the book reserved against rungs
  // that almost never fired. So the rung asks the free pool when it fires.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const ONE_ENTRY = ladderCapitalUsd(FLAT_15, 1, 0.05)
  const TWO_ENTRIES = ladderCapitalUsd(FLAT_15, 2, 0.05)
  const funded = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9 })
  const buys = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')

  it('is refused by the broker without it — the first buy spent what the position was given', async () => {
    const { store, run } = await rig({ held: funded, drop: true, stop: NO_STOP })
    await run(0.9)
    expect(await buys(store)).toHaveLength(1)
  })

  it('raises the position to two entries and buys through a broker that can see the capital', async () => {
    const { store, run } = await rig({ held: funded, drop: true, stop: NO_STOP, bookUsd: 100 })
    await run(0.9)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    expect((await store.loadPositions())[0]?.capitalUsd).toBeCloseTo(TWO_ENTRIES, 9)
  })

  it('waits when nothing is free, touches nothing, and says why', async () => {
    const { store, sent, run } = await rig({ held: funded, drop: true, stop: NO_STOP, bookUsd: ONE_ENTRY })
    await run(0.9)
    expect(await buys(store)).toHaveLength(1)
    expect((await store.loadPositions())[0]?.capitalUsd).toBeCloseTo(ONE_ENTRY, 9)
    const said = sent.find((a) => a.title.includes('sin capital libre para el escalón'))
    expect(said?.level).toBe('info')
  })
})

describe('the pressure ladder pays for its rungs the same way', () => {
  // Off in production, one variable away — and it must still WORK when turned
  // on. A slot is allocated its first buy only, so a pressure rung bought out
  // of the position's own capital is refused by the broker for funds, silently.
  const ONE_ENTRY = ladderCapitalUsd(FLAT_15, 1, 0.05)
  const funded = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.97 })
  const buys = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')

  it('asks the free capital for the rung before buying it', async () => {
    const { store, run } = await rig({ held: funded, bookUsd: 100 })
    await run(0.97)
    await run(0.97)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('waits, and says why, when nothing is free', async () => {
    const { store, sent, run } = await rig({ held: funded, bookUsd: ONE_ENTRY })
    await run(0.97)
    await run(0.97)
    expect(await buys(store)).toHaveLength(1)
    expect(sent.some((a) => a.title.includes('sin capital libre para el escalón'))).toBe(true)
  })
})

describe('ladder A, as production runs it: $10, then $15, $20, $25, $30 and $35', () => {
  // *Arriesguémonos, activá la A.* The first buy is $10 at 1.00; DCA-n buys its
  // own size at 1.00 less its drop — −10, −15, −20, −25 and −30%. Each rung
  // asks the free capital for its share, and the broker holds six entries.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const ONE_ENTRY = ladderCapitalUsd(PARAMS_A, 1, 0.05)
  const held = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.8 })
  const buys = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')
  // Just under each line, each measured from the rung before it — *con
  // respecto al anterior*: 0.899, then 15% under that, 20% under the next…
  const LINES = [0.899, 0.764, 0.611, 0.458, 0.32]

  it('is what production reads with nothing set', () => {
    expect(A.maxUsdPerLevel).toBe(10)
    expect(A.maxOpenEntries).toBe(6)
    expect(A.dcaDropsPct).toEqual([10, 15, 20, 25, 30])
    expect(A.dcaRungsUsd).toEqual([15, 20, 25, 30, 35])
    expect(A.dcaFrom).toBe('previous')
  })

  it('waits for 15% under DCA-1, not for 15% under the first buy', async () => {
    // WORLD, live: −44% in a minute bought all five rungs, each 5–6% under the
    // one before. Measured from the previous buy, 0.80 is only 9% under DCA-1.
    const { store, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.88)
    await run(0.8)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    await run(0.748)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2'])
  })

  it('says how far it fell from the previous buy', async () => {
    const { sent, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.88)
    await run(0.748)
    // The rung pays the spread on top of 0.88, so the fall reads a hair over 15%.
    expect(sent.find((a) => a.title.includes('DCA-2'))?.body).toMatch(/15\.\d% desde la compra anterior/)
  })

  it('buys each rung at its own size, and DCA-5’s $35 goes through after DCA-1..4', async () => {
    const { store, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    for (const price of LINES) await run(price)
    const bought = await buys(store)
    expect(bought.map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2', 'DCA-3', 'DCA-4', 'DCA-5'])
    expect(bought.map((f) => f.price * f.qty)).toEqual([10, 15, 20, 25, 30, 35].map((usd) => expect.closeTo(usd, 0)))
    // Funded to exactly the whole ladder: $135 grossed up, and seven swaps of gas.
    expect((await store.loadPositions())[0]?.capitalUsd).toBeCloseTo(capitalForFillsUsd([10, 15, 20, 25, 30, 35], 0.05), 9)
  })

  it('stops at five rungs, however far the price falls after', async () => {
    const { store, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    for (const price of [...LINES, 0.5, 0.3]) await run(price)
    expect(await buys(store)).toHaveLength(6)
  })

  it('waits above a line: a price that holds after DCA-1 buys nothing more', async () => {
    const { store, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.88)
    await run(0.88)
    expect((await buys(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('says in the alert what the rung bought', async () => {
    const { sent, run } = await rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    for (const price of LINES.slice(0, 3)) await run(price)
    expect(sent.find((a) => a.title.includes('DCA-1'))?.body).toContain('Compró $15.00')
    expect(sent.find((a) => a.title.includes('DCA-3'))?.body).toContain('Compró $25.00')
  })
})

describe('ladder A at the token’s own scale: the more it moves, the wider its rungs', () => {
  // *Más largo y más separado para las volátiles.* A token moving 10% a bar has
  // a scale of 1.925: DCA-1 at −19.2% of the first buy, DCA-2 28.9% under DCA-1.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const ONE_ENTRY = ladderCapitalUsd(PARAMS_A, 1, 0.05)
  const WILD = dcaScale(10)
  const held = (dcaScale?: number) => position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9, ...(dcaScale === undefined ? {} : { dcaScale }) })
  const bought = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy')

  it('is ON with nothing set', () => {
    expect(A.dcaAdaptive).toBe(true)
  })

  it('waits for DCA-1 of a wild token until −19.2%, and DCA-2 28.9% under what DCA-1 paid', async () => {
    const { store, run } = await rig({ held: held(WILD), drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.81)
    expect((await bought(store)).map((f) => f.orderId)).toEqual(['Entry'])
    await run(0.806)
    const [, dca1] = await bought(store)
    expect(dca1?.orderId).toBe('DCA-1')
    // 15% × 1.925 = 28.87% under what DCA-1 actually paid.
    await run(dca1!.price * 0.72)
    expect(await bought(store)).toHaveLength(2)
    await run(dca1!.price * 0.71)
    expect((await bought(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2'])
  })

  it('says in the alert the fall the rung waited for', async () => {
    const { sent, run } = await rig({ held: held(WILD), drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.806)
    expect(sent.find((a) => a.title.includes('DCA-1'))?.body).toContain('este escalón pedía 19.2%')
  })

  it('uses the base drops for a position nobody has measured yet', async () => {
    const { store, run } = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.947)
    expect(await bought(store)).toHaveLength(1)
    await run(0.899)
    expect((await bought(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
  })

  it('uses the base drops for every position when the switch is off', async () => {
    const { store, sent, run } = await rig({ held: held(WILD), drop: 'A', stop: NO_STOP, bookUsd: 1_000, adaptive: false })
    await run(0.947)
    expect(await bought(store)).toHaveLength(1)
    await run(0.899)
    expect((await bought(store)).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    expect(sent.find((a) => a.title.includes('DCA-1'))?.body).toContain('este escalón pedía 10%')
  })
})

describe('the NEXT rung, spaced by the token’s last hour — in real time', () => {
  // *Que el próximo escalón DCA lo calcule por la cantidad de volatilidad que
  // tenga en ese preciso momento la moneda — si es mucha, escalón bien largo;
  // si es poca, escalón corto.* Then *tiempo real.* The sweep asks for the last
  // hour of 5-minute bars when a rung could fire, and spaces THAT rung by it.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const ONE_ENTRY = ladderCapitalUsd(PARAMS_A, 1, 0.05)
  const WILD_AT_BUY = dcaScale(10)
  const held = (dcaScale?: number) => position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9, ...(dcaScale === undefined ? {} : { dcaScale }) })
  const bought = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy').map((f) => f.orderId)
  // Four times the median is a scale of two: DCA-1 at −20%. A quarter of it is
  // the floor, a half: DCA-1 at −5%.
  const WILD_HOUR = MEDIAN_VOL_5M_PCT * 4
  const CALM_HOUR = MEDIAN_VOL_5M_PCT / 4
  const lastHour = (volPct: number | null, measuredAt = AT) => {
    const asked: string[] = []
    const read = async (p: PersistedPosition) => {
      asked.push(p.id)
      return volPct === null ? null : { volPct, measuredAt }
    }
    return { read, asked }
  }

  it('waits deeper after a wild hour than after a calm one, from the same previous buy', async () => {
    const calm = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(CALM_HOUR).read })
    await calm.run(0.951)
    expect(await bought(calm.store)).toEqual(['Entry'])
    await calm.run(0.949)
    expect(await bought(calm.store)).toEqual(['Entry', 'DCA-1'])

    const wild = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(WILD_HOUR).read })
    await wild.run(0.949)
    await wild.run(0.801)
    expect(await bought(wild.store)).toEqual(['Entry'])
    await wild.run(0.799)
    expect(await bought(wild.store)).toEqual(['Entry', 'DCA-1'])
  })

  it('outranks the scale measured at the buy: a token calm then and crashing now waits', async () => {
    // Measured calm the day before it was bought, and falling hard this hour:
    // the at-buy spacing would buy the middle of the fall.
    const { store, run } = await rig({ held: held(dcaScale(1)), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(WILD_HOUR).read })
    await run(0.93)
    expect(await bought(store)).toEqual(['Entry'])
  })

  it('says in the alert the fall the rung waited for and the volatility it used', async () => {
    const { sent, run } = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(WILD_HOUR).read })
    await run(0.79)
    expect(sent.find((a) => a.title.includes('DCA-1'))?.body).toContain('este escalón pedía 20% (volatilidad de la última hora: 8.7%)')
  })

  it('falls back to the scale measured at the buy when the last hour cannot be measured', async () => {
    const { store, sent, run } = await rig({ held: held(WILD_AT_BUY), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(null).read })
    await run(0.81)
    expect(await bought(store)).toEqual(['Entry'])
    await run(0.806)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
    expect(sent.find((a) => a.title.includes('DCA-1'))?.body).toContain('este escalón pedía 19.2% (volatilidad al comprar)')
  })

  it('falls back to the base drops when nothing was measured at all', async () => {
    const { store, run } = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: lastHour(null).read })
    await run(0.901)
    expect(await bought(store)).toEqual(['Entry'])
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
  })

  it('falls back the same way when asking THROWS — a refusal is not a reading', async () => {
    const { store, run } = await rig({
      held: held(WILD_AT_BUY), drop: 'A', stop: NO_STOP, bookUsd: 1_000,
      recentVolatility: async () => { throw new Error('HTTP 503') },
    })
    await run(0.806)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
  })

  it('never asks for a position above the shallowest line any spacing could draw', async () => {
    // Half the base drop is as close as a rung can ever sit: −5% for DCA-1.
    // Above it no reading of the hour can buy anything, so none is fetched.
    const hour = lastHour(CALM_HOUR)
    const { run } = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: hour.read })
    await run(1.2)
    await run(0.951)
    expect(hour.asked).toEqual([])
    await run(0.95)
    expect(hour.asked).toEqual([ID])
  })

  it('writes the reading onto the position for the screen — once per reading', async () => {
    const hour = lastHour(WILD_HOUR, AT - 1_000)
    const { store, run } = await rig({ held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: hour.read })
    let saves = 0
    const save = store.savePosition.bind(store)
    store.savePosition = async (p) => { saves++; await save(p) }
    await run(0.9)
    const [after] = await store.loadPositions()
    expect(after!.dcaScaleNow).toBeCloseTo(2, 12)
    expect(after!.dcaScaleNowAt).toBe(AT - 1_000)
    expect(saves).toBe(1)
  })

  it('does not write a reading the position already carries', async () => {
    const hour = lastHour(WILD_HOUR, AT - 1_000)
    const carrying = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9, dcaScaleNow: 2, dcaScaleNowAt: AT - 1_000 })
    const { store, run } = await rig({ held: carrying, drop: 'A', stop: NO_STOP, bookUsd: 1_000, recentVolatility: hour.read })
    let saves = 0
    const save = store.savePosition.bind(store)
    store.savePosition = async (p) => { saves++; await save(p) }
    await run(0.9)
    expect(hour.asked).toEqual([ID])
    expect(saves).toBe(0)
  })

  it('waits to write when this pass has already bought for the position — the snapshot is stale', async () => {
    // A pressure rung earlier in the same sweep raised the row's capital in the
    // store; writing the sweep's snapshot back would lower it again.
    let store: MemoryStore | undefined
    const { store: s, run } = await rig({
      held: held(), drop: 'A', stop: NO_STOP, bookUsd: 1_000,
      recentVolatility: async () => {
        await store!.recordFill(buy(ID, 0.9, 1, 15))
        return { volPct: WILD_HOUR, measuredAt: AT }
      },
    })
    store = s
    await run(0.9)
    expect((await s.loadPositions())[0]!.dcaScaleNow).toBeNull()
  })

  it('uses only the scale measured at the buy when the real-time switch is off', async () => {
    // Off is the dependency absent: nothing asks for the hour at all.
    const { store, run } = await rig({ held: held(WILD_AT_BUY), drop: 'A', stop: NO_STOP, bookUsd: 1_000 })
    await run(0.9)
    expect(await bought(store)).toEqual(['Entry'])
    await run(0.806)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
  })

  it('scales nothing at all, real time included, when the ladder does not adapt', async () => {
    const hour = lastHour(CALM_HOUR)
    const { store, run } = await rig({ held: held(WILD_AT_BUY), drop: 'A', stop: NO_STOP, bookUsd: 1_000, adaptive: false, recentVolatility: hour.read })
    await run(0.901)
    expect(await bought(store)).toEqual(['Entry'])
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
    expect(hour.asked).toEqual([])
  })
})

describe('the liquidity watch: braked while the pool drains, a rung on the bounce', () => {
  // *Freno en tiempo real por cambio de liquidez inmediata que supere el 5%* —
  // *5 minutos o 1 hora.* PAID froze with its pool at 41% of its entry
  // liquidity after the ladder had bought DCA-2 and DCA-3 into it (−$16.96).
  // Then: *si la liquidez desde el punto más bajo aumenta un 5%, activar la
  // compra del escalón si está en negativo todavía… pero siempre esperar la
  // recuperación del 5% de liquidez a partir del mínimo.*
  //
  // Ladder A: a $10 first buy at 1.00, DCA-1 on the line at 0.9.
  const NO_STOP = { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }
  const ONE_ENTRY = ladderCapitalUsd(PARAMS_A, 1, 0.05)
  const held = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9 })
  const bought = async (store: MemoryStore) => (await store.fillsFor(ID)).filter((f) => f.side === 'buy').map((f) => f.orderId)
  const draining = (usd: number, h1 = -8): LiquidityReading => ({ usd, m5: -1, h1 })
  const calm = (usd: number): LiquidityReading => ({ usd, m5: 0, h1: 0 })
  /** The pool each sweep sees, in order; the last repeats. Null: nobody answered. */
  const pool = (...seen: (LiquidityReading | null)[]) => {
    const asked: string[][] = []
    const read = async (positions: readonly PersistedPosition[]) => {
      asked.push(positions.map((p) => p.id))
      const reading = seen[Math.min(asked.length - 1, seen.length - 1)]!
      return new Map(reading === null ? [] : [['solana:T', reading] as const])
    }
    return { read, asked }
  }
  const watched = (liquidity: ReturnType<typeof pool>, over: Parameters<typeof rig>[0] = {}) =>
    rig({ held, drop: 'A', stop: NO_STOP, bookUsd: 1_000, reload: true, liquidityChange: liquidity.read, ...over })
  const titled = (sent: readonly Alert[], text: string) => sent.filter((a) => a.title.includes(text))

  it('holds a rung at its line back while the pool drains 8% in the hour, and says why', async () => {
    const { store, sent, run } = await watched(pool(draining(92_000)))
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry'])
    const said = titled(sent, 'escalón frenado')
    expect(said).toHaveLength(1)
    expect(said[0]!.title).toBe('🧊 T: escalón frenado')
    expect(said[0]!.level).toBe('info')
    expect(said[0]!.body).toContain('La liquidez del pool cayó 8.0% en la última hora')
    expect(said[0]!.body).toContain('DCA-1')
    expect(said[0]!.body).toContain('no se compra hasta que deje de caer')
  })

  it('names both windows when both fell', async () => {
    const { sent, run } = await watched(pool({ usd: 80_000, m5: -6, h1: -19.3 }))
    await run(0.899)
    expect(titled(sent, 'escalón frenado')[0]!.body).toContain('cayó 6.0% en los últimos 5 minutos y 19.3% en la última hora')
  })

  it('keeps the brake on however deep the price goes, and says so once', async () => {
    const { store, sent, run } = await watched(pool(draining(92_000), draining(85_000), draining(70_000)))
    for (const price of [0.899, 0.8, 0.6]) await run(price)
    expect(await bought(store)).toEqual(['Entry'])
    expect(titled(sent, 'escalón frenado')).toHaveLength(1)
  })

  it('is not lifted by the hour going quiet — only by a 5% bounce off the minimum', async () => {
    // The drain stopped; the pool did not come back. That is not the signal.
    const { store, run } = await watched(pool(draining(92_000), calm(92_000), { usd: 96_500, m5: 3, h1: -2 }))
    await run(0.899)
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry'])
    // +4.9% off 92,000: still not the bounce.
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry'])
  })

  it('buys the NEXT rung on the bounce while still at a loss — above its price line', async () => {
    // 0.97 is only 3% under the first buy, far above DCA-1's line at 0.9 — but
    // under the average cost, and the pool bounced 5.1% off its low.
    const { store, sent, run } = await watched(pool(draining(92_000), calm(96_700)))
    await run(0.97)
    expect(await bought(store)).toEqual(['Entry'])
    await run(0.97)
    const fills = (await store.fillsFor(ID)).filter((f) => f.side === 'buy')
    expect(fills.map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    // DCA-1's own size, at the live price.
    expect(fills[1]!.price * fills[1]!.qty).toBeCloseTo(15, 0)
    const said = titled(sent, 'la liquidez se recuperó')
    expect(said).toHaveLength(1)
    // Down from 100,000 — where the hour said the pool was — to 92,000.
    expect(said[0]!.title).toBe('🌱 T: la liquidez se recuperó 5% desde el mínimo (había caído 8.0%) — compra DCA-1')
    expect(said[0]!.level).toBe('info')
  })

  it('buys nothing on a bounce that finds the position in profit — the brake just lifts', async () => {
    const { store, run } = await watched(pool(draining(92_000), calm(96_700), calm(96_700)))
    await run(0.97)
    await run(1.02)
    expect(await bought(store)).toEqual(['Entry'])
    // Lifted: the price line buys again as it always did.
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
  })

  it('buys ONE rung on the bounce, however many lines the price has crossed', async () => {
    const { store, run } = await watched(pool(draining(92_000), calm(96_700)))
    await run(0.5)
    await run(0.5)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
  })

  it('buys nothing on the bounce into a FROZEN position, and names no rung the brake holds', async () => {
    const frozen = position({ capitalUsd: ONE_ENTRY, lastPriceUsd: 0.9, deathWatch: { ...startDeathWatch(1, 0), stage: 'frozen' } })
    const { store, sent, run } = await watched(pool(draining(92_000), calm(96_700)), { held: frozen })
    await run(0.97)
    expect(titled(sent, 'escalón frenado')).toEqual([])
    await run(0.97)
    expect(await bought(store)).toEqual(['Entry'])
  })

  it('never asks the free capital for a rung the brake holds back — no capital moves', async () => {
    const { store, run, fundCalls } = await watched(pool(draining(92_000), draining(88_000)))
    await run(0.899)
    await run(0.8)
    expect(fundCalls()).toBe(0)
    expect((await store.loadPositions())[0]?.capitalUsd).toBeCloseTo(ONE_ENTRY, 9)
  })

  it('writes the watch onto the position, so the next sweep — or the next process — holds the brake', async () => {
    const { store, run } = await watched(pool(draining(92_000)))
    await run(0.95)
    expect((await store.loadPositions())[0]!.liquidityWatch).toMatchObject({ braked: true, minUsd: 92_000, holdingSince: 0 })
  })

  it('changes nothing on silence: no reading brakes nothing, and lifts nothing', async () => {
    const unknown = await watched(pool(null))
    await unknown.run(0.899)
    expect(await bought(unknown.store)).toEqual(['Entry', 'DCA-1'])

    const braked = await watched(pool(draining(92_000), null, { usd: null, m5: 9, h1: 9 }))
    for (const price of [0.97, 0.97, 0.899]) await braked.run(price)
    expect(await bought(braked.store)).toEqual(['Entry'])

    const refused = await watched(pool(), { liquidityChange: async () => { throw new Error('HTTP 503') } })
    await refused.run(0.899)
    expect(await bought(refused.store)).toEqual(['Entry', 'DCA-1'])
  })

  it('watches every held position on every sweep, in ONE call for the book', async () => {
    // The bounce does not wait for the price line, so neither does the watch.
    const liquidity = pool(calm(100_000))
    const { run } = await watched(liquidity)
    await run(1.2)
    await run(0.95)
    expect(liquidity.asked).toEqual([[ID], [ID]])
  })

  it('asks nothing, holds nothing and buys on the line as always with the switch off', async () => {
    const liquidity = pool(draining(92_000))
    const { store, run } = await watched(liquidity, { liquidityBrakePct: 0 })
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry', 'DCA-1'])
    expect(liquidity.asked).toEqual([])
  })

  it('brakes at the operator’s five when no threshold is given', async () => {
    const { store, run } = await watched(pool({ usd: 94_900, m5: 0, h1: -5.1 }))
    await run(0.899)
    expect(await bought(store)).toEqual(['Entry'])
  })
})
