import { describe, it, expect } from 'vitest'
import { DEFAULT_PARAMS } from '../strategy/params.js'
import { minAgeForHistory, evaluateSafetyGates, DEFAULT_GATE_POLICY, STRICT_GATE_POLICY, DEFAULT_GATE_POLICY as P, evaluateGates, evaluateMarketGates } from './gates.js'
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

/**
 * Every gate's LOGIC, proved under the policy that still asks them all.
 *
 * Production narrowed to three component floors plus safety, so
 * `DEFAULT_GATE_POLICY` no longer asks the taste gates anything — turnover,
 * volume, the daily fall, the FDV ceiling, the liquidity floor. The gates
 * themselves are unchanged and a test that proves `turnover` fires on a slow
 * pool is still worth having; it just has to name the policy it proves that
 * under, instead of leaning on a default whose whole point is that it does not
 * decide any more.
 *
 * The structural thresholds — age, history, idle, staleBars, priceMismatch —
 * are identical in both, so nothing about them changes meaning here.
 */
const failedGates = (snapshot: TokenSnapshot) =>
  evaluateGates(snapshot, STRICT_GATE_POLICY).failures.map((f) => `${f.gate}:${f.reason}`)

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

  it('whale-heavy: top holders own almost everything', () => {
    // 70% used to be the fixture, and 70% now PASSES: the operator raised the
    // ceiling to 80 after this gate turned out to be the single largest cut on
    // a market where high concentration is ordinary. What is still a rug shape
    // is a supply nearly all in a few hands.
    expect(failedGates(clean({}, { topHoldersPct: 70 }))).toEqual([])
    expect(failedGates(clean({}, { topHoldersPct: 95 }))).toEqual(['topHolders:failed'])
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

  it('the cap admits large tokens now; the RANKING is what keeps them last', () => {
    // $50M excluded every established token outright, and measured on ten days
    // of 15m candles that was wrong about the thing that matters: SOL/USDC hits
    // the classic entry — a 10% drop from the five-hour high — on 4.1% of bars.
    // Tradeable, just rarer. A stablecoin pair hits it on 0%, which is the
    // denylist's job, not this gate's.
    //
    // Small caps remain the thesis. `smallCapFdvUsd` in the ranking puts them
    // ahead of every large one whatever the scores say, so the big names only
    // ever take a slot nothing smaller wanted.
    expect(failedGates(clean({ fdvUsd: 240_000_000 }))).toEqual([])
    expect(failedGates(clean({ fdvUsd: 49_000_000 }))).toEqual([])
    // A genuine mega cap is still not a small-cap trade.
    expect(failedGates(clean({ fdvUsd: 3_800_000_000 }))).toEqual(['marketCap:failed'])
    // Unknown FDV is tolerated: liquidity and volume gates still apply.
    expect(failedGates(clean({ fdvUsd: null }))).toEqual([])
    // And the cap can be switched off.
    expect(evaluateGates(clean({ fdvUsd: 3_800_000_000 }), { ...P, maxFdvUsd: null }).passed).toBe(true)
  })
})

describe('gates — market thresholds', () => {
  it('thin liquidity', () => {
    expect(failedGates(clean({ liquidityUsd: P.minLiquidityUsd - 1 }))).toEqual(['liquidity:failed'])
  })

  it('too young: a 3-hour-old pair', () => {
    expect(failedGates(clean({ pairCreatedAt: NOW - 3 * HOUR }))).toEqual(['age:failed'])
  })

  it('too little history for the ENTRY indicators to exist', () => {
    // The first capital-floor run found candidates with 38 and 105 bars, and
    // both were refused while the threshold was 250.
    //
    // 105 is admitted now, deliberately. The classic entry — the only door a
    // NEW position comes through — needs a 20-bar swing high inside a lateral
    // zone, and its longest lookback is the 50-bar Bollinger basis. Only the
    // trend RE-ENTRY needs EMA-200, and that door opens after a sell, by which
    // time the pool has had time to grow into it.
    //
    // 38 is still refused: it cannot compute the lateral zone at all.
    expect(failedGates(clean({ historyBars: 38 }))).toEqual(['history:failed'])
    expect(failedGates(clean({ historyBars: 105 }))).toEqual([])
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
    const failed = (s: TokenSnapshot) => evaluateMarketGates(s, STRICT_GATE_POLICY).failures.map((f) => f.gate)
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
    const [failure] = evaluateGates(clean({ priceChangePct: { h1: -3, h6: -70, h24: 0 } }), STRICT_GATE_POLICY).failures
    expect(failure!.detail).toContain('70')
    expect(failure!.detail).toContain('6h')
  })

  it('still lets a drop through while the DAY is intact — the ladder is for that', () => {
    // The distinction the gate turns on. A drop inside the hour with the day
    // still holding is the shape the cascade exists to buy into; the same drop
    // carried across the whole day is an exit in progress that we would simply
    // be joining.
    //
    // Nothing here touches an OPEN position: a ladder with money in it goes on
    // averaging down, which is its job. This decides only what to enter.
    expect(failedGates(clean({ priceChangePct: { h1: -18, h6: -40, h24: -10 } }))).toEqual([])
  })

  it('reads the 24h window at the TIGHTEST threshold of the three', () => {
    // This assertion has now moved twice, and both moves are the record of a
    // decision rather than a tweak.
    //
    // It first said 24h was never read at all: half a day is a bad day and the
    // strategy was built for bad days. That held while the ladder had ten rungs
    // to answer with. Cutting it to TWO changed it — a shallow ladder cannot
    // chase a day-long bleed — and the window was read at a LOOSE 70%.
    //
    // Then a token was bought at −64% on the day and the position sat flat: the
    // collapse had happened entirely before we arrived, and we had joined it
    // for nothing. The operator set it to 15, which makes the day the strictest
    // window of the three and reverses the original reasoning outright.
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -55 } }))).toEqual(['freefall:failed'])
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -12 } }))).toEqual([])
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
      STRICT_GATE_POLICY,
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

  it('refuses a day-long bleed the ladder would once have bought into', () => {
    // The reversal, stated as a test. −55% across a day used to pass on the
    // argument that a slow fall is a bad day rather than a collapse. It is
    // refused now: what the operator saw was that a token already down that far
    // does not recover on our schedule, it simply stops falling with our money
    // in it.
    expect(failedGates(clean({ priceChangePct: { h1: -2, h6: -8, h24: -55 } }))).toEqual(['freefall:failed'])
    expect(failedGates(clean({ priceChangePct: { h1: -55, h6: -8, h24: -55 } }))).toEqual(['freefall:failed'])
  })

  it('names the day as the window, so the reason can be checked', () => {
    const [failure] = evaluateGates(clean({ priceChangePct: { h1: 0, h6: 0, h24: -80 } }), STRICT_GATE_POLICY).failures
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

describe('minAgeForHistory — the cheapest rejection is the one that needs no request', () => {
  it('refuses to let a pool through that is arithmetically too young for the bars', () => {
    // 250 bars of 15m is 62.5 hours. A pool 30 hours old CANNOT have them, and
    // learning that used to cost a thousand-row candle download per token — the
    // single heaviest call in a cycle, made to produce one integer.
    expect(minAgeForHistory(250, 15)).toBe(62.5)
  })

  it('scales with the bar, because the same 250 bars are a different age', () => {
    // At 1H the same requirement is ten and a half days. Hardcoding an hour
    // count would be right for one timeframe and silently wrong for the other.
    expect(minAgeForHistory(250, 60)).toBe(250)
  })

  it('never lowers a floor that was set higher on purpose', () => {
    // 24h is the standing minimum and answers a different question — a pool
    // that has existed for a day. This raises it to what history needs; it must
    // not lower it if someone deliberately demands more.
    expect(Math.max(DEFAULT_GATE_POLICY.minAgeHours, minAgeForHistory(250, 15))).toBe(62.5)
  })
})

describe('evaluateSafetyGates — what must still hold at the moment capital moves', () => {
  it('still refuses a token that became unsafe', () => {
    // The whole reason to look again. A mint authority that came back, an LP
    // that unlocked, a pool that drained, a sell path that closed — these are
    // the answers that turn between the scan and the buy, and every one of them
    // costs real money.
    const verdict = evaluateSafetyGates(clean({}, { mintAuthorityActive: true }), DEFAULT_GATE_POLICY)
    expect(verdict.passed).toBe(false)
    expect(verdict.failures.map((f) => f.gate)).toContain('mintAuthority')
  })

  it('does NOT re-argue the opportunity: a price that moved is not a reason to walk away', () => {
    // The operator's point, and it is right. On a DEX the price moves WHILE we
    // buy — somebody else's order moves it, and ours moves it too. A token that
    // dipped past the freefall threshold between being chosen and being bought
    // has not become dangerous; it has become cheaper, which is the entire
    // premise of a DCA ladder.
    //
    // The scanner already decided this token was worth trading. Asking that
    // question again at the door means refusing entries for the ordinary
    // motion the strategy exists to harvest — and it filled the alert log
    // while the book sat at eight positions.
    const crashed = clean({ priceChangePct: { h1: -60, h6: -55, h24: -65 } })
    expect(evaluateGates(crashed, STRICT_GATE_POLICY).passed).toBe(false)
    expect(evaluateSafetyGates(crashed, STRICT_GATE_POLICY).passed).toBe(true)
  })

  it('does not re-argue activity either', () => {
    // Turnover, hourly trades and volume are the scanner's selection call, made
    // on a full universe. At the door there is no universe to compare against —
    // only this token, and whether it is safe.
    const quiet = clean({ volumeUsd: { h1: 10, h6: 60, h24: 240 }, txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 10, sells: 8 } } })
    expect(evaluateGates(quiet, DEFAULT_GATE_POLICY).passed).toBe(false)
    expect(evaluateSafetyGates(quiet, DEFAULT_GATE_POLICY).passed).toBe(true)
  })

  it('keeps refusing what is not a trade at all', () => {
    // A denylisted or impersonating token is not an opportunity judgement, and
    // it does not stop being true because we already decided to buy.
    const fake = clean({ symbol: 'BTC', address: 'NotTheRealOne' })
    expect(evaluateSafetyGates(fake, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).toContain('impersonation')
  })

  it('still refuses a pool nobody can get out of', () => {
    // Liquidity and impact are not about attractiveness. They answer "can this
    // position be left", which is the one question a ladder cannot survive
    // getting wrong.
    expect(evaluateSafetyGates(clean({ liquidityUsd: 400 }), DEFAULT_GATE_POLICY).passed).toBe(false)
    expect(evaluateSafetyGates(clean({ measuredImpactPct: 40 }), DEFAULT_GATE_POLICY).passed).toBe(false)
  })
})

describe('minHistoryBars — enough to ENTER, not enough for every door', () => {
  it('asks for what the classic entry needs, not for what the second door needs', () => {
    // Measured on a live universe: of 97 priced Solana tokens, 15 passed the
    // free gates and AGE ALONE blocked another 16 — the single biggest cut, and
    // it exists only to serve this number.
    //
    // 250 was calibrated for the whole indicator set, EMA-200 included. But the
    // EMA feeds exactly one thing — `trendBullish`, which arms the TREND
    // RE-ENTRY, the second door and one that only opens after a sell. Every new
    // position comes through the CLASSIC door, and that needs the 20-bar swing
    // high and the lateral zone, whose longest lookback is the 50-bar
    // Bollinger basis.
    //
    // A young pool is therefore tradeable long before it can use both doors,
    // and an unconverged EMA is null, so the second door simply does not open
    // until the pool has matured. Safe by construction rather than by luck.
    // ENOUGH for the basis to exist with room to spare, not twice it.
    //
    // Two times the Bollinger length was a margin rather than a requirement,
    // and it was the second largest cut in the whole funnel: measured over 564
    // live Solana tokens, `age` blocked 354 and was the SOLE cause for 40,
    // because what these lists return is mostly pools born this morning.
    //
    // The basis needs `bbLength` bars to produce its first value and the swing
    // high needs 20, so 60 leaves ten bars of converged Bollinger output to
    // decide a lateral zone on. Thin, and the operator chose it knowing that:
    // 25 hours of required pool age becomes 15.
    expect(DEFAULT_GATE_POLICY.minHistoryBars).toBeGreaterThan(DEFAULT_PARAMS.bbLength)
    expect(DEFAULT_GATE_POLICY.minHistoryBars).toBeGreaterThanOrEqual(DEFAULT_PARAMS.bbLength + 10)
    expect(DEFAULT_GATE_POLICY.minHistoryBars).toBeLessThan(DEFAULT_PARAMS.trendEmaLength)
  })

  it('and the age gate follows it down, because it only ever existed to serve it', () => {
    // 100 bars of 15m is 25 hours, against 62.5 for 250. The gate stays at its
    // own 24h floor, which answers a different question — a pool that has
    // existed for at least a day.
    // 15 hours, down from 25: the age gate exists only to serve the bar count,
    // so lowering one lowers the other by construction. Measured, that is 40
    // tokens a scan that were refused for nothing but being born this morning.
    expect(minAgeForHistory(DEFAULT_GATE_POLICY.minHistoryBars, 15)).toBe(15)
  })
})

describe('priceMismatch — two providers that disagree about the price cannot both be right', () => {
  it('refuses a token whose candle price is nothing like its market price', () => {
    // ZCAT, live: DexScreener quoted $0.1318 and GeckoTerminal's candles for
    // the SAME pool quoted $1,429.49 — a factor of 10,846. The engine sizes an
    // order from one and fills it at the other, so it bought 0.0105 tokens for
    // $15.11 when that money was fifteen dollars of a token worth a tenth of a
    // dollar. It read on screen as a 100% collapse minutes after buying.
    //
    // It is not a rug and it is not a crash. It is a unit nobody agreed on, and
    // the only safe answer is the same as for stale bars: if the engine cannot
    // price a token consistently, it cannot trade it.
    const verdict = evaluateGates(clean({ priceUsd: 0.1318, lastCandlePriceUsd: 1_429.49 }), DEFAULT_GATE_POLICY)
    expect(verdict.failures.map((f) => f.gate)).toContain('priceMismatch')
  })

  it('tolerates the ordinary gap between a bar close and a live quote', () => {
    // The last CLOSED bar is up to fifteen minutes old and these tokens move.
    // A band that fired on that would reject the whole universe, so it is
    // generous by design: it exists to catch a mismatched UNIT, not a price
    // that moved.
    expect(evaluateGates(clean({ priceUsd: 0.01, lastCandlePriceUsd: 0.013 }), DEFAULT_GATE_POLICY).passed).toBe(true)
    expect(evaluateGates(clean({ priceUsd: 0.01, lastCandlePriceUsd: 0.007 }), DEFAULT_GATE_POLICY).passed).toBe(true)
  })

  it('catches the mismatch in EITHER direction', () => {
    const inverted = evaluateGates(clean({ priceUsd: 1_429.49, lastCandlePriceUsd: 0.1318 }), DEFAULT_GATE_POLICY)
    expect(inverted.failures.map((f) => f.gate)).toContain('priceMismatch')
  })

  it('stays silent when nobody measured the candle price', () => {
    // Fires on evidence, never on absence — the same rule as `history` and
    // `staleBars`. A scan that has not fetched candles says nothing.
    expect(evaluateGates(clean({}), DEFAULT_GATE_POLICY).passed).toBe(true)
  })
})

describe('freefall — fifteen percent on the day, and only downward', () => {
  it('refuses a token down more than 15% over the day', () => {
    // The operator's number. It let −64% through at 70, and a token down that
    // far had already spent its fall before we ever saw it: measured live,
    // RICHDEBT was bought at −64% on the day and the position sat flat, so the
    // collapse was entirely somebody else's and we simply joined it.
    expect(failedGates(clean({ priceChangePct: { h1: -1, h6: -5, h24: -20 } }))).toEqual(['freefall:failed'])
    expect(failedGates(clean({ priceChangePct: { h1: -1, h6: -5, h24: -14 } }))).toEqual([])
  })

  it('never fires on a RISE, however violent', () => {
    // Only downward, explicitly. A token up 300% on the day is a question for
    // `headroom`, which scores it low — not for a gate, which would refuse it
    // outright. Those are different verdicts and they must not be confused.
    expect(failedGates(clean({ priceChangePct: { h1: 40, h6: 120, h24: 300 } }))).toEqual([])
  })

  it('still catches a pump that is dumping inside the day', () => {
    // The short windows earn their place here: up on the day, collapsing in the
    // hour. The daily gate cannot see it because the day is still green.
    expect(failedGates(clean({ priceChangePct: { h1: -55, h6: 10, h24: 40 } }))).toEqual(['freefall:failed'])
  })
})

describe('gates — the taste gates step aside; the structural ones do not', () => {
  // The operator's rule, and it is a deliberate narrowing of what a GATE is
  // allowed to be: *tendencia reciente alcista +50%, sube en una hora +30% y
  // eficiencia de costos +30%, esa va a ser la única regla, y obvio la regla
  // de que no nos metan una cripto trampa.*
  //
  // So: three component floors plus safety. Everything that merely expressed a
  // PREFERENCE about the pool — how fast it turns, how much it traded
  // yesterday, how big the name is, how far it fell today — stops deciding.
  // Measured on 114 live Solana tokens, those four together were blocking a
  // third of the universe while `liquidity` and `volume` never blocked anything
  // on their own at all.
  //
  // Two survive the cut and they are NOT taste, which is the distinction worth
  // keeping. `age`/`history` and `idle` are the machine's own requirements: no
  // bars means no Bollinger basis and no twenty-bar swing high, so the strategy
  // has nothing to decide an entry with; and under four trades an hour a 15m
  // bar comes back EMPTY, which is exactly how six positions once froze with
  // their capital unreachable.

  const gentle = (over: Partial<TokenSnapshot> = {}) => ({ ...clean(), ...over })

  it('no longer refuses a pool that turns slowly', () => {
    const slow = gentle({ liquidityUsd: 2_000_000, volumeUsd: { h1: 5_000, h6: 30_000, h24: 120_000 } })
    expect(evaluateMarketGates(slow, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).not.toContain('turnover')
  })

  it('no longer refuses a thin day', () => {
    const quiet = gentle({ volumeUsd: { h1: 400, h6: 2_400, h24: 9_000 } })
    expect(evaluateMarketGates(quiet, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).not.toContain('volume')
  })

  it('refuses again a token that already collapsed TODAY — the hour cannot see it', () => {
    // This test recorded turning the daily gate off, on the argument that the
    // hour already decides through the `headroom` floor and a daily threshold
    // was belt and braces against the same accident.
    //
    // PERK falsified it. They are not the same accident: the hour sees *falling
    // right now*, the day sees *already collapsed before we arrived*, and a
    // token can be calm this hour having lost almost everything since
    // yesterday. The engine bought PERK when it was already down 92.6% on the
    // day, and then lost another 43.6% of what it put in.
    //
    // Measured across 36 live positions: of the capital a >30% band would have
    // refused, 18.5% was lost, against 3.4% for the book overall.
    const collapsed = gentle({ priceChangePct: { h1: 1, h6: -10, h24: -40 } })
    expect(evaluateMarketGates(collapsed, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).toContain('freefall')
  })

  it('but still buys an ordinary bad day, which is what the ladder is for', () => {
    // The line is at thirty and not lower on purpose. `fone` had already fallen
    // 20.3% when the engine bought it and is UP; `CODEC` 15.6% and up. Those
    // are the thesis working, and a tighter gate would eat them.
    const dip = gentle({ priceChangePct: { h1: 1, h6: -8, h24: -20 } })
    expect(evaluateMarketGates(dip, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).not.toContain('freefall')
  })

  it('still refuses a pool the machine cannot compute an entry on', () => {
    const newborn = gentle({ pairCreatedAt: NOW - 60 * 60 * 1000 })
    expect(evaluateMarketGates(newborn, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).toContain('age')
  })

  it('still refuses a pool whose bars come back empty', () => {
    const still = gentle({ txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 40, sells: 30 } } })
    expect(evaluateMarketGates(still, DEFAULT_GATE_POLICY).failures.map((f) => f.gate)).toContain('idle')
  })
})

describe('gates — concentration at eighty, which is nearly open', () => {
  // The operator, with the trade stated in his own words: *subilo al 80%, nos
  // vamos a arriesgar.*
  //
  // Forty was calibrated for a more distributed market than the one this book
  // trades. Measured on live Solana tokens: cbBTC 26.67%, eHYUSD 45%, TRUMP
  // 81.28% — and in a run over 35 tokens that cleared every other gate,
  // `topHolders` blocked 20 and was the SOLE cause for 7, more than any other
  // check. High concentration on Solana is the norm rather than the exception,
  // and it is not always the creator: an LP position, an exchange wallet or
  // the first buyers all look the same from here.
  //
  // What eighty BUYS is those seven back. What it COSTS is stated rather than
  // softened: a holder with four fifths of the supply can sell whenever they
  // like, and this engine will be inside when they do. The check is close to
  // open now — it still refuses the extreme case, and nothing milder.

  it('admits the concentration this market actually has', () => {
    expect(failedGates(clean({}, { topHoldersPct: 26 }))).toEqual([])
    expect(failedGates(clean({}, { topHoldersPct: 45 }))).toEqual([])
    expect(failedGates(clean({}, { topHoldersPct: 79 }))).toEqual([])
  })

  it('still refuses the extreme', () => {
    expect(failedGates(clean({}, { topHoldersPct: 81 }))).toEqual(['topHolders:failed'])
    expect(failedGates(clean({}, { topHoldersPct: 99 }))).toEqual(['topHolders:failed'])
  })

  it('still fails CLOSED when nobody measured it', () => {
    // Unchanged, and it is the half of this gate that still does real work:
    // GoPlus returns an empty holders array for most Solana tokens, and an
    // unknown concentration is an unanswered question rather than a low one.
    expect(failedGates(clean({}, { topHoldersPct: null }))).toEqual(['topHolders:unknown'])
  })
})

describe('the day-long collapse, measured on the book that paid for it', () => {
  // PRODUCTION policy, not the strict one. The gate's logic is pinned above
  // against `STRICT_GATE_POLICY`; what this pins is the DECISION — the number
  // the engine actually runs with, which had been sitting at 100 (off) while
  // CLAUDE.md documented 15. A choice written down and not implemented is the
  // failure mode this project names more than any other.
  //
  // The threshold is MEASURED, on 36 live positions, by reconstructing how far
  // each token had already fallen when the engine bought it
  // (`tools/freefall-what-if.ts`). Of the capital each band refused, this much
  // was lost:
  //
  //     already down >50%   47.2%   ← PERK alone, $45.98 of a $134.11 book
  //     already down >30%   18.5%
  //     already down >20%    8.4%
  //     already down >15%    6.0%
  //     the book overall     3.4%
  //
  // So past 30% is catastrophe — five to fourteen times the book's own rate,
  // bought for $271 of deployment not made. Between 5% and 30% it is an
  // ordinary bad day at roughly twice the average, and tightening into it costs
  // WINNERS: `fone` had already fallen 20.3% and is up, `CODEC` 15.6% and up.
  //
  // That is the strategy's own thesis, so the gate must not eat it. CASCADE DCA
  // exists to buy weakness; this exists to refuse a collapse already in
  // progress. Thirty is where the measurement puts the line between them.
  const production = (over: Partial<TokenSnapshot>) =>
    evaluateGates(clean(over), DEFAULT_GATE_POLICY).failures.map((f) => f.gate)

  it('refuses a token that already collapsed before we arrived — PERK, −92.6%', () => {
    expect(production({ priceChangePct: { h1: -21.7, h6: -60, h24: -92.6 } })).toContain('freefall')
  })

  it('still buys the DIP, which is what the strategy is for — fone at −20.3%', () => {
    // Refusing this one would cost a winner and contradict the premise: the
    // ladder exists to enter weakness. Measured, it is up.
    expect(production({ priceChangePct: { h1: 1, h6: -5, h24: -20.3 } })).not.toContain('freefall')
  })

  it('and CODEC at −15.6%, also up', () => {
    expect(production({ priceChangePct: { h1: 1, h6: -4, h24: -15.6 } })).not.toContain('freefall')
  })

  it('draws the line at thirty, where the measurement puts it', () => {
    expect(production({ priceChangePct: { h1: 0, h6: -10, h24: -31 } })).toContain('freefall')
    expect(production({ priceChangePct: { h1: 0, h6: -10, h24: -29 } })).not.toContain('freefall')
  })

  it('never on a RISE, however violent', () => {
    // A token up 300% on the day is a question for the score, not for a gate.
    // The check is `change >= -limit`, so a rise cannot trip it.
    expect(production({ priceChangePct: { h1: 50, h6: 120, h24: 300 } })).not.toContain('freefall')
  })

  it('stays quiet where the provider said nothing', () => {
    // Unlike the SAFETY gates, which fail closed because unknown danger IS
    // evidence, this one fires only on a number somebody measured.
    expect(production({ priceChangePct: { h1: null, h6: null, h24: null } })).not.toContain('freefall')
  })
})
