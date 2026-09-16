import { describe, it, expect } from 'vitest'
import { DEFAULT_GATE_POLICY, DEFAULT_GATE_POLICY as P, evaluateGates, evaluateMarketGates } from './gates.js'
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
  // Turns over 3.5× a day, which is the MEDIAN of 252 live tokens. The fixture
  // used to sit at 0.8× and pass, because nothing measured activity against
  // the pool — a clean token should look like a live one.
  volumeUsd: { h1: 35_000, h6: 180_000, h24: 525_000 },
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

  it('the UNWRAPPED majors are impostors too — there is no native BTC on Solana', () => {
    // Live, holding money: a fifteen-day-old memecoin at
    // E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx wearing the ticker "BTC",
    // with a $267k pool and not one blocker against it. The map knew WBTC and
    // did not know BTC, so the most recognisable ticker in crypto was the one
    // symbol anybody could borrow.
    //
    // Bitcoin and Ether have no native mint on Solana. Only the wrapped ones
    // exist, so ANY other address wearing those names is not the asset.
    expect(failedGates(clean({ address: 'E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx', symbol: 'BTC' }))).toEqual(['impersonation:failed'])
    expect(failedGates(clean({ address: 'Fake', symbol: 'ETH' }))).toEqual(['impersonation:failed'])
    // And the real wrapped mints still answer to both names.
    expect(failedGates(clean({ address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'BTC' }))).toEqual([])
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
    // Both, and both are true: too few dollars, and a pool standing still.
    // Neither is the other's restatement.
    expect(failedGates(clean({ volumeUsd: { h1: 0, h6: 100, h24: 500 } }))).toEqual(['volume:failed', 'turnover:failed'])
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

describe('evaluateMarketGates — free gates, run before the paid ones', () => {
  it('decides everything it can without a security report', () => {
    const noSecurity = clean({}, {
      honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null,
      hasBlacklist: null, transferTaxPct: null, lpLockedPct: null, topHoldersPct: null,
    })
    // The full gate set rejects this for unknown security…
    expect(evaluateGates(noSecurity, P).passed).toBe(false)
    // …while the free gates pass it through to be paid for.
    expect(evaluateMarketGates(noSecurity, P).passed).toBe(true)
  })

  it('still rejects on liquidity, age, volume, FDV, denylist and impersonation', () => {
    const failed = (s: TokenSnapshot) => evaluateMarketGates(s, P).failures.map((f) => f.gate)
    expect(failed(clean({ liquidityUsd: 100 }))).toEqual(['liquidity'])
    expect(failed(clean({ pairCreatedAt: NOW - HOUR }))).toEqual(['age'])
    expect(failed(clean({ volumeUsd: { h1: 0, h6: 0, h24: 10 } }))).toEqual(['volume', 'turnover'])
    expect(failed(clean({ fdvUsd: 900_000_000 }))).toEqual(['marketCap'])
    expect(failed(clean({ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }))).toEqual(['denylist'])
    expect(failed(clean({ address: 'Fake', symbol: 'BONK' }))).toEqual(['impersonation'])
  })

  it('never passes something the full gates would reject on market grounds', () => {
    // The reorder must not soften anything: any market failure appears in both.
    for (const s of [clean({ liquidityUsd: 1 }), clean({ fdvUsd: 1e9 }), clean({ pairCreatedAt: NOW })]) {
      const cheap = evaluateMarketGates(s, P).failures.map((f) => f.gate)
      const full = evaluateGates(s, P).failures.map((f) => f.gate)
      for (const gate of cheap) expect(full).toContain(gate)
    }
  })
})

describe('evaluateGates — what it costs to get out', () => {
  it('refuses a pool whose measured impact makes the trade unwinnable', () => {
    // CREPE, live: $718,000 of REPORTED liquidity, and a $285 sell moved the
    // price 98%. It passed every other gate and became a position. Reported
    // depth is a claim; a quote is a measurement.
    const shallow = clean({ measuredImpactPct: 98 })
    const result = evaluateGates(shallow, P)
    expect(result.passed).toBe(false)
    expect(result.failures.map((f) => f.gate)).toContain('impact')
  })

  it('allows a pool deep enough to leave', () => {
    expect(evaluateGates(clean({ measuredImpactPct: 0.4 }), P).passed).toBe(true)
  })

  it('stays silent when nothing was measured — it fires on evidence, never on absence', () => {
    // Unlike the safety gates, which fail closed: an unmeasured cost is not a
    // danger signal, and rejecting on it would blind the scanner to every
    // token the probe budget could not reach this cycle.
    const result = evaluateGates(clean({ measuredImpactPct: null }), P)
    expect(result.failures.map((f) => f.gate)).not.toContain('impact')
  })
})

// ── Freefall ────────────────────────────────────────────────────────────────
//
// The user's rule: do not open on a token that has fallen more than half in
// about three hours.
//
// It belongs HERE and nowhere near the death exit. CLAUDE.md is categorical
// that price may never cause an exit — a death exit that reacts to price is a
// stop loss wearing a different name, and the ladder's whole premise is that a
// drop is an opportunity to average down. Choosing what to ENTER on price is a
// different question entirely, and the strategy already does it: the classic
// gate is a drop from the swing high.
//
// Three hours is not a window the providers report. They give 1h, 6h and 24h,
// so three sits between two of them and the gate reads BOTH rather than
// inventing the one it wants: half gone inside an hour is a collapse, half gone
// over six is a bleed, and neither is something to open into.

describe('gates — a token in freefall is not an opportunity', () => {
  it('refuses one that lost more than half within the hour', () => {
    expect(failedGates(clean({ priceChangePct: { h1: -62, h6: -10, h24: 5 } }))).toEqual(['freefall:failed'])
  })

  it('refuses one that lost more than half across six hours', () => {
    expect(failedGates(clean({ priceChangePct: { h1: -4, h6: -55, h24: -60 } }))).toEqual(['freefall:failed'])
  })

  it('says how far it fell and over what', () => {
    const [failure] = evaluateGates(clean({ priceChangePct: { h1: -3, h6: -70, h24: 0 } }), DEFAULT_GATE_POLICY).failures
    expect(failure!.detail).toContain('70')
    expect(failure!.detail).toContain('6h')
  })

  it('leaves a hard but survivable drop alone — that is what the ladder is for', () => {
    // Down 40% is exactly the shape the cascade exists to buy into. A gate that
    // rejected it would be a stop loss applied before the position opens.
    expect(failedGates(clean({ priceChangePct: { h1: -18, h6: -40, h24: -45 } }))).toEqual([])
  })

  it('reads the 24h window too, but at its own threshold', () => {
    // This test used to assert the opposite — that 24h was never read, because
    // half a day is a bad day and the strategy was built for bad days. That
    // held while the ladder had ten rungs to answer with. The decision changed
    // when the ladder was cut to TWO: a shallower ladder cannot chase a
    // day-long bleed, so it has to decline to enter one.
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -80 } }))).toEqual(['freefall:failed'])
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -55 } }))).toEqual([])
  })

  it('stays quiet when the provider reported nothing — silence is not a crash', () => {
    expect(failedGates(clean({ priceChangePct: { h1: null, h6: null, h24: null } }))).toEqual([])
  })

  it('is not fooled by a rise', () => {
    expect(failedGates(clean({ priceChangePct: { h1: 220, h6: 340, h24: 900 } }))).toEqual([])
  })
})

// ── Activity, measured against the pool rather than in dollars ──────────────
//
// `minVolume24hUsd` is an absolute floor, and an absolute floor cannot tell
// $10k of volume on a $2M pool (dead) from $10k on a $25k pool (lively).
// Measured across 252 live tokens, turnover — 24h volume over liquidity —
// spans four orders of magnitude: p10 of 0.12, median 3.5, p90 of 116.
//
// Turning over its own depth once a day is a crisp definition of "there is
// activity here", and it keeps 173 of 252: a filter, not a wall.

describe('gates — a pool that does not turn over is not active', () => {
  it('refuses a pool whose whole day of volume is a fraction of its depth', () => {
    expect(failedGates(clean({ liquidityUsd: 1_000_000, volumeUsd: { h1: 500, h6: 3_000, h24: 200_000 } })))
      .toEqual(['turnover:failed'])
  })

  it('accepts a small pool that trades itself over', () => {
    // $60k of volume on a $40k pool. In dollars it is a quarter of the one
    // above; in life it is the opposite.
    expect(failedGates(clean({ liquidityUsd: 40_000, volumeUsd: { h1: 4_000, h6: 18_000, h24: 60_000 } })))
      .toEqual([])
  })

  it('keeps the absolute floor too — a ratio cannot save an untradeable pool', () => {
    // Turns over three times a day, and nobody can get $15 in or out of it.
    const failures = failedGates(clean({ liquidityUsd: 3_000, volumeUsd: { h1: 400, h6: 2_000, h24: 9_000 } }))
    expect(failures).toContain('liquidity:failed')
  })

  it('says the ratio it measured, not just that it failed', () => {
    const [failure] = evaluateGates(
      clean({ liquidityUsd: 1_000_000, volumeUsd: { h1: 500, h6: 3_000, h24: 200_000 } }),
      DEFAULT_GATE_POLICY,
    ).failures
    expect(failure!.detail).toContain('0.2')
  })
})

// ── A day-long bleed, now that the ladder has two rungs ─────────────────────
//
// The freefall gate reads 1h and 6h and ignores 24h on purpose: half a day is
// not freefall, it is a bad day, and the strategy was built for bad days.
//
// That argument held while the ladder had ten rungs to answer with. At TWO it
// does not: a token down 60% in a day needs a bounce the ladder can no longer
// chase. Measured live, 58 of 252 tokens were worse than -50% over 24h and
// every one of them passed, because nothing looked.
//
// The threshold is LOOSER than the short windows, and deliberately: the same
// fall given four times as long to happen is a different event.

describe('gates — a sustained bleed over a full day', () => {
  it('refuses a token that lost most of a day', () => {
    expect(failedGates(clean({ priceChangePct: { h1: -3, h6: -20, h24: -72 } }))).toEqual(['freefall:failed'])
  })

  it('tolerates over a day what it would refuse within the hour', () => {
    // -55% is a collapse in one hour and a bad day across twenty-four. The
    // ladder was built for bad days.
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -55 } }))).toEqual([])
    expect(failedGates(clean({ priceChangePct: { h1: -55, h6: -8, h24: -55 } }))).toEqual(['freefall:failed'])
  })

  it('names the day as the window, so the reason can be checked', () => {
    const [failure] = evaluateGates(clean({ priceChangePct: { h1: 0, h6: 0, h24: -80 } }), DEFAULT_GATE_POLICY).failures
    expect(failure!.detail).toContain('24h')
  })

  it('still treats an unreported day as silence', () => {
    expect(failedGates(clean({ priceChangePct: { h1: null, h6: null, h24: null } }))).toEqual([])
  })
})

// ── An hour with nothing in it ──────────────────────────────────────────────
//
// The 24h figures cannot catch this: `world` was reported live with $168k of
// daily volume and FIVE HOURS without a new bar. A daily average is a lagging
// one — a token can trade heavily in the morning and be dead by the afternoon,
// and the 24h number keeps quoting the morning.
//
// It is the last hour that says whether the pool is alive NOW, and the
// threshold is tied to the bar size rather than guessed: the strategy runs on
// 15-minute bars, so an hour holds FOUR of them. Fewer than four trades in an
// hour guarantees empty bars, and an empty bar produces no candle — which is
// precisely how a position ends up frozen with nothing new to act on.

describe('gates — an hour with no trades in it', () => {
  it('refuses a token nobody traded in the last hour', () => {
    expect(failedGates(clean({ txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 900, sells: 850 } } })))
      .toEqual(['idle:failed'])
  })

  it('refuses one with fewer trades than the hour has bars', () => {
    // Three trades across four 15-minute bars: at least one bar is empty, and
    // an empty bar is a bar the strategy never sees.
    expect(failedGates(clean({ txns: { h1: { buys: 2, sells: 1 }, h24: { buys: 900, sells: 850 } } })))
      .toEqual(['idle:failed'])
  })

  it('accepts one trading at least once a bar', () => {
    expect(failedGates(clean({ txns: { h1: { buys: 3, sells: 1 }, h24: { buys: 900, sells: 850 } } })))
      .toEqual([])
  })

  it('is not fooled by a healthy DAY behind a dead hour', () => {
    // The exact shape reported: $168k over 24h, nothing since.
    const zombie = clean({
      volumeUsd: { h1: 0, h6: 40_000, h24: 168_000 },
      txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 4_000, sells: 3_900 } },
    })
    expect(failedGates(zombie)).toContain('idle:failed')
  })

  it('says how many trades it counted, and against what', () => {
    const [failure] = evaluateGates(
      clean({ txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 900, sells: 850 } } }),
      DEFAULT_GATE_POLICY,
    ).failures
    expect(failure!.detail).toContain('1')
    expect(failure!.detail).toContain('4')
  })
})
