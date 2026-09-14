import { describe, it, expect } from 'vitest'
import { GeckoTerminal, GECKOTERMINAL_BASE } from './geckoterminal.js'
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
    await gt.candles('solana', POOL, 'hour', 500, 1789340400)
    expect(http.calls[0]).toContain('limit=500')
    expect(http.calls[0]).toContain('before_timestamp=1789340400')
    expect(waits).toBe(1)
  })

  it('returns empty candles for an empty response, and throws on HTTP errors', async () => {
    const empty = new GeckoTerminal(stubHttp({ [url]: { body: body([]) } }))
    expect((await empty.candles('solana', POOL)).time).toEqual([])
    const down = new GeckoTerminal(stubHttp({ [url]: { status: 429, body: {} } }))
    await expect(down.candles('solana', POOL)).rejects.toMatchObject({ name: 'HttpError', status: 429 })
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
