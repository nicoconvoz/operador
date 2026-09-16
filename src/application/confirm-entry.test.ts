import { describe, it, expect } from 'vitest'
import { confirmEntry } from './confirm-entry.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000

const healthy = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  chain: 'solana', address: 'Mint1', pairAddress: 'Pool1', symbol: 'GOOD', observedAt: NOW,
  priceUsd: 0.01, liquidityUsd: 150_000, fdvUsd: 1_000_000,
  volumeUsd: { h1: 35_000, h6: 180_000, h24: 525_000 },
  priceChangePct: { h1: 2, h6: -3, h24: 5 },
  txns: { h1: { buys: 40, sells: 30 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 86_400_000, dexId: 'raydium', dexLabels: [],
  historyBars: 1000, securityChecked: true,
  security: {
    honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
    hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 10, creatorPct: 1, verifiedSource: true, isProxy: false,
  },
  ...over,
})

describe('confirmEntry — the last look before the money moves', () => {
  it('opens on a token that still passes every gate', async () => {
    const out = await confirmEntry('Mint1', async () => healthy(), DEFAULT_GATE_POLICY)
    expect(out.ok).toBe(true)
  })

  it('refuses a token whose CANDLES we cannot see, however active the market data says it is', async () => {
    // Measured live, the same pool asked of both providers at the same moment:
    //
    //            GeckoTerminal    DexScreener
    //   DREGG     0 txns / 1h     35 txns / 1h
    //   HEV       0 txns / 1h     96 txns / 1h
    //
    // The engine was caught between them — admitted by DexScreener's activity,
    // condemned by GeckoTerminal's silence. And the strategy is bar-driven, so
    // a pool with no bars cannot be traded AT ALL: the entry decided at a close
    // waits forever for an open that never arrives. Six positions sat at
    // "$0.00 dentro" with their ladder frozen and their capital stuck.
    //
    // Whoever is right about the market, the engine's own answer is the same:
    // do not buy what you cannot watch.
    const out = await confirmEntry('Mint1', async () => healthy(), DEFAULT_GATE_POLICY, {
      barAgeHours: async () => 5,
      maxBarAgeHours: 1,
    })
    expect(out).toMatchObject({ ok: false, reason: 'stale-bars' })
  })

  it('refuses when the candle feed answers nothing at all', async () => {
    // No bars is not "fresh bars". Fail closed, like every other reading here.
    const out = await confirmEntry('Mint1', async () => healthy(), DEFAULT_GATE_POLICY, {
      barAgeHours: async () => null,
      maxBarAgeHours: 1,
    })
    expect(out.ok).toBe(false)
  })

  it('opens when the bars are current', async () => {
    const out = await confirmEntry('Mint1', async () => healthy(), DEFAULT_GATE_POLICY, {
      barAgeHours: async () => 0.2,
      maxBarAgeHours: 1,
    })
    expect(out.ok).toBe(true)
  })

  it('checks the gates BEFORE spending a candle request on the feed', async () => {
    // A token that already fails its gates is not worth a download. The order
    // matters because this runs on every position about to be opened.
    let asked = 0
    await confirmEntry(
      'Mint1',
      async () => healthy({ liquidityUsd: 1_000 }),
      DEFAULT_GATE_POLICY,
      { barAgeHours: async () => { asked++; return 0.1 }, maxBarAgeHours: 1 },
    )
    expect(asked).toBe(0)
  })

  it('refuses a token whose mint authority came back since the scan', async () => {
    // The case only this check can catch. A token that became mintable an hour
    // ago still quotes a perfectly good sell, so `confirmSellable` — the only
    // thing that used to run here — would have waved it through.
    const out = await confirmEntry(
      'Mint1',
      async () => healthy({ security: { ...healthy().security, mintAuthorityActive: true } }),
      DEFAULT_GATE_POLICY,
    )
    expect(out).toMatchObject({ ok: false, reason: 'gates' })
    if (out.ok === false && out.reason === 'gates') {
      expect(out.failures.map((f) => f.gate)).toContain('mintAuthority')
    }
  })

  it('refuses a token whose pool drained since the scan', async () => {
    const out = await confirmEntry('Mint1', async () => healthy({ liquidityUsd: 1_000 }), DEFAULT_GATE_POLICY)
    expect(out.ok).toBe(false)
  })

  it('refuses a token that stopped trading since the scan', async () => {
    // The user's rule at the door as well as at the exit: activity is the point.
    const out = await confirmEntry(
      'Mint1',
      async () => healthy({ txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 900, sells: 850 } } }),
      DEFAULT_GATE_POLICY,
    )
    expect(out.ok).toBe(false)
  })

  it('refuses rather than guesses when the provider throws', async () => {
    // Fail CLOSED, and the asymmetry is deliberate. A refused entry is an
    // opportunity missed; an entry taken on an unreadable provider is money
    // placed into something nobody could see.
    const out = await confirmEntry('Mint1', async () => { throw new Error('502 bad gateway') }, DEFAULT_GATE_POLICY)
    expect(out).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('refuses when the provider cannot price the token at all', async () => {
    // Not found is not "fine". A token nobody can price a minute before we buy
    // is one we cannot size a ladder against either.
    const out = await confirmEntry('Mint1', async () => null, DEFAULT_GATE_POLICY)
    expect(out).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('hands back the FRESH snapshot, not the one the scanner chose', async () => {
    // Whatever opens the position should size against what is true now. Passing
    // the stale snapshot on would make this check a veto and nothing more.
    const out = await confirmEntry('Mint1', async () => healthy({ liquidityUsd: 222_222 }), DEFAULT_GATE_POLICY)
    expect(out.ok === true && out.snapshot.liquidityUsd).toBe(222_222)
  })
})
