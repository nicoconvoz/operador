import { describe, it, expect } from 'vitest'
import { sweepStops, buyFirstStepOnSelection, type DipBounce, type ExitLevels, type StopSweepDeps } from './stop-sweep.js'
import { fundStepFromFreeCapital } from './free-capital.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { AlertThrottle, type Alert } from '../domain/notifications/alerts.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, DEFAULT_DEATH_EXIT_POLICY, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { DEFAULT_DIP_BOUNCE_POLICY, dipBounceThresholds, type DipBouncePolicy } from '../domain/strategy/dip-bounce.js'
import { type LiquidityReading } from '../domain/strategy/liquidity-brake.js'

/**
 * *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y armá
 * escalones de 1 USD con la misma regla* — then *disminuí los escalones a 20*,
 * then *3% suma 2%, el 2% suma 2% por cada DCA* and *el rebote dejalo que
 * aumente de 1%*: each DCA asks 2 more points of dip and ceiling, 1 of bounce.
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

const NO_STOP: ExitLevels = { stop: { shareOfRun: 0, minStopPct: 0, maxStopPct: 0, maxLossUsd: 0 }, armAtPct: null, breakEvenPct: 0, gainLock: null, fixedTpPct: null }

const rig = async (options: {
  readonly held?: PersistedPosition
  readonly bookUsd?: number
  readonly others?: readonly PersistedPosition[]
  readonly policy?: DipBouncePolicy
  /** The book's pools, as the runtime's Jupiter reader answers them. Absent: no pool check. */
  readonly pool?: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>
  /** Whether the cycle buys the first step the moment it opens the slot. */
  readonly onSelection?: boolean
} = {}) => {
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
    policy: options.policy ?? DEFAULT_DIP_BOUNCE_POLICY,
    stepUsd: 1,
    gasUsdPerSwap: GAS,
    fund: fundStepFromFreeCapital({
      store,
      totalCapitalUsd: options.bookUsd ?? 1_000,
      cashOf: async (p) => (await brokerFor(p)).equityCash,
    }),
    ...(options.pool ? { pool: { liquidity: options.pool, deathPolicy: DEFAULT_DEATH_EXIT_POLICY, refusing: new Set<string>() } } : {}),
    ...(options.onSelection === true ? { onSelection: true } : {}),
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

/** Walks the price down one full step: a 4% dip, then a 2.1% bounce off it — the first buy's and DCA 1's. */
const oneStep = async (run: (price: number) => Promise<unknown>, from: number) => {
  await run(from * 0.96)
  await run(from * 0.96 * 1.021)
  return from * 0.96 * 1.021
}

/**
 * Walks the price down one full step for the k-th buy: a point past its own dip,
 * then a point past its own bounce off that low.
 */
const stepDown = async (run: (price: number) => Promise<unknown>, from: number, k: number) => {
  const { dipPct, bouncePct } = dipBounceThresholds(k, DEFAULT_DIP_BOUNCE_POLICY)
  const low = from * (1 - (dipPct + 1) / 100)
  await run(low)
  await run(low * (1 + (bouncePct + 1) / 100))
  return low * (1 + (bouncePct + 1) / 100)
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
    expect(averaged).toEqual(['🪜 T promedió — compra 2 de 20: cayó 4.0% (pedía 3%) y rebotó 2.1% (pedía 2%) — DCA 1'])
    expect(sent.find((a) => a.kind === 'dca-filled')?.level).toBe('info')
    void price
  })

  it('asks DCA 2 for a 5% dip and a 3% bounce: DCA 1’s 4% and 2.1% again buy nothing', async () => {
    const { run, buys, sent } = await rig()
    await run(1)
    let price = await oneStep(run, 1)
    price = await oneStep(run, price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    await oneStep(run, price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1'])
    await stepDown(run, price, 3)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry', 'DCA-1', 'DCA-2'])
    expect(sent.filter((a) => a.kind === 'dca-filled').map((a) => a.title)[1]).toMatch(/: cayó \d+\.\d% \(pedía 5%\) y rebotó \d+\.\d% \(pedía 3%\) — DCA 2$/)
  })

  it('stops at twenty, the first buy included — every one a dollar, every one under the last', async () => {
    const { run, buys } = await rig()
    await run(1)
    let price = 1
    for (let k = 1; k <= 25; k++) price = await stepDown(run, price, k)
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
    for (let k = 1; k <= 20; k++) price = await stepDown(run, price, k)
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
    for (let k = 1; k <= 20; k++) price = await stepDown(run, price, k)
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

describe('the dip-bounce ladder, through the sweep — a fall of more than 20% is a collapse, not a dip', () => {
  // "If it fell more than 20% it is a collapse, not a dip: don't buy there.
  // Wait until it is back within 20%." YAP and BAGSPAY bought on 31–34%.
  const collapses = (sent: readonly Alert[]) => sent.filter((a) => a.title.includes('es un derrumbe'))

  for (const pct of [4, 10, 15.6]) {
    it(`a ${pct}% dip buys exactly what it bought before — the same fill and the same watch`, async () => {
      const walk = async (policy: DipBouncePolicy) => {
        const r = await rig({ policy })
        for (const price of [1, 1 - pct / 100, (1 - pct / 100) * 1.021]) await r.run(price)
        return { fills: (await r.buys()).map(({ orderId, price, qty }) => ({ orderId, price, qty })), watch: await r.watch() }
      }
      const on = await walk(DEFAULT_DIP_BOUNCE_POLICY)
      expect(on.fills.map((f) => f.orderId)).toEqual(['Entry'])
      expect(on).toEqual(await walk({ ...DEFAULT_DIP_BOUNCE_POLICY, maxDipPct: 0 }))
    })
  }

  it('buys nothing on a 31.6% first dip however it bounces, says so ONCE, and writes the collapse down', async () => {
    const { run, buys, watch, sent } = await rig()
    for (const price of [1, 0.684, 0.684 * 1.021, 0.684 * 1.05, 0.7, 0.66, 0.68]) await run(price)
    expect(await buys()).toEqual([])
    expect(collapses(sent).map((a) => a.title)).toEqual([
      '🧊 T: cayó 31.6% — más de 20% (techo de la primera compra) es un derrumbe; no compra hasta que vuelva a estar a menos de 20% de $1',
    ])
    expect(collapses(sent)[0]!.level).toBe('info')
    expect(await watch()).toMatchObject({ reference: 1, armed: true, crashed: true })
  })

  it('buys once the price is back within 20% and bounces 2% off the NEW low — back to −18%, then +2%', async () => {
    const { run, buys, sent } = await rig()
    for (const price of [1, 0.684, 0.7, 0.82]) await run(price)
    expect(await buys()).toEqual([])
    await run(0.82 * 1.021)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    expect(sent.find((a) => a.kind === 'position-opened')?.title).toBe('🟢 T compró $1 — cayó 18.0% y rebotó 2.1% (compra 1 de 20)')
  })

  it('holds every later buy to the same ceiling, measured from the last buy — and says which price it waits to be near', async () => {
    const { run, buys, sent } = await rig()
    await run(1)
    const first = await oneStep(run, 1)
    for (const price of [first * 0.75, first * 0.75 * 1.03, first * 0.7, first * 0.72]) await run(price)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    expect(collapses(sent).map((a) => a.title)).toEqual([
      `🧊 T: cayó 25.0% — más de 20% (techo del DCA 1) es un derrumbe; no compra hasta que vuelva a estar a menos de 20% de $${first}`,
    ])
  })

  it('holds each DCA to its OWN ceiling, grown with its dip: DCA 10 collapses past 38%, not past 20%', async () => {
    // *El techo del 20% crece 2 puntos por DCA, igual que la caída.*
    const { run, buys, sent } = await rig()
    await run(1)
    let price = 1
    for (let k = 1; k <= 10; k++) price = await stepDown(run, price, k)
    expect(await buys()).toHaveLength(10)
    await run(price * 0.6)
    expect(collapses(sent).map((a) => a.title)).toEqual([
      `🧊 T: cayó 40.0% — más de 38% (techo del DCA 10) es un derrumbe; no compra hasta que vuelva a estar a menos de 38% de $${price}`,
    ])
    expect(collapses(sent)[0]!.body).toContain('desde ahí la compra espera un rebote de 11%')
    // Back within its 38% — 35% under — and an 11% bounce: DCA 10.
    await run(price * 0.65)
    await run(price * 0.65 * 1.111)
    expect((await buys()).map((f) => f.orderId).at(-1)).toBe('DCA-10')
  })

  it('says a second collapse after a recovery — once per collapse, never once per sweep', async () => {
    const { run, buys, sent } = await rig()
    // Collapsed at −30%, back to −10% (armed, the new low), then −25%: a second collapse.
    for (const price of [1, 0.7, 0.69, 0.9, 0.89, 0.75, 0.74, 0.73]) await run(price)
    expect(await buys()).toEqual([])
    expect(collapses(sent).map((a) => a.title.slice(0, 16))).toEqual(['🧊 T: cayó 30.0%', '🧊 T: cayó 25.0%'])
  })
})

describe('the dip-bounce ladder, through the sweep — the pool, asked live before every step', () => {
  // YAP froze with "liquidity $52,380 = 26.6% of entry" — but the freeze is
  // assessed by the tick, once a bar, and the thirty-second sweep bought four
  // more steps into the draining pool before it landed.
  const ENTRY = 196_917
  const YAP = 52_380
  const draining = (usd: { value: number | null }, calls: (readonly string[])[] = []) =>
    async (positions: readonly PersistedPosition[]) => {
      calls.push(positions.map((p) => p.id))
      return new Map<string, LiquidityReading>([['solana:T', { m5: null, h1: null, usd: usd.value }]])
    }
  const pooled = (over: Partial<PersistedPosition> = {}) => reservation({ deathWatch: startDeathWatch(ENTRY, 0), ...over })
  const drained = (sent: readonly Alert[]) => sent.filter((a) => a.title.includes('el pool perdió liquidez'))

  it('refuses the step on YAP’s pool — 26.6% of entry — says so ONCE, and keeps the watch armed for when it comes back', async () => {
    const usd = { value: YAP as number | null }
    const { run, buys, watch, sent } = await rig({ held: pooled(), pool: draining(usd) })
    for (const price of [1, 0.96, 0.98, 0.985, 0.99]) await run(price)
    expect(await buys()).toEqual([])
    expect(drained(sent).map((a) => a.title)).toEqual(['🧊 T: el pool perdió liquidez (queda 26.6% de la entrada) — no compra'])
    expect(drained(sent)[0]!.level).toBe('info')
    expect(await watch()).toMatchObject({ armed: true, low: 0.96 })
    // The pool comes back to 90% of entry: the same bounce buys.
    usd.value = ENTRY * 0.9
    await run(0.99)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    // And a pool that drains AGAIN is said again: a second refusal, not the same one.
    usd.value = YAP
    await oneStep(run, 0.99)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    expect(drained(sent)).toHaveLength(2)
  })

  it('buys as before on a pool at 90% of entry — and at exactly the freeze line', async () => {
    for (const share of [0.9, 0.5]) {
      const { run, buys, sent } = await rig({ held: pooled(), pool: draining({ value: ENTRY * share }) })
      for (const price of [1, 0.96, 0.98]) await run(price)
      expect((await buys()).map((f) => f.orderId), `${share}`).toEqual(['Entry'])
      expect(drained(sent)).toEqual([])
    }
  })

  it('refuses a later step the same way — every buy, the first included', async () => {
    const usd = { value: ENTRY as number | null }
    const { run, buys } = await rig({ held: pooled(), pool: draining(usd) })
    await run(1)
    const first = await oneStep(run, 1)
    usd.value = ENTRY * 0.3
    await oneStep(run, first)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
  })

  it('never refuses on a reading nobody gave: a token missing, a depth unreported, a refused request', async () => {
    const answers: ((positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, LiquidityReading>>)[] = [
      async () => new Map(),
      draining({ value: null }),
      async () => { throw new Error('429') },
    ]
    for (const pool of answers) {
      const { run, buys } = await rig({ held: pooled(), pool })
      for (const price of [1, 0.96, 0.98]) await run(price)
      expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    }
  })

  it('asks ONCE a sweep for the whole book, and never on a sweep with no step to buy', async () => {
    const calls: (readonly string[])[] = []
    const other = pooled({ id: 'solana:U:1', tokenAddress: 'U', pairAddress: 'Q', symbol: 'U' })
    const { run, buys } = await rig({ held: pooled(), others: [other], pool: draining({ value: ENTRY }, calls) })
    await run(1)
    await run(0.96)
    expect(calls).toEqual([])
    await run(0.98)
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
    expect(calls).toHaveLength(1)
    expect([...calls[0]!].sort()).toEqual(['solana:T:1', 'solana:U:1'])
  })
})

describe('the FIRST step on selection — bought the moment a slot is opened', () => {
  // *Y además que la primera compra entre automáticamente.* The operator. The
  // cycle calls this for a slot it just opened, after the door's safety
  // re-check and the tick that put a candle close on record: the first dollar
  // does not wait for a dip and a bounce. Every later one does.
  const onSelection = async (options: Parameters<typeof rig>[0] = {}) => {
    const r = await rig({ ...options, onSelection: true })
    const first = async (price: number | null, close = 1, at = AT) => {
      const [position] = await r.store.loadPositions()
      return buyFirstStepOnSelection(r.deps, { ...position!, lastPriceUsd: close }, price, at, new AlertThrottle(0))
    }
    return { ...r, first }
  }

  it('buys one step at the live price, names the reference for the next one, and says so', async () => {
    const { first, buys, watch, sent } = await onSelection()
    expect(await first(1)).toBe('bought')
    const bought = await buys()
    expect(bought.map((f) => f.orderId)).toEqual(['Entry'])
    expect(bought[0]!.qty).toBeCloseTo(1 / 1, 9)
    expect(await watch()).toMatchObject({ reference: 1, armed: false, low: null, holdingSince: bought[0]!.time })
    const said = sent.find((a) => a.kind === 'position-opened')!
    expect(said.title).toBe('🟢 T compró $1 al entrar como candidata (compra 1 de 20)')
    expect(said.level).toBe('info')
  })

  it('buys it ONCE: a second call, the same pass or the next, finds the step already bought', async () => {
    const { first, buys } = await onSelection()
    await first(1)
    expect(await first(1)).toBeNull()
    expect(await first(1, 1, AT + 15 * MIN)).toBeNull()
    expect((await buys()).map((f) => f.orderId)).toEqual(['Entry'])
  })

  it('never on a slot that has held anything before — a holding after a sale waits for its dip and bounce', async () => {
    const { first, buys, store } = await onSelection()
    await store.recordFill({ positionId: ID, orderId: 'Entry', side: 'buy', time: 1, price: 1, qty: 1, costUsd: 0.05, comment: '🟢 Entry', idempotencyKey: `${ID}:1:Entry` })
    await store.recordFill({ positionId: ID, orderId: 'Exit', side: 'sell', time: 2, price: 1.2, qty: 1, costUsd: 0.05, comment: '🏁 Exit', idempotencyKey: `${ID}:2:Exit` })
    expect(await first(1)).toBeNull()
    expect(await buys()).toHaveLength(1)
  })

  it('keeps every guard a step has: a candle close, prices that agree, a healthy watch, nothing in flight, a price at all', async () => {
    const cases: [string, Partial<PersistedPosition>, number | null, number][] = [
      ['no close on record', { lastBarTime: -1 }, 1, 1],
      ['prices disagree', {}, 1, 40],
      ['frozen', { deathWatch: { ...startDeathWatch(1, 0), stage: 'frozen' } }, 1, 1],
      ['in flight', { pendingOrders: [{ kind: 'closeAll', comment: '🏁 Exit' }] }, 1, 1],
      ['no live price', {}, null, 1],
    ]
    for (const [why, held, price, close] of cases) {
      const { first, buys } = await onSelection({ held: reservation(held) })
      expect(await first(price, close), why).toBeNull()
      expect(await buys(), why).toEqual([])
    }
  })

  it('is off unless asked for: every caller that predates it buys nothing here', async () => {
    const r = await rig()
    const [position] = await r.store.loadPositions()
    expect(await buyFirstStepOnSelection(r.deps, position!, 1, AT, new AlertThrottle(0))).toBeNull()
    expect(await r.buys()).toEqual([])
  })

  it('says a first step that found no free capital for its fees, and buys nothing — never shrunk', async () => {
    const { first, buys, sent } = await onSelection({ bookUsd: 0.5, held: reservation({ capitalUsd: 0.5 }) })
    expect(await first(1)).toBe('unfunded')
    expect(await buys()).toEqual([])
    expect(sent.some((a) => a.kind === 'entry-refused' && a.title.startsWith('💤 T sin capital libre para la compra 1 de 20'))).toBe(true)
  })
})
