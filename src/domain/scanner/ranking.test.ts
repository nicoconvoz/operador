import { describe, it, expect } from 'vitest'
import { rankUniverse, tokenKey, type RankingPolicy } from './ranking.js'
import { DEFAULT_GATE_POLICY } from './gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from './opportunity.js'
import { type TokenSnapshot } from './snapshot.js'
import { type MarketQuality } from '../market/market-quality.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const token = (address: string, over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  chain: 'solana',
  address,
  symbol: address,
  pairAddress: `pair-${address}`,
  observedAt: NOW,
  priceUsd: 0.01,
  // 4x turnover. The live median across 252 tokens is 3.5x; this fixture sat
  // at 0.8x, which the turnover gate now reads as a pool standing still.
  liquidityUsd: 30_000,
  fdvUsd: null,
  volumeUsd: { h1: 5_000, h6: 30_000, h24: 120_000 },
  priceChangePct: { h1: 2, h6: -4, h24: 6 },
  txns: { h1: { buys: 40, sells: 30 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 10 * 24 * HOUR,
  security: {
    honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
    hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
  },
  ...over,
})

const quality = (s: TokenSnapshot): MarketQuality => ({
  liquidityUsd: s.liquidityUsd, spreadPct: 0.5, slippagePct: 0.3, referenceUsd: 100, observedAt: s.observedAt,
})

const policy: RankingPolicy = {
  gates: DEFAULT_GATE_POLICY,
  opportunity: DEFAULT_OPPORTUNITY_POLICY,
  watchSlots: 3,
  minScore: 10,
}

describe('ranking — gates first, then score, then slots', () => {
  it('rejects unsafe tokens with their reasons and never scores them', () => {
    const universe = [token('safe'), token('rug', { security: { ...token('rug').security, honeypot: true } })]
    const { candidates, rejected } = rankUniverse(universe, new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['safe'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.gates.failures[0]!.gate).toBe('honeypot')
  })

  it('orders candidates by score, highest first', () => {
    const quiet = token('quiet', { volumeUsd: { h1: 1_000, h6: 10_000, h24: 120_000 } })
    const hot = token('hot', { volumeUsd: { h1: 20_000, h6: 60_000, h24: 120_000 }, txns: { h1: { buys: 70, sells: 20 }, h24: { buys: 900, sells: 850 } } })
    const { candidates } = rankUniverse([quiet, hot], new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['hot', 'quiet'])
  })

  it('cuts the list to the watch slots', () => {
    const universe = Array.from({ length: 10 }, (_, i) => token(`t${i}`))
    expect(rankUniverse(universe, new Map(), quality, policy).candidates).toHaveLength(policy.watchSlots)
  })

  it('drops safe-but-boring tokens below the minimum score without calling them rejected', () => {
    // Live enough to clear the gates, dull enough to score under the minimum —
    // which is the distinction this test exists to make. No hourly expansion,
    // no price movement, plenty of pool turnover.
    const boring = token('boring', {
      volumeUsd: { h1: 0, h6: 1_000, h24: 60_000 },
      txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 50, sells: 50 } },
      priceChangePct: { h1: 0, h6: 0, h24: 0 },
    })
    const strict = { ...policy, minScore: 30 }
    const { candidates, rejected } = rankUniverse([boring], new Map(), quality, strict)
    expect(candidates).toEqual([])
    expect(rejected).toEqual([])
  })

  it('uses the previous snapshot of the same token for liquidity growth', () => {
    const before = token('grow', { liquidityUsd: 100_000, volumeUsd: { h1: 20_000, h6: 120_000, h24: 480_000 } })
    const now = token('grow', { liquidityUsd: 160_000, volumeUsd: { h1: 20_000, h6: 120_000, h24: 480_000 } })
    const previous = new Map([[tokenKey(before), before]])
    const { candidates } = rankUniverse([now], previous, quality, policy)
    expect(candidates[0]!.opportunity.components.liquidityGrowth).toBe(1)
  })

  it('every candidate carries the market quality the executor will re-validate', () => {
    const { candidates } = rankUniverse([token('a')], new Map(), quality, policy)
    expect(candidates[0]!.marketQuality).toEqual(quality(token('a')))
  })

  it('ties break deterministically by address', () => {
    const { candidates } = rankUniverse([token('b'), token('a')], new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['a', 'b'])
  })
})
