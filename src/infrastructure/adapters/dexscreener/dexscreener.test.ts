import { describe, it, expect } from 'vitest'
import { DexScreener, DEXSCREENER_BASE, type DexPair } from './dexscreener.js'
import { stubHttp } from '../../http.js'

/** Trimmed from a live response for BONK on Solana (Sept 2026). */
const bonkOrca: DexPair = {
  chainId: 'solana',
  dexId: 'orca',
  pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
  baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'Bonk' },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
  priceUsd: '0.000002723',
  liquidity: { usd: 273239.21, base: 77662572324, quote: 618.847 },
  fdv: 241976399,
  volume: { h24: 488686.15, h6: 104969.84, h1: 9028.52, m5: 1676.07 },
  priceChange: { m5: 0.37, h1: 0.41, h6: -1.72, h24: -2.16 },
  txns: { m5: { buys: 38, sells: 20 }, h1: { buys: 221, sells: 195 }, h6: { buys: 1573, sells: 1422 }, h24: { buys: 5289, sells: 7223 } },
  pairCreatedAt: 1671980424000,
}

const bonkShallow: DexPair = { ...bonkOrca, dexId: 'raydium', pairAddress: 'shallow', liquidity: { usd: 12_000, base: 1, quote: 1 } }
const bonkNoPrice: DexPair = { ...bonkOrca, pairAddress: 'nopx', priceUsd: null }
const bonkOnBase: DexPair = { ...bonkOrca, chainId: 'base', pairAddress: 'base-pair' }

const NOW = 1_800_000_000_000

describe('DexScreener adapter — mapping', () => {
  const dex = new DexScreener(stubHttp({}), () => NOW)

  it('maps a live pair object into the market half of a TokenSnapshot', () => {
    expect(dex.toMarketSnapshot('solana', bonkOrca)).toEqual({
      chain: 'solana',
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      symbol: 'Bonk',
      pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
      dexId: 'orca',
      dexLabels: [],
      observedAt: NOW,
      priceUsd: 0.000002723,
      liquidityUsd: 273239.21,
      fdvUsd: 241976399,
      volumeUsd: { h1: 9028.52, h6: 104969.84, h24: 488686.15 },
      // m5 is the freshest window any free provider reports, and it was
      // arriving in every response and being discarded.
      priceChangePct: { m5: 0.37, h1: 0.41, h6: -1.72, h24: -2.16 },
      txns: { h1: { buys: 221, sells: 195 }, h24: { buys: 5289, sells: 7223 } },
      pairCreatedAt: 1671980424000,
    })
  })

  it('picks the deepest pool per token and ignores other chains and priceless pairs', () => {
    const snapshots = dex.toMarketSnapshots('solana', [bonkShallow, bonkNoPrice, bonkOnBase, bonkOrca])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.pairAddress).toBe(bonkOrca.pairAddress)
  })

  it('tolerates missing optional fields with nulls and zeros', () => {
    const sparse: DexPair = { ...bonkOrca, priceChange: null, fdv: null, pairCreatedAt: null, volume: { h24: 10 }, txns: {} }
    const s = dex.toMarketSnapshot('solana', sparse)
    expect(s.priceChangePct).toEqual({ m5: null, h1: null, h6: null, h24: null })
    expect(s.fdvUsd).toBeNull()
    expect(s.pairCreatedAt).toBeNull()
    expect(s.volumeUsd).toEqual({ h1: 0, h6: 0, h24: 10 })
    expect(s.txns.h1).toEqual({ buys: 0, sells: 0 })
  })
})

describe('DexScreener adapter — endpoints', () => {
  it('fetches pairs by token, tokens in batch, and search', async () => {
    const http = stubHttp({
      [`${DEXSCREENER_BASE}/token-pairs/v1/solana/${bonkOrca.baseToken.address}`]: { body: [bonkOrca, bonkShallow] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/`]: { body: [bonkOrca] },
      [`${DEXSCREENER_BASE}/latest/dex/search?q=`]: { body: { pairs: [bonkOrca, bonkOnBase] } },
    })
    const dex = new DexScreener(http, () => NOW)
    expect(await dex.tokenPairs('solana', bonkOrca.baseToken.address)).toHaveLength(2)
    expect(await dex.tokens('solana', [bonkOrca.baseToken.address])).toHaveLength(1)
    expect(await dex.search('bonk')).toHaveLength(2)
  })

  it('discovers the universe from profiles and boosts, filtered to the chain, deduplicated', async () => {
    const http = stubHttp({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'A' }, { chainId: 'base', tokenAddress: 'X' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'B' }, { chainId: 'solana', tokenAddress: 'A' }] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [{ chainId: 'bsc', tokenAddress: 'Y' }, { chainId: 'solana', tokenAddress: 'C' }] },
    })
    const dex = new DexScreener(http, () => NOW)
    expect(await dex.discoverTokens('solana')).toEqual(['A', 'B', 'C'])
    expect(await dex.discoverTokens('bsc')).toEqual(['Y'])
  })

  it('refuses more than 30 addresses per batch — the API limit', async () => {
    const dex = new DexScreener(stubHttp({}), () => NOW)
    await expect(dex.tokens('solana', Array.from({ length: 31 }, (_, i) => `t${i}`))).rejects.toThrow(/max 30/)
  })

  it('surfaces non-200 responses as HttpError', async () => {
    const dex = new DexScreener(stubHttp({ [DEXSCREENER_BASE]: { status: 429, body: {} } }), () => NOW)
    await expect(dex.search('x')).rejects.toMatchObject({ name: 'HttpError', status: 429 })
  })
})
