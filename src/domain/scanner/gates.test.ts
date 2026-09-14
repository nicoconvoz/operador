import { describe, it, expect } from 'vitest'
import { DEFAULT_GATE_POLICY as P, evaluateGates } from './gates.js'
import { type SecurityReport, type TokenSnapshot } from './snapshot.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const safeSecurity: SecurityReport = {
  honeypot: false,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  transferTaxPct: 0,
  hasBlacklist: false,
  lpLockedPct: 100,
  topHoldersPct: 22,
  creatorPct: 2,
  verifiedSource: null,
  isProxy: null,
}

/** A token that should sail through every gate. */
const clean = (over: Partial<TokenSnapshot> = {}, security: Partial<SecurityReport> = {}): TokenSnapshot => ({
  chain: 'solana',
  address: 'So1anaTokenAddress',
  symbol: 'GOOD',
  pairAddress: 'PairAddress',
  observedAt: NOW,
  priceUsd: 0.01,
  liquidityUsd: 150_000,
  fdvUsd: 2_000_000,
  volumeUsd: { h1: 8_000, h6: 40_000, h24: 120_000 },
  priceChangePct: { h1: 1.2, h6: -3.1, h24: 8.4 },
  txns: { h1: { buys: 40, sells: 35 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 24 * HOUR,
  security: { ...safeSecurity, ...security },
  ...over,
})

const failedGates = (snapshot: TokenSnapshot) => evaluateGates(snapshot, P).failures.map((f) => `${f.gate}:${f.reason}`)

describe('gates — a clean token passes', () => {
  it('passes with no failures', () => {
    expect(evaluateGates(clean(), P)).toEqual({ passed: true, failures: [] })
  })
})

describe('gates — the shapes of real rugs', () => {
  it('honeypot: sell simulation failed', () => {
    expect(failedGates(clean({}, { honeypot: true }))).toEqual(['honeypot:failed'])
  })

  it('infinite mint: mint authority still active', () => {
    expect(failedGates(clean({}, { mintAuthorityActive: true }))).toEqual(['mintAuthority:failed'])
  })

  it('freeze: the dev can lock your tokens', () => {
    expect(failedGates(clean({}, { freezeAuthorityActive: true }))).toEqual(['freezeAuthority:failed'])
  })

  it('blacklist function present', () => {
    expect(failedGates(clean({}, { hasBlacklist: true }))).toEqual(['blacklist:failed'])
  })

  it('tax trap: 30% sell tax', () => {
    expect(failedGates(clean({}, { transferTaxPct: 30 }))).toEqual(['transferTax:failed'])
  })

  it('unlocked LP: the dev can pull liquidity', () => {
    expect(failedGates(clean({}, { lpLockedPct: 10 }))).toEqual(['lpLocked:failed'])
  })

  it('whale-heavy: top holders own 70%', () => {
    expect(failedGates(clean({}, { topHoldersPct: 70 }))).toEqual(['topHolders:failed'])
  })

  it('creator still holds a quarter of supply', () => {
    expect(failedGates(clean({}, { creatorPct: 25 }))).toEqual(['creatorShare:failed'])
  })

  it('upgradeable proxy on BSC', () => {
    expect(failedGates(clean({ chain: 'bsc' }, { isProxy: true, verifiedSource: true }))).toEqual(['proxy:failed'])
    // Irrelevant on Solana, where there are no proxy contracts.
    expect(failedGates(clean({ chain: 'solana' }, { isProxy: true }))).toEqual([])
  })

  it('a rug can fail several gates at once — all are reported', () => {
    const rug = clean({ liquidityUsd: 3_000 }, { honeypot: true, mintAuthorityActive: true, lpLockedPct: 0, topHoldersPct: 90 })
    expect(failedGates(rug)).toEqual([
      'honeypot:failed', 'mintAuthority:failed', 'lpLocked:failed', 'topHolders:failed', 'liquidity:failed',
    ])
  })
})

describe('gates — not a trade at all', () => {
  it('stablecoins and wrapped natives are denied by mint', () => {
    expect(failedGates(clean({ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }))).toEqual(['denylist:failed'])
    expect(failedGates(clean({ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }))).toEqual(['denylist:failed'])
  })

  it('a token wearing a canonical symbol at another address is an impostor', () => {
    // The first live scan proposed a "USDC" on Raydium with a $96k pool.
    expect(failedGates(clean({ address: 'NotTheRealUSDC111', symbol: 'USDC' }))).toEqual(['impersonation:failed'])
    expect(failedGates(clean({ address: 'NotTheRealUSDC111', symbol: '$usdc' }))).toEqual(['impersonation:failed'])
    expect(failedGates(clean({ address: 'Fake', symbol: 'BONK' }))).toEqual(['impersonation:failed'])
    // A symbol nobody owns is fine.
    expect(failedGates(clean({ address: 'Fresh', symbol: 'GOOD' }))).toEqual([])
  })

  it('a large cap is not what the strategy was tuned for', () => {
    expect(failedGates(clean({ fdvUsd: 240_000_000 }))).toEqual(['marketCap:failed'])
    expect(failedGates(clean({ fdvUsd: 49_000_000 }))).toEqual([])
    // Unknown FDV is tolerated: liquidity and volume gates still apply.
    expect(failedGates(clean({ fdvUsd: null }))).toEqual([])
    // And the cap can be switched off.
    expect(evaluateGates(clean({ fdvUsd: 240_000_000 }), { ...P, maxFdvUsd: null }).passed).toBe(true)
  })
})

describe('gates — market thresholds', () => {
  it('thin liquidity', () => {
    expect(failedGates(clean({ liquidityUsd: P.minLiquidityUsd - 1 }))).toEqual(['liquidity:failed'])
  })

  it('too young: a 3-hour-old pair', () => {
    expect(failedGates(clean({ pairCreatedAt: NOW - 3 * HOUR }))).toEqual(['age:failed'])
  })

  it('too little history for the indicators to exist', () => {
    // The first capital-floor run found candidates with 38 and 105 bars.
    expect(failedGates(clean({ historyBars: 38 }))).toEqual(['history:failed'])
    expect(failedGates(clean({ historyBars: 105 }))).toEqual(['history:failed'])
    expect(failedGates(clean({ historyBars: 250 }))).toEqual([])
    expect(failedGates(clean({ historyBars: 1000 }))).toEqual([])
  })

  it('unmeasured history is not a failure — the scanner may not have fetched candles yet', () => {
    expect(failedGates(clean({ historyBars: null }))).toEqual([])
    expect(failedGates(clean())).toEqual([])
  })

  it('dead volume', () => {
    expect(failedGates(clean({ volumeUsd: { h1: 0, h6: 100, h24: 500 } }))).toEqual(['volume:failed'])
  })

  it('thresholds are inclusive on the safe side', () => {
    expect(evaluateGates(clean({ liquidityUsd: P.minLiquidityUsd }), P).passed).toBe(true)
    expect(evaluateGates(clean({}, { lpLockedPct: P.minLpLockedPct, topHoldersPct: P.maxTopHoldersPct, transferTaxPct: P.maxTransferTaxPct }), P).passed).toBe(true)
  })
})

describe('gates — fail closed on unknown critical facts', () => {
  it('an unknown honeypot result is a failure, not a pass', () => {
    expect(failedGates(clean({}, { honeypot: null }))).toEqual(['honeypot:unknown'])
  })

  it('unknown authorities, blacklist, tax, LP lock and concentration all fail closed', () => {
    const blind = clean({}, {
      mintAuthorityActive: null, freezeAuthorityActive: null, hasBlacklist: null,
      transferTaxPct: null, lpLockedPct: null, topHoldersPct: null,
    })
    expect(failedGates(blind)).toEqual([
      'mintAuthority:unknown', 'freezeAuthority:unknown', 'blacklist:unknown',
      'transferTax:unknown', 'lpLocked:unknown', 'topHolders:unknown',
    ])
  })

  it('the LP lock gate is skipped, not passed, on concentrated venues', () => {
    // No LP token exists on Orca / CLMM / DLMM, so "unknown lock" is not a failure there…
    expect(failedGates(clean({ dexId: 'orca' }, { lpLockedPct: null }))).toEqual([])
    expect(failedGates(clean({ dexId: 'raydium', dexLabels: ['CLMM'] }, { lpLockedPct: null }))).toEqual([])
    // …while on a classic pool it still fails closed.
    expect(failedGates(clean({ dexId: 'raydium' }, { lpLockedPct: null }))).toEqual(['lpLocked:unknown'])
  })

  it('unknown pair age fails closed', () => {
    expect(failedGates(clean({ pairCreatedAt: null }))).toEqual(['age:unknown'])
  })

  it('unknown creator share is tolerated — concentration covers the dangerous case', () => {
    expect(evaluateGates(clean({}, { creatorPct: null }), P).passed).toBe(true)
  })

  it('unknown verified-source and proxy are tolerated on Solana, where they do not apply', () => {
    expect(evaluateGates(clean({}, { verifiedSource: null, isProxy: null }), P).passed).toBe(true)
  })
})
