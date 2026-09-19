import { describe, it, expect } from 'vitest'
import { healthFromSnapshot, UNMEASURED } from './health-from-scan.js'
import { type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { DEFAULT_GATE_POLICY, evaluateGates, evaluateSafetyGates, type GatePolicy } from '../domain/scanner/gates.js'

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

const lp = (pct: number): GatePolicy => ({ ...DEFAULT_GATE_POLICY, minLpLockedPct: pct })

describe('healthFromSnapshot — the scanner’s verdict, made actionable', () => {
  it('reports nothing when the scan has nothing to say', () => {
    expect(healthFromSnapshot(null, lp(80))).toEqual(UNMEASURED)
  })

  it('carries the readings the death watch was never given', () => {
    const health = healthFromSnapshot(snapshot({}, { mintAuthorityActive: true, freezeAuthorityActive: true }), lp(80))
    expect(health).toEqual({
      liquidityUsd: 250_000,
      lpStatus: 'locked',
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      safetyFailed: ['mintAuthority', 'freezeAuthority'],
    })
  })

  it('calls the LP unlocked by the same threshold the gate refuses on', () => {
    // One definition, not two that drift. "Unlocked" here has to mean what it
    // means when the scanner declines to open a position at all.
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 79 }), lp(80)).lpStatus).toBe('unlocked')
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 80 }), lp(80)).lpStatus).toBe('locked')
  })

  it('will not claim burned or removed, which nothing measures', () => {
    // The providers report a locked percentage. Burned is indistinguishable
    // from locked in that number, and removed would need a withdrawal event
    // nobody watches for. Either claim would be a measurement we do not have.
    const statuses = [0, 50, 100, null].map((pct) => healthFromSnapshot(snapshot({}, { lpLockedPct: pct }), lp(80)).lpStatus)
    expect(statuses).not.toContain('burned')
    expect(statuses).not.toContain('removed')
  })

  it('says unknown when the provider said nothing, rather than unlocked', () => {
    // Silence is not a verdict. Reading null as "unlocked" would manufacture
    // stage-2 evidence out of a provider having a bad minute.
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: null }), lp(80)).lpStatus).toBe('unknown')
  })

  it('keeps liquidity but no security reading from an unexamined token', () => {
    // Its report is UNKNOWN_SECURITY — the absence of a reading, not a reading
    // of absence. Liquidity came from the market pass and is real.
    const health = healthFromSnapshot(snapshot({ securityChecked: false }), lp(80))
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
    const health = healthFromSnapshot(snapshot({}, { topHoldersPct: 90 }), lp(80))
    expect(health).not.toHaveProperty('topHolderMovedPct')
  })

  it('never turns "has a blacklist function" into "we are blocked"', () => {
    // The contract HAVING the function is not the same as it being used on us.
    // The sell probe answers the real question, and it already runs.
    const health = healthFromSnapshot(snapshot({}, { hasBlacklist: true }), lp(80))
    expect(health).not.toHaveProperty('transfersBlocked')
  })

  it('never invents a last-trade time out of volume', () => {
    // We measure volume, not when the last trade happened. Deriving one from
    // the other hands the abandonment signal a number it treats as measured.
    const health = healthFromSnapshot(snapshot({ volumeUsd: { h1: 0, h6: 0, h24: 0 } }), lp(80))
    expect(health).not.toHaveProperty('hoursSinceLastTrade')
  })
})

// ── Concentrated pools have no LP to lock ───────────────────────────────────
//
// Reported live: PURR opened green and froze, twice across two relaunches, on
// the evidence "LP unlocked" — while the scanner's own gates passed it with no
// blockers at all. The screen and the death watch disagreed about the same
// token, which is exactly what this file's own comment claims to prevent.
//
// The gate only reads lpLockedPct when `lpModelOf` says the venue HAS LP
// tokens. On Orca Whirlpools, Raydium CLMM and Meteora DLMM, positions are
// NFTs — there is nothing to lock, so the gate skips the question rather than
// answering it. lp-model.ts puts it plainly: it does not PASS a concentrated
// pool by pretending a lock exists.
//
// This mapping read the field on every pool, and so made the mirror-image
// mistake: it FAILED one by pretending a lock was missing.

describe('healthFromSnapshot — a venue with no LP token', () => {
  const concentrated = (dexId: string, dexLabels: string[] = []) =>
    healthFromSnapshot(snapshot({ dexId, dexLabels }, { lpLockedPct: 0 }), lp(80)).lpStatus

  it('says unknown on an Orca whirlpool, not unlocked', () => {
    expect(concentrated('orca')).toBe('unknown')
  })

  it('says unknown on Raydium CLMM', () => {
    expect(concentrated('raydium', ['CLMM'])).toBe('unknown')
  })

  it('says unknown on Meteora DLMM', () => {
    expect(concentrated('meteora', ['DLMM'])).toBe('unknown')
  })

  it('still reads the lock where LP tokens actually exist', () => {
    // Raydium's classic AMM does have them, and there the number means what it
    // says. Skipping it everywhere would be the opposite error.
    expect(healthFromSnapshot(snapshot({ dexId: 'raydium' }, { lpLockedPct: 0 }), lp(80)).lpStatus).toBe('unlocked')
    expect(healthFromSnapshot(snapshot({ dexId: 'pancakeswap' }, { lpLockedPct: 100 }), lp(80)).lpStatus).toBe('locked')
  })

  it('agrees with the gate on the same token, which is the whole point', () => {
    // A position frozen for a reason the scanner does not consider a problem is
    // a system arguing with itself, and the reader has to pick a side.
    const whirlpool = snapshot({ dexId: 'orca' }, { lpLockedPct: 0 })
    expect(evaluateGates(whirlpool, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).not.toContain('lpLocked')
    expect(healthFromSnapshot(whirlpool, lp(80)).lpStatus).not.toBe('unlocked')
  })
})

describe('a safety gate that turns on a token we already hold', () => {
  // The operator's rule, and he named what it cost him: *si falla una compuerta
  // de seguridad, filtrar y no dejar operar, restricción total, porque esas me
  // han hecho perder mucho dinero.*
  //
  // The ENTRY path was already closed — a safety failure is never ranked, never
  // forgiven into the reserve, and re-asked at the door. The hole was on the
  // other side. This mapper handed the death watch four facts out of the scan
  // (liquidity, the LP, the two authorities) and dropped the rest on the floor:
  // a transfer tax appearing, a blacklist function appearing, concentration
  // spiking, the contract turning into a proxy.
  //
  // ANSEM is the token that proved it. The screen drew it `turnedUnsafe` with
  // its blockers listed, and the engine reported `deathStage: healthy` over a
  // live position — the screen-versus-engine disagreement this project has paid
  // for more than once.

  it('says nothing failed when nothing failed', () => {
    expect(healthFromSnapshot(snapshot(), lp(80)).safetyFailed).toEqual([])
  })

  it('names the gate, because only a person can tell a turn from a blip', () => {
    const taxed = healthFromSnapshot(snapshot({}, { transferTaxPct: 30 }), lp(80))
    expect(taxed.safetyFailed).toContain('transferTax')
  })

  it('reports the gates the old mapping was blind to', () => {
    // Every one of these is measured by the scan and none of them reached the
    // death watch: they map to no field on the observation.
    const rotten = healthFromSnapshot(
      snapshot({}, { topHoldersPct: 99, hasBlacklist: true, creatorPct: 99 }),
      lp(80),
    )
    expect(rotten.safetyFailed).toEqual(
      expect.arrayContaining(['topHolders', 'blacklist', 'creatorShare']),
    )
  })

  it('reports NULL for a token nobody examined, never a list of failures', () => {
    // The safety gates fail CLOSED, so an unexamined token fails all of them by
    // design. Reading that as "it turned" would freeze every position the
    // security budget has not reached yet — and with `exitOnFreeze` on, that
    // is not a pause, it is a liquidation of the whole book.
    expect(healthFromSnapshot(snapshot({ securityChecked: false }), lp(80)).safetyFailed).toBeNull()
    expect(healthFromSnapshot(null, lp(80)).safetyFailed).toBeNull()
  })

  it('a provider that could not ANSWER has not condemned anything', () => {
    // The sharpest edge in this change, and this project has already paid for
    // it once: a GoPlus rate limit leaves the report all-null while the scan
    // still marks the token examined. The safety gates fail CLOSED, so every
    // one of them then reports a failure — and with `exitOnFreeze` on, that
    // would sell the entire book because we ran out of quota.
    //
    // It is the sell probe's own rule, in the mirror: *an RPC failure is never
    // read as "no route" — one is inconclusive, the other is a death signal.*
    // Only a gate that failed on a MEASURED fact freezes a position.
    const unanswered = healthFromSnapshot(
      snapshot({}, { honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null, hasBlacklist: null, topHoldersPct: null, creatorPct: null }),
      lp(80),
    )
    expect(unanswered.safetyFailed).toEqual([])
  })

  it('still freezes when ONE gate answered and the rest went quiet', () => {
    // The quiet half must not swallow the half that spoke. A 30% transfer tax
    // is a measurement whoever else failed to reply.
    const mixed = healthFromSnapshot(
      snapshot({}, { transferTaxPct: 30, mintAuthorityActive: null, topHoldersPct: null }),
      lp(80),
    )
    expect(mixed.safetyFailed).toEqual(['transferTax'])
  })

  it('leaves the opportunity gates alone — taste is not danger', () => {
    // A pool that turns over slowly or had a thin day is a preference, and the
    // reserve exists precisely to forgive those. Freezing a position over one
    // would turn the engine's own shortlist policy into a sell signal.
    const quiet = snapshot({ volumeUsd: { h1: 0, h6: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 1, sells: 1 } } })
    expect(healthFromSnapshot(quiet, lp(80)).safetyFailed).toEqual([])
  })

  it('is the SAME verdict the door uses, not a second opinion', () => {
    // One definition of "is this dangerous". Two would eventually disagree
    // about which tokens are safe, and the one on the screen is the one the
    // operator would believe.
    const turned = snapshot({}, { transferTaxPct: 30, topHoldersPct: 99 })
    expect(healthFromSnapshot(turned, DEFAULT_GATE_POLICY).safetyFailed).toEqual(
      evaluateSafetyGates(turned, DEFAULT_GATE_POLICY).failures.map((failure) => failure.gate),
    )
  })
})
