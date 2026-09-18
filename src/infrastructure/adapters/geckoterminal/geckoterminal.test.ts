import { describe, it, expect } from 'vitest'
import { GeckoTerminal, GECKOTERMINAL_BASE, FIFTEEN_MINUTES, ONE_HOUR, barSizeMs } from './geckoterminal.js'
import { stubHttp } from '../../http.js'
/** * How many lists `discoverPools` sweeps. * * Named so a test can say "two pages per list" instead of a number that breaks * every time the breadth changes — which it did the day `pools` gained a * volume and a transaction-count ordering. */const LISTS = 5

const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9'
const url = `${GECKOTERMINAL_BASE}/networks/solana/pools/${POOL}/ohlcv/hour`

/** Newest first, seconds — exactly as the live API returns it. */
const body = (rows: number[][]) => ({ data: { attributes: { ohlcv_list: rows } } })
const live = body([
  [1789347600, 2.7273e-6, 2.7431e-6, 2.6935e-6, 2.7168e-6, 18655.63],
  [1789344000, 2.7000e-6, 2.7300e-6, 2.6900e-6, 2.7273e-6, 12000.0],
  [1789340400, 2.6800e-6, 2.7100e-6, 2.6700e-6, 2.7000e-6, 9000.0],
])

describe('GeckoTerminal — candles', () => {
  it('reverses to oldest-first and converts seconds to milliseconds', async () => {
    const gt = new GeckoTerminal(stubHttp({ [url]: { body: live } }))
    const candles = await gt.candles('solana', POOL)
    expect(candles.time).toEqual([1789340400_000, 1789344000_000, 1789347600_000])
    expect(candles.open[0]).toBeCloseTo(2.68e-6, 12)
    expect(candles.close.at(-1)).toBeCloseTo(2.7168e-6, 12)
    expect(candles.volume).toEqual([9000, 12000, 18655.63])
  })

  it('drops the bar that is still being BUILT, because a signal may not read one', async () => {
    // GeckoTerminal's newest row is the CURRENT bar, still accumulating. It is
    // not a candle yet: its close is wherever the price happens to be at the
    // moment of the request, and it will be something else fifteen minutes
    // later. Reading it as closed is what constraint 7 forbids.
    //
    // Measured in production: the engine sized BinanceTown's entry against
    // 0.0013161 while that bar was mid-pump, and the bar ENDED at 0.00100069.
    // A $15 order bought $11.44 — the order was decided at a price that never
    // existed at any close.
    const nowMs = 1789347600_000 + 40 * 60_000 // 40 minutes into the 1H bar
    const gt = new GeckoTerminal(stubHttp({ [url]: { body: live } }), undefined, undefined, { now: () => nowMs })
    const candles = await gt.candles('solana', POOL)
    expect(candles.time).toEqual([1789340400_000, 1789344000_000])
  })

  it('keeps the newest bar once its window has ENDED', async () => {
    const nowMs = 1789347600_000 + 60 * 60_000
    const gt = new GeckoTerminal(stubHttp({ [url]: { body: live } }), undefined, undefined, { now: () => nowMs })
    expect((await gt.candles('solana', POOL)).time).toHaveLength(3)
  })

  it('measures the window against the bar size it ASKED for, not a default', async () => {
    // The same timestamp is a closed 15m bar and an open 1H one.
    const fifteenUrl = `${GECKOTERMINAL_BASE}/networks/solana/pools/${POOL}/ohlcv/minute`
    const nowMs = 1789347600_000 + 20 * 60_000
    const gt = new GeckoTerminal(stubHttp({ [fifteenUrl]: { body: live } }), undefined, undefined, { now: () => nowMs })
    expect((await gt.candles('solana', POOL, FIFTEEN_MINUTES)).time).toHaveLength(3)
  })

  it('drops candles with no price rather than poisoning every indicator', async () => {
    const broken = body([[1789347600, 1, 1, 1, 1, 5], [1789344000, 0, 0, 0, 0, 0], [1789340400, 2, 2, 2, 2, 5]])
    const gt = new GeckoTerminal(stubHttp({ [url]: { body: broken } }))
    const candles = await gt.candles('solana', POOL)
    expect(candles.time).toHaveLength(2)
  })

  it('passes limit and before_timestamp, and waits on the throttle', async () => {
    const http = stubHttp({ [url]: { body: live } })
    let waits = 0
    const gt = new GeckoTerminal(http, { wait: async () => { waits++ } })
    await gt.candles('solana', POOL, ONE_HOUR, 500, 1789340400)
    expect(http.calls[0]).toContain('limit=500')
    expect(http.calls[0]).toContain('before_timestamp=1789340400')
    expect(waits).toBe(1)
  })

  it('returns empty candles for an empty response, and throws on HTTP errors', async () => {
    const empty = new GeckoTerminal(stubHttp({ [url]: { body: body([]) } }))
    expect((await empty.candles('solana', POOL)).time).toEqual([])
    const down = new GeckoTerminal(stubHttp({ [url]: { status: 500, body: {} } }))
    await expect(down.candles('solana', POOL)).rejects.toMatchObject({ name: 'HttpError', status: 500 })
  })

  it('retries a 429 with doubling backoff, then succeeds', async () => {
    let calls = 0
    const http = async () => {
      calls++
      return calls < 3 ? { status: 429, json: async () => ({}) } : { status: 200, json: async () => live }
    }
    const sleeps: number[] = []
    const gt = new GeckoTerminal(http, undefined, undefined, { backoffMs: 4_000, sleep: async (ms) => { sleeps.push(ms) } })
    expect((await gt.candles('solana', POOL)).time).toHaveLength(3)
    expect(sleeps).toEqual([4_000, 8_000])
  })

  it('gives up once the wait budget is spent, so a scan does not hang forever', async () => {
    const sleeps: number[] = []
    const gt = new GeckoTerminal(stubHttp({ [url]: { status: 429, body: {} } }), undefined, undefined,
      { waitBudgetMs: 3_000, backoffMs: 1_000, sleep: async (ms) => { sleeps.push(ms) } })
    await expect(gt.candles('solana', POOL)).rejects.toMatchObject({ status: 429 })
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(3_000)
  })
})

describe('GeckoTerminal — history paging', () => {
  it('pages backwards until it has enough bars for EMA-200 and friends', async () => {
    const page1 = body(Array.from({ length: 3 }, (_, i) => [2000 - i * 3600, 1, 1, 1, 1, 1]))
    const page2 = body(Array.from({ length: 3 }, (_, i) => [2000 - 3 * 3600 - i * 3600, 1, 1, 1, 1, 1]))
    let call = 0
    const http = Object.assign(
      async () => {
        call++
        return { status: 200, json: async () => (call === 1 ? page1 : call === 2 ? page2 : body([])) }
      },
      { calls: [] as string[] },
    )
    const gt = new GeckoTerminal(http)
    const candles = await gt.history('solana', POOL, 5)
    expect(candles.time).toHaveLength(6)
    // Oldest first, strictly increasing.
    expect([...candles.time].sort((a, b) => a - b)).toEqual(candles.time)
  })

  it('stops when the pool has no more history', async () => {
    const gt = new GeckoTerminal(stubHttp({ [url]: { body: live } }))
    const candles = await gt.history('solana', POOL, 10_000)
    expect(candles.time.length).toBeGreaterThan(0)
  })
})

describe('GeckoTerminal — a universe that works on any chain', () => {
  const poolsUrl = `${GECKOTERMINAL_BASE}/networks/bsc`
  const pools = (entries: [string, string][]) => ({
    data: entries.map(([token, pool]) => ({
      attributes: { address: pool, name: `${token} / USDT` },
      relationships: { base_token: { data: { id: `bsc_${token}` } } },
    })),
  })

  it('strips the network prefix from the base token id', async () => {
    const gt = new GeckoTerminal(stubHttp({ [poolsUrl]: { body: pools([['0xabc', 'poolA']]) } }))
    expect(await gt.discoverPools('bsc', 1)).toEqual([{ tokenAddress: '0xabc', poolAddress: 'poolA' }])
  })

  it('deduplicates a token that appears in several lists, keeping the first pool', async () => {
    const gt = new GeckoTerminal(stubHttp({ [poolsUrl]: { body: pools([['0xabc', 'poolA'], ['0xabc', 'poolB'], ['0xdef', 'poolC']]) } }))
    const found = await gt.discoverPools('bsc', 1)
    expect(found).toHaveLength(2)
    expect(found[0]).toEqual({ tokenAddress: '0xabc', poolAddress: 'poolA' })
  })

  it('stops paging on an empty page instead of asking forever', async () => {
    let calls = 0
    const http = async () => {
      calls++
      return { status: 200, json: async () => (calls === 1 ? pools([['0xabc', 'poolA']]) : { data: [] }) }
    }
    const gt = new GeckoTerminal(http)
    await gt.discoverPools('bsc', 5)
    // One page of data and one empty page per list, and then it moves on: the
    // count is TWO PER LIST, not the five pages it was allowed to ask for.
    //
    // Asserted as a ratio rather than a number, because the number moved the
    // day a fourth and fifth list were added — and what this test is about is
    // that an empty page ends a list, not how many lists there are.
    const perList = calls / LISTS
    expect(perList).toBeLessThanOrEqual(2)
    expect(calls).toBeLessThan(5 * LISTS)
  })

  it('a failing list does not lose what the others found', async () => {
    let calls = 0
    const http = async () => {
      calls++
      return calls === 1 ? { status: 500, json: async () => ({}) } : { status: 200, json: async () => pools([['0xdef', 'poolC']]) }
    }
    const gt = new GeckoTerminal(http, undefined, undefined, { waitBudgetMs: 0 })
    expect(await gt.discoverPools('bsc', 1)).toEqual([{ tokenAddress: '0xdef', poolAddress: 'poolC' }])
  })

  it('asks for the newest pools too, not only what is trending and what is big', async () => {
    // The doc comment on `discoverPools` has claimed 'trending, top by
    // liquidity, and NEWEST' since it was written. The list was
    // ['trending_pools', 'pools'] — two of the three. Every remaining source
    // ranks by popularity NOW, so nothing in the universe was there because it
    // was new; the user asked for newer and older, and only one end was wired.
    const seen: string[] = []
    const gt = new GeckoTerminal(async (url) => {
      seen.push(url)
      return { status: 200, json: async () => ({ data: [] }) }
    })
    await gt.discoverPools('bsc', 1)
    expect(seen.some((url) => url.includes('/new_pools'))).toBe(true)
  })

  it('works the same on solana', async () => {
    const solUrl = `${GECKOTERMINAL_BASE}/networks/solana`
    const gt = new GeckoTerminal(stubHttp({ [solUrl]: { body: pools([['Mint1', 'PoolX']]) } }))
    expect(await gt.discoverPools('solana', 1)).toEqual([{ tokenAddress: 'Mint1', poolAddress: 'PoolX' }])
  })
})

describe('GeckoTerminal — bar sizes', () => {
  const url15 = `${GECKOTERMINAL_BASE}/networks/solana/pools/${POOL}/ohlcv/minute`

  it('sends the aggregate for 15-minute bars', async () => {
    const http = stubHttp({ [url15]: { body: live } })
    await new GeckoTerminal(http).candles('solana', POOL, FIFTEEN_MINUTES)
    expect(http.calls[0]).toContain('/ohlcv/minute?')
    expect(http.calls[0]).toContain('aggregate=15')
  })

  it('sends no aggregate for hourly bars', async () => {
    const http = stubHttp({ [url]: { body: live } })
    await new GeckoTerminal(http).candles('solana', POOL, ONE_HOUR)
    expect(http.calls[0]).toContain('/ohlcv/hour?')
    expect(http.calls[0]).not.toContain('aggregate')
  })

  it('knows how long a bar is — 250 bars is 10 days at 1H and 2.6 at 15m', () => {
    expect(barSizeMs(ONE_HOUR)).toBe(3_600_000)
    expect(barSizeMs(FIFTEEN_MINUTES)).toBe(900_000)
    expect((250 * barSizeMs(ONE_HOUR)) / 86_400_000).toBeCloseTo(10.4, 1)
    expect((250 * barSizeMs(FIFTEEN_MINUTES)) / 86_400_000).toBeCloseTo(2.6, 1)
  })
})

describe('GeckoTerminal — a budget of TIME, not a count of tries', () => {
  // The operator's rule: do not put a fixed number on it. Wait until the data
  // arrives and stop the instant it does — sometimes three seconds, sometimes
  // forty — and give up only after a MAXIMUM of sixty seconds with nothing.
  //
  // A retry count prices the wrong thing. Three tries is cheap against a
  // provider that answers and ruinous against one that does not, and the number
  // that actually matters — how long a scan takes — is never stated anywhere.
  // A deadline states it, and the average of the real waits is then a
  // measurement rather than an artefact of the cap.
  const sleepsUntil = async (failures: number, options: Record<string, unknown> = {}) => {
    let calls = 0
    const sleeps: number[] = []
    const gt = new GeckoTerminal(
      async () => {
        calls++
        return calls <= failures ? { status: 429, json: async () => ({}) } : { status: 200, json: async () => live }
      },
      undefined, undefined,
      { ...options, sleep: async (ms: number) => { sleeps.push(ms) } },
    )
    await gt.candles('solana', POOL).catch(() => undefined)
    return sleeps
  }

  it('costs nothing when the answer is there', async () => {
    expect(await sleepsUntil(0)).toEqual([])
  })

  it('stops the moment it HAS the data, however long that took', async () => {
    // One 429 then success: it paid one wait and left. It did not keep going
    // to fill a budget, because the budget is a ceiling and not a quota.
    expect(await sleepsUntil(1)).toHaveLength(1)
  })

  it('spends up to sixty seconds on one that never answers, and not a second more', async () => {
    const total = (await sleepsUntil(Infinity)).reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(60_000)
    expect(total).toBeGreaterThan(55_000)
  })

  it('uses the whole budget rather than stopping short of it', async () => {
    // A doubling backoff that refuses to start a wait it cannot finish leaves
    // half the budget unspent — and the unspent half is exactly where a slow
    // provider would have answered.
    const sleeps = await sleepsUntil(Infinity)
    expect(sleeps.length).toBeGreaterThan(4)
  })

  it('takes a smaller budget when one is given', async () => {
    const total = (await sleepsUntil(Infinity, { waitBudgetMs: 10_000 })).reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(10_000)
  })
})

describe('GeckoTerminal — discovery has nothing to wait for', () => {
  // The rule is not "discovery matters less". It is the sell probe's own
  // distinction, applied where it belongs: a failure that would be read as a
  // VERDICT deserves patience, a failure that says nothing and has a fallback
  // does not.
  //
  //   a sell quote fails  → honeypot unknown → a good token thrown out  → wait
  //   a pool page fails   → a few tokens fewer, and the stale list stands → go on
  //
  // `CachedDiscovery` already falls back to the previous list precisely because
  // an old universe beats no universe. So there is nothing here a wait could
  // buy — and paying the 60-second budget thirty times per chain bought nine
  // minutes of a log that printed nothing at all.
  it('moves straight on from a refused page instead of backing off', async () => {
    const sleeps: number[] = []
    const gt = new GeckoTerminal(stubHttp({ [`${GECKOTERMINAL_BASE}/networks/bsc`]: { status: 429, body: {} } }),
      undefined, undefined, { sleep: async (ms) => { sleeps.push(ms) } })

    expect(await gt.discoverPools('bsc', 2)).toEqual([])
    expect(sleeps).toEqual([])
  })

  it('keeps what the other lists DID return', async () => {
    // One list refusing must not cost the others their pages: the same rule
    // `latestScansByChain` exists for, one level down.
    let calls = 0
    const http = async () => {
      calls++
      return calls <= 2
        ? { status: 429, json: async () => ({}) }
        : { status: 200, json: async () => ({ data: [{ attributes: { address: 'poolA' }, relationships: { base_token: { data: { id: 'bsc_0xabc' } } } }] }) }
    }
    const gt = new GeckoTerminal(http, undefined, undefined, { sleep: async () => {} })
    expect(await gt.discoverPools('bsc', 1)).toEqual([{ tokenAddress: '0xabc', poolAddress: 'poolA' }])
  })
})

describe('GeckoTerminal — market data for the pools DexScreener cannot see', () => {
  // Measured, and it is why the book was starving: of the addresses
  // GeckoTerminal discovers, DexScreener can price only 65% — 46 of 132 in one
  // sweep are simply not in its index, too new or too small. Jupiter's
  // addresses price at 97%, so the loss is specific to the pools.
  //
  // And the data was in our hands the whole time. Every pool response carries
  // `base_token_price_usd`, `reserve_in_usd`, `volume_usd`, the price changes
  // and the transaction counts by window — the complete market snapshot — and
  // the scanner threw it away and then asked a provider that had never heard
  // of the token.
  //
  // It cannot come from the discovery CACHE, which stands for six hours and
  // whose market half would be six hours stale. `pools/multi` takes up to
  // thirty pool addresses in one call, so the ones DexScreener missed cost two
  // requests rather than forty-six.

  const pool = (address: string, over: Record<string, unknown> = {}) => ({
    id: `solana_${address}`,
    attributes: {
      address,
      base_token_price_usd: '0.0125',
      reserve_in_usd: '48200.5',
      fdv_usd: '990000',
      pool_created_at: '2026-09-10T12:00:00Z',
      volume_usd: { h1: '4500.25', h6: '26000', h24: '98000' },
      price_change_percentage: { h1: '3.2', h6: '-1.5', h24: '12.8' },
      transactions: { h1: { buys: 41, sells: 22 }, h24: { buys: 900, sells: 700 } },
      ...over,
    },
    relationships: { base_token: { data: { id: `solana_TOKEN-${address}` } } },
  })

  const url = (pools: string) => `${GECKOTERMINAL_BASE}/networks/solana/pools/multi/${pools}`

  it('reads a pool into the same shape the scanner uses everywhere else', async () => {
    const gecko = new GeckoTerminal(stubHttp({ [url('P1')]: { body: { data: [pool('P1')] } } }))
    const [market] = await gecko.poolMarkets('solana', ['P1'])

    expect(market!.address).toBe('TOKEN-P1')
    expect(market!.pairAddress).toBe('P1')
    expect(market!.priceUsd).toBeCloseTo(0.0125, 9)
    expect(market!.liquidityUsd).toBeCloseTo(48_200.5, 6)
    expect(market!.fdvUsd).toBeCloseTo(990_000, 6)
    expect(market!.volumeUsd).toEqual({ h1: 4_500.25, h6: 26_000, h24: 98_000 })
    expect(market!.priceChangePct).toEqual({ h1: 3.2, h6: -1.5, h24: 12.8 })
    expect(market!.txns.h1).toEqual({ buys: 41, sells: 22 })
    expect(market!.pairCreatedAt).toBe(Date.parse('2026-09-10T12:00:00Z'))
  })

  it('asks for thirty at a time, because that is the endpoint ceiling', async () => {
    const asked: string[] = []
    const http = async (target: string) => {
      asked.push(target)
      return stubHttp({ [`${GECKOTERMINAL_BASE}/networks/solana/pools/multi/`]: { body: { data: [] } } })(target)
    }
    await new GeckoTerminal(http).poolMarkets('solana', Array.from({ length: 65 }, (_, i) => `P${i}`))
    expect(asked).toHaveLength(3)
  })

  it('drops a pool with no price or no reserve rather than inventing one', async () => {
    // The same rule DexScreener's mapping follows. A pool nobody can price is
    // not a cheap token, it is an unanswered question, and the gates fail
    // closed on those for a reason.
    const http = stubHttp({
      [url('P1,P2')]: { body: { data: [pool('P1', { base_token_price_usd: null }), pool('P2', { reserve_in_usd: null })] } },
    })
    expect(await new GeckoTerminal(http).poolMarkets('solana', ['P1', 'P2'])).toEqual([])
  })

  it('never throws into the scan — a bad minute costs the fallback, not the cycle', async () => {
    const http = stubHttp({ [url('P1')]: { status: 500, body: {} } })
    expect(await new GeckoTerminal(http).poolMarkets('solana', ['P1'])).toEqual([])
  })
})

describe('GeckoTerminal — breadth is the only lever left', () => {
  // Ten pages is the free tier's hard ceiling: page eleven answers 401 on
  // every list, measured. So depth is exhausted and the only thing that still
  // widens the universe is asking the same endpoint a DIFFERENT question.
  //
  // `pools` accepts a sort, and the orderings are not the same set. Measured
  // over one sweep: 125 unique from the three popularity lists, 204 from all
  // five. The transaction-count ordering adds the most of the 79 new, which is
  // the shape of it — trending and volume both concentrate on the same large
  // pools, while "most traded" reaches ones that are busy without being big.
  //
  // This test exists because a mutation that DELETED both sorted lists killed
  // nothing: they were wired and unproved, which is the third time in one
  // night that the wiring was the part nobody tested.

  const swept = async () => {
    const asked: string[] = []
    const http = async (target: string) => {
      asked.push(target)
      return { status: 200, json: async () => ({ data: [] }) }
    }
    await new GeckoTerminal(http).discoverPools('solana', 1)
    return asked
  }

  it('asks the popularity lists', async () => {
    const asked = await swept()
    expect(asked.some((t) => t.includes('trending_pools'))).toBe(true)
    expect(asked.some((t) => t.includes('new_pools'))).toBe(true)
  })

  it('asks `pools` by VOLUME and by TRANSACTION COUNT as well', async () => {
    const asked = await swept()
    expect(asked.some((t) => t.includes('sort=h24_volume_usd_desc'))).toBe(true)
    expect(asked.some((t) => t.includes('sort=h24_tx_count_desc'))).toBe(true)
  })

  it('still asks `pools` unsorted, which is a third set again', async () => {
    const asked = await swept()
    expect(asked.some((t) => /\/pools\?page=\d+$/.test(t))).toBe(true)
  })

  it('sweeps every list, so breadth is what the count reflects', async () => {
    expect(await swept()).toHaveLength(LISTS)
  })
})
