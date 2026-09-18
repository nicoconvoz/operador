import { describe, it, expect } from 'vitest'
import { DEFAULT_OPPORTUNITY_POLICY as P, meetsMinimums, scoreOpportunity } from './opportunity.js'
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

  it('runs from full to empty, and stays empty past the end', () => {
    expect(scoreOpportunity(rising(0), P, null, cheap).components.headroom).toBeCloseTo(1, 6)
    expect(scoreOpportunity(rising(P.headroomFullyRunPct), P, null, cheap).components.headroom).toBeCloseTo(0, 6)
    // Fully spent is fully spent: a token up 400% is not worse than one up 200%
    // in any way this component can measure, and a negative would be a claim.
    expect(scoreOpportunity(rising(2 * P.headroomFullyRunPct), P, null, cheap).components.headroom).toBeCloseTo(0, 6)
  })

  it('is LOGARITHMIC: the first percent of a run costs more than the last', () => {
    // The operator's shape, and the reason is asymmetry. Eating a 70% fall is
    // ruinous; taking a 25% gain and moving on is fine. So the distinction
    // worth paying for is between BARELY MOVED and ALREADY RAN — up near the
    // top one more percent says very little.
    const at = (pct: number) => scoreOpportunity(rising(pct), P, null, cheap).components.headroom
    const early = at(0) - at(25)
    const late = at(175) - at(200)
    expect(early).toBeGreaterThan(late * 3)
  })

  it('costs a token most of the score to have run all the way', () => {
    // The operator asked for +200% to land near thirty, and that is what set
    // the WEIGHT rather than the curve: a component moves the score only within
    // its share of the weights.
    //
    // The ABSOLUTE number is not pinned here, and cannot be, because two more
    // pillars arrived afterwards — `activity`, then the toll. A score is a
    // weighted AVERAGE, so every pillar added takes share from the ones already
    // there: headroom went 37.0% → 30.2% of the weights, and its reach fell
    // with it. That is arithmetic, not a change of mind.
    //
    // What the operator actually decided survives and is asserted below: of
    // the eight components, headroom is still the LARGEST. What survives here
    // is the SPREAD — running all the way is still the biggest single thing
    // that can happen to a score.
    const fresh = scoreOpportunity(rising(0), P, null, cheap).score
    const spent = scoreOpportunity(rising(P.headroomFullyRunPct), P, null, cheap).score
    expect(fresh - spent).toBeGreaterThan(28)
  })

  it('gives a FALLING token no headroom at all, not a neutral half', () => {
    // It was 0.5 — neutral — so as not to reward a knife for being far from its
    // high. That was right while the weight was small and wrong once headroom
    // became the largest term: measured live, RICHDEBT was down 64% on the day
    // with momentum at zero and still scored 52.5, because neutral on the
    // biggest component is a gift rather than an abstention.
    //
    // The question this asks is "how much of the upside is left". A token going
    // the wrong way has NONE of it — that is not punishing the fall twice, it is
    // the honest answer to the question.
    const knife = base({ priceChangePct: { h1: -5, h6: -20, h24: -40 } })
    expect(scoreOpportunity(knife, P, null, cheap).components.headroom).toBe(0)
  })

  it('drops a crashed token far below a rising one', () => {
    const knife = base({ priceChangePct: { h1: -5, h6: -20, h24: -64 } })
    const climbing = base({ priceChangePct: { h1: 2, h6: 5, h24: 10 } })
    expect(scoreOpportunity(climbing, P, null, cheap).score - scoreOpportunity(knife, P, null, cheap).score)
      .toBeGreaterThan(28)
  })

  it('is neutral when the recent window says NOTHING, which is not the same as falling', () => {
    // Silence is not evidence — the rule the whole scanner runs on. An
    // unreported window must not be read as a crash.
    const silent = base({ priceChangePct: { h1: null, h6: null, h24: null } })
    expect(scoreOpportunity(silent, P, null, cheap).components.headroom).toBeCloseTo(0.5, 6)
  })
})

describe('opportunity — activity is the other pillar', () => {
  const traded = (perHour: number) =>
    base({ txns: { h1: { buys: Math.round(perHour * 0.6), sells: Math.round(perHour * 0.4) }, h24: { buys: 800, sells: 700 } } })

  it('keeps paying for more trades well past the old ceiling', () => {
    // It was `txns / 60` flat, so a pool with sixty trades an hour and one with
    // five hundred scored IDENTICALLY — every difference above the cap was
    // invisible to the ranking, which is the opposite of "more activity is
    // worth more".
    expect(scoreOpportunity(traded(100), P, null, cheap).score)
      .toBeGreaterThan(scoreOpportunity(traded(60), P, null, cheap).score)
    expect(scoreOpportunity(traded(200), P, null, cheap).score)
      .toBeGreaterThan(scoreOpportunity(traded(100), P, null, cheap).score)
  })

  it('has diminishing returns, so the first trades matter most', () => {
    // The same shape as `headroom` and for the same reason: the distinction
    // worth paying for is between DEAD and ALIVE, not between very busy and
    // slightly busier.
    const at = (n: number) => scoreOpportunity(traded(n), P, null, cheap).components.activity
    expect(at(25) - at(4)).toBeGreaterThan(at(200) - at(100))
  })

  it('separates a dead pool from a live one by enough to decide a ranking', () => {
    // The operator's rule. A pool nobody is trading is one nobody will buy from
    // us either — which is the death watch's whole subject, met here at the
    // door instead of three hours into a position.
    const dead = scoreOpportunity(traded(4), P, null, cheap).score
    const alive = scoreOpportunity(traded(300), P, null, cheap).score
    expect(alive - dead).toBeGreaterThan(25)
  })
})

describe('opportunity — the toll a token charges is the third pillar', () => {
  it('scores zero once the round trip eats two of the profits the exit asks for', () => {
    // `minProfitPct` is 2: the normal exit sells at avg_cost + 2%. The zero
    // point is DERIVED from that, not picked — a token whose round trip costs
    // two full targets has to double its own exit just to break even, and no
    // entry gate can promise that. It was 6%, three targets, where a toll that
    // already made the cycle unprofitable still scored two thirds.
    const twoTargets: MarketQuality = { ...cheap, spreadPct: 1.0, slippagePct: 1.0 }
    expect(scoreOpportunity(base(), P, null, twoTargets).components.costEfficiency).toBe(0)
  })

  it('weighs more than volume, buy pressure, liquidity growth and volatility COMBINED', () => {
    // At 0.2 of 3.08 the toll was 6.5% of the score: measurable, never
    // decisive. The operator's rule — heavily penalise the ones that charge a
    // lot, or we take losses we never had to take.
    const w = P.weights
    expect(w.costEfficiency).toBeGreaterThan(w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.volatility)
  })

  it('separates a cheap token from its expensive twin by more than those four can ever move', () => {
    // Pins the INTENT rather than a number: whatever the weights become, the
    // toll must be able to outvote everything except the two pillars.
    const weights = Object.values(P.weights) as number[]
    const total = weights.reduce((sum, x) => sum + x, 0)
    const four = P.weights.volumeExpansion + P.weights.buyPressure + P.weights.liquidityGrowth + P.weights.volatility
    const gap = scoreOpportunity(base(), P, null, cheap).score - scoreOpportunity(base(), P, null, dear).score
    expect(gap).toBeGreaterThan((four / total) * 100)
  })

  it('ranks the three pillars in the order the operator decided them', () => {
    // headroom ("es mas importante que todo"), then activity ("la otra pata"),
    // then the toll ("penaliza con poco puntaje los que cobren tanto"). This is
    // the durable statement: the absolute scale moves every time a pillar is
    // added, the ORDER is the decision.
    const w = P.weights
    expect(w.headroom).toBeGreaterThan(w.activity)
    expect(w.activity).toBeGreaterThan(w.costEfficiency)
    for (const other of [w.volumeExpansion, w.buyPressure, w.liquidityGrowth, w.volatility, w.momentum]) {
      expect(w.costEfficiency).toBeGreaterThan(other)
    }
  })

  it('still does not punish a toll NOBODY measured', () => {
    // Silence is not evidence — the rule the whole scanner runs on. Unlike a
    // falling token, whose headroom is genuinely zero, an unmeasured toll is
    // an absent answer and the safety gates already refuse to trade on one.
    expect(scoreOpportunity(base(), P).components.costEfficiency).toBe(0.5)
  })
})

describe('meetsMinimums — three floors, all of them mandatory', () => {
  // The operator's rule: if it does not have cost, headroom AND trend all above
  // thirty percent, it is not a coin to trade.
  //
  // A FLOOR, not a weight, and that is the whole point. The score is a weighted
  // average, so a token can be ruinous on one term and still rank well by being
  // good at the rest — PURR charged 15.55% a round trip, scored zero on cost,
  // and was bought anyway because everything else carried it. An average cannot
  // express "this one thing disqualifies you"; a floor can.
  //
  // Measured against a live book of 29: **8 survive**. Headroom rejects 16,
  // cost 8, trend 5.
  const floors = { costEfficiency: 0.3, headroom: 0.3, momentum: 0.3 }

  it('passes a token clear of all three', () => {
    expect(meetsMinimums({ costEfficiency: 0.58, headroom: 0.97, momentum: 1 }, floors)).toBe(true)
  })

  it('refuses one that is ruinous to trade however good the rest is', () => {
    // RAYCAT, live: a perfect 1.00 of headroom and 0.75 of trend, and a pool so
    // expensive that cost scores zero.
    expect(meetsMinimums({ costEfficiency: 0, headroom: 1, momentum: 0.75 }, floors)).toBe(false)
  })

  it('refuses one that has already run, or is falling', () => {
    // Bonk, live: cheap and liquid, headroom spent, trend against it.
    expect(meetsMinimums({ costEfficiency: 0.82, headroom: 0, momentum: 0.4 }, floors)).toBe(false)
  })

  it('refuses one going the wrong way even when it is cheap and has room', () => {
    expect(meetsMinimums({ costEfficiency: 0.9, headroom: 0.9, momentum: 0.2 }, floors)).toBe(false)
  })

  it('reads a MISSING component as failing, because the floors are a promise', () => {
    // An absent number is not a passing one. Everywhere else in this scanner
    // silence means "no verdict"; here the verdict was already asked for.
    expect(meetsMinimums({ headroom: 0.9, momentum: 0.9 }, floors)).toBe(false)
  })

  it('lets every token through when no floors are set', () => {
    expect(meetsMinimums({ costEfficiency: 0, headroom: 0, momentum: 0 }, undefined)).toBe(true)
  })
})
