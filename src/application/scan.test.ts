import { describe, it, expect } from 'vitest'
import { scanOnce, type ScanConfig, type ScanDeps } from './scan.js'
import { DexScreener, DEXSCREENER_BASE, type DexPair } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus, GOPLUS_BASE, type GoPlusSolanaToken } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter, JUPITER_LITE_BASE } from '../infrastructure/adapters/jupiter/jupiter.js'
import { stubHttp } from '../infrastructure/http.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { type SecurityReport } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const pair = (address: string, over: Partial<DexPair> = {}): DexPair => ({
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: `pair-${address}`,
  baseToken: { address, name: address, symbol: address.toUpperCase() },
  quoteToken: { address: 'So111', symbol: 'SOL' },
  priceUsd: '0.01',
  liquidity: { usd: 150_000, base: 1, quote: 1 },
  fdv: 1_000_000,
  volume: { h1: 8_000, h6: 40_000, h24: 120_000 },
  priceChange: { h1: 2, h6: -3, h24: 5 },
  txns: { h1: { buys: 40, sells: 30 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * DAY,
  ...over,
})

const safe: GoPlusSolanaToken = {
  mintable: { status: '0' }, freezable: { status: '0' }, closable: { status: '0' },
  balance_mutable_authority: { status: '0' }, transfer_fee: {}, non_transferable: '0',
  holders: [{ account: 'a', percent: '0.1', is_locked: 0 }],
  lp_holders: [{ percent: '1', is_locked: 1 }],
}
const minty: GoPlusSolanaToken = { ...safe, mintable: { status: '1', authority: [{ address: 'dev' }] } }

const goodQuote = { inputMint: 'x', inAmount: '1', outputMint: 'y', outAmount: '99000000', otherAmountThreshold: '0', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.004', routePlan: [] }

const config: ScanConfig = {
  chain: 'solana',
  ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 5, minScore: 0 },
  referenceUsd: 100,
  spreadPct: 0.5,
  maxTokens: 50,
}

const build = (table: Parameters<typeof stubHttp>[0], decimals: Record<string, number | null> = {}) => {
  const http = stubHttp(table)
  const deps: ScanDeps = {
    dex: new DexScreener(http, () => NOW),
    goplus: new GoPlus(http, { minIntervalMs: 0, maxRetries: 0 }),
    sellProbe: new Jupiter(http),
    decimals: { decimals: async (_c, a) => (a in decimals ? decimals[a]! : 6) },
    now: () => NOW,
  }
  return { deps, http }
}

describe('scanOnce — discover → market → security → probe → rank', () => {
  it('ranks a clean token and rejects a mintable one, with the sell probe deciding honeypot on Solana', async () => {
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }, { chainId: 'solana', tokenAddress: 'bad' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good,bad`]: { body: [pair('good'), pair('bad')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=bad`]: { body: { code: 1, message: 'ok', result: { bad: minty } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=bad`]: { body: goodQuote },
    })
    const out = await scanOnce(deps, config)

    expect(out.errors).toEqual([])
    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['good'])
    expect(out.rejected.map((r) => [r.snapshot.address, r.gates.failures[0]!.gate])).toEqual([['bad', 'mintAuthority']])

    const good = out.candidates[0]!
    expect(good.snapshot.security.honeypot).toBe(false)
    expect(good.marketQuality).toEqual({ liquidityUsd: 150_000, spreadPct: 0.5, slippagePct: 0.4, referenceUsd: 100, observedAt: NOW })
    // Reference sell sized from price and decimals: $100 / $0.01 = 10,000 tokens × 10^6
    expect(http.calls.find((u) => u.includes('inputMint=good'))).toContain('amount=10000000000')
  })

  it('a failing sell route marks the token a honeypot and the gates reject it', async () => {
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'trap' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/trap`]: { body: [pair('trap')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=trap`]: { body: { code: 1, message: 'ok', result: { trap: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=trap`]: { status: 400, body: { error: 'Could not find any route' } },
    })
    const out = await scanOnce(deps, config)
    expect(out.candidates).toEqual([])
    expect(out.rejected[0]!.gates.failures.map((f) => f.gate)).toContain('honeypot')
    expect(out.snapshots[0]!.security.honeypot).toBe(true)
  })

  it('isolates errors: a token whose security call fails is recorded and fails closed, the rest proceed', async () => {
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }, { chainId: 'solana', tokenAddress: 'flaky' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good,flaky`]: { body: [pair('good'), pair('flaky')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=flaky`]: { status: 503, body: {} },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=`]: { body: goodQuote },
    })
    const out = await scanOnce(deps, config)
    expect(out.errors).toEqual([{ address: 'flaky', stage: 'security', error: expect.stringContaining('503') }])
    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['good'])
    expect(out.rejected.map((r) => r.snapshot.address)).toEqual(['flaky'])
    expect(out.rejected[0]!.gates.failures.every((f) => f.reason === 'unknown' || f.gate === 'honeypot')).toBe(true)
  })

  it('falls back to the impact model when decimals are unknown and no quote can be sized', async () => {
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'nodec' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/nodec`]: { body: [pair('nodec')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=nodec`]: { body: { code: 1, message: 'ok', result: { nodec: safe } } },
    }, { nodec: null })
    const out = await scanOnce(deps, config)
    expect(http.calls.some((u) => u.includes('jup.ag'))).toBe(false)
    // No probe → honeypot unknown → fails closed.
    expect(out.rejected[0]!.gates.failures.map((f) => `${f.gate}:${f.reason}`)).toContain('honeypot:unknown')
    // Quality still computed from the model: $100 against $150k → 0.133% impact.
    expect(out.snapshots).toHaveLength(1)
  })

  it('respects maxTokens', async () => {
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: Array.from({ length: 5 }, (_, i) => ({ chainId: 'solana', tokenAddress: `t${i}` })) },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/t0,t1`]: { body: [] },
    })
    await scanOnce(deps, { ...config, maxTokens: 2 })
    expect(http.calls.some((u) => u.endsWith('/tokens/v1/solana/t0,t1'))).toBe(true)
    expect(http.calls.some((u) => u.includes('t2'))).toBe(false)
  })
})


describe('scanOnce — a bounded budget for the expensive checks', () => {
  // Three tokens that all clear the free gates, in an order that would punish
  // taking the first N: the liveliest is in the middle.
  const budgetRig = () =>
    build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: {
        body: [
          { chainId: 'solana', tokenAddress: 'dull' },
          { chainId: 'solana', tokenAddress: 'lively' },
          { chainId: 'solana', tokenAddress: 'quiet' },
        ],
      },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/dull,lively,quiet`]: {
        body: [
          pair('dull', { volume: { h1: 500, h6: 3_000, h24: 20_000 }, priceChange: { h1: 0, h6: 0, h24: 0 } }),
          pair('lively', {
            volume: { h1: 40_000, h6: 90_000, h24: 200_000 },
            priceChange: { h1: 9, h6: 4, h24: 22 },
            txns: { h1: { buys: 180, sells: 40 }, h24: { buys: 2_000, sells: 900 } },
          }),
          pair('quiet', { volume: { h1: 900, h6: 4_000, h24: 30_000 }, priceChange: { h1: 0, h6: 0, h24: 1 } }),
        ],
      },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=dull`]: { body: { code: 1, message: 'ok', result: { dull: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=lively`]: { body: { code: 1, message: 'ok', result: { lively: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=quiet`]: { body: { code: 1, message: 'ok', result: { quiet: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=`]: { body: goodQuote },
    })

  const securityCalls = (http: { calls: string[] }) =>
    http.calls.filter((url) => url.includes('token_security')).map((url) => url.split('contract_addresses=')[1]!)

  it('spends the budget on the most promising token, not on the first one it met', async () => {
    const { deps, http } = budgetRig()
    await scanOnce(deps, { ...config, maxSecurityChecks: 1 })

    // Discovery order is dull, lively, quiet. Taking the first would spend the
    // whole budget on the dullest token on the list.
    expect(securityCalls(http)).toEqual(['lively'])
  })

  it('still reports the tokens it could not afford to check, marked as unchecked', async () => {
    const { deps } = budgetRig()
    const out = await scanOnce(deps, { ...config, maxSecurityChecks: 1 })

    expect(out.snapshots).toHaveLength(3)
    const unchecked = out.snapshots.filter((s) => s.securityChecked === false).map((s) => s.address).sort()
    expect(unchecked).toEqual(['dull', 'quiet'])
    // Present on the screen, never tradeable: nothing unexamined is a candidate.
    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['lively'])
  })

  it('checks everything when no budget is given', async () => {
    const { deps, http } = budgetRig()
    await scanOnce(deps, config)
    expect(securityCalls(http).sort()).toEqual(['dull', 'lively', 'quiet'])
  })
})

describe('scanOnce — the budget rotates, so nothing waits forever', () => {
  const NOW_MS = NOW

  class Cache {
    readonly rows = new Map<string, { security: SecurityReport; slippagePct: number | null; measuredAt: number }>()
    async cachedSecurity(chain: string, address: string) {
      return this.rows.get(`${chain}:${address}`) ?? null
    }
    async recordSecurity(chain: string, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number) {
      this.rows.set(`${chain}:${address}`, { security, slippagePct, measuredAt })
    }
  }

  const threeTokens = (cache: Cache, now = NOW_MS) => {
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: {
        body: ['a', 'b', 'c'].map((t) => ({ chainId: 'solana', tokenAddress: t })),
      },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/a,b,c`]: { body: [pair('a'), pair('b'), pair('c')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=a`]: { body: { code: 1, message: 'ok', result: { a: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=b`]: { body: { code: 1, message: 'ok', result: { b: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=c`]: { body: { code: 1, message: 'ok', result: { c: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=`]: { body: goodQuote },
    })
    return { deps: { ...deps, securityCache: cache, now: () => now }, http }
  }

  const checked = (http: { calls: string[] }) =>
    http.calls.filter((u) => u.includes('token_security')).map((u) => u.split('contract_addresses=')[1]!).sort()

  it(`spends the next cycle's budget on tokens nobody has looked at yet`, async () => {
    const cache = new Cache()
    const first = threeTokens(cache)
    await scanOnce(first.deps, { ...config, maxSecurityChecks: 1 })
    const firstChecked = checked(first.http)
    expect(firstChecked).toHaveLength(1)

    // THE BUG THIS PINS: with a deterministic score order and no memory, every
    // cycle checked the same token and the rest stayed "sin revisar" forever.
    const second = threeTokens(cache)
    await scanOnce(second.deps, { ...config, maxSecurityChecks: 1 })
    expect(checked(second.http)).not.toEqual(firstChecked)
  })

  it('a token with a fresh report stays fully evaluated, at no network cost', async () => {
    const cache = new Cache()
    const first = threeTokens(cache)
    await scanOnce(first.deps, { ...config, maxSecurityChecks: 3 })
    expect(checked(first.http)).toEqual(['a', 'b', 'c'])

    const second = threeTokens(cache)
    const out = await scanOnce(second.deps, { ...config, maxSecurityChecks: 3 })
    expect(checked(second.http)).toEqual([])
    // Cached is EVALUATED, not pending: a report that still holds is an answer.
    expect(out.snapshots.filter((s) => s.securityChecked === false)).toHaveLength(0)
    expect(out.candidates.map((c) => c.snapshot.address).sort()).toEqual(['a', 'b', 'c'])
  })

  it('re-checks a report that has gone stale', async () => {
    const cache = new Cache()
    await scanOnce(threeTokens(cache).deps, { ...config, maxSecurityChecks: 3 })

    const later = threeTokens(cache, NOW_MS + 5 * 60 * 60 * 1000)
    await scanOnce(later.deps, { ...config, maxSecurityChecks: 3, securityTtlMs: 60 * 60 * 1000 })
    expect(checked(later.http)).toEqual(['a', 'b', 'c'])
  })
})
