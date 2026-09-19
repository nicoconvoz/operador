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
  it('a steady, balanced, quiet token reports neutral components and sits between the extremes', () => {
    const { score, components } = scoreOpportunity(base(), P)
    expect(components.volumeExpansion).toBeCloseTo(1 / 3, 9) // ratio 1 of 3
    expect(components.buyPressure).toBe(0)
    expect(components.liquidityGrowth).toBeCloseTo(0.5, 9) // no previous → ratio 1
    expect(components.volatility).toBe(0)
    // Flat is not positive, so the trend reads zero — the operator's rule.
    expect(components.momentum).toBe(0) // flat in every window → no reason either way
    expect(components.headroom).toBe(1) // flat is not a collapse, and the hour only asks about that
    expect(components.costEfficiency).toBe(0.5) // unmeasured → neutral, never generous

    // The score used to be asserted BELOW 50 here, and that number was a
    // consequence of eight weighted terms rather than a decision. Three carry
    // it now — *tendencia reciente alcista 50%, sube en una hora 30%,
    // eficiencia de costos 30%* — and two of them are neutral by construction
    // on a token like this, so any absolute bound would be pinning arithmetic
    // that the next weight change moves again.
    //
    // What survives the change is an ORDERING, which is the actual claim: a
    // quiet token is worth strictly less than the same token climbing and
    // strictly more than the same token falling out from under us.
    const climbing = scoreOpportunity(base({ priceChangePct: { h1: 5, h6: 5, h24: 5 } }), P).score
    const collapsing = scoreOpportunity(base({ priceChangePct: { h1: -30, h6: -30, h24: -30 } }), P).score
    expect(score).toBeLessThan(climbing)
    expect(score).toBeGreaterThan(collapsing)
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

describe('opportunity — the components still move the right way, weighed or not', () => {
  // The operator cut the score down to three terms: *tendencia reciente
  // alcista +50%, sube en una hora +30% y eficiencia de costos +30%, esa va a
  // ser la única regla.* The other five are still COMPUTED and still drawn —
  // the dashboard's detail sheet renders every component as a bar so "why is
  // this ranked here" is answerable without reading code — they simply no
  // longer move the total.
  //
  // So these tests moved down one level rather than being deleted. Their
  // subject was always the MEASUREMENT; asserting it through the score was a
  // convenience that stopped being available, and a measurement nobody checks
  // is a bar on a screen that can quietly start lying.

  it('a volume burst raises volumeExpansion, and no longer moves the score', () => {
    const steady = scoreOpportunity(base(), P)
    const burst = scoreOpportunity(base({ volumeUsd: { h1: 3_000, h6: 8_000, h24: 24_000 } }), P)
    expect(burst.components.volumeExpansion).toBeGreaterThan(steady.components.volumeExpansion)
    // Tripling the hourly run-rate is the full-expansion case, so the bar goes
    // to the top of the screen — and the total does not move by a point.
    expect(burst.components.volumeExpansion).toBe(1)
    expect(burst.score).toBe(steady.score)
  })

  it('buyers outnumbering sellers raises buyPressure; sellers dominating floors it at neutral', () => {
    const neutral = scoreOpportunity(base(), P)
    const buying = scoreOpportunity(base({ txns: { h1: { buys: 18, sells: 2 }, h24: { buys: 240, sells: 240 } } }), P)
    const selling = scoreOpportunity(base({ txns: { h1: { buys: 2, sells: 18 }, h24: { buys: 240, sells: 240 } } }), P)
    expect(buying.components.buyPressure).toBeGreaterThan(neutral.components.buyPressure)
    // Only the EXCESS over an even split counts, so a book of sellers reads as
    // "no buying pressure" rather than as a negative — the component has no
    // way to say "actively bad" and must not pretend otherwise.
    expect(selling.components.buyPressure).toBe(0)
    expect(buying.score).toBe(neutral.score)
  })

  it('growing liquidity still separates from draining liquidity, and neither moves the score', () => {
    const previous = base({ liquidityUsd: 100_000 })
    const growing = scoreOpportunity(base({ liquidityUsd: 150_000 }), P, previous)
    const draining = scoreOpportunity(base({ liquidityUsd: 60_000 }), P, previous)
    expect(growing.components.liquidityGrowth).toBe(1)
    expect(draining.components.liquidityGrowth).toBeCloseTo(0.1, 9)
    expect(growing.score).toBe(draining.score)
  })

  it('reads motion as volatility whichever way it goes — and the score now asks WHICH way', () => {
    // This test used to say "a moving price scores higher than a flat one —
    // the ladder needs drops to work", and the operator's rule reversed the
    // second half of that sentence. Motion is no longer worth anything on its
    // own; direction is worth half the score.
    //
    // The pair below is the cleanest statement of both facts at once: the same
    // absolute move, up and down, is the SAME volatility — the component is
    // blind to direction by design, and that blindness is exactly why it could
    // not be allowed to carry weight — while the scores are as far apart as
    // this scanner can put two tokens.
    const flat = scoreOpportunity(base(), P)
    const up = scoreOpportunity(base({ priceChangePct: { h1: 8, h6: 12, h24: 3 } }), P)
    const down = scoreOpportunity(base({ priceChangePct: { h1: -8, h6: -12, h24: -3 } }), P)
    expect(up.components.volatility).toBeGreaterThan(flat.components.volatility)
    expect(down.components.volatility).toBe(up.components.volatility)
    expect(up.score).toBeGreaterThan(down.score)
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
  it('treats the DAY and the HOUR as equals, which they were not', () => {
    // The three tests that stood here asserted a weighting: 0.6 on the hour,
    // 0.25 on six, 0.15 on the day, with the hour able to outvote the other
    // two together. All of it is gone. The windows are symmetric now and
    // either one answering yes is enough — the operator's rule, chosen from
    // six measured readings, and the only one of the six that opened the book
    // rather than closing it further.
    const up = (h1: number | null, h24: number | null) =>
      scoreOpportunity(base({ priceChangePct: { h1, h6: null, h24 } }), P, null, cheap).components.momentum
    expect(up(5, null)).toBe(up(null, 5))
    expect(up(5, -50)).toBe(1)
    expect(up(-50, 5)).toBe(1)
  })

  it('asks for a full percent, because drift is not a rise', () => {
    // It used to ask only WHETHER, at any size at all. These pools move 0.9%
    // standing still, so a threshold is what separates a move from the noise.
    const up = (h1: number) =>
      scoreOpportunity(base({ priceChangePct: { h1, h6: null, h24: null } }), P, null, cheap).components.momentum
    expect(up(0.9)).toBe(0)
    expect(up(P.minRisePct)).toBe(1)
  })

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


  it('treats a FLAT token as not-up, which is not the same as bad', () => {
    // Zero movement is the absence of a reason either way. Scoring it as a
    // failure would push the book toward whatever moved most in any direction,
    // which is the bias this component exists to remove.
    const flat = scoreOpportunity(base({ priceChangePct: { h1: 0, h6: 0, h24: 0 } }), P, null, cheap)
    expect(flat.components.momentum).toBe(0)
  })

  it('treats an unreported hour as not-up either — nobody said it rose', () => {
    // The same rule the whole scanner runs on: silence is not evidence. A
    // provider that omitted a window must not cost the token points.
    const silent = scoreOpportunity(base({ priceChangePct: { h1: null, h6: null, h24: null } }), P, null, cheap)
    expect(silent.components.momentum).toBe(0)
  })



  it('never exceeds its bounds, however violent the move', () => {
    const insane = scoreOpportunity(base({ priceChangePct: { h1: 900, h6: 900, h24: 900 } }), P, null, cheap)
    expect(insane.components.momentum).toBeLessThanOrEqual(1)
    const ruined = scoreOpportunity(base({ priceChangePct: { h1: -99, h6: -99, h24: -99 } }), P, null, cheap)
    expect(ruined.components.momentum).toBeGreaterThanOrEqual(0)
  })
})

describe('opportunity — activity is measured and drawn, and no longer weighed', () => {
  // It WAS the other pillar, at 32.5% and then at 51.5% of the score, and the
  // operator retired it with the other four: *tendencia reciente alcista +50%,
  // sube en una hora +30% y eficiencia de costos +30%, esa va a ser la única
  // regla.*
  //
  // The measurement stays, and keeping these tests is the reason it can. "Is
  // anyone trading this pool" did not stop mattering — it is asked by the
  // GATES instead (`minHourlyTxns` at 4, `minTurnoverRatio`, `staleBars`),
  // where a failure refuses a token outright rather than docking it points.
  // A door is stricter than a weight, which is the same trade the toll made
  // when it moved to `minComponents`.
  const traded = (perHour: number) =>
    base({ txns: { h1: { buys: Math.round(perHour * 0.6), sells: Math.round(perHour * 0.4) }, h24: { buys: 800, sells: 700 } } })

  it('keeps separating pools well past the old flat ceiling', () => {
    // It was `txns / 60` flat, so a pool with sixty trades an hour and one with
    // five hundred read IDENTICALLY — every difference above the cap was
    // invisible, which is the opposite of "more activity is worth more".
    //
    // Asserted on the component now that the weight is zero. The claim was
    // never really about the total: it is that the CURVE has no ceiling, and
    // that is what the bar on the detail sheet is drawn from.
    const at = (n: number) => scoreOpportunity(traded(n), P, null, cheap).components.activity
    expect(at(100)).toBeGreaterThan(at(60))
    expect(at(200)).toBeGreaterThan(at(100))
  })

  it('has diminishing returns, so the first trades matter most', () => {
    // The distinction worth paying for is between DEAD and ALIVE, not between
    // very busy and slightly busier.
    const at = (n: number) => scoreOpportunity(traded(n), P, null, cheap).components.activity
    expect(at(25) - at(4)).toBeGreaterThan(at(200) - at(100))
  })

  it('separates a dead pool from a live one on the screen, not in the score', () => {
    // Both halves are the point, and the second is what the change cost.
    //
    // The component still tells a dead pool from a live one by almost its
    // whole range — the operator's reason for it survives intact: a pool
    // nobody is trading is one nobody will buy from us either. What is gone is
    // its vote. Four trades an hour and three hundred now produce the SAME
    // total, so the only thing standing between the book and a dead pool is
    // the gate, and this test says so out loud rather than leaving somebody to
    // find it from a frozen position.
    const dead = scoreOpportunity(traded(4), P, null, cheap)
    const alive = scoreOpportunity(traded(300), P, null, cheap)
    expect(alive.components.activity - dead.components.activity).toBeGreaterThan(0.9)
    expect(alive.score).toBe(dead.score)
  })
})

describe('opportunity — the toll a token charges is one of the three', () => {
  it('scores zero once the round trip eats two of the profits the exit asks for', () => {
    // `minProfitPct` is 2: the normal exit sells at avg_cost + 2%. The zero
    // point is DERIVED from that, not picked — a token whose round trip costs
    // two full targets has to double its own exit just to break even, and no
    // entry gate can promise that. It was 6%, three targets, where a toll that
    // already made the cycle unprofitable still scored two thirds.
    const twoTargets: MarketQuality = { ...cheap, spreadPct: 1.0, slippagePct: 1.0 }
    expect(scoreOpportunity(base(), P, null, twoTargets).components.costEfficiency).toBe(0)
  })

  it('is a minority of the score — the teeth are still the FLOOR, not the weight', () => {
    // The claim survives its third rewrite; only the arithmetic behind it has
    // moved. It read `costEfficiency < the four minor weights` while those
    // four existed; they are all zero now, so the same sentence has to be
    // said against what is left.
    //
    // Why it is still worth saying: the toll ran at 0.9 for a day and a
    // weighted average has ONE denominator, so weight added here was share
    // taken from every other term. The operator watched his whole shortlist
    // sink below the thresholds he reads it against and asked the right
    // question — what changed? Nothing in the market. Us.
    //
    // The toll's real teeth are in `minComponents`, and a floor is STRICTER
    // than any weight: an average can be carried by its other terms — which
    // is exactly how PURR was bought at a 15.55% round trip — and a floor
    // cannot be carried by anything.
    const w = P.weights
    const total = (Object.values(w) as number[]).reduce((sum, x) => sum + x, 0)
    expect(w.costEfficiency).toBeLessThan(w.momentum)
    expect(w.costEfficiency * 2).toBeLessThan(total)
  })

  it('separates a cheap token from its expensive twin, and still cannot outvote direction', () => {
    // Both halves matter, and the second is the operator's own ordering:
    // *tendencia reciente alcista +50%, sube en una hora +30% y eficiencia de
    // costos +30%.* The toll must MOVE the ranking — between two tokens the
    // gates let through, the cheaper one is worth more and the score should
    // say so — and it must not settle the question on its own.
    //
    // The upper bound used to be weight arithmetic against the four minor
    // terms, which are now zero, so it is stated where it actually bites
    // instead: the cheapest token in the book, drifting DOWN, loses to the
    // dearest one that is climbing. Headroom is 1 on both — a 2% drift is not
    // a collapse — so momentum against the toll is the only thing being
    // compared, which is what makes it an isolation rather than a vibe.
    const twins = scoreOpportunity(base(), P, null, cheap).score - scoreOpportunity(base(), P, null, dear).score
    expect(twins).toBeGreaterThan(0)

    const cheapDrifting = scoreOpportunity(base({ priceChangePct: { h1: -2, h6: 0, h24: 0 } }), P, null, cheap)
    const dearClimbing = scoreOpportunity(base({ priceChangePct: { h1: 8, h6: 8, h24: 8 } }), P, null, dear)
    expect(cheapDrifting.components.costEfficiency).toBeGreaterThan(dearClimbing.components.costEfficiency)
    expect(cheapDrifting.components.headroom).toBe(dearClimbing.components.headroom)
    expect(dearClimbing.score).toBeGreaterThan(cheapDrifting.score)
  })

  it('leaves THREE terms in the score, and the toll is one of them', () => {
    // It was briefly a third pillar, demoted the same day to a door, and the
    // operator has now put it back as one of exactly three: *esa va a ser la
    // única regla.* Five components are silent, and silent here means a
    // literal zero — they contribute nothing to the numerator AND nothing to
    // the denominator, so the score is a clean average of the three.
    //
    // The ORDER is the decision and an absolute score is its consequence, so
    // the order is what is pinned. Direction leads; the hour and the toll are
    // given the same share as each other; and the two of them together can
    // still outvote direction, which is what stops "it went up in the last
    // hour" from being the only thing this scanner can see.
    const w = P.weights
    for (const silent of [w.volumeExpansion, w.buyPressure, w.liquidityGrowth, w.activity, w.volatility]) {
      expect(silent).toBe(0)
    }
    expect(w.momentum).toBeGreaterThan(w.headroom)
    expect(w.momentum).toBeGreaterThan(w.costEfficiency)
    expect(w.headroom).toBe(w.costEfficiency)
    expect(w.headroom + w.costEfficiency).toBeGreaterThan(w.momentum)
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
  //
  // The NAME survived and now asks something else: *sube en una hora +30%.*
  // Binary over the last hour — 0 below `headroomMaxFallPct`, 1 above it, 0.5
  // when nobody reported the window — and weighted again at 0.3. So "how far
  // it has already run" really is gone; what carries weight under that name is
  // "has it just fallen out from under us", which is a different question with
  // a different answer on the same token.

  it('scores a token up 2000% exactly as one up 5%, all else equal', () => {
    const moving = { h1: 5, h6: 40 }
    const ran = scoreOpportunity(base({ priceChangePct: { ...moving, h24: 2_000 } }), P, null, cheap).score
    const fresh = scoreOpportunity(base({ priceChangePct: { ...moving, h24: 5 } }), P, null, cheap).score
    expect(ran).toBe(fresh)
  })

  it('weighs again under the same name, and a collapse costs exactly its share', () => {
    // It went to zero for a day and came back at 0.3 asking a different
    // question, which is why this test now asserts the opposite of what it
    // used to. The weight is only half the statement — the useful half is
    // WHAT it buys, and here that is isolated rather than argued.
    //
    // Both tokens below are falling, so `momentum` reads the same on each and
    // cancels out; `costEfficiency` is the same measured pool. The ONLY
    // difference is that one drifted 1% and the other fell through the -3%
    // line, and the distance between their scores is therefore exactly
    // headroom's whole share of the score — which is the arithmetic claim
    // "the weight is applied to this term and normalised by the total",
    // written as a ratio so no future weight change can make it a lie.
    const w = P.weights
    const total = (Object.values(w) as number[]).reduce((sum, x) => sum + x, 0)
    expect(w.headroom).toBeGreaterThan(0)

    const drifting = scoreOpportunity(base({ priceChangePct: { h1: -1, h6: 0, h24: 0 } }), P, null, cheap)
    const collapsing = scoreOpportunity(base({ priceChangePct: { h1: -10, h6: 0, h24: 0 } }), P, null, cheap)
    expect(collapsing.components.momentum).toBe(drifting.components.momentum)
    expect(drifting.components.headroom - collapsing.components.headroom).toBe(1)
    expect(drifting.score - collapsing.score).toBeCloseTo((w.headroom / total) * 100, 9)
  })

  it('still REPORTS a number the day it stops being weighed', () => {
    // The detail sheet draws every component as a bar so "why is this ranked
    // here" is answerable without reading code. Five of them weigh nothing
    // today and are drawn all the same, and this component has been on both
    // sides of that line inside a week — which is the argument for measuring
    // everything and weighing only what the operator asked for.
    //
    // Two values only now, because the question it answers is a yes/no.
    const climbing = scoreOpportunity(base({ priceChangePct: { h1: 20, h6: 40, h24: 150 } }), P, null, cheap)
    const collapsing = scoreOpportunity(base({ priceChangePct: { h1: -30, h6: 40, h24: 150 } }), P, null, cheap)
    expect(climbing.components.headroom).toBe(1)
    expect(collapsing.components.headroom).toBe(0)
  })

  it('leaves a score made of exactly three shares, none of them a majority — stated, not discovered later', () => {
    // The operator named them as percentages — *tendencia reciente alcista
    // +50%, sube en una hora +30% y eficiencia de costos +30%* — and they sum
    // to 110, not 100. A weighted average normalises by its own denominator,
    // so what he called 50% is 45.5% of the score and each 30% is 27.3%.
    //
    // Nothing is wrong with that: the ORDER is what he decided and the order
    // is exactly what was implemented. But "direction is half the score" is
    // the sentence everyone will repeat, and it is not true — direction is the
    // largest share and the other two together outvote it. That belongs
    // written down here rather than discovered from a shortlist nobody can
    // explain.
    //
    // The day somebody normalises the weights to 0.5/0.25/0.25 this test is
    // what will say the claim has changed, which is the whole reason it exists.
    const w = P.weights
    const total = (Object.values(w) as number[]).reduce((sum, x) => sum + x, 0)
    expect(w.momentum + w.headroom + w.costEfficiency).toBe(total)
    expect(w.momentum / total).toBeGreaterThan(w.headroom / total)
    expect(w.momentum / total).toBeLessThan(0.5)
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

  it('opens on the HOUR and on nothing else', () => {
    // It measured a DECAY once — how much of the run was already spent — and
    // the operator retired that outright. What is left is a door, and what
    // this can still say is that the door reads the hour and ignores the day.
    expect(hour(1.5, 2_000)).toBe(hour(1.5, 0))
    expect(hour(-30, 2_000)).toBe(0)
  })

  it('ignores the day entirely — it is the window that let everything through', () => {
    // Same hour, wildly different days, identical answer. That is the point:
    // the day is not evidence about a token that moves in minutes.
    expect(hour(3, 0)).toBe(hour(3, 500))
  })

  it('gives a COLLAPSING token nothing, and tolerates a drift', () => {
    // -3% is the operator's line. Above it the token is still a token; below
    // it the hour is an exit in progress.
    expect(hour(-30)).toBe(0)
    expect(hour(-1)).toBe(1)
    expect(hour(0)).toBe(1)
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
    expect(hour(-30)).toBe(0)
  })

  it('refuses a COLLAPSE and nothing else', () => {
    expect(hour(-P.headroomMaxFallPct - 0.01)).toBe(0)
    expect(hour(-30)).toBe(0)
    expect(hour(0.1)).toBe(1)
  })

  it('still calls an unreported hour silence', () => {
    expect(scoreOpportunity(base({ priceChangePct: { h1: null, h6: 5, h24: 10 } }), P, null, cheap).components.headroom)
      .toBeCloseTo(0.5, 6)
  })
})

describe('opportunity — the hour asks that it has NOT collapsed', () => {
  // The operator's calibration, and it is the right question: *ponele que no
  // haya descendido más del -3% en la última hora.*
  //
  // Asking for a RISE of more than 1% was too strict, and measurably so: of 84
  // live Solana tokens only 37% cleared it, so the floor — not the score door
  // — was what kept the book at seven positions while he had run thirty-one.
  // Lowering minScore from 50 to 25 could not compensate, because the score
  // was never what was cutting.
  //
  // Asking that it has not COLLAPSED keeps 75% of the same sample, 68% once
  // momentum has its say. The rule stops being "is it going up right now",
  // which is a snapshot of one instant, and becomes "is it not falling out
  // from under us", which is what a door is actually for.

  const hour = (h1: number | null) =>
    scoreOpportunity(base({ priceChangePct: { h1, h6: 5, h24: 10 } }), P, null, cheap).components.headroom

  it('admits anything that is not collapsing, rising or not', () => {
    for (const change of [50, 5, 1, 0, -1, -2.9, -P.headroomMaxFallPct]) expect(hour(change)).toBe(1)
  })

  it('refuses a token falling harder than the limit', () => {
    expect(hour(-3.01)).toBe(0)
    expect(hour(-10)).toBe(0)
    expect(hour(-60)).toBe(0)
  })

  it('still has NO ceiling — a bigger rise is never a reason to refuse', () => {
    expect(hour(2_000)).toBe(1)
  })

  it('still calls an unreported hour silence, never a crash', () => {
    expect(hour(null)).toBeCloseTo(0.5, 6)
  })

  it('is looser than the momentum floor it sits beside, on purpose', () => {
    // They answer different questions and the overlap is the point: momentum
    // asks which WAY it has been going across three windows, this asks only
    // that the most recent one has not fallen out. A token drifting down 2% in
    // the hour is still a token; one down 30% is an exit in progress.
    expect(hour(-2)).toBe(1)
    expect(scoreOpportunity(base({ priceChangePct: { h1: -2, h6: -5, h24: -20 } }), P, null, cheap).components.momentum)
      .toBeLessThan(0.3)
  })
})

describe('opportunity — up in the DAY or up in the HOUR', () => {
  // The operator's rule, chosen from six measured readings of his own phrase:
  // *que mire las últimas 24 horas y detecte que haya subido por lo menos 1%
  // desde la última vela y la de la última hora.*
  //
  // Measured over 174 tokens the machine could actually operate:
  //
  //   hoy: la hora > 0                  64 = 37%
  //   la hora >= 1%                     34 = 20%
  //   el dia >= 1%                     120 = 69%
  //   el dia >= 1% Y la hora > 0        42 = 24%
  //   el dia >= 1% Y la hora >= 1%      20 = 11%
  //   el dia >= 1% O la hora >= 1%     134 = 77%   <- this one
  //
  // The readings with AND close harder than the rule they replace; only the OR
  // opens. More than double what the hour alone admitted.
  //
  // It also makes the two floors say different things for the first time.
  // `momentum` asks whether it rose ANYWHERE, `headroom` whether it is not
  // collapsing RIGHT NOW — a token up 5% on the day and down 10% in the hour
  // passes the first and fails the second, which is exactly the case neither
  // could express while both read the same window.

  const trend = (h1: number | null, h24: number | null) =>
    scoreOpportunity(base({ priceChangePct: { h1, h6: null, h24 } }), P, null, cheap).components.momentum

  it('admits a token up on the DAY even when the hour is flat', () => {
    expect(trend(0, 5)).toBe(1)
    expect(trend(-0.5, 40)).toBe(1)
  })

  it('admits a token up in the HOUR even when the day is down', () => {
    // A bottom turning: the day is a record of what already happened and the
    // hour is what is happening.
    expect(trend(3, -20)).toBe(1)
  })

  it('refuses one that rose in neither', () => {
    expect(trend(0, 0)).toBe(0)
    expect(trend(-5, -30)).toBe(0)
    expect(trend(0.5, 0.5)).toBe(0)
  })

  it('asks for a full percent in whichever window it uses', () => {
    // Drift is not a rise. 0.9% either way is inside the noise these pools
    // make standing still.
    expect(trend(0.9, 0.9)).toBe(0)
    expect(trend(1, 0)).toBe(1)
    expect(trend(0, 1)).toBe(1)
  })

  it('does NOT read silence as a rise, in either window', () => {
    // Nobody said it went up, so it did not. Unchanged from the hour-only
    // rule, and the one place this file departs from "silence is not
    // evidence" — the operator's rule is what departs.
    expect(trend(null, null)).toBe(0)
    expect(trend(null, 5)).toBe(1)
    expect(trend(5, null)).toBe(1)
  })
})
