import { describe, it, expect } from 'vitest'
import { scanOnce, type ScanConfig, type ScanDeps } from './scan.js'
import { DexScreener, DEXSCREENER_BASE, type DexPair } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus, GOPLUS_BASE, type GoPlusSolanaToken } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter, JUPITER_LITE_BASE } from '../infrastructure/adapters/jupiter/jupiter.js'
import { stubHttp } from '../infrastructure/http.js'
import { evaluateGates, DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
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
  // 3.5x turnover — the live median across 252 tokens. These fixtures mean
  // "a healthy token", and sat at 0.8x because nothing measured activity
  // against the pool.
  volume: { h1: 35_000, h6: 180_000, h24: 525_000 },
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


/**
 * A candle series whose newest TRADED bar is `hoursAgo` old.
 *
 * `poolCandles` replaced three separate downloads, so a test that wants to say
 * "this pool last traded five hours ago" now says it the way the engine reads
 * it: out of the bars themselves. `volume: 0` is a bar nobody traded, which is
 * what `hoursSinceLastTrade` walks back past.
 */
const seriesAged = (hoursAgo: number | null, bars = 300) => ({
  time: Array.from({ length: bars }, (_, i) => NOW - (bars - 1 - i) * 900_000),
  open: Array.from({ length: bars }, () => 1),
  high: Array.from({ length: bars }, () => 1),
  low: Array.from({ length: bars }, () => 1),
  close: Array.from({ length: bars }, () => 0.01),
  // null means "the feed answered and nobody ever traded" — every bar empty.
  volume: Array.from({ length: bars }, (_, i) =>
    hoursAgo === null ? 0 : NOW - (bars - 1 - i) * 900_000 <= NOW - hoursAgo * 3_600_000 ? 100 : 0),
})

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
          pair('dull', { volume: { h1: 500, h6: 3_000, h24: 200_000 }, priceChange: { h1: 0, h6: 0, h24: 0 } }),
          pair('lively', {
            volume: { h1: 40_000, h6: 90_000, h24: 200_000 },
            priceChange: { h1: 9, h6: 4, h24: 22 },
            txns: { h1: { buys: 180, sells: 40 }, h24: { buys: 2_000, sells: 900 } },
          }),
          pair('quiet', { volume: { h1: 900, h6: 4_000, h24: 300_000 }, priceChange: { h1: 0, h6: 0, h24: 1 } }),
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

// ── A token holding our money is never a candidate ──────────────────────────
//
// Reported live: many HELD positions showing "el escáner no la encontró en
// este ciclo — los datos son los de la posición". The universe comes from
// discovery — Jupiter's lists, GeckoTerminal's trending pools, DexScreener's
// boosts — and every one of those is a list of what is POPULAR NOW. A token
// bought six hours ago that has since stopped trending simply falls out, and
// then gets cut twice more: by `maxTokens`, and by a security budget shared
// out on opportunity score.
//
// That is the priority exactly inverted. A token holding our money is not
// competing for attention; it has already won. Its security status is the one
// we most need current, because it is the one a rug would cost us.

describe('scanOnce — what we already hold comes first', () => {
  const table = {
    [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'trending' }] },
    [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/ours,trending`]: { body: [pair('ours'), pair('trending')] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/trending,ours`]: { body: [pair('trending'), pair('ours')] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/ours`]: { body: [pair('ours')] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/trending`]: { body: [pair('trending')] },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=ours`]: { body: { code: 1, message: 'ok', result: { ours: safe } } },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=trending`]: { body: { code: 1, message: 'ok', result: { trending: safe } } },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=ours`]: { body: goodQuote },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=trending`]: { body: goodQuote },
  }

  it('scans a held token no discovery source mentioned', async () => {
    const { deps } = build(table)

    const out = await scanOnce(deps, { ...config, held: ['ours'] })

    // Nothing put 'ours' in the universe. Holding it is what puts it there.
    expect(out.snapshots.map((s) => s.address).sort()).toEqual(['ours', 'trending'])
  })

  it('survives the maxTokens cut, however long the trending list is', async () => {
    const { deps } = build(table)

    // One slot, and discovery got there first. The cut must not be what
    // decides whether our own position is looked at.
    const out = await scanOnce(deps, { ...config, maxTokens: 1, held: ['ours'] })

    expect(out.snapshots.map((s) => s.address)).toContain('ours')
  })

  it('takes the security budget ahead of any candidate', async () => {
    const { deps } = build(table)

    // Budget of one, and 'trending' outranks 'ours' on nothing in particular —
    // it does not matter. A held token is not ranked against candidates.
    const out = await scanOnce(deps, { ...config, maxSecurityChecks: 1, held: ['ours'] })

    const ours = out.snapshots.find((s) => s.address === 'ours')
    expect(ours?.securityChecked).toBe(true)
  })

  it('does not double-count one we hold that discovery also found', async () => {
    const { deps } = build(table)

    const out = await scanOnce(deps, { ...config, held: ['trending'] })

    expect(out.snapshots.filter((s) => s.address === 'trending')).toHaveLength(1)
  })

  it('changes nothing when we hold nothing', async () => {
    const { deps } = build(table)
    const out = await scanOnce(deps, { ...config, held: [] })
    expect(out.snapshots.map((s) => s.address)).toEqual(['trending'])
  })
})

describe('scanOnce — a cap that bites says so', () => {
  it('reports how many the cap dropped, instead of reporting only what it kept', async () => {
    // A silent truncation reads exactly like a universe that small. Sweeping
    // deeper on a cold start buys nothing if the cut then throws the tail away
    // without a word, and from a log that only ever prints what survived those
    // two cases are indistinguishable.
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [
        { chainId: 'solana', tokenAddress: 'a' },
        { chainId: 'solana', tokenAddress: 'b' },
        { chainId: 'solana', tokenAddress: 'c' },
      ] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/a`]: { body: [pair('a')] },
    })
    const progress: { stage: string; dropped?: number }[] = []
    await scanOnce({ ...deps, onProgress: (p) => progress.push(p as never) }, { ...config, maxTokens: 1 })

    expect(progress.find((p) => p.stage === 'universe')?.dropped).toBe(2)
  })
})

describe('scanOnce — a token the engine cannot watch is not a candidate', () => {
  it('moves a token with stale bars out of the shortlist and says why', async () => {
    // Measured live, the same pool asked of both providers at once: GeckoTerminal
    // reported 0 trades in the last hour where DexScreener reported 35, and its
    // 24h volume was half. The engine was admitting on one feed and condemning
    // on the other — and since the strategy is bar-driven, a pool with no bars
    // cannot be traded at all: the entry waits forever for an open that never
    // comes, the ladder freezes at three hours, and the capital is stuck.
    //
    // The refusal belongs here as well as at the door. A candidate the engine
    // can never act on is not a candidate; leaving it on the shortlist means
    // choosing it, refusing it, and choosing it again every cycle.
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good`]: { body: [pair('good')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
    })

    const out = await scanOnce({ ...deps, poolCandles: async () => seriesAged(5) }, { ...config, maxBarAgeHours: 1 })

    expect(out.candidates).toEqual([])
    expect(out.rejected.map((r) => r.gates.failures[0]!.gate)).toContain('staleBars')
  })

  it('writes the verdict onto the SNAPSHOT, so the screen and the engine agree', async () => {
    // The dashboard re-evaluates the gates on the stored snapshot. A verdict
    // kept only inside the ranking meant the screen drew a token as eligible
    // while the engine refused it — eighteen of twenty-seven Solana tokens were
    // in exactly that state, and the operator counted six reds where there
    // should have been twenty-four.
    //
    // Two implementations of "is this token tradeable" will always drift; the
    // fix is one measurement both of them read.
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good`]: { body: [pair('good')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
    })

    const out = await scanOnce({ ...deps, poolCandles: async () => seriesAged(5) }, { ...config, maxBarAgeHours: 1 })

    expect(out.snapshots[0]!.lastTradeAgoHours).toBe(5)
    // And the gates, run again on that snapshot by anyone, reach the same verdict.
    expect(evaluateGates(out.snapshots[0]!, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).toContain('staleBars')
  })

  it('keeps a token whose bars are current', async () => {
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good`]: { body: [pair('good')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
    })

    const out = await scanOnce({ ...deps, poolCandles: async () => seriesAged(0.2) }, { ...config, maxBarAgeHours: 1 })

    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['good'])
  })

  it('asks only about CANDIDATES, never about everything it priced', async () => {
    // One candle request per candidate is affordable once an hour; one per
    // token priced would be three hundred, against the provider that
    // rate-limits hardest. The gates have already cut ninety percent by here.
    const asked: string[] = []
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }, { chainId: 'solana', tokenAddress: 'bad' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good,bad`]: { body: [pair('good'), pair('bad')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=bad`]: { body: { code: 1, message: 'ok', result: { bad: minty } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=bad`]: { body: goodQuote },
    })

    await scanOnce(
      { ...deps, poolCandles: async (s: { address: string }) => { asked.push(s.address); return seriesAged(0.2) } },
      { ...config, maxBarAgeHours: 1 },
    )

    expect(asked).toEqual(['good'])
  })
})

describe('scanOnce — the reserve has to be EXAMINED before it can be reserve', () => {
  // The free gates run before the paid ones, so a token they reject is never
  // examined: no security report, `securityChecked: false`, and an all-null
  // report fails every safety gate closed. That put the whole reserve behind a
  // door it could never open — measured live after the first relaunch, ONE
  // token held, zero in reserve, and 108 filtered by turnover alone.
  const deepAndQuiet = pair('slow', { liquidity: { usd: 5_000_000, base: 1, quote: 1 }, volume: { h1: 4_000, h6: 24_000, h24: 96_000 } })

  it('examines a token held back only by a preference, and keeps it as a fallback', async () => {
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'slow' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/slow`]: { body: [deepAndQuiet] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=slow`]: { body: { code: 1, message: 'ok', result: { slow: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=slow`]: { body: goodQuote },
    })
    const out = await scanOnce(deps, config)

    expect(out.snapshots[0]?.securityChecked).toBe(true)
    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['slow'])
    expect(out.candidates[0]?.forgiven?.map((f) => f.gate)).toEqual(['turnover'])
  })

  it('does not spend a security check on one the strategy could never run', async () => {
    // Too young for any indicator. Forgiving it at the door would buy nothing
    // and cost a throttled request per token, on the tier the deep sweep
    // returns most of.
    const newborn = pair('newborn', { pairCreatedAt: NOW - 3_600_000 })
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'newborn' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/newborn`]: { body: [newborn] },
    })
    const out = await scanOnce(deps, config)

    expect(out.candidates).toEqual([])
    expect(http.calls.some((u) => u.includes('token_security'))).toBe(false)
  })
})

describe('scanOnce — a provider that could not answer has not condemned anything', () => {
  // `null` from the candle feed means "asked, and nobody traded" — the
  // strongest form of "this engine cannot watch it", and rightly a SAFETY
  // failure. A request that never got an answer says nothing about the token.
  //
  // Collapsing the two turned **26 of 29 live positions red at once**, Bonk
  // among them, the moment the retry budget was cut and 429s started landing.
  // The screen said the whole book had gone dangerous; what had happened was
  // that we had run out of quota.
  const table = {
    [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }] },
    [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/good`]: { body: [pair('good')] },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
  }

  it('leaves the measurement ABSENT when the feed could not be reached', async () => {
    const { deps } = build(table)
    const out = await scanOnce({ ...deps, poolCandles: async () => { throw new Error('429') } }, { ...config, maxBarAgeHours: 1 })

    expect(out.snapshots[0]?.lastTradeAgoHours).toBeUndefined()
    expect(out.candidates.map((c) => c.snapshot.address)).toEqual(['good'])
  })

  it('still condemns a pool the feed answered about with SILENCE', async () => {
    const { deps } = build(table)
    const out = await scanOnce({ ...deps, poolCandles: async () => seriesAged(null) }, { ...config, maxBarAgeHours: 1 })

    expect(out.snapshots[0]?.lastTradeAgoHours).toBeNull()
    expect(out.candidates).toEqual([])
  })
})

describe('scanOnce — ONE candle download, for the ones that already won', () => {
  // Measured per chain, before: `historyBars` for every affordable token
  // (~105), then `barAgeHours` for every candidate (~50), then
  // `lastCandlePriceUsd` for every candidate again (~50). **About 205 requests
  // to the provider that rate-limits hardest**, and 155 of them for tokens the
  // ranking had already put out of reach.
  //
  // All three answers come out of one series. The operator's rule: score them
  // on what is free, keep the ones the budget can fund, and only then pay for
  // candles.
  const candles = (bars: number, at: number) => ({
    time: Array.from({ length: bars }, (_, i) => at - (bars - 1 - i) * 900_000),
    open: Array.from({ length: bars }, () => 1),
    high: Array.from({ length: bars }, () => 1),
    low: Array.from({ length: bars }, () => 1),
    close: Array.from({ length: bars }, () => 0.01),
    volume: Array.from({ length: bars }, () => 100),
  })

  const table = (address: string) => ({
    [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: address }] },
    [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/${address}`]: { body: [pair(address)] },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=${address}`]: { body: { code: 1, message: 'ok', result: { [address]: safe } } },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=${address}`]: { body: goodQuote },
  })

  it('asks the candle feed ONCE per candidate and answers all three questions', async () => {
    const asked: string[] = []
    const { deps } = build(table('good'))
    const out = await scanOnce(
      { ...deps, poolCandles: async (s) => { asked.push(s.address); return candles(300, NOW) } },
      { ...config, maxBarAgeHours: 1 },
    )

    expect(asked).toEqual(['good'])
    const snapshot = out.snapshots[0]!
    expect(snapshot.historyBars).toBe(300)
    expect(snapshot.lastTradeAgoHours).toBeCloseTo(0, 6)
    expect(snapshot.lastCandlePriceUsd).toBe(0.01)
  })

  it('never asks about a token the ranking already discarded', async () => {
    // A honeypot is refused on the sell quote, which costs no candles at all.
    const asked: string[] = []
    const { deps } = build({
      ...table('trap'),
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=trap`]: { status: 400, body: { error: 'Could not find any route' } },
    })
    const out = await scanOnce(
      { ...deps, poolCandles: async (s) => { asked.push(s.address); return candles(300, NOW) } },
      { ...config, maxBarAgeHours: 1 },
    )

    expect(out.candidates).toEqual([])
    expect(asked).toEqual([])
  })
})

describe('scanOnce — fills the slots, topping up from the next best score', () => {
  // The operator's rule: download candles for the ones the budget can fund, and
  // if one fails, move to the next highest score until the slots are full.
  //
  // A fixed overshoot cannot do both. Too small and a bad batch leaves capital
  // idle — exactly the failure this book spent a morning on. Too large and
  // every scan pays for candles nobody will use, against the provider that
  // rate-limits hardest. Asking for the SHORTFALL never does either.
  const bars = (traded: boolean) => ({
    time: Array.from({ length: 300 }, (_, i) => NOW - (299 - i) * 900_000),
    open: Array.from({ length: 300 }, () => 1),
    high: Array.from({ length: 300 }, () => 1),
    low: Array.from({ length: 300 }, () => 1),
    close: Array.from({ length: 300 }, () => 0.01),
    // Never traded → `staleBars` condemns it, which is what makes it drop out
    // of the candidates after the re-rank.
    volume: Array.from({ length: 300 }, () => (traded ? 100 : 0)),
  })

  const many = (addresses: string[]) => {
    const table: Record<string, { body: unknown; status?: number }> = {
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: addresses.map((a) => ({ chainId: 'solana', tokenAddress: a })) },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/${addresses.join(',')}`]: { body: addresses.map((a) => pair(a)) },
    }
    for (const a of addresses) {
      table[`${GOPLUS_BASE}/solana/token_security?contract_addresses=${a}`] = { body: { code: 1, message: 'ok', result: { [a]: safe } } }
      table[`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=${a}`] = { body: goodQuote }
    }
    return table
  }

  it('asks only for as many as the budget funds when they all survive', async () => {
    const asked: string[] = []
    const { deps } = build(many(['a', 'b', 'c', 'd']))
    await scanOnce(
      { ...deps, poolCandles: async (s: { address: string }) => { asked.push(s.address); return bars(true) } },
      { ...config, maxBarAgeHours: 1, candleBudget: 2 },
    )
    expect(asked).toHaveLength(2)
  })

  it('reaches for the NEXT best when one fails the candle gates', async () => {
    // The first two answer "nobody ever traded" and are condemned; the loop
    // must not stop there with two empty slots.
    const asked: string[] = []
    const { deps } = build(many(['a', 'b', 'c', 'd']))
    const out = await scanOnce(
      {
        ...deps,
        poolCandles: async (s: { address: string }) => { asked.push(s.address); return bars(asked.length > 2) },
      },
      { ...config, maxBarAgeHours: 1, candleBudget: 2 },
    )
    expect(asked).toHaveLength(4)
    expect(out.candidates).toHaveLength(2)
  })

  it('never asks about the same token twice, however many rounds it takes', async () => {
    const asked: string[] = []
    const { deps } = build(many(['a', 'b', 'c', 'd']))
    await scanOnce(
      { ...deps, poolCandles: async (s: { address: string }) => { asked.push(s.address); return bars(false) } },
      { ...config, maxBarAgeHours: 1, candleBudget: 2 },
    )
    expect(new Set(asked).size).toBe(asked.length)
  })

  it('stops when the list runs out rather than asking forever', async () => {
    const asked: string[] = []
    const { deps } = build(many(['a', 'b']))
    await scanOnce(
      { ...deps, poolCandles: async (s: { address: string }) => { asked.push(s.address); return bars(false) } },
      { ...config, maxBarAgeHours: 1, candleBudget: 10 },
    )
    expect(asked).toHaveLength(2)
  })
})

describe('scanOnce — the same scan, over a smaller universe', () => {
  // The full scan did two jobs at one rate: re-examining ~30 tokens that hold
  // money, and discovering ~450 that might. The project's own cadence rule says
  // they are not the same urgency, and the scan did not know it.
  //
  // `discover: false` leaves the universe as exactly the book. Everything after
  // is unchanged — same gates, same security call, same sell quote, same
  // candles — so it is the same scan over fewer tokens, not a lesser one.
  const table = {
    [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'found' }] },
    [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
    [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
    // `stubHttp` matches by PREFIX, so the longer key has to come first or a
    // request for two tokens is answered by the stub for one.
    [`${DEXSCREENER_BASE}/tokens/v1/solana/ours,found`]: { body: [pair('ours'), pair('found')] },
    [`${DEXSCREENER_BASE}/tokens/v1/solana/ours`]: { body: [pair('ours')] },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=ours`]: { body: { code: 1, message: 'ok', result: { ours: safe } } },
    [`${GOPLUS_BASE}/solana/token_security?contract_addresses=found`]: { body: { code: 1, message: 'ok', result: { found: safe } } },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=ours`]: { body: goodQuote },
    [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=found`]: { body: goodQuote },
  }

  it('looks at what we hold and asks no discovery source anything', async () => {
    const { deps, http } = build(table)
    const out = await scanOnce(deps, { ...config, held: ['ours'], discover: false })

    expect(out.snapshots.map((s) => s.address)).toEqual(['ours'])
    expect(http.calls.some((u) => u.includes('token-profiles') || u.includes('token-boosts'))).toBe(false)
  })

  it('still examines it properly — this is not a cheaper check', async () => {
    const { deps } = build(table)
    const out = await scanOnce(deps, { ...config, held: ['ours'], discover: false })
    expect(out.snapshots[0]!.securityChecked).toBe(true)
    expect(out.snapshots[0]!.security.honeypot).toBe(false)
  })

  it('discovers by default, so no existing caller changes behaviour', async () => {
    const { deps } = build(table)
    const out = await scanOnce(deps, { ...config, held: ['ours'] })
    expect(out.snapshots.map((s) => s.address).sort()).toEqual(['found', 'ours'])
  })
})

describe('scanOnce — the door is asked BEFORE anything is paid for', () => {
  // The operator: *¿no podemos filtrar antes a los tokens, de pasarlos por la
  // revisión de Gecko?*
  //
  // `provisionalScore` already existed and was only used to ORDER a bounded
  // budget — so with the budget unbounded it did not even sort, and every
  // token that cleared the free gates cost a throttled GoPlus call, two sell
  // quotes and a history count. About 2.5 seconds each, set by the slowest
  // throttle and not by any latency.
  //
  // Asking the score door and the floors first is SAFE, and provably so rather
  // than approximately: the provisional score models slippage from REPORTED
  // liquidity, which overstates depth — HEV reported $186k against $3.8k of
  // real depth. Overstated depth means understated cost, so the provisional
  // `costEfficiency` and therefore the provisional score are an UPPER BOUND on
  // the real ones. A token below the door provisionally is below it really.
  // `headroom` and `momentum` come out identical, because they read the same
  // price changes either way.

  it('never pays for a token the score door would have refused anyway', async () => {
    const paid: string[] = []
    const { deps, http } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'dull' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/dull`]: { body: [pair('dull')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=dull`]: { body: { code: 1, message: 'ok', result: { dull: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=dull`]: { body: goodQuote },
    })
    const spy: ScanDeps = {
      ...deps,
      goplus: { securityReport: async (c: 'solana' | 'bsc', a: string) => { paid.push(a); return deps.goplus.securityReport(c, a) } } as ScanDeps['goplus'],
    }
    // A door nothing can clear.
    await scanOnce(spy, { ...config, ranking: { ...config.ranking, minScore: 999 } })
    expect(paid).toEqual([])
  })

  it('still pays for a token that clears it', async () => {
    const paid: string[] = []
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [{ chainId: 'solana', tokenAddress: 'good' }] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/good`]: { body: [pair('good')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=good`]: { body: { code: 1, message: 'ok', result: { good: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=good`]: { body: goodQuote },
    })
    const spy: ScanDeps = {
      ...deps,
      goplus: { securityReport: async (c: 'solana' | 'bsc', a: string) => { paid.push(a); return deps.goplus.securityReport(c, a) } } as ScanDeps['goplus'],
    }
    await scanOnce(spy, { ...config, ranking: { ...config.ranking, minScore: 0 } })
    expect(paid).toEqual(['good'])
  })

  it('never lets the pre-filter touch a token we HOLD', async () => {
    // Its security is the one answer we most need current, because it is the
    // one a rug would cost us. A held token is not competing for a look and
    // must never be skipped for scoring badly — the score decides what to BUY,
    // never what to keep watching.
    const paid: string[] = []
    const { deps } = build({
      [`${DEXSCREENER_BASE}/token-profiles/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/latest/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/token-boosts/top/v1`]: { body: [] },
      [`${DEXSCREENER_BASE}/tokens/v1/solana/ours`]: { body: [pair('ours')] },
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=ours`]: { body: { code: 1, message: 'ok', result: { ours: safe } } },
      [`${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=ours`]: { body: goodQuote },
    })
    const spy: ScanDeps = {
      ...deps,
      goplus: { securityReport: async (c: 'solana' | 'bsc', a: string) => { paid.push(a); return deps.goplus.securityReport(c, a) } } as ScanDeps['goplus'],
    }
    await scanOnce(spy, { ...config, held: ['ours'], ranking: { ...config.ranking, minScore: 999 } })
    expect(paid).toEqual(['ours'])
  })
})
