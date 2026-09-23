import { describe, it, expect } from 'vitest'
import { JupiterTokens } from './jupiter-tokens.js'
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

