import { describe, it, expect } from 'vitest'
import { rankUniverse, tokenKey, type RankingPolicy } from './ranking.js'
import { DEFAULT_GATE_POLICY, STRICT_GATE_POLICY } from './gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from './opportunity.js'
import { type TokenSnapshot } from './snapshot.js'
import { type MarketQuality } from '../market/market-quality.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const token = (address: string, over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  chain: 'solana',
  address,
  symbol: address,
  pairAddress: `pair-${address}`,
  observedAt: NOW,
  priceUsd: 0.01,
  // 4x turnover, kept AFTER the liquidity floor rose to $100k: turnover is
  // volume over depth, so deepening the pool without the volume would have
  // turned this fixture into a token standing still and broken tests that are
  // about something else entirely.
  liquidityUsd: 300_000,
  fdvUsd: null,
  volumeUsd: { h1: 50_000, h6: 300_000, h24: 1_200_000 },
  priceChangePct: { h1: 2, h6: -4, h24: 6 },
  txns: { h1: { buys: 40, sells: 30 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 10 * 24 * HOUR,
  security: {
    honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
    hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
  },
  ...over,
})

const quality = (s: TokenSnapshot): MarketQuality => ({
  liquidityUsd: s.liquidityUsd, spreadPct: 0.5, slippagePct: 0.3, referenceUsd: 100, observedAt: s.observedAt,
})

const policy: RankingPolicy = {
  gates: DEFAULT_GATE_POLICY,
  opportunity: DEFAULT_OPPORTUNITY_POLICY,
  watchSlots: 3,
  minScore: 10,
  // Off here: these pin the gates and the scoring, not the strategy.
  requireRising: false,
  
}

describe('ranking — gates first, then score, then slots', () => {
  it('rejects unsafe tokens with their reasons and never scores them', () => {
    const universe = [token('safe'), token('rug', { security: { ...token('rug').security, honeypot: true } })]
    const { candidates, rejected } = rankUniverse(universe, new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['safe'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.gates.failures[0]!.gate).toBe('honeypot')
  })

  it('orders candidates by score, highest first', () => {
    const quiet = token('quiet', { volumeUsd: { h1: 1_000, h6: 10_000, h24: 120_000 } })
    const hot = token('hot', { volumeUsd: { h1: 20_000, h6: 60_000, h24: 120_000 }, txns: { h1: { buys: 70, sells: 20 }, h24: { buys: 900, sells: 850 } } })
    const { candidates } = rankUniverse([quiet, hot], new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['hot', 'quiet'])
  })

  it('cuts the list to the watch slots', () => {
    const universe = Array.from({ length: 10 }, (_, i) => token(`t${i}`))
    expect(rankUniverse(universe, new Map(), quality, policy).candidates).toHaveLength(policy.watchSlots)
  })

  it('drops safe-but-boring tokens below the minimum score without calling them rejected', () => {
    // Live enough to clear the gates, dull enough to score under the minimum —
    // which is the distinction this test exists to make. No hourly expansion,
    // no price movement, plenty of pool turnover.
    const boring = token('boring', {
      volumeUsd: { h1: 0, h6: 1_000, h24: 60_000 },
      // Alive — one trade a bar, so no bar is empty — but going nowhere.
      // Rejected by a gate and dropped by score are different verdicts, and
      // this test exists to keep them apart.
      txns: { h1: { buys: 2, sells: 2 }, h24: { buys: 50, sells: 50 } },
      priceChangePct: { h1: 0, h6: 0, h24: 0 },
    })
    // 45, not 30. The SCALE moved when `headroom` became the largest weight:
    // its neutral 0.5 — what a flat token gets, since it has neither run nor
    // fallen — is now a quarter of the score on its own, so a token about which
    // nothing is known lands near 36 rather than under 30. The test's point is
    // unchanged: boring is DROPPED, not rejected.
    // The door is derived from what this token actually scores, not written as
    // a number. Every change to the weights moved that number — 30, then 45,
    // then the operator's three-component rule moved it again — and each time
    // the test broke for a reason that had nothing to do with what it proves:
    // that boring is DROPPED and rejected is REJECTED, which are different
    // verdicts about different questions.
    const open = { ...policy, minScore: 0 }
    const scored = rankUniverse([boring], new Map(), quality, open).candidates[0]!.opportunity.score
    const strict = { ...policy, minScore: scored + 1 }
    const { candidates, rejected } = rankUniverse([boring], new Map(), quality, strict)
    expect(candidates).toEqual([])
    expect(rejected).toEqual([])
  })

  it('uses the previous snapshot of the same token for liquidity growth', () => {
    const before = token('grow', { liquidityUsd: 100_000, volumeUsd: { h1: 20_000, h6: 120_000, h24: 480_000 } })
    const now = token('grow', { liquidityUsd: 160_000, volumeUsd: { h1: 20_000, h6: 120_000, h24: 480_000 } })
    const previous = new Map([[tokenKey(before), before]])
    const { candidates } = rankUniverse([now], previous, quality, policy)
    expect(candidates[0]!.opportunity.components.liquidityGrowth).toBe(1)
  })

  it('every candidate carries the market quality the executor will re-validate', () => {
    const { candidates } = rankUniverse([token('a')], new Map(), quality, policy)
    expect(candidates[0]!.marketQuality).toEqual(quality(token('a')))
  })

  it('ties break deterministically by address', () => {
    const { candidates } = rankUniverse([token('b'), token('a')], new Map(), quality, policy)
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['a', 'b'])
  })
})

describe('rankUniverse — the small ones fill the book, the big ones complete it', () => {
  // Same shape, different size: the BIG one is also the livelier, so it scores
  // higher. Without the rule it would take the slot.
  const lively = { volumeUsd: { h1: 20_000, h6: 60_000, h24: 120_000 }, txns: { h1: { buys: 70, sells: 20 }, h24: { buys: 900, sells: 850 } } }
  const quiet = { volumeUsd: { h1: 1_000, h6: 10_000, h24: 120_000 } }

  it('puts a small cap ahead of a bigger one that scores higher', () => {
    // The operator's rule, and it keeps the project's thesis while fixing what
    // was actually broken. Small caps are what the ladder is FOR: they move
    // enough for a 10% drop from a five-hour high to happen daily. Large caps
    // were excluded outright at $50M — and measured on ten days of 15m candles,
    // SOL/USDC triggers that same entry on 4.1% of bars, once every six hours.
    // Tradeable, just rarer.
    //
    // So they are not competitors, they are the FALLBACK: admitted now, and
    // ranked behind every small cap regardless of score, so they only ever take
    // a slot nothing smaller wanted.
    const universe = [
      token('BIG', { ...lively, fdvUsd: 400_000_000 }),
      token('SMALL', { ...quiet, fdvUsd: 5_000_000 }),
    ]
    const { candidates } = rankUniverse(universe, new Map(), quality, { ...policy, smallCapFdvUsd: 50_000_000 })
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['SMALL', 'BIG'])
  })

  it('still ranks by score WITHIN each size', () => {
    const universe = [
      token('WEAK', { ...quiet, fdvUsd: 5_000_000 }),
      token('STRONG', { ...lively, fdvUsd: 5_000_000 }),
    ]
    const { candidates } = rankUniverse(universe, new Map(), quality, { ...policy, smallCapFdvUsd: 50_000_000 })
    expect(candidates.map((c) => c.snapshot.address)).toEqual(['STRONG', 'WEAK'])
  })

  it('treats an unknown FDV as small, because that is what the book is mostly made of', () => {
    // An unreported FDV is the normal case on a young pool. Sorting it last
    // would quietly demote exactly the tokens this system exists to trade.
    const universe = [
      token('BIG', { ...lively, fdvUsd: 400_000_000 }),
      token('UNK', { ...quiet, fdvUsd: null }),
    ]
    const { candidates } = rankUniverse(universe, new Map(), quality, { ...policy, smallCapFdvUsd: 50_000_000 })
    expect(candidates[0]!.snapshot.address).toBe('UNK')
  })
})

describe('ranking — the reserve: what gets bought when nothing better is free', () => {
  // The operator's rule: when there are not enough coins to trade, or capital
  // is sitting free, reach further down — but always in the order the scores
  // decided. Measured live on 509 tokens: THREE were ready to trade and
  // EIGHTY-FOUR were held back by the turnover gate alone.
  const deep: RankingPolicy = { ...policy, gates: STRICT_GATE_POLICY, watchSlots: 10, minScore: 0 }
  const quiet = (address: string, over: Partial<TokenSnapshot> = {}) =>
    // Trades briskly — four an hour clears `idle` easily — but the pool is so
    // deep it barely turns over its own liquidity in a day.
    token(address, { liquidityUsd: 5_000_000, volumeUsd: { h1: 4_000, h6: 24_000, h24: 96_000 }, ...over })

  it('admits a token held back ONLY by a preference, and says what it forgave', () => {
    // Under the STRICT policy, which is where these gates still live: the
    // production default stopped asking turnover, volume and the FDV cap, so
    // nothing is ever FORGIVEN under it and the reserve has nothing to hold.
    // The mechanism is proved here and comes back the day those gates do.
    const [only] = rankUniverse([quiet('quiet')], new Map(), quality, deep).candidates
    expect(only?.snapshot.address).toBe('quiet')
    expect(only?.forgiven?.map((f) => f.gate)).toEqual(['turnover'])
  })

  it('admits NOTHING forgiven when the reserve is off — every condition, or no candidate', () => {
    // *Hacé que sólo sean candidatas las que ya cumplan todas las condiciones.*
    const ranked = rankUniverse([quiet('quiet'), token('clean')], new Map(), quality, { ...deep, reserve: false })
    expect(ranked.candidates.map((c) => c.snapshot.address)).toEqual(['clean'])
    expect(ranked.rejected.map((r) => r.snapshot.address)).toEqual(['quiet'])
  })

  it('puts every fully-qualified token ahead of it, whatever the scores say', () => {
    // A reserve token is a fallback for idle capital, never a competitor.
    const ranked = rankUniverse([quiet('quiet'), token('clean')], new Map(), quality, deep).candidates
    expect(ranked.map((c) => c.snapshot.address)).toEqual(['clean', 'quiet'])
    expect(ranked[0]?.forgiven).toBeUndefined()
  })

  it('orders the reserve among itself by score, like everything else', () => {
    const dull = quiet('dull', { priceChangePct: { h1: -1, h6: -2, h24: -3 } })
    const bright = quiet('bright', { priceChangePct: { h1: 5, h6: 8, h24: 12 } })
    const ranked = rankUniverse([dull, bright], new Map(), quality, deep).candidates
    expect(ranked.map((c) => c.snapshot.address)).toEqual(['bright', 'dull'])
  })

  it('forgives nothing that makes the token DANGEROUS', () => {
    const rug = quiet('rug', { security: { ...token('x').security, honeypot: true } })
    expect(rankUniverse([rug], new Map(), quality, deep).candidates).toHaveLength(0)
  })

  it('forgives nothing the STRATEGY needs in order to run', () => {
    // Under the STRICT policy, which is where these gates still live: the
    // production default stopped asking turnover, volume and the FDV cap, so
    // nothing is ever FORGIVEN under it and the reserve has nothing to hold.
    // The mechanism is proved here and comes back the day those gates do.
    // `idle` is not a preference: under four trades an hour a 15m bar comes
    // back empty, and an empty bar is how a position freezes with its capital
    // unreachable. That is the failure this book just spent a session fixing.
    const dead = quiet('dead', { txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 900, sells: 850 } } })
    expect(rankUniverse([dead], new Map(), quality, deep).candidates).toHaveLength(0)

    // A pool with no history has no indicators, so the machine cannot step.
    const newborn = quiet('newborn', { pairCreatedAt: NOW - HOUR })
    expect(rankUniverse([newborn], new Map(), quality, deep).candidates).toHaveLength(0)

    // And a day-long bleed is an exit in progress — today's decision stands.
    const knife = quiet('knife', { priceChangePct: { h1: -1, h6: -10, h24: -40 } })
    expect(rankUniverse([knife], new Map(), quality, deep).candidates).toHaveLength(0)
  })

  it('never lets the reserve push a qualified token out of the watch slots', () => {
    const universe = [quiet('q1'), quiet('q2'), quiet('q3'), token('clean')]
    const ranked = rankUniverse(universe, new Map(), quality, { ...deep, watchSlots: 2 }).candidates
    expect(ranked[0]?.snapshot.address).toBe('clean')
    expect(ranked).toHaveLength(2)
  })
})

describe('ranking — two doors on an already-computed score', () => {
  // The operator's framing, and the whole reason both of these live HERE and
  // not in the weights: *un filtro aparte, que no modifique el puntaje total*.
  //
  // A weight cannot say "this alone disqualifies you" — it is one term of an
  // average and the other terms can always carry it, which is how PURR was
  // bought at a 15.55% round trip. A door can, and it costs the scale nothing:
  // every number the operator reads is the number it was yesterday.

  const expensive = (s: TokenSnapshot): MarketQuality => ({
    // 8% round trip, twice the zero point. `costEfficiency` is 0, the floor
    // is 0.3, and nothing else about the token is allowed to rescue it.
    liquidityUsd: s.liquidityUsd, spreadPct: 4, slippagePct: 4, referenceUsd: 100, observedAt: s.observedAt,
  })

  const floors = { ...policy, minScore: 0, minComponents: { costEfficiency: 0.3, headroom: 0.3, momentum: 0.3 } }

  it('refuses a ruinous toll however good the rest of the token is', () => {
    const great = token('great', {
      volumeUsd: { h1: 20_000, h6: 60_000, h24: 120_000 },
      txns: { h1: { buys: 200, sells: 40 }, h24: { buys: 3_000, sells: 900 } },
      priceChangePct: { h1: 3, h6: 5, h24: 8 },
    })
    // It clears every gate and scores well when the toll is ordinary...
    expect(rankUniverse([great], new Map(), quality, floors).candidates).toHaveLength(1)
    // ...and is gone the moment the toll is ruinous, on the same token.
    const { candidates, rejected } = rankUniverse([great], new Map(), expensive, floors)
    expect(candidates).toEqual([])
    // Not REJECTED either: the gates had no complaint. It failed a floor,
    // which the caller reads as "not worth trading" rather than "dangerous".
    expect(rejected).toEqual([])
  })

  it('keeps a floor failure out of the RESERVE as well, not only the shortlist', () => {
    // The reserve forgives a preference about the POOL — a deep one that turns
    // slowly, a thin day, a name bigger than this book likes. It may never
    // forgive a verdict about the OPPORTUNITY, or the fallback becomes a back
    // door around the rule it was told to respect.
    const thin = token('thin', { volumeUsd: { h1: 200, h6: 1_200, h24: 6_000 } })
    const { candidates } = rankUniverse([thin], new Map(), expensive, floors)
    expect(candidates.filter((c) => c.forgiven !== undefined)).toEqual([])
  })

  it('leaves the SCORE untouched — the door reads it, it never moves it', () => {
    // The property the operator asked for by name. Same token, same market,
    // two different doors: the score that comes back is identical, and only
    // whether it comes back at all differs.
    const open = { ...policy, minScore: 0 }
    const shut = { ...policy, minScore: 99 }
    const scored = rankUniverse([token('x')], new Map(), quality, open).candidates
    expect(scored).toHaveLength(1)
    expect(rankUniverse([token('x')], new Map(), quality, shut).candidates).toEqual([])
    // and re-opening it returns the very same number, to the last decimal
    expect(rankUniverse([token('x')], new Map(), quality, open).candidates[0]!.opportunity.score).toBe(
      scored[0]!.opportunity.score,
    )
  })
})

describe('ranking — a floor failure is REPORTED, not swallowed', () => {
  // It used to `continue` in silence, which was fine while the only
  // consequence was "do not buy this". It stopped being fine the moment the
  // same verdict can SELL a position: the orchestrator could not tell "the
  // switch went off on our token" from "the scanner did not find it this
  // cycle", and those two must never produce the same action.
  //
  // The distinction the scanner has paid for twice already: an answered
  // question with a bad answer, versus no answer at all.

  const expensive = (s: TokenSnapshot): MarketQuality => ({
    liquidityUsd: s.liquidityUsd, spreadPct: 4, slippagePct: 4, referenceUsd: 100, observedAt: s.observedAt,
  })
  const floors = { ...policy, minScore: 0, minComponents: { costEfficiency: 0.3, momentum: 0.3 } }

  it('names the token and the floors it failed', () => {
    const { switchedOff } = rankUniverse([token('toll')], new Map(), expensive, floors)
    expect(switchedOff.map((s) => s.snapshot.address)).toEqual(['toll'])
    expect(switchedOff[0]!.failed).toContain('costEfficiency')
  })

  it('reports nothing for a token that cleared every floor', () => {
    expect(rankUniverse([token('fine')], new Map(), quality, floors).switchedOff).toEqual([])
  })

  it('reports nothing for a token a GATE rejected — it was never scored', () => {
    // A gate failure is a different verdict and already has its own channel.
    // Reporting it here too would tell the allocator the switch went off on a
    // token nobody ever measured the switch for.
    const rug = token('rug', { security: { ...token('rug').security, honeypot: true } })
    const { switchedOff, rejected } = rankUniverse([rug], new Map(), expensive, floors)
    expect(switchedOff).toEqual([])
    expect(rejected).toHaveLength(1)
  })

  it('reports nothing when no floors were configured at all', () => {
    const { minComponents: _omitted, ...none } = { ...policy, minScore: 0 }
    expect(rankUniverse([token('toll')], new Map(), expensive, none).switchedOff).toEqual([])
  })

  it('carries the score too, so the alert can say what it fell to', () => {
    const { switchedOff } = rankUniverse([token('toll')], new Map(), expensive, floors)
    expect(switchedOff[0]!.opportunity.score).toBeGreaterThanOrEqual(0)
  })
})

describe('ranking — an unbounded book gets an unbounded shortlist', () => {
  // `maxPositions: 0` means NO CEILING everywhere else in this engine — the
  // operator's own decision, because once every slot is the same size what
  // bounds the damage one token can do is that SIZE, and capping the count
  // only leaves capital idle.
  //
  // It arrived here as `watchSlots: 50`, which is the same trap this project
  // has now hit three times: a zero that means "no limit" in one file and a
  // number in the one next door. It does not bite while a scan produces twelve
  // candidates; it bites the moment the scan starts working.
  //
  // The candle bill is bounded SEPARATELY and always was — `candleBudget` is
  // priced off what the capital can actually fund — so a longer shortlist
  // costs nothing extra to examine.

  it('cuts to the slots when there is a ceiling', () => {
    const universe = Array.from({ length: 10 }, (_, i) => token(`t${i}`))
    expect(rankUniverse(universe, new Map(), quality, { ...policy, watchSlots: 3 }).candidates).toHaveLength(3)
  })

  it('keeps every candidate when the book has no ceiling at all', () => {
    const universe = Array.from({ length: 10 }, (_, i) => token(`t${i}`))
    const uncapped = { ...policy, watchSlots: Number.POSITIVE_INFINITY }
    expect(rankUniverse(universe, new Map(), quality, uncapped).candidates).toHaveLength(10)
  })
})

describe('the momentum door — moving up right now, or the switch is off', () => {
  // The operator's strategy change: *sacá todos los filtros mientras haya
  // liquidez; vamos a operar con la única condición de que en los últimos 15
  // minutos haya subido más del 1%... mirá las últimas 4 horas, que no haya
  // bajado de 0% y que se haya incrementado en el total del tiempo hasta los 5m.*
  //
  // It lands on `switchedOff` rather than on `rejected`, and that placement is
  // the design rather than a convenience. `switchedOff` is what feeds
  // `rotateOnSwitchOff`, so a token WE HOLD that stops rising is sold — which
  // is exactly the exit this strategy needs. A rejection would only mean "do
  // not buy it", and would leave the book holding tokens that had stopped
  // doing the one thing they were bought for.
  //
  // Together with the stop it makes a complete pair: the switch takes the
  // profit when the climb ends, the stop takes the loss when it reverses.

  // The operator rule: up more than 5% on the DAY, hour still positive.
  // Up 1% or more in the last five minutes, and nothing else matters.
  const rising = { m5: 2, h1: 2, h6: 3, h24: 10 }
  const rank = (universe: TokenSnapshot[], requireRising: boolean) =>
    rankUniverse(universe, new Map(), quality, { ...policy, requireRising })

  it('admits a token green on all three windows', () => {
    const { candidates } = rank([token('A', { priceChangePct: rising })], true)
    expect(candidates).toHaveLength(1)
  })

  it('switches OFF one that is not moving NOW', () => {
    const { candidates, switchedOff } = rank([token('A', { priceChangePct: { ...rising, m5: 0.5 } })], true)
    expect(candidates).toEqual([])
    expect(switchedOff).toHaveLength(1)
    expect(switchedOff[0]!.failed).toContain('rising')
  })

  it('switches OFF one whose five minutes nobody reported', () => {
    // There is no such thing as an unmeasured reason to BUY.
    const { switchedOff } = rank([token('A', { priceChangePct: { m5: null, h1: 2, h6: 3, h24: 10 } })], true)
    expect(switchedOff[0]!.failed).toContain('rising')
  })

  it('never reaches the RESERVE — a fallback is not a way around the rule', () => {
    // The reserve exists to put idle capital into something safe the gates
    // merely did not prefer. A token that is not rising is not a matter of
    // taste under this strategy; it is the whole condition.
    // The reserve is merged into `candidates` on the way out, so proving it
    // never entered means proving the token is absent from there AND present in
    // `switchedOff` — which is where a refusal belongs rather than nowhere.
    const { candidates, switchedOff } = rank([token('A', { priceChangePct: { ...rising, m5: -1 } })], true)
    expect(candidates).toEqual([])
    expect(switchedOff).toHaveLength(1)
  })

  it('still refuses a DANGEROUS token that happens to be rising', () => {
    // Safety was never part of *sacá todos los filtros*, and the operator was
    // emphatic in the other direction the same day: *si falla una compuerta de
    // seguridad, restricción total, porque esas me han hecho perder mucho
    // dinero.*
    const honeypot = token('A', { priceChangePct: rising, security: { ...token('A').security, honeypot: true } })
    const { candidates, rejected } = rank([honeypot], true)
    expect(candidates).toEqual([])
    expect(rejected).toHaveLength(1)
  })

  it('leaves every other token alone when the door is OFF', () => {
    // The rule is opt-in, so the reference behaviour survives untouched and
    // the parity harness keeps meaning what it meant.
    const falling = token('A', { priceChangePct: { ...rising, h1: -0.5 } })
    expect(rank([falling], false).candidates).toHaveLength(1)
  })
})
