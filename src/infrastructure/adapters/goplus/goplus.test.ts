import { describe, it, expect } from 'vitest'
import { GoPlus, GOPLUS_BASE, type GoPlusEvmToken, type GoPlusSolanaToken } from './goplus.js'
import { stubHttp, type HttpGet } from '../../http.js'

/** Trimmed from the live BONK response (Sept 2026). */
const bonk: GoPlusSolanaToken = {
  mintable: { authority: [], status: '0' },
  freezable: { authority: [], status: '0' },
  closable: { authority: [], status: '0' },
  balance_mutable_authority: { authority: [], status: '0' },
  transfer_fee: {},
  non_transferable: null,
  holders: [
    { account: '9WzD', percent: '0.0883', is_locked: 0, tag: '' },
    { account: 'burn', percent: '0.05', is_locked: 0, tag: 'Burn' },
    { account: 'x1', percent: '0.03', is_locked: 1, tag: '' },
  ],
  lp_holders: null,
  creators: [],
  trusted_token: 0,
}

/** Trimmed from the live CAKE response (Sept 2026). */
const cake: GoPlusEvmToken = {
  is_honeypot: '0', is_mintable: '1', is_proxy: '0', is_open_source: '1',
  buy_tax: null, sell_tax: null, is_blacklisted: '0', transfer_pausable: '0',
  cannot_sell_all: null, creator_percent: '0.000000',
  holders: [{ address: '0x000000000000000000000000000000000000dead', percent: '0.9263', is_locked: 1 }, { address: '0xabc', percent: '0.02', is_locked: 0 }],
  lp_holders: null,
}

describe('GoPlus adapter — Solana mapping', () => {
  it('maps BONK: no authorities, no fee, top holders as percent, no LP data', () => {
    expect(GoPlus.fromSolana(bonk)).toEqual({
      honeypot: null,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      transferTaxPct: 0,
      hasBlacklist: false,
      lpLockedPct: null,
      topHoldersPct: expect.closeTo(8.83 + 3, 9), // burn address excluded, locked wallet counted
      creatorPct: null,
      verifiedSource: null,
      isProxy: null,
    })
  })

  it('leaves honeypot null on Solana — the sell test lives in Jupiter', () => {
    expect(GoPlus.fromSolana(bonk).honeypot).toBeNull()
  })

  it('reads active mint and freeze authorities', () => {
    const rug: GoPlusSolanaToken = { ...bonk, mintable: { status: '1', authority: [{ address: 'dev' }] }, freezable: { status: '1' } }
    const r = GoPlus.fromSolana(rug)
    expect(r.mintAuthorityActive).toBe(true)
    expect(r.freezeAuthorityActive).toBe(true)
  })

  it('folds balance-mutable, closable and non-transferable into the blacklist gate', () => {
    expect(GoPlus.fromSolana({ ...bonk, balance_mutable_authority: { status: '1' } }).hasBlacklist).toBe(true)
    expect(GoPlus.fromSolana({ ...bonk, closable: { status: '1' } }).hasBlacklist).toBe(true)
    expect(GoPlus.fromSolana({ ...bonk, non_transferable: '1' }).hasBlacklist).toBe(true)
  })

  it('reads a Token-2022 transfer fee as percent', () => {
    expect(GoPlus.fromSolana({ ...bonk, transfer_fee: { current_fee_rate: { fee_rate: '0.05' } } }).transferTaxPct).toBe(5)
  })

  it('unknown everything → nulls, so the gates fail closed', () => {
    const r = GoPlus.fromSolana({})
    expect(r.mintAuthorityActive).toBeNull()
    expect(r.freezeAuthorityActive).toBeNull()
    expect(r.transferTaxPct).toBeNull()
    expect(r.hasBlacklist).toBeNull()
    expect(r.topHoldersPct).toBeNull()
    expect(r.lpLockedPct).toBeNull()
  })

  it('LP locked share sums locked and burned LP holders', () => {
    const lp: GoPlusSolanaToken = { ...bonk, lp_holders: [
      { percent: '0.7', is_locked: 1 },
      { percent: '0.2', is_locked: 0, tag: 'burn' },
      { percent: '0.1', is_locked: 0 },
    ] }
    expect(GoPlus.fromSolana(lp).lpLockedPct).toBeCloseTo(90, 9)
  })
})

describe('GoPlus adapter — EVM mapping', () => {
  it('maps CAKE: not a honeypot, mintable, open source, burn address excluded from concentration', () => {
    expect(GoPlus.fromEvm(cake)).toEqual({
      honeypot: false,
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      transferTaxPct: null,
      hasBlacklist: false,
      lpLockedPct: null,
      topHoldersPct: expect.closeTo(2, 9),
      creatorPct: 0,
      verifiedSource: true,
      isProxy: false,
    })
  })

  it('takes the higher of buy and sell tax, as percent', () => {
    expect(GoPlus.fromEvm({ ...cake, buy_tax: '0.02', sell_tax: '0.3' }).transferTaxPct).toBeCloseTo(30, 9)
  })

  it('a honeypot, a pausable transfer and cannot-sell-all are all caught', () => {
    expect(GoPlus.fromEvm({ ...cake, is_honeypot: '1' }).honeypot).toBe(true)
    expect(GoPlus.fromEvm({ ...cake, transfer_pausable: '1' }).hasBlacklist).toBe(true)
    expect(GoPlus.fromEvm({ ...cake, cannot_sell_all: '1' }).hasBlacklist).toBe(true)
  })

  it('locked LP share counts locked holders and the dead address', () => {
    const lp: GoPlusEvmToken = { ...cake, lp_holders: [
      { address: '0x000000000000000000000000000000000000dead', percent: '0.6', is_locked: 0 },
      { address: '0xlocker', percent: '0.3', is_locked: 1 },
      { address: '0xdev', percent: '0.1', is_locked: 0 },
    ] }
    expect(GoPlus.fromEvm(lp).lpLockedPct).toBeCloseTo(90, 9)
  })
})

/** No waiting in tests: instant sleep, a clock that jumps on each sleep. */
const fakeClock = () => {
  let t = 0
  const sleeps: number[] = []
  return {
    sleeps,
    options: { sleep: async (ms: number) => { sleeps.push(ms); t += ms }, now: () => t },
  }
}

describe('GoPlus adapter — endpoints', () => {
  it('calls the Solana and BSC endpoints and unwraps the envelope', async () => {
    const http = stubHttp({
      [`${GOPLUS_BASE}/solana/token_security?contract_addresses=Mint1`]: { body: { code: 1, message: 'ok', result: { Mint1: bonk } } },
      [`${GOPLUS_BASE}/token_security/56?contract_addresses=0xABC`]: { body: { code: 1, message: 'ok', result: { '0xabc': cake } } },
    })
    const gp = new GoPlus(http, fakeClock().options)
    expect((await gp.securityReport('solana', 'Mint1'))?.mintAuthorityActive).toBe(false)
    expect((await gp.securityReport('bsc', '0xABC'))?.honeypot).toBe(false)
  })

  it('returns null for a token GoPlus has never seen', async () => {
    const gp = new GoPlus(stubHttp({ [GOPLUS_BASE]: { body: { code: 1, message: 'ok', result: {} } } }), fakeClock().options)
    expect(await gp.securityReport('solana', 'Unknown')).toBeNull()
  })

  it('surfaces a non-1 code and non-200 status as HttpError', async () => {
    const bad = new GoPlus(stubHttp({ [GOPLUS_BASE]: { body: { code: 4010, message: 'bad key' } } }), fakeClock().options)
    await expect(bad.securityReport('solana', 'x')).rejects.toMatchObject({ name: 'HttpError' })
    const down = new GoPlus(stubHttp({ [GOPLUS_BASE]: { status: 503, body: {} } }), fakeClock().options)
    await expect(down.securityReport('bsc', 'x')).rejects.toMatchObject({ name: 'HttpError', status: 503 })
  })

  it('spaces calls by the minimum interval — GoPlus limited us after ~50 back-to-back calls', async () => {
    const clock = fakeClock()
    const gp = new GoPlus(stubHttp({ [GOPLUS_BASE]: { body: { code: 1, message: 'ok', result: {} } } }), { ...clock.options, minIntervalMs: 1_300 })
    await gp.securityReport('solana', 'a')
    await gp.securityReport('solana', 'b')
    await gp.securityReport('solana', 'c')
    expect(clock.sleeps).toEqual([1_300, 1_300])
  })

  it('retries a 4029 with doubling backoff, then succeeds', async () => {
    let calls = 0
    const http: HttpGet = Object.assign(
      async () => {
        calls++
        return calls < 3
          ? { status: 200, json: async () => ({ code: 4029, message: 'too many requests' }) }
          : { status: 200, json: async () => ({ code: 1, message: 'ok', result: { m: bonk } }) }
      },
      { calls: [] as string[] },
    )
    const clock = fakeClock()
    const gp = new GoPlus(http, { ...clock.options, minIntervalMs: 0, backoffMs: 2_000, maxRetries: 2 })
    expect((await gp.securityReport('solana', 'm'))?.mintAuthorityActive).toBe(false)
    expect(calls).toBe(3)
    expect(clock.sleeps).toEqual([2_000, 4_000])
  })

  it('gives up after maxRetries and lets the scan fail closed', async () => {
    const gp = new GoPlus(stubHttp({ [GOPLUS_BASE]: { status: 429, body: {} } }), { ...fakeClock().options, minIntervalMs: 0, maxRetries: 1 })
    await expect(gp.securityReport('solana', 'x')).rejects.toMatchObject({ name: 'HttpError', status: 429 })
  })
})
