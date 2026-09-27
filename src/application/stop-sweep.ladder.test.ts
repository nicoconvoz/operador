import { describe, it, expect } from 'vitest'
import { sweepStops, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
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
} = {}) => {
  const store = new MemoryStore()
  const held = options.held ?? position()
  await store.savePosition(held)
  await store.recordFill(buy(ID, 1, 0, options.drop === 'A' ? A.maxUsdPerLevel : 15))
  for (const fill of options.history ?? []) await store.recordFill(fill)

  const sent: Alert[] = []
  let countRequests = 0
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
            ...(options.bookUsd !== undefined
              ? { fund: fundRungsFromFreeCapital({ store, totalCapitalUsd: options.bookUsd, params: PARAMS_A, gasUsdPerSwap: 0.05, rungsUsd: A.dcaRungsUsd }) }
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

  it('an ARMED position that falls through its first buy still buys its rung', async () => {
    // The ratchet is on by default and an armed position stays armed for
    // life, so a winner that turned came through the refused sale on every
    // sweep — and the price ladder, one step further down, never got a look.
    const { store, run } = await rig({
      held: position({ breakEvenArmed: true, lastPriceUsd: 0.9 }),
      drop: true,
      levels: { stop: NO_STOP, armAtPct: 7.5, breakEvenPct: 7.5 },
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
