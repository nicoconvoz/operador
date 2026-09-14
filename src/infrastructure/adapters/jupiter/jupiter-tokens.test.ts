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
