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

  it('stays measurable and never decisive — the teeth are the FLOOR, not the weight', () => {
    // REVERSED on purpose, and the reason is worth more than the number.
    //
    // It ran at 0.9 for a day and the arithmetic of a weighted average made
    // that expensive everywhere: ONE denominator, so weight added here is
    // share taken from every other term. The operator watched his whole
    // shortlist sink below the thresholds he reads it against and asked the
    // right question — what changed? Nothing in the market. Us.
    //
    // The toll's real teeth moved to `minComponents`, and a floor is
    // STRICTER than the weight ever was: an average can be carried by the
    // other terms — which is exactly how PURR was bought at a 15.55% round
    // trip — and a floor cannot be carried by anything.
    const w = P.weights
    expect(w.costEfficiency).toBeLessThan(w.volumeExpansion + w.buyPressure + w.liquidityGrowth + w.volatility)
  })

  it('separates a cheap token from its expensive twin, but does not decide between them', () => {
    // Both halves matter. The toll must still MOVE the ranking — between two
    // tokens the gates let through, the cheaper one is worth more and the
    // score should say so. What it must not do is settle the question on its
    // own, because the question "is this too expensive to trade" already has
    // a better answer that no amount of other merit can talk round.
    const weights = Object.values(P.weights) as number[]
    const total = weights.reduce((sum, x) => sum + x, 0)
    const four = P.weights.volumeExpansion + P.weights.buyPressure + P.weights.liquidityGrowth + P.weights.volatility
    const gap = scoreOpportunity(base(), P, null, cheap).score - scoreOpportunity(base(), P, null, dear).score
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThan((four / total) * 100)
  })

  it('leaves ONE pillar in the score, and the toll is not it', () => {
    // headroom ("es mas importante que todo") then activity ("la otra pata")
    // are what the score is mostly made of, and that survives. The toll was
    // briefly promoted to a third and demoted again the same day: it is a
    // question of ADMISSION, not of ranking, and the two are answered in
    // different places on purpose.
    //
    // This is the durable statement. An absolute score moves every time a
    // weight does; the ORDER is the decision.
    // `headroom` was the other one and the operator retired it outright, so
    // `activity` is now alone at the top — and with more than half the score,
    // which is stated in its own test rather than left to be discovered.
    const w = P.weights
    expect(w.headroom).toBe(0)
    for (const other of [w.volumeExpansion, w.buyPressure, w.liquidityGrowth, w.volatility, w.momentum, w.costEfficiency]) {
      expect(w.activity).toBeGreaterThan(other)
    }
    expect(w.costEfficiency).toBeLessThan(w.activity)
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

describe('opportunity — how far it has ALREADY run is no longer an argument', () => {
  // The operator's reversal, and his reason is the thesis this system was
  // built on: *una moneda de estas puede subir 2000% y nos estamos perdiendo
  // una oportunidad.* `headroom` answered "how much of the rise is still
  // ahead", and on a micro-cap that answer was a bet the move was over.
  //
  // It was not a small term. At 1.14 it was the LARGEST weight in the score
  // and its 0.3 floor refused every token up more than about 95% on the day —
  // which is precisely the shape of the runner this book exists to catch.
  //
  // What replaces it is not nothing. The 24h change still refuses a token, in
  // one direction only: `maxDailyFallPct` (15) is a gate on the FALL. A token
  // going the wrong way is an exit in progress; one going the right way, however
  // violently, is the trade.

  it('scores a token up 2000% exactly as one up 5%, all else equal', () => {
    const moving = { h1: 5, h6: 40 }
    const ran = scoreOpportunity(base({ priceChangePct: { ...moving, h24: 2_000 } }), P, null, cheap).score
    const fresh = scoreOpportunity(base({ priceChangePct: { ...moving, h24: 5 } }), P, null, cheap).score
    expect(ran).toBe(fresh)
  })

  it('carries no weight at all, so nothing it reports can move a ranking', () => {
    expect(P.weights.headroom).toBe(0)
  })

  it('still REPORTS the number, because a diagnostic is not a verdict', () => {
    // Kept on the screen and out of the arithmetic. The detail sheet draws the
    // components as bars so "why is this ranked here" is answerable without
    // reading code, and deleting the measurement would answer it with silence.
    // Reported on the detail sheet, worth nothing in the score. Two values
    // only now, because the question it answers is a yes/no.
    const climbing = scoreOpportunity(base({ priceChangePct: { h1: 20, h6: 40, h24: 150 } }), P, null, cheap)
    const drifting = scoreOpportunity(base({ priceChangePct: { h1: 0.2, h6: 40, h24: 150 } }), P, null, cheap)
    expect(climbing.components.headroom).toBe(1)
    expect(drifting.components.headroom).toBe(0)
  })

  it('leaves activity as what the score is now mostly made of — stated, not discovered later', () => {
    // Removing the largest weight does not leave a neutral score: it hands the
    // majority to whatever was second. Total weights fall 3.08 -> 1.94 and
    // `activity` goes from 32.5% to 51.5% of the score, so "is anyone trading
    // it" is now more than half the answer. That is a consequence of the
    // operator's decision, and it belongs written down rather than found.
    const w = P.weights
    const total = (Object.values(w) as number[]).reduce((sum, x) => sum + x, 0)
    expect(w.activity / total).toBeGreaterThan(0.5)
    expect(w.activity).toBeGreaterThan(w.costEfficiency)
  })
})

describe('opportunity — the run ahead is measured over the HOUR, not the day', () => {
  // The operator's argument, and it is the same class of error this project
  // already paid for with `dropInitPct`: *de qué me sirve una ventana tan
  // grande de un día en tokens que cambian en minutos... el día cuela todo.*
  //
  // A parameter calibrated for one window stops meaning what it meant when the
  // window changes. `headroom` asked "how much of the rise is still ahead" and
  // asked it of the DAY, on an engine trading 15-minute bars — so a token that
  // moved this morning and has been flat since read as fully spent, and one
  // that is running right now read as fresh.
  //
  // Measured across 72 live Solana pools over $50k of liquidity: of those
  // RISING in the last hour, the median moves +1.45%, p90 is +11.56% and p95
  // is +23.42%. 36% are flat or falling. The curve is derived from exactly
  // that — knee at the p75 (4%), fully run at the p95 (25%) — rather than
  // carried over from a window it was never measured on.

  const hour = (h1: number | null, h24 = 0) =>
    scoreOpportunity(base({ priceChangePct: { h1, h6: 0, h24 } }), P, null, cheap).components.headroom

  it('gives a token that RAN ALL DAY but is only drifting now its room back', () => {
    // The whole reason the operator retired the daily version: *una moneda de
    // estas puede subir 2000% y nos estamos perdiendo una oportunidad.* Up
    // 2000% on the day scored ZERO and was refused; up 2% in the hour is a
    // token with almost all of its next move still ahead of it.
    expect(hour(2, 2_000)).toBeGreaterThan(0.7)
  })

  it('opens the moment the HOUR is moving, whatever the day did', () => {
    // It used to measure a DECAY — how much of the run was already spent — and
    // the operator retired that outright: *sacale el techo.* What is left is a
    // door, so what this can still say is that the door opens on the hour and
    // on nothing else.
    expect(hour(1.5)).toBe(1)
    expect(hour(20)).toBe(1)
    expect(hour(0.5)).toBe(0)
  })

  it('ignores the day entirely — it is the window that let everything through', () => {
    // Same hour, wildly different days, identical answer. That is the point:
    // the day is not evidence about a token that moves in minutes.
    expect(hour(3, 0)).toBe(hour(3, 500))
  })

  it('still gives a token going the wrong way NOTHING', () => {
    expect(hour(-1)).toBe(0)
    expect(hour(0)).toBe(0)
  })

  it('still treats an unreported hour as silence, never as a crash', () => {
    expect(hour(null)).toBeCloseTo(0.5, 6)
  })

  it('has NO ceiling — a bigger move is never a reason to refuse', () => {
    // The operator, twice: *sacale el techo.* An earlier version of this test
    // asserted the opposite, that +13% in an hour closed the door. That was
    // the last of "how much of the move is already spent", and it refused a
    // token for the one property this book is looking for.
    expect(hour(11)).toBe(1)
    expect(hour(13)).toBe(1)
    expect(hour(300)).toBe(1)
  })
})

describe('opportunity — a whisker above zero is not a rise', () => {
  // The operator's number, and it closes a cliff I had just flagged: the
  // direction branch was a hard edge at exactly 0%, so USELESS sat at +0.1%
  // in the hour scoring 0.984 — one hundredth of a percent from 0.000, which
  // is the entire range of the component. A position oscillating there would
  // be rotated out and bought back every half hour, paying its round trip
  // each time.
  //
  // At +1% the edge sits on a move rather than on noise. Measured on the same
  // 72-pool sample, the median riser moves +1.45%, so this asks for about what
  // an ordinary climbing token is already doing.
  //
  // The admitted band is now stateable in one line: UP between 1% and about
  // 12% in the hour. Below it nothing is happening; above it the move already
  // happened and what we would buy is its top.

  const hour = (h1: number) =>
    scoreOpportunity(base({ priceChangePct: { h1, h6: 5, h24: 10 } }), P, null, cheap).components.headroom

  it('gives nothing to a token drifting inside the noise', () => {
    expect(hour(0.1)).toBe(0)
    expect(hour(0.9)).toBe(0)
    expect(hour(P.headroomMinRisePct)).toBe(0)
  })

  it('opens the moment the rise is real', () => {
    expect(hour(1.5)).toBeGreaterThan(0.3)
    expect(hour(4)).toBeGreaterThan(0.3)
  })

  it('asks for about what an ordinary climbing token already does', () => {
    // The live median riser is +1.45%. A threshold above it would refuse the
    // typical token outright, which is a different rule from "ignore noise".
    expect(P.headroomMinRisePct).toBeLessThan(1.45)
  })

  it('keeps a falling token and an unreported hour telling their own stories', () => {
    expect(hour(-3)).toBe(0)
    expect(scoreOpportunity(base({ priceChangePct: { h1: null, h6: 5, h24: 10 } }), P, null, cheap).components.headroom)
      .toBeCloseTo(0.5, 6)
  })
})

describe('opportunity — above the threshold there is NO ceiling', () => {
  // *Sacale el techo.* The operator, twice, and it finishes the argument he
  // started this morning: *una moneda de estas puede subir 2000% y nos estamos
  // perdiendo una oportunidad.*
  //
  // The decay was the last of "how much of the move is already spent", and
  // that question is now answered by nobody — on purpose. It refused a token
  // for the crime of moving, which is the one property this book is looking
  // for. What is left is a single yes/no: **is it climbing meaningfully in the
  // last hour.**
  //
  // So the component is BINARY, and that is the honest shape for a door. The
  // curve, its knee and its fully-run point are gone rather than left in the
  // policy doing nothing — a number nobody can justify is a bug waiting.

  const hour = (h1: number) =>
    scoreOpportunity(base({ priceChangePct: { h1, h6: 5, h24: 10 } }), P, null, cheap).components.headroom

  it('never refuses a token for having moved too much', () => {
    for (const rise of [1.5, 12, 25, 60, 200, 2_000]) expect(hour(rise)).toBe(1)
  })

  it('answers exactly one question, so the answer has exactly two values', () => {
    expect(new Set([hour(1.01), hour(5), hour(500)]).size).toBe(1)
    expect(hour(0.5)).toBe(0)
  })

  it('still refuses the noise, the fall and nothing else', () => {
    expect(hour(P.headroomMinRisePct)).toBe(0)
    expect(hour(0.1)).toBe(0)
    expect(hour(-4)).toBe(0)
  })

  it('still calls an unreported hour silence', () => {
    expect(scoreOpportunity(base({ priceChangePct: { h1: null, h6: 5, h24: 10 } }), P, null, cheap).components.headroom)
      .toBeCloseTo(0.5, 6)
  })
})
