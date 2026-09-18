import { describe, it, expect } from 'vitest'
import { GeckoTerminal, GECKOTERMINAL_BASE, FIFTEEN_MINUTES, ONE_HOUR, barSizeMs } from './geckoterminal.js'
import { stubHttp } from '../../http.js'

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

  it('gives up after maxRetries so a scan does not hang forever', async () => {
    const sleeps: number[] = []
    const gt = new GeckoTerminal(stubHttp({ [url]: { status: 429, body: {} } }), undefined, undefined,
      { maxRetries: 2, backoffMs: 1_000, sleep: async (ms) => { sleeps.push(ms) } })
    await expect(gt.candles('solana', POOL)).rejects.toMatchObject({ status: 429 })
    expect(sleeps).toHaveLength(2)
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
    // page 1 has data, page 2 is empty and breaks — then the second list does the same.
    expect(calls).toBeLessThanOrEqual(4)
  })

  it('a failing list does not lose what the others found', async () => {
    let calls = 0
    const http = async () => {
      calls++
      return calls === 1 ? { status: 500, json: async () => ({}) } : { status: 200, json: async () => pools([['0xdef', 'poolC']]) }
    }
    const gt = new GeckoTerminal(http, undefined, undefined, { maxRetries: 0 })
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

describe('GeckoTerminal — historyBars asks for what the gate needs, not for a thousand rows', () => {
  it('requests only `enough` candles, because the answer is a threshold not a depth', async () => {
    // It downloaded a THOUSAND rows to produce one integer, and the gate only
    // ever asks "at least 250?". Four times the payload for a boolean, once per
    // examined token, against the provider that rate-limits hardest.
    const seen: string[] = []
    const gt = new GeckoTerminal(async (url) => {
      seen.push(url)
      return { status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [] } } }) }
    })
    await gt.historyBars('solana', 'Pool1', ONE_HOUR, 250)
    // 251, not 250: one of the rows is the bar still being built and gets
    // discarded, so a page of exactly `enough` can never COUNT to `enough`.
    // The economy this test exists for is untouched — the point was never the
    // exact number, it was not downloading a thousand rows for a boolean.
    expect(seen[0]).toContain('limit=251')
    expect(seen[0]).not.toContain('limit=1000')
  })

  it('saturates at what was asked for, which is all the gate can use', async () => {
    // "250 or more" is the only answer the threshold needs. Reporting the exact
    // depth would mean downloading it, which is the cost being removed.
    const rows = Array.from({ length: 250 }, (_, i) => [1_700_000_000 + i * 3600, 1, 2, 0.5, 1.5, 100])
    const gt = new GeckoTerminal(async () => ({ status: 200, json: async () => ({ data: { attributes: { ohlcv_list: rows } } }) }))
    expect(await gt.historyBars('solana', 'Pool1', ONE_HOUR, 250)).toBe(250)
  })

  it('still reports a SHORT count exactly, because that is what expires', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => [1_700_000_000 + i * 3600, 1, 2, 0.5, 1.5, 100])
    const gt = new GeckoTerminal(async () => ({ status: 200, json: async () => ({ data: { attributes: { ohlcv_list: rows } } }) }))
    expect(await gt.historyBars('solana', 'Pool1', ONE_HOUR, 250)).toBe(40)
  })
})

describe('GeckoTerminal — counting history when one row is always discarded', () => {
  // The gate asks a THRESHOLD, not a depth: "at least 100?" So the runtime asks
  // GeckoTerminal for exactly `minHistoryBars` rows and counts what comes back.
  //
  // Dropping the bar still being built then made that count unreachable BY
  // CONSTRUCTION: a hundred rows requested, the newest discarded, ninety-nine
  // returned — forever, for every pool on both chains. Measured in production
  // the morning after: **162 tokens rejected with "99 barras de historial <
  // 100"**, and a book of four positions where the day before it ran thirty.
  //
  // The adapter is what drops the row, so the adapter is what compensates.
  // Pushing this onto the caller puts the reason in a different file from the
  // cause, and the next caller gets it wrong again.
  const rows = (count: number, startSeconds: number) =>
    Array.from({ length: count }, (_, i) => [startSeconds - i * 3600, 1, 1, 1, 1, 10])

  it('still reaches the count it was asked for', async () => {
    const nowMs = 1_800_000_000_000
    const newest = nowMs / 1000 // the bar opening right now: still forming
    const http = stubHttp({ [url]: { body: body(rows(101, newest)) } })
    const gt = new GeckoTerminal(http, undefined, undefined, { now: () => nowMs })

    expect(await gt.historyBars('solana', POOL, ONE_HOUR, 100)).toBe(100)
  })

  it('asks for one MORE row than it needs to count', async () => {
    const http = stubHttp({ [url]: { body: body([]) } })
    const gt = new GeckoTerminal(http)
    await gt.historyBars('solana', POOL, ONE_HOUR, 100)
    expect(http.calls[0]).toContain('limit=101')
  })

  it('still reports a SHORT pool short, which is the whole point of the gate', async () => {
    const nowMs = 1_800_000_000_000
    const http = stubHttp({ [url]: { body: body(rows(40, nowMs / 1000)) } })
    const gt = new GeckoTerminal(http, undefined, undefined, { now: () => nowMs })

    expect(await gt.historyBars('solana', POOL, ONE_HOUR, 100)).toBe(39)
  })
})
