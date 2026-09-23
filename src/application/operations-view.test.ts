import { describe, it, expect } from 'vitest'
import { buildOperations } from './operations-view.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'
import { type PersistedFill, type PersistedPosition } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

const position = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', pairAddress: 'Pair1', symbol: 'DREGG',
  cascade: { ...initialState(), level: 3, ep1: 0.01, wasInTrade: true },
  deathWatch: startDeathWatch(250_000, NOW),
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 200, lastBarTime: NOW, lastPriceUsd: 0.011, pendingOrders: [],
  openedAt: NOW - 60 * MIN, updatedAt: NOW, ...over,
})

const fill = (orderId: string, price: number, qty: number, at: number, side: 'buy' | 'sell' = 'buy'): PersistedFill => ({
  positionId: 'pos-1', orderId, side, time: at, price, qty, costUsd: price * qty * 0.006,
  comment: orderId, idempotencyKey: `${orderId}:${at}`,
})

const seed = async (fills: PersistedFill[], over: Partial<PersistedPosition> = {}) => {
  const store = new MemoryStore()
  await store.savePosition(position(over))
  for (const f of fills) await store.recordFill(f)
  return store
}

const options = { now: () => NOW, params: DEFAULT_PARAMS }

describe('buildOperations — the books come from the fills', () => {
  it('an empty store reports nothing, not zeroes that look like activity', async () => {
    const view = await buildOperations(new MemoryStore(), options)
    expect(view.positions).toEqual([])
    expect(view.recentFills).toEqual([])
    expect(view.totals.deployedUsd).toBe(0)
  })

  it('derives deployed, quantity and average cost from the fills themselves', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN), fill('DCA-1', 0.009, 2_000, NOW - 10 * MIN)])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.qty).toBe(3_000)
    expect(p!.deployedUsd).toBeCloseTo(0.01 * 1_000 + 0.009 * 2_000, 9)
    expect(p!.avgCostUsd).toBeCloseTo(28 / 3_000, 9)
  })

  it('marks the position at its last known price and shows the gap', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN)])
    const [p] = (await buildOperations(store, options)).positions
    // Bought at 0.01, marked at 0.011: up 10%.
    expect(p!.marketValueUsd).toBeCloseTo(11, 9)
    expect(p!.unrealisedUsd).toBeCloseTo(1, 9)
    expect(p!.unrealisedPct).toBeCloseTo(10, 6)
  })

  it('shows a loss as a loss', async () => {
    const store = await seed([fill('Entry', 0.02, 1_000, NOW - MIN)])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.unrealisedUsd).toBeLessThan(0)
    expect(p!.unrealisedPct).toBeLessThan(0)
  })

  it('totals what the chain has taken so far', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN), fill('DCA-1', 0.009, 2_000, NOW)])
    const view = await buildOperations(store, options)
    expect(view.totals.costsUsd).toBeGreaterThan(0)
    expect(view.totals.costsUsd).toBeCloseTo(view.positions[0]!.costsUsd, 9)
  })

  it('a sell reduces the quantity held', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 20 * MIN), fill('Entry', 0.012, 1_000, NOW - MIN, 'sell')])
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.qty).toBe(0)
    expect(p!.marketValueUsd).toBeNull()
  })
})

describe('buildOperations — the ladder, planned against actual', () => {
  it('marks which rungs filled, at what price, and which one is next', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN), fill('DCA-1', 0.0094, 2_000, NOW - 10 * MIN)])
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    expect(ladder[0]).toMatchObject({ level: 0, filled: true, fillPrice: 0.01 })
    expect(ladder[1]).toMatchObject({ level: 1, filled: true, fillPrice: 0.0094 })
    // The machine is at level 3, so that is the rung it waits on.
    expect(ladder[2]).toMatchObject({ level: 2, filled: false, pending: false })
    expect(ladder[3]).toMatchObject({ level: 3, filled: false, pending: true })
  })

  it('computes each rung trigger from the anchor entry, not from the last fill', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - MIN)])
    const { ladder } = (await buildOperations(store, options)).positions[0]!
    // ep1 = 0.01, linear drops 1%, 4%, 7% …
    expect(ladder[1]!.triggerPrice).toBeCloseTo(0.01 * 0.99, 12)
    expect(ladder[2]!.triggerPrice).toBeCloseTo(0.01 * 0.96, 12)
    expect(ladder[0]!.triggerPrice).toBeNull() // the entry has no trigger of its own
  })

  it('draws only the rungs the venue will actually hold', async () => {
    // It used to draw twelve from `maxLevels` — what the MACHINE signals — and
    // flag the ones past the venue cap. That was readable at ten fillable of
    // fifty signalled. At ONE fillable it is eleven boxes of nothing, on a
    // phone, times thirty-seven positions.
    const { ladder } = (await buildOperations(await seed([]), options)).positions[0]!
    expect(ladder.map((r) => r.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('carries the nominal size of each rung, so the plan is visible too', async () => {
    const { ladder } = (await buildOperations(await seed([]), options)).positions[0]!
    expect(ladder[0]!.nominalUsd).toBe(1_000)
    expect(ladder[1]!.nominalUsd).toBe(2_200)
  })
})

describe('buildOperations — the tape', () => {
  it('lists fills newest first, tagged with the token', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 30 * MIN),
      fill('DCA-1', 0.009, 2_000, NOW - 10 * MIN),
      fill('DCA-2', 0.008, 3_000, NOW - MIN),
    ])
    const { recentFills } = await buildOperations(store, options)
    expect(recentFills.map((f) => f.orderId)).toEqual(['DCA-2', 'DCA-1', 'Entry'])
    expect(recentFills[0]!.symbol).toBe('DREGG')
  })

  it('counts buys and sells', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 20 * MIN), fill('Entry', 0.012, 1_000, NOW - MIN, 'sell')])
    const { totals } = await buildOperations(store, options)
    expect(totals.buys).toBe(1)
    expect(totals.sells).toBe(1)
  })

  it('caps the tape so a long history does not become the whole page', async () => {
    const many = Array.from({ length: 80 }, (_, i) => fill(`DCA-${i}`, 0.01, 10, NOW - i * MIN))
    const view = await buildOperations(await seed(many), { ...options, tapeLength: 25 })
    expect(view.recentFills).toHaveLength(25)
  })
})

describe('buildOperations — what needs attention', () => {
  it('surfaces a pending order and the death stage', async () => {
    const store = await seed([], {
      pendingOrders: [{ kind: 'entry', id: 'DCA-3', level: 3, usd: 100, qty: 1, comment: 'DCA-3' }],
      deathWatch: { ...startDeathWatch(250_000, NOW), stage: 'frozen' },
    })
    const [p] = (await buildOperations(store, options)).positions
    expect(p!.hasPendingOrders).toBe(true)
    expect(p!.deathStage).toBe('frozen')
  })
})

describe('buildOperations — the ladder points at what is actually waiting', () => {
  it('marks the rung whose ORDER is in flight, not the level the machine reached', async () => {
    // The machine advances to level 1 the moment it signals the Entry, but the
    // Entry itself does not fill until the next bar's open. Pointing at rung 1
    // then says "waiting for DCA-1" while rung 0 — the order actually in
    // flight — sits unmarked. Reading that, you would think the entry had
    // happened.
    const store = await seed([], {
      cascade: { ...initialState(), level: 1, ep1: 0.01, wasInTrade: true },
      pendingOrders: [{ kind: 'entry', id: 'Entry', level: 0, usd: 15, qty: 1500, comment: 'Entry' }],
    })
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    expect(ladder[0]!.pending).toBe(true)
    expect(ladder[1]!.pending).toBe(false)
  })

  it('falls back to the level being waited on when nothing is in flight', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN)], {
      cascade: { ...initialState(), level: 1, ep1: 0.01, wasInTrade: true },
      pendingOrders: [],
    })
    const { ladder } = (await buildOperations(store, options)).positions[0]!

    // Entry filled, nothing in flight: the ladder points at the trigger the
    // strategy is watching for.
    expect(ladder[0]!.filled).toBe(true)
    expect(ladder[1]!.pending).toBe(true)
  })
})

// ── Realised profit ─────────────────────────────────────────────────────────
//
// The whole system exists to produce realised profit, and the screen did not
// have it. A position that sold everything showed qty 0, unrealised null, and
// its actual gain — the only money the system had genuinely made — appeared
// nowhere at all.
//
// The same walk fixes a second, quieter error. deployedUsd summed EVERY buy
// ever made, including ones already sold, so a position that had cycled once
// reported twice the capital it holds — and avgCost was that blend divided by
// every unit ever bought, which made the UNREALISED number wrong too.

describe('buildOperations — the money actually made', () => {
  it('reports the gain of a round trip that closed', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 30 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 10 * MIN, 'sell'),
    ], { cascade: initialState() })

    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    expect(view!.realisedUsd).toBeCloseTo(2, 6) // 1000 × (0.012 − 0.01)
    expect(view!.qty).toBe(0)
  })

  it('counts only what is still held as deployed, not everything ever bought', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 40 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 30 * MIN, 'sell'),
      fill('Entry', 0.011, 1_000, NOW - 20 * MIN),
    ])

    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    // $10 went in, came back out at $12, and $11 went in again. Eleven dollars
    // are committed — not twenty-one.
    expect(view!.deployedUsd).toBeCloseTo(11, 6)
    expect(view!.avgCostUsd).toBeCloseTo(0.011, 6)
  })

  it('marks the open position against what it actually cost, not a blend with closed trades', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 40 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 30 * MIN, 'sell'),
      fill('Entry', 0.011, 1_000, NOW - 20 * MIN),
    ], { lastPriceUsd: 0.012 })

    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    // Against the real basis of 0.011 the open lot is up $1. Averaged with the
    // closed trade the basis would read 0.0105 and the screen would claim $1.50
    // on a position that never paid that price.
    expect(view!.unrealisedUsd).toBeCloseTo(1, 6)
    expect(view!.realisedUsd).toBeCloseTo(2, 6)
  })

  it('averages the cost of a ladder, and a partial sale realises against it', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 40 * MIN),
      fill('DCA-1', 0.008, 1_000, NOW - 30 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 10 * MIN, 'sell'),
    ])

    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    // Basis 0.009 across two rungs; selling half realises 1000 × 0.003.
    expect(view!.avgCostUsd).toBeCloseTo(0.009, 6)
    expect(view!.realisedUsd).toBeCloseTo(3, 6)
    expect(view!.deployedUsd).toBeCloseTo(9, 6)
  })

  it('totals the profit, and states it net of what the chain took', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 30 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 10 * MIN, 'sell'),
    ], { cascade: initialState() })

    const { totals } = await buildOperations(store, { now: () => NOW })

    // Costs are never netted silently into the P&L — they sit beside it, so
    // "we made two dollars" and "the chain took thirteen cents" stay two
    // separate facts. netUsd is the one number that answers "are we ahead".
    expect(totals.realisedUsd).toBeCloseTo(2, 6)
    expect(totals.costsUsd).toBeGreaterThan(0)
    expect(totals.netUsd).toBeCloseTo(2 + totals.unrealisedUsd - totals.costsUsd, 6)
  })
})

// ── Why the next rung is not firing ─────────────────────────────────────────
//
// A token fell 28% below its entry and no DCA fired, and the screen could not
// say why. Working it out meant reading the cascade state out of the database
// and doing the arithmetic by hand — which is the same as the system not
// knowing.
//
// The five rebound locks are the answer, and "the ladder is waiting" is not a
// bug: locks 1 and 2 were satisfied twenty-seven points earlier, and what held
// was the confirmation window. On a token making a new low every bar,
// `barsSinceLow` resets every bar and never reaches its twenty. That is the
// anti-knife-catching rule doing its job — but it has to be VISIBLE, or every
// quiet ladder looks identical to a broken one.

describe('buildOperations — the locks between here and the next rung', () => {
  const armed = (over = {}) => position({
    cascade: {
      ...initialState(), level: 1, ep1: 0.01, wasInTrade: true,
      cycleLow: 0.007, lastFill: 0.01, barsSinceLow: 3, ...over,
    },
    lastPriceUsd: 0.00714,
  })

  it('says the price got low enough to arm the rung', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 60 * MIN)], armed())
    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    // trigger(1) is ep1 × 0.99 = 0.0099, and the cycle low is 0.007.
    const trigger = view!.locks!.find((l) => l.name === 'trigger')
    expect(trigger!.held).toBe(true)
  })

  it('names the confirmation window as what is actually holding it back', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 60 * MIN)], armed())
    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    const confirm = view!.locks!.find((l) => l.name === 'confirmation')
    expect(confirm!.held).toBe(false)
    expect(confirm!.detail).toContain('3')
    expect(confirm!.detail).toContain('20')
  })

  it('a new low resets the window, which is why a falling token never confirms', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 60 * MIN)], armed({ barsSinceLow: 0 }))
    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    expect(view!.locks!.find((l) => l.name === 'confirmation')!.held).toBe(false)
  })

  it('holds every lock once the bottom has held and the price bounced', async () => {
    const store = await seed(
      [fill('Entry', 0.01, 1_000, NOW - 60 * MIN)],
      { ...armed({ barsSinceLow: 25 }), lastPriceUsd: 0.0075 }, // 0.007 × 1.025 = 0.007175
    )
    const [view] = (await buildOperations(store, { now: () => NOW })).positions

    expect(view!.locks!.filter((l) => !l.held)).toEqual([])
  })

  it('reports nothing to unlock when the position is flat', async () => {
    const store = await seed([], { cascade: initialState() })
    const [view] = (await buildOperations(store, { now: () => NOW })).positions
    expect(view!.locks).toBeNull()
  })
})

describe('buildOperations — the ladder stops where the VENUE stops', () => {
  it('takes the cap from production, never from the reference', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 60 * MIN)])
    // Five DCAs: the entry plus its ladder is six. Reading PYRAMIDING here
    // would draw four rungs the broker is going to refuse.
    const [view] = (await buildOperations(store, { now: () => NOW, maxOpenEntries: 6 })).positions
    expect(view!.ladder.map((r) => r.level)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('falls back to the reference when production says nothing', async () => {
    const store = await seed([fill('Entry', 0.01, 1_000, NOW - 60 * MIN)])
    const [view] = (await buildOperations(store, { now: () => NOW })).positions
    expect(view!.ladder).toHaveLength(PYRAMIDING)
  })
})

// ── Profit does not leave when the position does ────────────────────────────
//
// Reported live: a token that had made the most money ceded its slot, and its
// gain vanished — not shown as banked anywhere, as if it had never won.
//
// The view read `loadPositions()` and summed only those, so a position that
// closed took its realised profit off the screen with it. The fills stayed in
// the database — `fills` has no foreign key to `positions` precisely so they
// survive — and nothing was reading them.
//
// Worse than cosmetic: the allocator counts that money, through commonFund over
// every fill, and the screen did not. Two answers to "how much have we made",
// disagreeing. The one on the screen is the one you would believe.

describe('buildOperations — a closed position keeps its profit on the screen', () => {
  const winner = async (store: MemoryStore) => {
    // No row in `positions`: this one closed. Only its fills remain.
    await store.recordFill({ positionId: 'gone-1', orderId: 'Entry', side: 'buy', time: NOW - 40 * MIN, price: 1, qty: 100, costUsd: 0.2, comment: '🟢 Entry', idempotencyKey: 'w1' })
    await store.recordFill({ positionId: 'gone-1', orderId: 'Exit', side: 'sell', time: NOW - 20 * MIN, price: 1.5, qty: 100, costUsd: 0.3, comment: '🏁 Exit', idempotencyKey: 'w2' })
  }

  it('still counts the gain of a position that has left the book', async () => {
    const store = new MemoryStore()
    await winner(store)

    const { totals } = await buildOperations(store, { now: () => NOW })

    expect(totals.realisedUsd).toBeCloseTo(50, 6)
  })

  it('still counts what the chain took from it', async () => {
    const store = new MemoryStore()
    await winner(store)

    const { totals } = await buildOperations(store, { now: () => NOW })

    expect(totals.costsUsd).toBeCloseTo(0.5, 6)
    expect(totals.netUsd).toBeCloseTo(49.5, 6)
  })

  it('counts its executions, so the tape is not quietly short', async () => {
    const store = new MemoryStore()
    await winner(store)

    const { totals } = await buildOperations(store, { now: () => NOW })

    expect(totals.buys).toBe(1)
    expect(totals.sells).toBe(1)
  })

  it('keeps it in the tape, so the winning trade can still be read', async () => {
    const store = new MemoryStore()
    await winner(store)

    const view = await buildOperations(store, { now: () => NOW })

    expect(view.recentFills.map((f) => f.comment)).toEqual(['🏁 Exit', '🟢 Entry'])
  })

  it('adds up open and closed together, and never twice', async () => {
    const store = await seed([
      fill('Entry', 0.01, 1_000, NOW - 30 * MIN),
      fill('Exit', 0.012, 1_000, NOW - 10 * MIN, 'sell'),
    ], { cascade: initialState() })
    await winner(store)

    const { totals } = await buildOperations(store, { now: () => NOW })

    expect(totals.realisedUsd).toBeCloseTo(52, 6) // $2 open-book, $50 departed
  })
})

describe('buildOperations — the unrealised figure at the LIVE price', () => {
  const held = async () => seed([fill('Entry', 0.01, 1_000, NOW - 30 * MIN)])

  it('values the position at the market price now, not at the last bar close', async () => {
    // The screen sat still because it valued everything at `lastPriceUsd` — the
    // price of the last CLOSED bar, which on 15-minute candles changes four
    // times an hour. The engine is right to decide on closed bars; the screen is
    // not showing a decision, it is showing what the position is WORTH, and
    // that moves continuously.
    const view = await buildOperations(await held(), {
      ...options,
      livePrices: async () => new Map([['solana:Mint1', 0.02]]),
    })
    const p = view.positions[0]!
    expect(p.lastPriceUsd).toBe(0.02)
    expect(p.priceIsLive).toBe(true)
    // And the unrealised figure follows it: 1,000 bought at 0.01, worth 0.02.
    expect(p.unrealisedUsd).toBeCloseTo(10, 5)
  })

  it('falls back to the bar close when the price feed says nothing about it', async () => {
    // A provider having a bad minute must never blank the one number the system
    // exists to produce. Stale and LABELLED beats absent.
    const view = await buildOperations(await held(), { ...options, livePrices: async () => new Map() })
    expect(view.positions[0]!.lastPriceUsd).toBe(0.011)
    expect(view.positions[0]!.priceIsLive).toBe(false)
  })

  it('never lets a broken price feed break the page', async () => {
    const view = await buildOperations(await held(), {
      ...options,
      livePrices: async () => { throw new Error('502') },
    })
    expect(view.positions[0]!.lastPriceUsd).toBe(0.011)
    expect(view.positions[0]!.priceIsLive).toBe(false)
  })

  it('leaves the LADDER on the price the engine acted on, not the live one', async () => {
    // The rungs are what the strategy decided, at the closes it decided them
    // on. Redrawing them against a price the engine has not acted on yet would
    // make the screen disagree with the machine about where the ladder is.
    const view = await buildOperations(await held(), {
      ...options,
      livePrices: async () => new Map([['solana:Mint1', 0.02]]),
    })
    expect(view.positions[0]!.ladder[0]!.fillPrice).toBe(0.01)
  })
})

describe('a ladder the venue cannot climb is not a ladder', () => {
  // The operator, counting his own screen: *además hay dos escalones por moneda,
  // no uno como te había pedido.*
  //
  // The ENGINE was right — every card read `0 DCA` and every position held one
  // buy. What had two rungs was the PICTURE: twelve boxes built from
  // `maxLevels` (50, what the machine SIGNALS) with no reference to
  // `maxOpenEntries` (1, what the broker will HOLD), and one of them painted as
  // the rung being waited on, with a line underneath explaining the price it
  // needed to reach.
  //
  // Nothing was ever waiting for it. `PaperBroker` refuses every entry past the
  // cap, so that amber box was a promise the engine had already refused to
  // keep. It is the screen-versus-engine disagreement this read model exists to
  // prevent, with the sides swapped — usually the engine refuses what the screen
  // offers; here the screen offered what the engine refuses.

  const oneBuy = { ...options, maxOpenEntries: 1 }

  it('draws exactly as many rungs as the venue will hold', async () => {
    const { ladder } = (await buildOperations(await seed([]), oneBuy)).positions[0]!
    expect(ladder).toHaveLength(1)
  })

  it('never says it is WAITING for a rung that can never fill', async () => {
    // The fixture's machine sits at level 3 — it advances past the cap and goes
    // on describing the next rung, while the broker throws every such order
    // away. "Pending" has to mean an order that can arrive.
    const { ladder } = (await buildOperations(await seed([]), oneBuy)).positions[0]!
    expect(ladder.some((rung) => rung.pending)).toBe(false)
  })

  it('grows back the day the operator asks for a ladder again', async () => {
    const { ladder } = (await buildOperations(await seed([]), { ...options, maxOpenEntries: 6 })).positions[0]!
    expect(ladder).toHaveLength(6)
  })
})

describe('buildOperations — the ladder the ENGINE buys: buy pressure crossing 1%', () => {
  // *Aplicalo para el DCA también — nada de escalones, esa regla.* A rung is
  // bought each time buy pressure crosses 1% upward, so the screen draws no
  // price for a rung — there is none — and says where the pressure stands.
  const ladder = (pressure: number | null) => ({
    ...options,
    maxOpenEntries: 6,
    pressureLadder: { threshold: 0.01, pressureOf: async () => pressure },
  })
  const held = { cascade: { ...initialState(), level: 1, ep1: 1, wasInTrade: true }, lastPriceUsd: 0.97 }

  it('draws six rungs with NO trigger price — a rung waits on buyers, not on a price', async () => {
    const store = await seed([fill('Entry', 1, 15, NOW - 30 * MIN), fill('DCA-1', 0.94, 16, NOW - 20 * MIN)], held)
    const [p] = (await buildOperations(store, ladder(0))).positions
    expect(p!.ladder).toHaveLength(6)
    expect(p!.ladder.every((r) => r.triggerPrice === null)).toBe(true)
    expect(p!.ladder.map((r) => r.pending)).toEqual([false, false, true, false, false, false])
  })

  it('waits for buy pressure to cross 1%, and says where it is', async () => {
    const store = await seed([fill('Entry', 1, 15, NOW - 30 * MIN)], held)
    const [p] = (await buildOperations(store, ladder(0.004))).positions
    expect(p!.locks!.map((l) => [l.name, l.held])).toEqual([['pressure', false]])
    expect(p!.locks![0]!.detail).toContain('0.4%')
  })

  it('says a pressure already above 1% must dip and cross again — the engine buys the crossing', async () => {
    const store = await seed([fill('Entry', 1, 15, NOW - 30 * MIN)], held)
    const [p] = (await buildOperations(store, ladder(0.2))).positions
    expect(p!.locks![0]!.detail).toContain('vuelva a cruzarlo')
  })

  it('says so when nobody counted the hour', async () => {
    const store = await seed([fill('Entry', 1, 15, NOW - 30 * MIN)], held)
    const [p] = (await buildOperations(store, ladder(null))).positions
    expect(p!.locks![0]!.detail).toContain('sin conteo')
  })

  it('has nothing to wait on once all six are bought', async () => {
    const six = ['Entry', 'DCA-1', 'DCA-2', 'DCA-3', 'DCA-4', 'DCA-5'].map((id, i) => fill(id, 1 - i * 0.06, 15, NOW - (30 - i) * MIN))
    const store = await seed(six, held)
    const [p] = (await buildOperations(store, ladder(0))).positions
    expect(p!.locks).toBeNull()
  })
})
