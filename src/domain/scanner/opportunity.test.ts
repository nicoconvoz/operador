import { describe, it, expect } from 'vitest'
import { DEFAULT_OPPORTUNITY_POLICY as P, scoreOpportunity } from './opportunity.js'
import { type TokenSnapshot } from './snapshot.js'
import { type MarketQuality } from '../market/market-quality.js'

const cheap: MarketQuality = { liquidityUsd: 1_000_000, spreadPct: 0.25, slippagePct: 0.05, referenceUsd: 100, observedAt: 0 }
const dear: MarketQuality = { ...cheap, spreadPct: 1.0, slippagePct: 2.0 }

const base = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  chain: 'solana',
  address: 'A',
  symbol: 'T',
  pairAddress: 'P',
  observedAt: 0,
  priceUsd: 1,
  liquidityUsd: 100_000,
  fdvUsd: null,
  // Perfectly steady: 1h volume equals the 24h hourly average.
  volumeUsd: { h1: 1_000, h6: 6_000, h24: 24_000 },
  priceChangePct: { h1: 0, h6: 0, h24: 0 },
  txns: { h1: { buys: 10, sells: 10 }, h24: { buys: 240, sells: 240 } },
  pairCreatedAt: null,
  security: {
    honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
    hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 10, creatorPct: 0, verifiedSource: null, isProxy: null,
  },
  ...over,
})

describe('opportunity — components are explainable and bounded', () => {
  it('a steady, balanced, quiet token scores low with neutral components', () => {
    const { score, components } = scoreOpportunity(base(), P)
    expect(components.volumeExpansion).toBeCloseTo(1 / 3, 9) // ratio 1 of 3
    expect(components.buyPressure).toBe(0)
    expect(components.liquidityGrowth).toBeCloseTo(0.5, 9) // no previous → ratio 1
    expect(components.volatility).toBe(0)
    expect(components.costEfficiency).toBe(0.5) // unmeasured → neutral, never generous
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(50)
  })

  it('every component and the score stay within bounds under extreme inputs', () => {
    const wild = base({
      volumeUsd: { h1: 1_000_000, h6: 2_000_000, h24: 2_400_000 },
      priceChangePct: { h1: 400, h6: 900, h24: 5000 },
      txns: { h1: { buys: 5000, sells: 0 }, h24: { buys: 9000, sells: 100 } },
      liquidityUsd: 10_000_000,
    })
    const { score, components } = scoreOpportunity(wild, P, base({ liquidityUsd: 1 }), cheap)
    for (const value of Object.values(components)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(score).toBeLessThanOrEqual(100)
  })
})

describe('opportunity — the signal moves the right way', () => {
  it('a volume burst scores higher than steady volume', () => {
    const steady = scoreOpportunity(base(), P).score
    const burst = scoreOpportunity(base({ volumeUsd: { h1: 3_000, h6: 8_000, h24: 24_000 } }), P).score
    expect(burst).toBeGreaterThan(steady)
  })

  it('buyers outnumbering sellers scores higher; sellers dominating scores no lower than neutral', () => {
    const neutral = scoreOpportunity(base(), P)
    const buying = scoreOpportunity(base({ txns: { h1: { buys: 18, sells: 2 }, h24: { buys: 240, sells: 240 } } }), P)
    const selling = scoreOpportunity(base({ txns: { h1: { buys: 2, sells: 18 }, h24: { buys: 240, sells: 240 } } }), P)
    expect(buying.score).toBeGreaterThan(neutral.score)
    expect(selling.components.buyPressure).toBe(0)
  })

  it('growing liquidity scores higher than draining liquidity', () => {
    const previous = base({ liquidityUsd: 100_000 })
    const growing = scoreOpportunity(base({ liquidityUsd: 150_000 }), P, previous)
    const draining = scoreOpportunity(base({ liquidityUsd: 60_000 }), P, previous)
    expect(growing.components.liquidityGrowth).toBe(1)
    expect(draining.components.liquidityGrowth).toBeCloseTo(0.1, 9)
    expect(growing.score).toBeGreaterThan(draining.score)
  })

  it('a moving price scores higher than a flat one — the ladder needs drops to work', () => {
    const flat = scoreOpportunity(base(), P).score
    const moving = scoreOpportunity(base({ priceChangePct: { h1: -8, h6: 12, h24: 3 } }), P).score
    expect(moving).toBeGreaterThan(flat)
  })

  it('zero 24h volume does not divide by zero', () => {
    const dead = scoreOpportunity(base({ volumeUsd: { h1: 0, h6: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } } }), P)
    expect(dead.components.volumeExpansion).toBe(0)
    expect(dead.components.buyPressure).toBe(0)
    expect(Number.isFinite(dead.score)).toBe(true)
  })

  it('a cheap token outscores an expensive one, all else equal', () => {
    // 10% vs 72% of gross taken by the chain was a real measurement, not a hypothetical.
    const cheapScore = scoreOpportunity(base(), P, null, cheap)
    const dearScore = scoreOpportunity(base(), P, null, dear)
    expect(cheapScore.components.costEfficiency).toBeGreaterThan(dearScore.components.costEfficiency)
    expect(cheapScore.score).toBeGreaterThan(dearScore.score)
  })

  it('a toll past the worst round trip scores zero, not negative', () => {
    const brutal = { ...dear, spreadPct: 5, slippagePct: 10 }
    expect(scoreOpportunity(base(), P, null, brutal).components.costEfficiency).toBe(0)
  })

  it('weights are honoured: a policy that only values volume ignores everything else', () => {
    const volumeOnly = { ...P, weights: { volumeExpansion: 1, buyPressure: 0, liquidityGrowth: 0, activity: 0, volatility: 0, momentum: 0, headroom: 0, costEfficiency: 0 } }
    const burst = base({ volumeUsd: { h1: 3_000, h6: 8_000, h24: 24_000 }, priceChangePct: { h1: 50, h6: 50, h24: 50 } })
    expect(scoreOpportunity(burst, volumeOnly).score).toBeCloseTo(100, 9)
  })
})

describe('opportunity — direction, not only motion', () => {
  const rising = { h1: 8, h6: 20, h24: 40 }
  const falling = { h1: -8, h6: -20, h24: -40 }

  it('scores a token that is going UP above one that is going down', () => {
    // The score measured volatility — how much it MOVED — and never which way.
    // A token down 40% on the day and one up 40% looked identical to it, so the
    // shortlist was as happy to buy the knife as the climb.
    const up = scoreOpportunity(base({ priceChangePct: rising }), P, null, cheap)
    const down = scoreOpportunity(base({ priceChangePct: falling }), P, null, cheap)
    expect(up.score).toBeGreaterThan(down.score)
  })

  it('weights the RECENT hour above the day, because "lately" is the question', () => {
    // Up today but falling this hour is a top rolling over; down today but
    // rising this hour is a bottom turning. The second is the one worth buying,
    // and only a windowed weighting can tell them apart.
    const rollingOver = base({ priceChangePct: { h1: -8, h6: 5, h24: 40 } })
    const turning = base({ priceChangePct: { h1: 8, h6: -5, h24: -40 } })
    expect(scoreOpportunity(turning, P, null, cheap).components.momentum)
      .toBeGreaterThan(scoreOpportunity(rollingOver, P, null, cheap).components.momentum)
  })

  it('treats a flat token as neutral, not as bad', () => {
    // Zero movement is the absence of a reason either way. Scoring it as a
    // failure would push the book toward whatever moved most in any direction,
    // which is the bias this component exists to remove.
    const flat = scoreOpportunity(base({ priceChangePct: { h1: 0, h6: 0, h24: 0 } }), P, null, cheap)
    expect(flat.components.momentum).toBeCloseTo(0.5, 6)
  })

  it('treats an unreported window as neutral rather than as a fall', () => {
    // The same rule the whole scanner runs on: silence is not evidence. A
    // provider that omitted a window must not cost the token points.
    const silent = scoreOpportunity(base({ priceChangePct: { h1: null, h6: null, h24: null } }), P, null, cheap)
    expect(silent.components.momentum).toBeCloseTo(0.5, 6)
  })

  it('asks only WHETHER it rose, never by how much', () => {
    // The operator's correction, and it removes three invented numbers. There
    // is no percentage at which a rise becomes "a rise" — a threshold there
    // would be a guess wearing the clothes of a measurement. `volatility`
    // already carries the magnitude; together they say "moving, and upward".
    const gentle = scoreOpportunity(base({ priceChangePct: { h1: 0.4, h6: 0.4, h24: 0.4 } }), P, null, cheap)
    const violent = scoreOpportunity(base({ priceChangePct: { h1: 90, h6: 90, h24: 90 } }), P, null, cheap)
    expect(gentle.components.momentum).toBe(violent.components.momentum)
    expect(gentle.components.momentum).toBe(1)
  })

  it('lets the recent hour outvote the two longer windows together', () => {
    // Otherwise "lately" is decided by yesterday. A bottom turning up in the
    // last hour must beat a top that is still green on the day.
    const turning = base({ priceChangePct: { h1: 1, h6: -1, h24: -1 } })
    const rollingOver = base({ priceChangePct: { h1: -1, h6: 1, h24: 1 } })
    expect(scoreOpportunity(turning, P, null, cheap).components.momentum)
      .toBeGreaterThan(scoreOpportunity(rollingOver, P, null, cheap).components.momentum)
  })

  it('never exceeds its bounds, however violent the move', () => {
    const insane = scoreOpportunity(base({ priceChangePct: { h1: 900, h6: 900, h24: 900 } }), P, null, cheap)
    expect(insane.components.momentum).toBeLessThanOrEqual(1)
    const ruined = scoreOpportunity(base({ priceChangePct: { h1: -99, h6: -99, h24: -99 } }), P, null, cheap)
    expect(ruined.components.momentum).toBeGreaterThanOrEqual(0)
  })
})

describe('opportunity — how much room is left above it', () => {
  const rising = (h24: number) => base({ priceChangePct: { h1: 2, h6: 5, h24 } })

  it('prefers a riser that has not run far over one that already has', () => {
    // The operator's rule: the higher it already is, the more room there is to
    // fall. Both are going UP — the question is only how much of the move is
    // already behind us.
    const early = scoreOpportunity(rising(5), P, null, cheap)
    const extended = scoreOpportunity(rising(120), P, null, cheap)
    expect(early.components.headroom).toBeGreaterThan(extended.components.headroom)
    expect(early.score).toBeGreaterThan(extended.score)
  })

  it('has no hard threshold — it decays smoothly and never reaches zero', () => {
    // A cut-off would be the same invented number this component was written to
    // avoid. `headroomHalvingPct` sets how fast it separates two risers, and
    // the curve stays monotone at every size.
    expect(scoreOpportunity(rising(0), P, null, cheap).components.headroom).toBeCloseTo(1, 6)
    expect(scoreOpportunity(rising(P.headroomHalvingPct), P, null, cheap).components.headroom).toBeCloseTo(0.5, 6)
    expect(scoreOpportunity(rising(3 * P.headroomHalvingPct), P, null, cheap).components.headroom).toBeCloseTo(0.25, 6)
  })

  it('separates two risers by enough to matter, not merely enough to break a tie', () => {
    // Measured: at the first settings a token up 10% and one up 60% were 1.27
    // points apart, which loses to any other component that disagrees. The
    // operator asked for more, so the curve got steeper and the weight larger —
    // five points now, which survives a difference of opinion elsewhere.
    const early = scoreOpportunity(rising(10), P, null, cheap).score
    const extended = scoreOpportunity(rising(60), P, null, cheap).score
    expect(early - extended).toBeGreaterThan(4)
  })

  it('does NOT reward a token for being low while falling', () => {
    // "Low" and "cheap" are not the same claim. A token down 40% and still
    // sinking has plenty of room above it and is precisely the knife the
    // momentum component exists to avoid — so this stays neutral rather than
    // handing it the bonus for being far from its high.
    const knife = base({ priceChangePct: { h1: -5, h6: -20, h24: -40 } })
    expect(scoreOpportunity(knife, P, null, cheap).components.headroom).toBeCloseTo(0.5, 6)
  })

  it('is neutral when the recent window says nothing', () => {
    const silent = base({ priceChangePct: { h1: null, h6: null, h24: null } })
    expect(scoreOpportunity(silent, P, null, cheap).components.headroom).toBeCloseTo(0.5, 6)
  })
})
