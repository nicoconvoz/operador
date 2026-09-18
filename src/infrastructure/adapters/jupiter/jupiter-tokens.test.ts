import { describe, it, expect } from 'vitest'
import { JupiterTokens } from './jupiter-tokens.js'
import { JUPITER_LITE_BASE } from './jupiter.js'
import { stubHttp } from '../../http.js'

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
