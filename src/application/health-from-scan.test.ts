import { describe, it, expect } from 'vitest'
import { healthFromSnapshot, UNMEASURED } from './health-from-scan.js'
import { type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000

const security = (over: Partial<SecurityReport> = {}): SecurityReport => ({
  honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
  hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
  ...over,
})

const snapshot = (over: Partial<TokenSnapshot> = {}, sec: Partial<SecurityReport> = {}): TokenSnapshot => ({
  chain: 'solana', address: 'Mint1', symbol: 'TOK', pairAddress: 'Pair1', observedAt: NOW,
  priceUsd: 0.01, liquidityUsd: 250_000, fdvUsd: 5_000_000,
  volumeUsd: { h1: 60_000, h6: 300_000, h24: 875_000 },
  priceChangePct: { h1: 1, h6: 2, h24: 3 },
  txns: { h1: { buys: 70, sells: 25 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 86_400_000, historyBars: 1000,
  securityChecked: true, security: security(sec), ...over,
})

describe('healthFromSnapshot — the scanner’s verdict, made actionable', () => {
  it('reports nothing when the scan has nothing to say', () => {
    expect(healthFromSnapshot(null, 80)).toEqual(UNMEASURED)
  })

  it('carries the readings the death watch was never given', () => {
    const health = healthFromSnapshot(snapshot({}, { mintAuthorityActive: true, freezeAuthorityActive: true }), 80)
    expect(health).toEqual({
      liquidityUsd: 250_000,
      lpStatus: 'locked',
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
    })
  })

  it('calls the LP unlocked by the same threshold the gate refuses on', () => {
    // One definition, not two that drift. "Unlocked" here has to mean what it
    // means when the scanner declines to open a position at all.
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 79 }), 80).lpStatus).toBe('unlocked')
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 80 }), 80).lpStatus).toBe('locked')
  })

  it('will not claim burned or removed, which nothing measures', () => {
    // The providers report a locked percentage. Burned is indistinguishable
    // from locked in that number, and removed would need a withdrawal event
    // nobody watches for. Either claim would be a measurement we do not have.
    const statuses = [0, 50, 100, null].map((pct) => healthFromSnapshot(snapshot({}, { lpLockedPct: pct }), 80).lpStatus)
    expect(statuses).not.toContain('burned')
    expect(statuses).not.toContain('removed')
  })

  it('says unknown when the provider said nothing, rather than unlocked', () => {
    // Silence is not a verdict. Reading null as "unlocked" would manufacture
    // stage-2 evidence out of a provider having a bad minute.
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: null }), 80).lpStatus).toBe('unknown')
  })

  it('keeps liquidity but no security reading from an unexamined token', () => {
    // Its report is UNKNOWN_SECURITY — the absence of a reading, not a reading
    // of absence. Liquidity came from the market pass and is real.
    const health = healthFromSnapshot(snapshot({ securityChecked: false }), 80)
    expect(health.liquidityUsd).toBe(250_000)
    expect(health.mintAuthorityActive).toBeNull()
    expect(health.lpStatus).toBe('unknown')
  })
})

describe('healthFromSnapshot — what it refuses to map', () => {
  it('never turns holder CONCENTRATION into holder MOVEMENT', () => {
    // A token where ten wallets have always held 90% has moved nothing.
    // Reporting the level as a movement would fire the dev-dump signal on
    // every concentrated token in the book, permanently and wrongly.
    const health = healthFromSnapshot(snapshot({}, { topHoldersPct: 90 }), 80)
    expect(health).not.toHaveProperty('topHolderMovedPct')
  })

  it('never turns "has a blacklist function" into "we are blocked"', () => {
    // The contract HAVING the function is not the same as it being used on us.
    // The sell probe answers the real question, and it already runs.
    const health = healthFromSnapshot(snapshot({}, { hasBlacklist: true }), 80)
    expect(health).not.toHaveProperty('transfersBlocked')
  })

  it('never invents a last-trade time out of volume', () => {
    // We measure volume, not when the last trade happened. Deriving one from
    // the other hands the abandonment signal a number it treats as measured.
    const health = healthFromSnapshot(snapshot({ volumeUsd: { h1: 0, h6: 0, h24: 0 } }), 80)
    expect(health).not.toHaveProperty('hoursSinceLastTrade')
  })
})
