import { describe, it, expect } from 'vitest'
import { healthForCycle, healthFromSnapshot, UNMEASURED } from './health-from-scan.js'
import { type LiveMarket } from '../domain/scanner/live-market.js'
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
    expect(healthFromSnapshot(null, lp(80), undefined)).toEqual(UNMEASURED)
  })

  it('carries the readings the death watch was never given', () => {
    const health = healthFromSnapshot(snapshot({}, { mintAuthorityActive: true, freezeAuthorityActive: true }), lp(80), undefined)
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
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 79 }), lp(80), undefined).lpStatus).toBe('unlocked')
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: 80 }), lp(80), undefined).lpStatus).toBe('locked')
  })

  it('will not claim burned or removed, which nothing measures', () => {
    // The providers report a locked percentage. Burned is indistinguishable
    // from locked in that number, and removed would need a withdrawal event
    // nobody watches for. Either claim would be a measurement we do not have.
    const statuses = [0, 50, 100, null].map((pct) => healthFromSnapshot(snapshot({}, { lpLockedPct: pct }), lp(80), undefined).lpStatus)
    expect(statuses).not.toContain('burned')
    expect(statuses).not.toContain('removed')
  })

  it('says unknown when the provider said nothing, rather than unlocked', () => {
    // Silence is not a verdict. Reading null as "unlocked" would manufacture
    // stage-2 evidence out of a provider having a bad minute.
    expect(healthFromSnapshot(snapshot({}, { lpLockedPct: null }), lp(80), undefined).lpStatus).toBe('unknown')
  })

  it('keeps liquidity but no security reading from an unexamined token', () => {
    // Its report is UNKNOWN_SECURITY — the absence of a reading, not a reading
    // of absence. Liquidity came from the market pass and is real.
    const health = healthFromSnapshot(snapshot({ securityChecked: false }), lp(80), undefined)
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
    const health = healthFromSnapshot(snapshot({}, { topHoldersPct: 90 }), lp(80), undefined)
    expect(health).not.toHaveProperty('topHolderMovedPct')
  })

  it('never turns "has a blacklist function" into "we are blocked"', () => {
    // The contract HAVING the function is not the same as it being used on us.
    // The sell probe answers the real question, and it already runs.
    const health = healthFromSnapshot(snapshot({}, { hasBlacklist: true }), lp(80), undefined)
    expect(health).not.toHaveProperty('transfersBlocked')
  })

  it('never invents a last-trade time out of volume', () => {
    // We measure volume, not when the last trade happened. Deriving one from
    // the other hands the abandonment signal a number it treats as measured.
    const health = healthFromSnapshot(snapshot({ volumeUsd: { h1: 0, h6: 0, h24: 0 } }), lp(80), undefined)
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
    healthFromSnapshot(snapshot({ dexId, dexLabels }, { lpLockedPct: 0 }), lp(80), undefined).lpStatus

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
    expect(healthFromSnapshot(snapshot({ dexId: 'raydium' }, { lpLockedPct: 0 }), lp(80), undefined).lpStatus).toBe('unlocked')
    expect(healthFromSnapshot(snapshot({ dexId: 'pancakeswap' }, { lpLockedPct: 100 }), lp(80), undefined).lpStatus).toBe('locked')
  })

  it('agrees with the gate on the same token, which is the whole point', () => {
    // A position frozen for a reason the scanner does not consider a problem is
    // a system arguing with itself, and the reader has to pick a side.
    const whirlpool = snapshot({ dexId: 'orca' }, { lpLockedPct: 0 })
    expect(evaluateGates(whirlpool, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).not.toContain('lpLocked')
    expect(healthFromSnapshot(whirlpool, lp(80), undefined).lpStatus).not.toBe('unlocked')
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
    expect(healthFromSnapshot(snapshot(), lp(80), undefined).safetyFailed).toEqual([])
  })

  it('names the gate, because only a person can tell a turn from a blip', () => {
    const taxed = healthFromSnapshot(snapshot({}, { transferTaxPct: 30 }), lp(80), undefined)
    expect(taxed.safetyFailed).toContain('transferTax')
  })

  it('reports the gates the old mapping was blind to', () => {
    // Every one of these is measured by the scan and none of them reached the
    // death watch: they map to no field on the observation.
    const rotten = healthFromSnapshot(
      snapshot({}, { topHoldersPct: 99, hasBlacklist: true, creatorPct: 99 }),
      lp(80),
      undefined,
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
    expect(healthFromSnapshot(snapshot({ securityChecked: false }), lp(80), undefined).safetyFailed).toBeNull()
    expect(healthFromSnapshot(null, lp(80), undefined).safetyFailed).toBeNull()
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
      undefined,
    )
    expect(unanswered.safetyFailed).toEqual([])
  })

  it('still freezes when ONE gate answered and the rest went quiet', () => {
    // The quiet half must not swallow the half that spoke. A 30% transfer tax
    // is a measurement whoever else failed to reply.
    const mixed = healthFromSnapshot(
      snapshot({}, { transferTaxPct: 30, mintAuthorityActive: null, topHoldersPct: null }),
      lp(80),
      undefined,
    )
    expect(mixed.safetyFailed).toEqual(['transferTax'])
  })

  it('leaves the opportunity gates alone — taste is not danger', () => {
    // A pool that turns over slowly or had a thin day is a preference, and the
    // reserve exists precisely to forgive those. Freezing a position over one
    // would turn the engine's own shortlist policy into a sell signal.
    const quiet = snapshot({ volumeUsd: { h1: 0, h6: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 1, sells: 1 } } })
    expect(healthFromSnapshot(quiet, lp(80), undefined).safetyFailed).toEqual([])
  })

  it('is the SAME verdict the door uses, not a second opinion', () => {
    // One definition of "is this dangerous". Two would eventually disagree
    // about which tokens are safe, and the one on the screen is the one the
    // operator would believe.
    const turned = snapshot({}, { transferTaxPct: 30, topHoldersPct: 99 })
    expect(healthFromSnapshot(turned, DEFAULT_GATE_POLICY, undefined).safetyFailed).toEqual(
      evaluateSafetyGates(turned, DEFAULT_GATE_POLICY).failures.map((failure) => failure.gate),
    )
  })
})

describe('the pool is draining NOW, not twenty minutes ago', () => {
  // The operator read it off the tape: *el problema no son las comisiones, son
  // las congeladas... pierden muchísimo, debemos detectarlas antes.*
  //
  // He was right, and the cause is a request already being paid for. The engine
  // asks DexScreener for every held token once a CYCLE (5 min) and the response
  // carries the whole market half — price, LIQUIDITY, volume, counts. It kept
  // one line of it and threw the rest away, while the death watch read liquidity
  // from the stored SCAN, refreshed every twenty minutes in production.
  //
  // So a pool could drain for twenty minutes unseen, and `exitOnFreeze` would
  // then sell into it — exempt from the no-loss guard, at whatever price was
  // left. A blind window on the one signal whose entire purpose is to leave
  // BEFORE leaving stops being possible.
  //
  // The same shape already fixed for the SCREEN and never for the engine, which
  // is why the screen could watch a position drain while the engine held it.

  const live = (over: Partial<LiveMarket> = {}): LiveMarket => {
    const { security: _ignored, ...market } = snapshot()
    return { ...market, ...over }
  }

  it('takes the liquidity from the live feed, not from the stored scan', () => {
    const drained = healthFromSnapshot(snapshot(), lp(80), live({ liquidityUsd: 9_000 }))
    expect(drained.liquidityUsd).toBe(9_000)
  })

  it('falls back to the scan when no feed answered — silence is not a collapse', () => {
    // A provider having a bad minute must not read as a pool that emptied, or a
    // rate limit would freeze and SELL the whole book. The rule this engine has
    // already paid for twice.
    expect(healthFromSnapshot(snapshot(), lp(80), undefined).liquidityUsd).toBe(250_000)
  })

  it('re-asks the LIQUIDITY gate on the live number, so the engine agrees with the screen', () => {
    // The gate fires at `minLiquidityUsd`, and a pool that fell under it while
    // we held it is the death watch's business — not something to learn at the
    // next scan.
    const drained = healthFromSnapshot(snapshot(), lp(80), live({ liquidityUsd: 100 }))
    expect(drained.safetyFailed).toContain('liquidity')
  })

  it('never lets the feed touch the SECURITY half', () => {
    // A market response knows nothing about authorities, the LP or a honeypot.
    // Overlaying it whole would blank the evidence those gates fire on, and they
    // fail CLOSED — the position would turn red for the crime of being
    // refreshed, which is the failure `withLiveMarket` exists to prevent.
    const turned = snapshot({}, { mintAuthorityActive: true })
    const refreshed = healthFromSnapshot(turned, lp(80), live({ liquidityUsd: 900_000 }))
    expect(refreshed.mintAuthorityActive).toBe(true)
    expect(refreshed.safetyFailed).toContain('mintAuthority')
  })

  it('still reports NULL for a token nobody examined, however fresh the price is', () => {
    // A live market does not make an unexamined token examined. The gates fail
    // closed on a missing security report, and reading that as "it turned"
    // would sell every position the security budget has not reached.
    const fresh = healthFromSnapshot(snapshot({ securityChecked: false }), lp(80), live())
    expect(fresh.safetyFailed).toBeNull()
  })
})

describe('two halves on two clocks', () => {
  // The guard that must survive: the scan's SECURITY verdict folds ONCE per
  // scan, because `exitConfirmations` counts consecutive observations and
  // replaying one reading every five minutes would manufacture twelve
  // confirmations out of a single answer — the exact false positive the rule
  // exists to prevent, wearing the rule's own clothes.
  //
  // The liquidity is not that. It is a NEW measurement every cycle, so passing
  // it every cycle is reporting rather than repeating, and three confirmations
  // then mean three genuine readings fifteen minutes apart.
  //
  // This lived in the composition root, which is where every wiring bug this
  // project has paid for was hiding: a missing `discover`, a missing
  // `poolMarkets`, a trim that wrote over the tick. A decision belongs where it
  // can be tested; only the plumbing stays out there.

  const live = (over: Partial<LiveMarket> = {}): LiveMarket => {
    const { security: _ignored, ...market } = snapshot()
    return { ...market, ...over }
  }

  it('gives the whole verdict when the scan is fresh', () => {
    const health = healthForCycle(snapshot({}, { mintAuthorityActive: true }), lp(80), live(), true)
    expect(health.mintAuthorityActive).toBe(true)
    expect(health.safetyFailed).toContain('mintAuthority')
  })

  it('gives ONLY the live liquidity when the scan is not fresh', () => {
    // Everything else must read as unmeasured, or the same scan would be
    // counted again as a fresh confirmation.
    const health = healthForCycle(snapshot({}, { mintAuthorityActive: true }), lp(80), live({ liquidityUsd: 4_000 }), false)
    expect(health.liquidityUsd).toBe(4_000)
    expect(health.mintAuthorityActive).toBeNull()
    expect(health.safetyFailed).toBeNull()
    expect(health.lpStatus).toBe('unknown')
  })

  it('reports nothing at all when neither the scan nor the feed is new', () => {
    expect(healthForCycle(snapshot(), lp(80), undefined, false)).toEqual(UNMEASURED)
  })

  it('a stale scan can never re-confirm its own authority reading', () => {
    // Twelve cycles between scans, and the authority must be reported once.
    const stale = snapshot({}, { mintAuthorityActive: true })
    const cycles = Array.from({ length: 12 }, (_, i) => healthForCycle(stale, lp(80), live(), i === 0))
    expect(cycles.filter((c) => c.mintAuthorityActive === true)).toHaveLength(1)
  })

  it('but the LIQUIDITY is reported on every one of them', () => {
    // Which is the whole point: a pool draining is seen at cycle cadence, not
    // at scan cadence, so the freeze arrives before the pool is empty.
    const stale = snapshot()
    const cycles = Array.from({ length: 12 }, (_, i) => healthForCycle(stale, lp(80), live({ liquidityUsd: 7_000 }), i === 0))
    expect(cycles.every((c) => c.liquidityUsd === 7_000)).toBe(true)
  })
})
