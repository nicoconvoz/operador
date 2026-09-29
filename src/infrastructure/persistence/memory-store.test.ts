import { describe, it, expect } from 'vitest'
import { MemoryStore } from './memory-store.js'
import { type RememberedToken } from '../../domain/persistence/store.js'
import { initialState } from '../../domain/strategy/state.js'
import { startDeathWatch } from '../../domain/risk/death-exit.js'


describe('the permanent registry — the memory the providers do not have', () => {
  // The operator's idea, and it answers the constraint the whole scanner ran
  // into: the free providers cap discovery at about 570 a sweep and no
  // threshold widens that. Ten pages is GeckoTerminal's ceiling, Jupiter's
  // lists cap at 100 each, DexScreener's boosts are paid promotions.
  //
  // The only lever left is TIME. A registry accumulates what every sweep
  // found, so a week of scans knows far more than any one of them — and his
  // instruction about it was one line: *esto ojo nunca hay que borrarlo.*

  const row = (contract: string, over: Partial<RememberedToken> = {}): RememberedToken => ({
    contract, token: contract.toUpperCase(), pool: `pool-${contract}`,
    price: 0.01, volume24h: 50_000, liquidity: 120_000, marketCap: 900_000,
    txns: 300, lastUpdate: 1_000, ...over,
  })

  it('remembers a token and gives it back', async () => {
    const store = new MemoryStore()
    await store.rememberTokens([row('aaa')])
    expect(await store.knownTokens(10)).toEqual([row('aaa')])
  })

  it('updates what it already knows instead of duplicating it', async () => {
    const store = new MemoryStore()
    await store.rememberTokens([row('aaa', { price: 1, lastUpdate: 1_000 })])
    await store.rememberTokens([row('aaa', { price: 2, lastUpdate: 2_000 })])
    const known = await store.knownTokens(10)
    expect(known).toHaveLength(1)
    expect(known[0]!.price).toBe(2)
    expect(known[0]!.lastUpdate).toBe(2_000)
  })

  it('returns the ones that were MOVING first', async () => {
    // Not arbitrary order and not insertion order: a bounded read costs one
    // DexScreener call per thirty rows, so the first thirty had better be the
    // thirty worth re-pricing.
    const store = new MemoryStore()
    await store.rememberTokens([
      row('quiet', { volume24h: 1_000 }),
      row('busy', { volume24h: 900_000 }),
      row('middling', { volume24h: 40_000 }),
    ])
    expect((await store.knownTokens(10)).map((t) => t.contract)).toEqual(['busy', 'middling', 'quiet'])
  })

  it('honours the limit, because reading it whole is what it exists to avoid', async () => {
    const store = new MemoryStore()
    await store.rememberTokens(Array.from({ length: 50 }, (_, i) => row(`t${i}`, { volume24h: i })))
    expect(await store.knownTokens(5)).toHaveLength(5)
  })

  it('puts a token with no known volume last rather than dropping it', async () => {
    // An unmeasured volume is not a zero one. It goes to the back of the queue
    // and stays in the registry, because the registry's whole job is to
    // remember what the providers have forgotten.
    const store = new MemoryStore()
    await store.rememberTokens([row('unknown', { volume24h: null }), row('known', { volume24h: 5 })])
    expect((await store.knownTokens(10)).map((t) => t.contract)).toEqual(['known', 'unknown'])
  })
})

describe('MemoryStore — the break-even ratchet', () => {
  // The same rule as the SQL one, because the tests run on this store and a
  // reference implementation that is looser than production proves nothing.
  it('a later save cannot un-arm a position', async () => {
    const store = new MemoryStore()
    const base = {
      id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
      cascade: initialState(), deathWatch: startDeathWatch(1, 0),
      quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
      capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
    }
    await store.savePosition({ ...base, breakEvenArmed: true })
    await store.savePosition({ ...base, lastBarTime: 1 })
    const [loaded] = await store.loadPositions()
    expect(loaded!.breakEvenArmed).toBe(true)
    expect(loaded!.lastBarTime).toBe(1)
  })

  it('keeps the FIRST score a position was given — a later save cannot move the baseline', async () => {
    // *Cuando el puntaje cae 5 puntos, SL* — measured from the score at entry,
    // so the baseline is written once and every stale snapshot after it that
    // carries a different one, or none, leaves it where it was.
    const store = new MemoryStore()
    const base = {
      id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
      cascade: initialState(), deathWatch: startDeathWatch(1, 0),
      quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
      capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
    }
    await store.savePosition(base)
    await store.savePosition({ ...base, entryScore: 93.2 })
    await store.savePosition({ ...base, entryScore: 65.9 })
    await store.savePosition({ ...base, lastBarTime: 1 })
    const [loaded] = await store.loadPositions()
    expect(loaded!.entryScore).toBe(93.2)
  })

  it('keeps the FIRST DCA scale a position was given — a stale snapshot without one never erases it', async () => {
    // Exactly as the SQL keeps it: COALESCE, the first non-null value stays.
    const store = new MemoryStore()
    const base = {
      id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
      cascade: initialState(), deathWatch: startDeathWatch(1, 0),
      quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
      capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
    }
    await store.savePosition(base)
    expect((await store.loadPositions())[0]!.dcaScale).toBeNull()
    await store.savePosition({ ...base, dcaScale: 0.52 })
    await store.savePosition({ ...base, dcaScale: 1.64 })
    await store.savePosition({ ...base, lastBarTime: 1, dcaScale: null })
    await store.savePosition({ ...base, lastBarTime: 2 })
    const [loaded] = await store.loadPositions()
    expect(loaded!.dcaScale).toBe(0.52)
    expect(loaded!.lastBarTime).toBe(2)
  })
})

describe('MemoryStore — the real-time DCA scale: the NEWER reading wins', () => {
  // *Tiempo real.* The sweep writes the scale it measured from the last hour
  // onto the position, for the screen; every other step of the cycle writes
  // the whole row back from a snapshot read before that. Exactly as the SQL
  // keeps it: the pair with the newer `dcaScaleNowAt` wins.
  const base = {
    id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
    cascade: initialState(), deathWatch: startDeathWatch(1, 0),
    quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
    capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  }
  const reading = async (store: MemoryStore) => {
    const [loaded] = await store.loadPositions()
    return [loaded!.dcaScaleNow, loaded!.dcaScaleNowAt]
  }

  it('is absent until a sweep measures it', async () => {
    const store = new MemoryStore()
    await store.savePosition(base)
    expect(await reading(store)).toEqual([null, null])
  })

  it('takes a newer reading over an older one', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, dcaScaleNow: 2.1, dcaScaleNowAt: 1_000 })
    await store.savePosition({ ...base, dcaScaleNow: 0.7, dcaScaleNowAt: 2_000 })
    expect(await reading(store)).toEqual([0.7, 2_000])
  })

  it('never lets a stale snapshot overwrite a fresher reading — older, or none at all', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, dcaScaleNow: 2.1, dcaScaleNowAt: 2_000 })
    await store.savePosition({ ...base, dcaScaleNow: 0.7, dcaScaleNowAt: 1_000 })
    await store.savePosition({ ...base, lastBarTime: 1, dcaScaleNow: null, dcaScaleNowAt: null })
    await store.savePosition({ ...base, lastBarTime: 2 })
    expect(await reading(store)).toEqual([2.1, 2_000])
    expect((await store.loadPositions())[0]!.lastBarTime).toBe(2)
  })

  it('keeps the pair whole: a scale with no time, or a time with no scale, is not a reading', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, dcaScaleNow: 2.1, dcaScaleNowAt: 1_000 })
    await store.savePosition({ ...base, dcaScaleNow: 0.7, dcaScaleNowAt: null })
    await store.savePosition({ ...base, dcaScaleNow: null, dcaScaleNowAt: 5_000 })
    expect(await reading(store)).toEqual([2.1, 1_000])
  })
})

describe('MemoryStore — the gain lock ratchets, and survives a stale snapshot', () => {
  // *Con cada aumento de 20%, aumentar el break-even 10%.* A floor that only
  // rises while the same holding lives — and every step of the cycle writes
  // the whole row from a snapshot taken before the sweep raised it. The same
  // rule as the SQL one, because a reference looser than production proves
  // nothing.
  const base = {
    id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
    cascade: initialState(), deathWatch: startDeathWatch(1, 0),
    quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
    capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  }
  const lockAfter = async (...writes: Parameters<MemoryStore['savePosition']>[0][]) => {
    const store = new MemoryStore()
    for (const write of writes) await store.savePosition(write)
    return (await store.loadPositions())[0]!.gainLock ?? null
  }

  it('keeps a lock when a stale snapshot without one is written over it', async () => {
    expect(await lockAfter({ ...base, gainLock: { pct: 10, since: 5 } }, { ...base, lastBarTime: 1 })).toEqual({ pct: 10, since: 5 })
  })

  it('never lowers the floor of the same holding', async () => {
    expect(await lockAfter({ ...base, gainLock: { pct: 20, since: 5 } }, { ...base, gainLock: { pct: 10, since: 5 } })).toEqual({ pct: 20, since: 5 })
    expect(await lockAfter({ ...base, gainLock: { pct: 10, since: 5 } }, { ...base, gainLock: { pct: 30, since: 5 } })).toEqual({ pct: 30, since: 5 })
  })

  it('takes a newer holding’s lock whole, and refuses an older one', async () => {
    expect(await lockAfter({ ...base, gainLock: { pct: 40, since: 5 } }, { ...base, gainLock: { pct: 10, since: 9 } })).toEqual({ pct: 10, since: 9 })
    expect(await lockAfter({ ...base, gainLock: { pct: 10, since: 9 } }, { ...base, gainLock: { pct: 40, since: 5 } })).toEqual({ pct: 10, since: 9 })
  })

  it('stores none when none was ever written', async () => {
    expect(await lockAfter(base, { ...base, lastBarTime: 1 })).toBeNull()
  })
})

describe('MemoryStore — the day log folds each reading into its day', () => {
  // The same merge the SQL upsert runs, because the tests run on this store and
  // a reference looser than production proves nothing.
  const T = Date.parse('2026-09-28T12:00:00Z')

  it('the first sample of a day sets every field', async () => {
    const store = new MemoryStore()
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 10, at: T })
    expect(await store.dailyPnl(10)).toEqual([
      { day: '2026-09-28', openUsd: 10, closeUsd: 10, minUsd: 10, maxUsd: 10, firstAt: T, lastAt: T, samples: 1 },
    ])
  })

  it('later samples keep the open and first time, move the close, widen the range and count', async () => {
    const store = new MemoryStore()
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 10, at: T })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 3, at: T + 60_000 })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 14, at: T + 120_000 })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 9, at: T + 180_000 })
    expect(await store.dailyPnl(10)).toEqual([
      { day: '2026-09-28', openUsd: 10, closeUsd: 9, minUsd: 3, maxUsd: 14, firstAt: T, lastAt: T + 180_000, samples: 4 },
    ])
  })

  it('a sample on a new day starts a new row, and the newest day comes first', async () => {
    const store = new MemoryStore()
    await store.recordDailyPnl({ day: '2026-09-27', netUsd: 5, at: T - 86_400_000 })
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 8, at: T })
    const days = await store.dailyPnl(10)
    expect(days.map((d) => d.day)).toEqual(['2026-09-28', '2026-09-27'])
    expect(days[0]).toMatchObject({ openUsd: 8, closeUsd: 8, samples: 1 })
    expect(days[1]).toMatchObject({ openUsd: 5, closeUsd: 5, samples: 1 })
  })

  it('honours the limit, keeping the newest days', async () => {
    const store = new MemoryStore()
    for (let d = 1; d <= 5; d++) await store.recordDailyPnl({ day: `2026-09-0${d}`, netUsd: d, at: T + d })
    expect((await store.dailyPnl(2)).map((d) => d.day)).toEqual(['2026-09-05', '2026-09-04'])
  })

  it('hands back copies, so a caller cannot edit the log', async () => {
    const store = new MemoryStore()
    await store.recordDailyPnl({ day: '2026-09-28', netUsd: 10, at: T })
    const [row] = await store.dailyPnl(1)
    ;(row as { closeUsd: number }).closeUsd = 999
    expect((await store.dailyPnl(1))[0]!.closeUsd).toBe(10)
  })
})

describe('MemoryStore — the liquidity watch: the NEWER watch wins', () => {
  // *Siempre esperar la recuperación del 5% de liquidez a partir del mínimo.*
  // The sweep moves the watch — braked, its minimum, the bounce — and every
  // other step of the cycle writes the whole row back from a snapshot read
  // before that. Exactly as the SQL keeps it: the watch with the newer `at`.
  const base = {
    id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
    cascade: initialState(), deathWatch: startDeathWatch(1, 0),
    quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
    capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  }
  const watch = (at: number, braked: boolean) => ({ peakUsd: 100_000, minUsd: 90_000, braked, holdingSince: 1, at })
  const stored = async (store: MemoryStore) => (await store.loadPositions())[0]!.liquidityWatch

  it('is absent until a sweep writes one', async () => {
    const store = new MemoryStore()
    await store.savePosition(base)
    expect(await stored(store)).toBeNull()
  })

  it('takes a newer watch over an older one', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, liquidityWatch: watch(1_000, false) })
    await store.savePosition({ ...base, liquidityWatch: watch(2_000, true) })
    expect(await stored(store)).toEqual(watch(2_000, true))
  })

  it('never lets a stale snapshot revert it — an older watch, or none at all', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, liquidityWatch: watch(2_000, true) })
    await store.savePosition({ ...base, liquidityWatch: watch(1_000, false) })
    await store.savePosition({ ...base, lastBarTime: 1, liquidityWatch: null })
    await store.savePosition({ ...base, lastBarTime: 2 })
    expect(await stored(store)).toEqual(watch(2_000, true))
    expect((await store.loadPositions())[0]!.lastBarTime).toBe(2)
  })
})

describe('MemoryStore — the price low: a stale snapshot never raises it', () => {
  // *Si el precio cae más de 80% y hay un rebote de 10%, nueva compra DCA.*
  // The rebound is measured from the lowest price the holding has seen, and
  // every step of the cycle writes the whole row back from a snapshot read
  // before the sweep moved that low. Exactly as the SQL keeps it: the same
  // holding keeps the LOWER price, a newer holding replaces it whole.
  const base = {
    id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
    cascade: initialState(), deathWatch: startDeathWatch(1, 0),
    quality: { liquidityUsd: 1, spreadPct: 0, slippagePct: 0, referenceUsd: 1, observedAt: 0 },
    capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
  }
  const low = (price: number, holdingSince = 1, at = 10) => ({ price, at, holdingSince })
  const stored = async (store: MemoryStore) => (await store.loadPositions())[0]!.priceLow

  it('is absent until a sweep writes one', async () => {
    const store = new MemoryStore()
    await store.savePosition(base)
    expect(await stored(store)).toBeNull()
  })

  it('takes a lower price for the same holding', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, priceLow: low(0.5) })
    await store.savePosition({ ...base, priceLow: low(0.15, 1, 20) })
    expect(await stored(store)).toEqual(low(0.15, 1, 20))
  })

  it('never lets a stale snapshot raise it — a higher low, or none at all', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, priceLow: low(0.15) })
    await store.savePosition({ ...base, priceLow: low(0.5, 1, 30) })
    await store.savePosition({ ...base, lastBarTime: 1, priceLow: null })
    await store.savePosition({ ...base, lastBarTime: 2 })
    expect(await stored(store)).toEqual(low(0.15))
    expect((await store.loadPositions())[0]!.lastBarTime).toBe(2)
  })

  it('takes a NEWER holding’s low whole, and never an older one’s', async () => {
    const store = new MemoryStore()
    await store.savePosition({ ...base, priceLow: low(0.15, 1) })
    await store.savePosition({ ...base, priceLow: low(0.9, 2) })
    expect(await stored(store)).toEqual(low(0.9, 2))
    await store.savePosition({ ...base, priceLow: low(0.01, 1) })
    expect(await stored(store)).toEqual(low(0.9, 2))
  })
})
