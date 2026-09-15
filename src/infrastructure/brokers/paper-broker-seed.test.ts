import { describe, it, expect } from 'vitest'
import { PaperBroker } from './paper-broker.js'
import { type MarketQuality } from '../../domain/market/market-quality.js'
import { type PersistedFill } from '../../domain/persistence/store.js'
import { type Order } from '../../domain/strategy/state.js'

/**
 * The engine runs as a one-shot process: it wakes, advances one bar, writes
 * everything down and exits. A broker that keeps its position in memory is
 * therefore FLAT on every wake-up, and the strategy would never see the
 * position it opened fifteen minutes earlier.
 *
 * So the broker has to be rebuildable from the recorded fills. The property
 * that matters is a round trip: seed a fresh broker with what the first one
 * reported, and it must answer the same questions the same way.
 */

const QUALITY: MarketQuality = {
  liquidityUsd: 500_000,
  spreadPct: 0.3,
  slippagePct: 0.2,
  referenceUsd: 100,
  observedAt: 0,
}

const T = 1_800_000_000_000
const config = { gasUsdPerSwap: 0.05, initialCapital: 1_000, maxOpenEntries: 10, quality: () => QUALITY }

const entry = (id: string, usd: number, price: number): Order => ({
  kind: 'entry',
  id,
  level: 0,
  usd,
  qty: usd / price,
  comment: id,
})

const persist = (fills: ReturnType<PaperBroker['execute']>): PersistedFill[] =>
  fills.map((f) => ({
    positionId: 'pos-1',
    orderId: f.id,
    side: f.side,
    time: f.time,
    price: f.price,
    qty: f.qty,
    costUsd: f.commission,
    comment: f.comment,
    idempotencyKey: `pos-1:${f.time}:${f.id}`,
  }))

describe('PaperBroker.seed — the fills are the facts', () => {
  it('a fresh broker seeded from recorded fills reports the same position', () => {
    const live = new PaperBroker(config)
    const recorded = persist(live.execute([entry('Entry', 100, 0.01)], 0.01, T))
    recorded.push(...persist(live.execute([entry('DCA-1', 120, 0.009)], 0.009, T + 900_000)))

    const rebuilt = new PaperBroker(config)
    rebuilt.seed(recorded)

    expect(rebuilt.snapshot(0.011)).toEqual(live.snapshot(0.011))
    expect(rebuilt.equityCash).toBeCloseTo(live.equityCash, 9)
    expect(rebuilt.openTrades).toHaveLength(2)
  })

  it('a seeded broker knows it is flat after a close, and can open again', () => {
    const live = new PaperBroker(config)
    const recorded = persist(live.execute([entry('Entry', 100, 0.01)], 0.01, T))
    recorded.push(...persist(live.execute([{ kind: 'closeAll', comment: '🏁 Exit' }], 0.012, T + 900_000)))

    const rebuilt = new PaperBroker(config)
    rebuilt.seed(recorded)

    expect(rebuilt.snapshot(0.012).size).toBe(0)
    expect(rebuilt.equityCash).toBeCloseTo(live.equityCash, 9)
  })

  it('counts open entries against pyramiding, so a restart cannot reopen a full ladder', () => {
    const live = new PaperBroker({ ...config, maxOpenEntries: 2 })
    const recorded = persist(live.execute([entry('Entry', 50, 0.01), entry('DCA-1', 50, 0.01)], 0.01, T))

    const rebuilt = new PaperBroker({ ...config, maxOpenEntries: 2 })
    rebuilt.seed(recorded)
    rebuilt.execute([entry('DCA-2', 50, 0.01)], 0.01, T + 900_000)

    expect(rebuilt.openTrades).toHaveLength(2)
    expect(rebuilt.rejections.map((r) => r.reason)).toEqual(['pyramiding'])
  })

  it('seeding an empty history leaves the broker exactly as it started', () => {
    const broker = new PaperBroker(config)
    broker.seed([])
    expect(broker.snapshot(0.01)).toEqual({ size: 0, avgPrice: null, openProfit: 0 })
    expect(broker.equityCash).toBe(1_000)
  })

  it('reads fills in time order however they arrive — a store is not a queue', () => {
    const live = new PaperBroker(config)
    const recorded = persist(live.execute([entry('Entry', 100, 0.01)], 0.01, T))
    recorded.push(...persist(live.execute([entry('DCA-1', 120, 0.009)], 0.009, T + 900_000)))

    const shuffled = new PaperBroker(config)
    shuffled.seed([...recorded].reverse())

    expect(shuffled.snapshot(0.011)).toEqual(live.snapshot(0.011))
  })
})

// ── A deep ladder, rebuilt ──────────────────────────────────────────────────
//
// Every test above stops at two open entries, which is as far as production has
// ever got: the deepest thing ever seen live is DCA-1. But in production every
// cycle is a NEW PROCESS — decide, persist, die, rebuild from the fills, decide
// again — so the rebuild is the load-bearing step, and a ladder six levels deep
// exercises it in a way two entries do not.

describe('PaperBroker.seed — a ladder six levels deep', () => {
  /** Entry plus five DCAs, each 100 units, each a nickel lower. */
  const ladder = (broker: PaperBroker) => {
    const prices = [1, 0.95, 0.9, 0.85, 0.8, 0.75]
    const recorded = []
    for (const [level, price] of prices.entries()) {
      const id = level === 0 ? 'Entry' : `DCA-${level}`
      recorded.push(...persist(broker.execute([entry(id, 100 * price, price)], price, T + level * 900_000)))
    }
    return recorded
  }

  it('comes back with every rung, at the same average', () => {
    const live = new PaperBroker({ ...config, initialCapital: 10_000 })
    const recorded = ladder(live)

    const rebuilt = new PaperBroker({ ...config, initialCapital: 10_000 })
    rebuilt.seed(recorded)

    expect(rebuilt.openTrades).toHaveLength(6)
    expect(rebuilt.snapshot(0.9)).toEqual(live.snapshot(0.9))
    expect(rebuilt.equityCash).toBeCloseTo(live.equityCash, 9)

    // And the average is NOT the average of the trigger prices. The mid of
    // 1, .95, .9, .85, .8, .75 is 0.875; the basis comes out at 0.8792,
    // because every rung paid the venue on the way in and the ladder pays it
    // six times. The exit compares against THIS number, so a +2% target on a
    // six-deep ladder needs the price to travel nearly 2.5%.
    const nominal = (1 + 0.95 + 0.9 + 0.85 + 0.8 + 0.75) / 6
    expect(rebuilt.snapshot(0.9).avgPrice).toBeGreaterThan(nominal)
    expect(rebuilt.snapshot(0.9).avgPrice! / nominal - 1).toBeCloseTo(0.0048, 3)
  })

  it('closes all six rungs in one order, and the cash matches the live broker', () => {
    const live = new PaperBroker({ ...config, initialCapital: 10_000 })
    const recorded = ladder(live)

    const rebuilt = new PaperBroker({ ...config, initialCapital: 10_000 })
    rebuilt.seed(recorded)

    const liveFills = live.execute([{ kind: 'closeAll', comment: '🏁 Exit' }], 0.95, T + 10 * 900_000)
    const rebuiltFills = rebuilt.execute([{ kind: 'closeAll', comment: '🏁 Exit' }], 0.95, T + 10 * 900_000)

    // One fill per open entry, not one for the aggregate: the ledger has to
    // record which rung left, and gas is charged once for the whole close.
    expect(rebuiltFills).toHaveLength(6)
    expect(rebuiltFills.length).toBe(liveFills.length)
    expect(rebuilt.snapshot(0.95).size).toBe(0)
    expect(rebuilt.equityCash).toBeCloseTo(live.equityCash, 9)
  })

  it('rebuilds a ladder that is already at the pyramiding ceiling', () => {
    const live = new PaperBroker({ ...config, initialCapital: 10_000, maxOpenEntries: 10 })
    const recorded = []
    for (let level = 0; level < 10; level++) {
      const price = 1 - level * 0.05
      recorded.push(...persist(live.execute([entry(level === 0 ? 'Entry' : `DCA-${level}`, 100 * price, price)], price, T + level * 900_000)))
    }

    const rebuilt = new PaperBroker({ ...config, initialCapital: 10_000, maxOpenEntries: 10 })
    rebuilt.seed(recorded)
    rebuilt.execute([entry('DCA-10', 50, 0.5)], 0.5, T + 20 * 900_000)

    // The machine signals to 50; the venue fills ten. A restart must not be a
    // way to get an eleventh past the cap.
    expect(rebuilt.openTrades).toHaveLength(10)
    expect(rebuilt.rejections.map((r) => r.reason)).toEqual(['pyramiding'])
  })
})
