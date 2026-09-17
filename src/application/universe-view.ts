import { evaluateGates, forgivableFailures, type GatePolicy, DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { scoreOpportunity, type OpportunityPolicy, DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { estimatePriceImpactPct } from '../domain/market/market-quality.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

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

const PRIME_SCORE = 45

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

  const [scans, positions, blacklisted] = await Promise.all([
    store.latestScansByChain(),
    store.loadPositions(),
    store.blacklisted(),
  ])

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
    return now === undefined
      ? snapshot
      : {
          ...snapshot,
          priceUsd: now.priceUsd,
          liquidityUsd: now.liquidityUsd,
          fdvUsd: now.fdvUsd,
          volumeUsd: now.volumeUsd,
          priceChangePct: now.priceChangePct,
          txns: now.txns,
          observedAt: now.observedAt,
        }
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
              ? forgivableFailures(gateResult) !== null
                ? 'reserve'
                : 'filtered'
              : opportunity.score >= PRIME_SCORE
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
    tokens.push(fromPositionAlone(position))
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
function fromPositionAlone(position: PersistedPosition): UniverseToken {
  return {
    id: `${position.chain}:${position.tokenAddress}`,
    symbol: position.symbol,
    chain: position.chain,
    address: position.tokenAddress,
    pairAddress: position.pairAddress,
    tier: 'held',
    turnedUnsafe: false,
    score: 0,
    components: {},
    liquidityUsd: position.quality.liquidityUsd,
    volume24hUsd: 0,
    priceUsd: position.lastPriceUsd ?? 0,
    change24hPct: null,
    ageHours: null,
    frictionPct: 2 * (position.quality.spreadPct + position.quality.slippagePct),
    blockers: ['el escáner no la encontró en este ciclo — los datos son los de la posición'],
    position: {
      capitalUsd: position.capitalUsd,
      filledDcas: position.cascade.level > 0 ? position.cascade.level - 1 : 0,
      deathStage: position.deathWatch.stage,
      deathSignals: latestSignals(position),
    },
  }
}
