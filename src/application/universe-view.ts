import { evaluateGates, forgivableFailures, type GatePolicy, DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { meetsMinimums, scoreOpportunity, type ComponentFloors, type OpportunityPolicy, DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { estimatePriceImpactPct } from '../domain/market/market-quality.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { withLiveMarket } from '../domain/scanner/live-market.js'

/**
 * The universe, as something you can look at.
 *
 * The scanner already decides everything this needs; storing a second,
 * prettier version of those decisions would be a second place for them to be
 * wrong. So this recomputes from the stored snapshots using the SAME gate and
 * score functions the engine runs, and adds only what a picture needs:
 * a tier, a magnitude, and a reason.
 */

/**
 * What a token IS right now, in the order that matters visually.
 *
 * The order is the story: dead things are darkest, held things brightest,
 * and everything between is a degree of interest.
 */
export type TokenTier =
  /** Money is in it. */
  | 'held'
  /** Passed every gate and scored well — the ones worth watching. */
  | 'prime'
  /** Passed every gate, quieter score. */
  | 'eligible'
  /**
   * Failed a gate that is a PREFERENCE, and the allocator may still buy it
   * when nothing better is free — so it cannot be drawn as a rejection.
   *
   * A token the engine can reach for while the screen calls it filtered is the
   * screen-versus-engine disagreement this read model exists to prevent. It is
   * not eligible either: it only ever fills a slot the qualified list left
   * empty, and it never takes one from an incumbent.
   */
  | 'reserve'
  /** Failed a market gate: too thin, too young, too quiet, too big. */
  | 'filtered'
  /** Failed a SAFETY gate. Not a missed chance — a bullet dodged. */
  | 'unsafe'
  /**
   * Cleared the free gates but the cycle's security budget did not reach it.
   *
   * Deliberately NOT 'unsafe'. The gates fail closed, so an unexamined token
   * is rejected either way — but "nobody has looked at this yet" and "we
   * looked and it is dangerous" are different claims, and showing them the
   * same way would quietly turn a queue into an accusation.
   */
  | 'pending'
  /** The death exit condemned it. Never again. */
  | 'dead'

export interface UniverseToken {
  readonly id: string
  readonly symbol: string
  readonly chain: string
  readonly address: string
  readonly pairAddress: string
  readonly tier: TokenTier
  /** 0..100 from the scanner's own score. */
  readonly score: number
  /** The five components, so the picture can show WHY. */
  readonly components: Readonly<Record<string, number>>
  readonly liquidityUsd: number
  readonly volume24hUsd: number
  readonly priceUsd: number
  readonly change24hPct: number | null
  readonly ageHours: number | null
  /** Round-trip cost estimate, in percent — what the chain takes. */
  readonly frictionPct: number
  /** Gate failures, plainest first. Empty when it passed. */
  readonly blockers: readonly string[]
  /**
   * OUR money, in something that now fails a SAFETY gate.
   *
   * The tier short-circuits to 'held' for anything with a position, so a token
   * of ours whose mint authority came back went on being drawn green. The
   * engine acts on it — the death watch can see the scanner's verdict now —
   * but the screen never showed it coming.
   *
   * Both facts are true at once and both matter. It is not "an unsafe
   * candidate": it is a position that turned, which is more urgent than either
   * fact alone and is the one thing the tier cannot say.
   *
   * Never true for an UNEXAMINED token. Those fail every safety gate by
   * design — the gates fail closed — and reading that as "it turned" would put
   * a red alarm on every position the security budget had not reached, which
   * is how an alarm stops being read.
   */
  readonly turnedUnsafe: boolean
  /** Present only for held tokens. */
  readonly position: {
    readonly capitalUsd: number
    /**
     * Whether the slot actually holds tokens, read from the FILLS.
     *
     * A position with fills is a COMMITMENT whose slot cannot come back
     * without selling; one without is a RESERVATION that costs nothing to
     * cancel. The engine has always made that distinction — `idle-slots.ts`
     * releases only the second kind — and the screen was collapsing it:
     * three bodies drawn glowing and labelled "operando", every one with
     * zero quantity against $1,250 of capital.
     *
     * NEVER from the cascade level. A machine can sit at level 1 believing it
     * holds something the broker refused, and a reservation dressed as a
     * position is exactly the case this must not misread.
     */
    readonly holdsTokens: boolean
    readonly filledDcas: number
    readonly deathStage: 'healthy' | 'frozen' | 'dead'
    /**
     * Why it is not healthy, newest first.
     *
     * A snowflake with no reason is a state the operator cannot act on: only
     * they can decide whether the token really died or the engine is wrong
     * about it, and "❄️ congelada" answers neither. Six positions were frozen
     * at once with the evidence recorded, persisted, extracted by
     * `buildDashboard` — and rendered by nobody, so diagnosing one meant
     * reading the database.
     */
    readonly deathSignals: readonly string[]
  } | null
}

export interface UniverseView {
  readonly generatedAt: number
  readonly scannedAt: number | null
  readonly tokens: readonly UniverseToken[]
  readonly counts: Readonly<Record<TokenTier, number>>
  readonly chains: readonly string[]
}

export interface UniverseOptions {
  readonly now: () => number
  readonly gates?: GatePolicy
  readonly opportunity?: OpportunityPolicy
  /** Assumed venue fee when nothing was measured, in percent. */
  readonly spreadPct?: number
  /**
   * The same component floors the RANKING applies. Passed rather than assumed,
   * so the screen and the engine cannot hold different opinions about which
   * tokens the book may buy — the exact drift this read model exists to stop.
   */
  readonly minComponents?: ComponentFloors
  /** The engine's first-buy door: a token failing it is drawn filtered, never buyable. */
  readonly entryComponents?: ComponentFloors
  /**
   * The same SCORE door the ranking applies, for the same reason as the floors
   * above: a screen that draws a token as buyable while the engine refuses it
   * is the drift this read model exists to stop, and this project has paid for
   * that one more than once.
   *
   * Absent means no door — the old behaviour exactly, so a caller that does
   * not know the engine's threshold is not silently given a different rule.
   */
  readonly minScore?: number
  /** The engine's own reserve switch: off, a forgivable failure is drawn filtered. */
  readonly reserve?: boolean
  /**
   * The market, right now, for the tokens that HOLD money — keyed `chain:address`.
   *
   * The scan runs hourly, so a position's numbers, and the score computed from
   * them, could be an hour old on the one screen the operator watches. The
   * unrealised figure already moved live; everything explaining it did not.
   *
   * It costs NOTHING: the same DexScreener response that feeds the live price
   * already carries liquidity, volume, the price changes and the transaction
   * counts, and every field but the price was being discarded.
   *
   * Held only. Refreshing the other five hundred would be a real bill, and the
   * argument for these is that they are few and that they are ours.
   */
  readonly liveMarkets?: () => Promise<ReadonlyMap<string, Omit<TokenSnapshot, 'security'>>>
}

const TIERS: TokenTier[] = ['held', 'prime', 'eligible', 'reserve', 'pending', 'filtered', 'unsafe', 'dead']

/** Gates that mean "this could hurt you", as opposed to "not interesting". */
// `staleBars` belongs here, and the reason is worth stating because the tier
// split exists to keep these two apart. FILTERED means uninteresting — a missed
// chance. UNSAFE means a bullet dodged.
//
// A token this engine cannot see trading is the second. Buying one is not a
// mediocre trade, it is capital that gets STUCK: the entry decided at a close
// waits forever for an open that never comes, the ladder freezes, and the
// position can neither buy nor sell. Six of them proved it in production.
const SAFETY_GATES = new Set(['honeypot', 'mintAuthority', 'freezeAuthority', 'blacklist', 'transferTax', 'lpLocked', 'topHolders', 'creatorShare', 'proxy', 'impersonation', 'staleBars', 'priceMismatch'])

/**
 * The line between "fill the book with these" and "and these too".
 *
 * DERIVED from the engine's own door rather than fixed, because a fixed 45 sat
 * BELOW a door of 50 the moment one was set — and every survivor would then
 * have been drawn `prime`, which is a band that has stopped distinguishing
 * anything. A screen whose top tier is everything says as much as no tier.
 *
 * The margin is `minScoreEdge` (10): the points the allocator already requires
 * before it will swap one token for another. It is the project's own answer to
 * "how much better is meaningfully better", so borrowing it here keeps ONE
 * definition instead of inventing a second.
 *
 * With no door it is the 45 it always was, measured against a book that then
 * ran 25..88.
 */
const PRIME_MARGIN = 10
const PRIME_SCORE = 45
const primeLine = (door: number): number => (door > 0 ? door + PRIME_MARGIN : PRIME_SCORE)

/** The most recent verdict's reasons, newest observation first. */
const latestSignals = (position: PersistedPosition): readonly string[] =>
  [...position.deathWatch.evidence]
    .reverse()
    .flatMap((record) => record.signals.map((signal) => signal.detail))
    .slice(0, 3)

export async function buildUniverse(store: StatePort, options: UniverseOptions): Promise<UniverseView> {
  const generatedAt = options.now()
  const gates = options.gates ?? DEFAULT_GATE_POLICY
  const opportunityPolicy = options.opportunity ?? DEFAULT_OPPORTUNITY_POLICY
  const spreadPct = options.spreadPct ?? 0.3

  const [scans, positions, blacklisted, fills] = await Promise.all([
    store.latestScansByChain(),
    store.loadPositions(),
    store.blacklisted(),
    // Already cached for the operations view in the same build, so this costs
    // no extra round trip — and it is the only honest source for "is there
    // anything in this slot".
    store.allFills(),
  ])

  const holding = new Set<string>()
  for (const position of positions) {
    const qty = fills
      .filter((fill) => fill.positionId === position.id)
      .reduce((sum, fill) => sum + (fill.side === 'buy' ? fill.qty : -fill.qty), 0)
    if (qty > 0) holding.add(position.id)
  }

  const heldBy = new Map(positions.map((p) => [`${p.chain}:${p.tokenAddress}`, p]))
  // Every chain's newest scan, together. The universe is not one chain, and a
  // screen that shows whichever ran last makes the other one look like it
  // stopped existing.
  // ONE body per token, however many times it was scanned.
  //
  // Reported live: the chips said "operando 18" beside a header saying 15
  // positions, and a hand count of the green dots gave 15. The dots were right.
  //
  // A duplicate hides perfectly, which is why it took counting by hand to find:
  // a body's place in the sky comes from a HASH of its address, so the twin
  // lands exactly on top of the original and the two read as one.
  //
  // The DEEPEST copy wins, not the first. If one carries a measurement the
  // other does not, dropping the wrong one throws away evidence — and every
  // gate here fires on evidence.
  const deepest = new Map<string, TokenSnapshot>()
  for (const snapshot of scans.flatMap((scan) => scan.snapshots)) {
    const key = `${snapshot.chain}:${snapshot.address}`
    const current = deepest.get(key)
    if (!current || snapshot.liquidityUsd > current.liquidityUsd) deepest.set(key, snapshot)
  }
  // What the scan PAID for is kept and only the market half is replaced.
  //
  // Security, the history count, the bar-freshness measurement and the candle
  // price come from the expensive stage and from the candle feed; a market
  // response cannot answer any of them. Overlaying it whole would blank the
  // evidence every gate on this screen fires on, and the gates fail closed —
  // so a position would turn red for the crime of being refreshed.
  let live: ReadonlyMap<string, Omit<TokenSnapshot, 'security'>> = new Map()
  if (options.liveMarkets) {
    // Never fatal. Stale and drawn beats absent: a provider hiccup must not
    // empty the screen of the one thing on it holding money.
    try {
      live = await options.liveMarkets()
    } catch {
      live = new Map()
    }
  }

  const snapshots: readonly TokenSnapshot[] = [...deepest.values()].map((snapshot) => {
    const key = `${snapshot.chain}:${snapshot.address}`
    const now = heldBy.has(key) ? live.get(key) : undefined
    // `withLiveMarket` is the ONE definition of which half a market feed may
    // refresh. The recall a watch pass allocates from uses the same one, and
    // two copies of that rule would eventually disagree about whether a token
    // is safe.
    return withLiveMarket(snapshot, now)
  })

  const tokens: UniverseToken[] = snapshots.map((snapshot) => {
    const key = `${snapshot.chain}:${snapshot.address}`
    const held = heldBy.get(key)
    const gateResult = evaluateGates(snapshot, gates)

    // Quality was measured during the scan but is not stored per token, so the
    // picture falls back to the model. Stated rather than hidden: this is a
    // display estimate, and the executor still measures before it trades.
    const quality = {
      liquidityUsd: snapshot.liquidityUsd,
      spreadPct,
      // The measurement when there is one. The model is a fallback, and it is
      // the optimistic half of the pair: it reads reported liquidity, which
      // said $718,000 about a pool that moved 98% on a $285 sell.
      slippagePct:
        snapshot.measuredImpactPct ?? (snapshot.liquidityUsd > 0 ? estimatePriceImpactPct(100, snapshot.liquidityUsd) : 100),
      referenceUsd: 100,
      observedAt: snapshot.observedAt,
    }
    const opportunity = scoreOpportunity(snapshot, opportunityPolicy, null, quality)

    // An unexamined token fails every security gate for the same reason —
    // nobody looked — and those six lines bury the one that is the actual
    // cause. Measured live: 180 of 185 filtered tokens led with them.
    // True, and useless. The real reason is the market gate it hit.
    const blockers = gateResult.failures
      .filter((f) => snapshot.securityChecked !== false || !SAFETY_GATES.has(f.gate))
      .map((f) => f.detail)
    const unsafe = gateResult.failures.some((f) => SAFETY_GATES.has(f.gate))

    // A token nobody examined has an all-null security report, and the gates
    // fail closed — so a naive reading calls it dangerous. It is not: it is
    // unexamined. And if it was rejected on MARKET grounds it never will be
    // examined, which makes it uninteresting rather than queued.
    //
    // This mattered in production: the screen read "insegura 219, filtrada 6"
    // when almost all 219 were simply too thin to bother with. Calling a thin
    // pool a bullet dodged devalues the label for the tokens that earned it.
    const marketFailure = gateResult.failures.some((f) => !SAFETY_GATES.has(f.gate))

    const tier: TokenTier = blacklisted.has(key)
      ? 'dead'
      : held
        ? 'held'
        : snapshot.securityChecked === false
          ? marketFailure
            ? 'filtered'
            : 'pending'
          : unsafe
            ? 'unsafe'
            : !gateResult.passed
              ? options.reserve !== false && forgivableFailures(gateResult) !== null
                ? 'reserve'
                : 'filtered'
              // Below a component FLOOR is not tradeable, so the screen must not
              // draw it as if it were. Same function the ranking uses: two
              // definitions of "worth trading" is how the canvas and the engine
              // end up disagreeing about what the book may hold.
              : !meetsMinimums(opportunity.components, options.minComponents)
                ? 'filtered'
              // And the FIRST-buy door, which the engine applies to anything it
              // would open. Only reached for a token not held — `held` wins above.
              : !meetsMinimums(opportunity.components, options.entryComponents)
                ? 'filtered'
              // And below the engine's own SCORE door, for the same reason.
              : opportunity.score < (options.minScore ?? 0)
                ? 'filtered'
              : opportunity.score >= primeLine(options.minScore ?? 0)
                ? 'prime'
                : 'eligible'

    return {
      id: key,
      turnedUnsafe: held !== undefined && snapshot.securityChecked !== false && unsafe,
      symbol: snapshot.symbol,
      chain: snapshot.chain,
      address: snapshot.address,
      pairAddress: snapshot.pairAddress,
      tier,
      score: opportunity.score,
      components: opportunity.components as unknown as Record<string, number>,
      liquidityUsd: snapshot.liquidityUsd,
      volume24hUsd: snapshot.volumeUsd.h24,
      priceUsd: snapshot.priceUsd,
      change24hPct: snapshot.priceChangePct.h24,
      ageHours: snapshot.pairCreatedAt === null ? null : (snapshot.observedAt - snapshot.pairCreatedAt) / 3_600_000,
      frictionPct: 2 * (quality.spreadPct + quality.slippagePct),
      blockers,
      position: held
        ? {
            capitalUsd: held.capitalUsd,
            holdsTokens: holding.has(held.id),
            filledDcas: held.cascade.level > 0 ? held.cascade.level - 1 : 0,
            deathStage: held.deathWatch.stage,
            deathSignals: latestSignals(held),
          }
        : null,
    }
  })

  // ── A position is never invisible ─────────────────────────────────────────
  //
  // The universe above is built from the latest scan, and discovery lists churn
  // every cycle. A held token that falls out of them used to stop existing on
  // the screen: found live with five open positions and four bodies drawn, and
  // the missing one was holding money.
  //
  // The case matters most where you would least want it to fail. A token that
  // drops off every discovery list may be a token that is dying — so the screen
  // went blank at the exact moment it had something to say.
  const drawn = new Set(tokens.map((t) => `${t.chain}:${t.address}`))
  for (const position of positions) {
    const key = `${position.chain}:${position.tokenAddress}`
    if (drawn.has(key)) continue
    tokens.push(fromPositionAlone(position, holding.has(position.id), live.get(key), opportunityPolicy, spreadPct))
  }

  const counts = Object.fromEntries(TIERS.map((tier) => [tier, tokens.filter((t) => t.tier === tier).length])) as Record<TokenTier, number>

  return {
    generatedAt,
    // The OLDEST chain, not the newest. A universe is only as fresh as its
    // stalest half, and reporting the newest would let a healthy Solana scan
    // hide a BSC scanner that died three hours ago.
    scannedAt: scans.length === 0 ? null : Math.min(...scans.map((s) => s.scannedAt)),
    // Brightest first, so a truncated render keeps the interesting ones.
    tokens: [...tokens].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.score - a.score),
    counts,
    chains: [...new Set(tokens.map((t) => t.chain))].sort(),
  }
}

/**
 * A held token drawn from what the POSITION knows, because the scan said
 * nothing about it this cycle.
 *
 * Everything the scanner would have supplied is absent, and absent is what it
 * reports. The score is zero rather than a stale one, and the blockers say the
 * scanner did not see it — because an empty blockers list reads as "checked and
 * fine", which is the single thing nobody checked.
 *
 * Liquidity and price come from the position's own record: the quality measured
 * when it was opened and the last close the engine acted on. Both are real
 * measurements with a date on them, which is more than a placeholder would be.
 */
/**
 * A position the last scan did not mention, drawn from what we know of it.
 *
 * It used to come back with `score: 0`, and that is what the operator saw: a
 * body with NO RIPPLES beside others that had them, because the ripples ARE
 * the score. Right after a reset — or for any held token a scan happened to
 * miss — the screen said nothing about a token holding real money.
 *
 * The market half can still answer. The same batched response that prices the
 * book carries volume, liquidity, the changes and the trade counts, which is
 * everything `scoreOpportunity` reads; only the gates want security, and no
 * gate runs here. So the score is computed from the live feed when there is
 * one, and stays at zero when there is not — silence, not a verdict.
 */
/**
 * Every security answer UNKNOWN.
 *
 * `scoreOpportunity` never reads one — the gates do, and no gate runs on this
 * path. Spelling it out beats a cast: an all-unknown report fails every safety
 * gate closed, which is the correct verdict for a token nobody examined, so if
 * this shape ever reaches a gate it refuses rather than passes.
 */
const UNKNOWN_SECURITY: TokenSnapshot['security'] = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null,
  verifiedSource: null, isProxy: null,
}

function fromPositionAlone(
  position: PersistedPosition,
  holdsTokens: boolean,
  market: Omit<TokenSnapshot, 'security'> | undefined,
  policy: OpportunityPolicy,
  spreadPct: number,
): UniverseToken {
  const scored =
    market === undefined
      ? null
      : scoreOpportunity(
          { ...market, security: UNKNOWN_SECURITY },
          policy,
          null,
          {
            liquidityUsd: market.liquidityUsd,
            spreadPct,
            slippagePct: position.quality.slippagePct,
            referenceUsd: position.quality.referenceUsd,
            observedAt: market.observedAt,
          },
        )
  return {
    id: `${position.chain}:${position.tokenAddress}`,
    symbol: position.symbol,
    chain: position.chain,
    address: position.tokenAddress,
    pairAddress: position.pairAddress,
    tier: 'held',
    turnedUnsafe: false,
    score: scored?.score ?? 0,
    components: (scored?.components ?? {}) as unknown as Record<string, number>,
    liquidityUsd: market?.liquidityUsd ?? position.quality.liquidityUsd,
    volume24hUsd: market?.volumeUsd.h24 ?? 0,
    priceUsd: market?.priceUsd ?? position.lastPriceUsd ?? 0,
    change24hPct: market?.priceChangePct.h24 ?? null,
    ageHours: null,
    frictionPct: 2 * (position.quality.spreadPct + position.quality.slippagePct),
    blockers: ['el escáner no la encontró en este ciclo — los datos son los de la posición'],
    position: {
      capitalUsd: position.capitalUsd,
      holdsTokens,
      filledDcas: position.cascade.level > 0 ? position.cascade.level - 1 : 0,
      deathStage: position.deathWatch.stage,
      deathSignals: latestSignals(position),
    },
  }
}
