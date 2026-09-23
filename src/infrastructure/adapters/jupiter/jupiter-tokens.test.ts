import { describe, it, expect } from 'vitest'
import { JupiterTokens, jupiterMarket } from './jupiter-tokens.js'
import { JUPITER_LITE_BASE } from './jupiter.js'
import { stubHttp, type HttpGet } from '../../http.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'

/** Trimmed from the live tokens/v2 response for BONK (Sept 2026). */
const bonk = {
  id: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5, isVerified: true,
  organicScore: 84.2, holderCount: 1017056, liquidity: 1007195.75, mcap: 239068992.97,
}

const url = `${JUPITER_LITE_BASE}/tokens/v2/search?query=`

describe('JupiterTokens — decimals port', () => {
  it('returns decimals for an exact mint match', async () => {
    const tokens = new JupiterTokens(stubHttp({ [url]: { body: [bonk] } }))
    expect(await tokens.decimals('solana', BONK)).toBe(5)
  })

  it('ignores fuzzy matches that are not the mint asked for', async () => {
    const tokens = new JupiterTokens(stubHttp({ [url]: { body: [{ ...bonk, id: 'OtherMint' }] } }))
    expect(await tokens.decimals('solana', BONK)).toBeNull()
  })

  it('is null on other chains, on errors and on an unknown mint', async () => {
    expect(await new JupiterTokens(stubHttp({ [url]: { body: [bonk] } })).decimals('bsc', BONK)).toBeNull()
    expect(await new JupiterTokens(stubHttp({ [url]: { status: 503, body: {} } })).decimals('solana', BONK)).toBeNull()
    expect(await new JupiterTokens(stubHttp({ [url]: { body: [] } })).decimals('solana', BONK)).toBeNull()
  })

  it('caches per mint so a scan asks once', async () => {
    const http = stubHttp({ [url]: { body: [bonk] } })
    const tokens = new JupiterTokens(http)
    await tokens.decimals('solana', BONK)
    await tokens.decimals('solana', BONK)
    await tokens.info(BONK)
    expect(http.calls).toHaveLength(1)
  })
})

describe('JupiterTokens — discovery asks for everything the provider gives', () => {
  // It asked for 50 and the scanner called it with no argument, so half of
  // Jupiter's universe was being left on the table for no reason at all.
  //
  // ONE HUNDRED is the provider's own ceiling, measured rather than assumed:
  // asking for 200 or 500 returns 100 either way. And Jupiter is the LARGEST
  // of the three discovery sources — one sweep measured Jupiter 195 tokens,
  // GeckoTerminal 145 and DexScreener 44, with 128 that only Jupiter has.
  // The biggest one was running at half.

  const asked: string[] = []
  const spy = stubHttp({
    [`${JUPITER_LITE_BASE}/tokens/v2/`]: { body: [bonk] },
  })
  const recording = async (target: string) => {
    asked.push(target)
    return spy(target)
  }

  it('asks each list for the provider ceiling', async () => {
    asked.length = 0
    await new JupiterTokens(recording).discover()
    expect(asked).toHaveLength(3)
    for (const target of asked) expect(target).toContain('limit=100')
  })

  it('still lets a caller ask for less', async () => {
    asked.length = 0
    await new JupiterTokens(recording).discover(10)
    for (const target of asked) expect(target).toContain('limit=10')
  })

  it('sweeps all three lists, not just the trending one', async () => {
    asked.length = 0
    await new JupiterTokens(recording).discover()
    expect(asked.some((t) => t.includes('toptrending'))).toBe(true)
    expect(asked.some((t) => t.includes('toptraded'))).toBe(true)
    expect(asked.some((t) => t.includes('toporganicscore'))).toBe(true)
  })
})

describe('JupiterTokens — a hundred mints per request', () => {
  // *Hagamos todo con Jupiter.* The search endpoint takes a comma-separated
  // list and answered a hundred mints in 0.49s, measured — the scan was asking
  // one at a time. The universe's own lists already arrive with everything; this
  // is for the rest: the book, DexScreener's boosts, the registry.
  const recorder = (answer: (mints: string[]) => unknown[] = (mints) => mints.map((id) => ({ ...bonk, id }))) => {
    const asked: string[][] = []
    const http: HttpGet = async (u) => {
      const mints = decodeURIComponent(u.slice(url.length)).split(',')
      asked.push(mints)
      return { status: 200, json: async () => answer(mints) }
    }
    return { http, asked }
  }

  it('asks in batches of a hundred', async () => {
    const { http, asked } = recorder()
    await new JupiterTokens(http).prefetch(Array.from({ length: 250 }, (_, i) => `M${i}`))
    expect(asked.map((a) => a.length)).toEqual([100, 100, 50])
  })

  it('answers from the batch without asking again', async () => {
    const { http, asked } = recorder()
    const tokens = new JupiterTokens(http)
    await tokens.prefetch(['A', 'B'])
    expect(await tokens.decimals('solana', 'A')).toBe(5)
    expect(await tokens.security('solana', 'B')).not.toBeUndefined()
    expect(asked).toHaveLength(1)
  })

  it('does not re-ask for what the universe lists already brought', async () => {
    const { http, asked } = recorder()
    const tokens = new JupiterTokens(http)
    await tokens.prefetch(['A'])
    await tokens.prefetch(['A', 'B'])
    expect(asked).toEqual([['A'], ['B']])
  })

  it('re-asks once an answer is older than a minute', async () => {
    // Holder concentration is a safety gate and the door re-asks it before
    // money moves. An answer that never expired would approve on an old one.
    let clock = 0
    const { http, asked } = recorder()
    const tokens = new JupiterTokens(http, undefined, undefined, { now: () => clock, maxAgeMs: 60_000 })
    await tokens.prefetch(['A'])
    clock += 61_000
    await tokens.security('solana', 'A')
    expect(asked).toHaveLength(2)
  })
})

describe('jupiterMarket — the market half, from the same source as the candles', () => {
  // The candles moved to Jupiter, per MINT. The market half has to follow, for
  // two reasons measured on the same 183 tokens:
  //
  // - The death watch compares LIVE liquidity against the liquidity recorded
  //   at entry. Jupiter sums every pool of a mint and DexScreener reports one
  //   pair — p10 0.48x, p90 5.11x between them — so a ratio across the two
  //   providers would detect nothing.
  // - The idle gate asks whether anyone trades the token, and the candles now
  //   answer for the mint. A pair-level count beside mint-level bars measures
  //   "is it alive" with one ruler and "how did it move" with another.
  //
  // Prices agree: median ratio 0.9999, 80% within ±2%.

  const live = {
    id: 'Mint', name: 'Bonk', symbol: 'Bonk', decimals: 5,
    usdPrice: 0.0000038, liquidity: 5_376_761, fdv: 300_000_000,
    firstPool: { id: 'Pool1', createdAt: '2022-12-25T00:00:00.000Z' },
    stats5m: { priceChange: 0.4, buyVolume: 1_000, sellVolume: 500, numBuys: 30, numSells: 20 },
    stats1h: { priceChange: 2.8, buyVolume: 179_967, sellVolume: 152_568, numBuys: 4_617, numSells: 4_797 },
    stats6h: { priceChange: -1.1, buyVolume: 900_000, sellVolume: 850_000, numBuys: 20_000, numSells: 19_000 },
    stats24h: { priceChange: 5.5, buyVolume: 3_000_000, sellVolume: 2_900_000, numBuys: 80_000, numSells: 79_000 },
  }

  it('maps every field the gates and the death watch read', () => {
    const m = jupiterMarket(live, 1_000)!
    expect(m).toMatchObject({
      chain: 'solana', address: 'Mint', symbol: 'Bonk', observedAt: 1_000,
      priceUsd: 0.0000038, liquidityUsd: 5_376_761, fdvUsd: 300_000_000,
      volumeUsd: { h1: 179_967 + 152_568, h6: 1_750_000, h24: 5_900_000 },
      priceChangePct: { m5: 0.4, h1: 2.8, h6: -1.1, h24: 5.5 },
      txns: { h1: { buys: 4_617, sells: 4_797 }, h24: { buys: 80_000, sells: 79_000 } },
      pairCreatedAt: Date.parse('2022-12-25T00:00:00.000Z'),
    })
  })

  it('carries the LIQUIDITY change of the last hour — the only measured liquidity growth there is', () => {
    // *Crecimiento de liquidez de la última hora, más del 0%.* The component
    // compared against a previous look nobody ever passed, so every token read
    // a neutral 50%. Jupiter reports the change itself.
    expect(jupiterMarket({ ...live, stats1h: { ...live.stats1h, liquidityChange: 8 } }, 1)!.liquidityChangePct).toEqual({ h1: 8 })
    expect(jupiterMarket(live, 1)!.liquidityChangePct).toEqual({ h1: null })
  })

  it('has no market for a token with no price', () => {
    // Not a zero: a token nobody prices is not a token anyone can trade.
    const { usdPrice: _unpriced, ...noPrice } = live
    expect(jupiterMarket(noPrice, 1)).toBeNull()
    expect(jupiterMarket({ ...live, usdPrice: 0 }, 1)).toBeNull()
  })

  it('reports an unreported window as UNKNOWN, never as flat', () => {
    // A change of zero is a measurement; a missing window is silence. Reading
    // silence as flat would let the momentum rule decide on a number nobody
    // measured.
    const { stats5m: _gone, ...noFiveMinutes } = live
    expect(jupiterMarket(noFiveMinutes, 1)!.priceChangePct.m5).toBeNull()
  })

  it('answers many mints in one request and reuses what it already has', async () => {
    const asked: string[] = []
    const http: HttpGet = async (u) => {
      asked.push(u)
      const mints = decodeURIComponent(u.slice(url.length)).split(',')
      return { status: 200, json: async () => mints.map((id) => ({ ...live, id })) }
    }
    const tokens = new JupiterTokens(http)
    const markets = await tokens.markets('solana', ['A', 'B', 'C'])
    expect(markets.map((m) => m.address)).toEqual(['A', 'B', 'C'])
    expect(asked).toHaveLength(1)
    expect(await tokens.markets('bsc', ['A'])).toEqual([])
  })
})
describe('JupiterTokens — LIVE prices are never served from the cache', () => {
  // The cache stands a minute, which is right for a scan and wrong for the
  // stop: it re-prices the book every thirty seconds, and a price read from a
  // minute-old cache would cut a position on where it WAS. Hours of this
  // project went into making the stop look sooner; a stale price undoes all of it.
  it('refetches when asked to refresh, even what it just fetched', async () => {
    let requests = 0
    const http: HttpGet = async (u) => {
      requests++
      const mints = decodeURIComponent(u.slice(url.length)).split(',')
      return { status: 200, json: async () => mints.map((id) => ({ ...bonk, id, usdPrice: 1 })) }
    }
    const tokens = new JupiterTokens(http)
    await tokens.markets('solana', ['A'])
    await tokens.markets('solana', ['A'])
    expect(requests).toBe(1)
    await tokens.markets('solana', ['A'], { refresh: true })
    expect(requests).toBe(2)
  })
})
