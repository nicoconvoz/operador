import { estimatePriceImpactPct, type MarketQuality } from '../domain/market/market-quality.js'
import { rankUniverse, tokenKey, type RankingPolicy, type ScanResult } from '../domain/scanner/ranking.js'
import { evaluateMarketGates, forgivableFailures } from '../domain/scanner/gates.js'
import { scoreOpportunity } from '../domain/scanner/opportunity.js'
import { type Chain, type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { mergeSecurity } from '../domain/scanner/security-merge.js'
import { lpLockFromVenue } from '../infrastructure/adapters/solana/lp-heuristics.js'
import { type DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { type GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { type SellAssessment } from '../infrastructure/adapters/jupiter/jupiter.js'

/**
 * Quoting a real sell — the honeypot test, and the only honest source of price
 * impact. One port, one implementation per chain: Jupiter on Solana,
 * PancakeSwap's router on BSC. The domain never learns which.
 */
export interface SellProbePort {
  assessSell(token: string, amountRaw: bigint, decimals: number, expectedUsd: number): Promise<SellAssessment>
}

/** Token decimals — needed to size a reference sell in base units. */
export interface DecimalsPort {
  decimals(chain: Chain, address: string): Promise<number | null>
  /** Optional second opinion on security facts (e.g. Jupiter's audit block). */
  security?(chain: Chain, address: string): Promise<Partial<SecurityReport> | null>
  /** Optional extra universe (e.g. Jupiter's trending / traded / organic lists). */
  discover?(): Promise<string[]>
}

/**
 * How much 1H history a pool has. Optional: without it the history gate stays
 * silent and the executor checks again before it trades. Supplying it here
 * just means a token with no indicators never reaches the shortlist.
 */
export interface HistoryPort {
  historyBars(chain: Chain, poolAddress: string): Promise<number | null>
  /**
   * Optional chain-agnostic universe. Matters most on chains with no native
   * token list: BSC's only other source is DexScreener's boosts, which are
   * paid promotions and returned NINE tokens when measured.
   */
  discoverPools?(chain: Chain, pages?: number): Promise<{ tokenAddress: string; poolAddress: string }[]>
}

export interface ScanDeps {
  readonly dex: DexScreener
  readonly goplus: GoPlus
  /** Chain-appropriate sell probe. Without one, honeypot stays unknown and the gates fail closed. */
  readonly sellProbe?: SellProbePort
  readonly decimals: DecimalsPort
  readonly history?: HistoryPort
  readonly now?: () => number
  /** Optional. Injected rather than imported, so the domain never learns what a console is. */
  readonly onProgress?: (progress: ScanProgress) => void
  /**
   * Remembers which tokens have already been examined, and when.
   *
   * Without it the budget is spent on the same highest-scoring tokens every
   * cycle — the order is deterministic — so everything below the cut waits
   * forever. Measured in production: 106 tokens permanently "sin revisar"
   * while the same twenty were re-checked every fifteen minutes.
   */
  readonly securityCache?: SecurityCachePort
  /**
   * Hours since the newest bar CARRYING VOLUME for this token's pool, or null
   * when the candle feed answered nothing.
   *
   * Optional, and asked only about tokens that already cleared every gate —
   * one request per candidate is affordable once an hour; one per token priced
   * would be three hundred, against the provider that rate-limits hardest.
   *
   * It exists because two providers disagree. Measured live, the same pool at
   * the same moment: GeckoTerminal reported 0 trades in the last hour where
   * DexScreener reported 35, and half the 24h volume. Not a lag — the
   * provider's own top pools were current to the minute in the same run.
   *
   * The engine was caught between them: admitted on one feed's activity,
   * condemned by the other's silence. And the strategy is BAR-DRIVEN, so a pool
   * with no bars cannot be traded at all — the entry decided at a close waits
   * forever for an open that never comes, the ladder freezes at three hours,
   * and the capital is stuck behind a position that never opened.
   *
   * Whoever is right about the market, the engine's answer is the same: it does
   * not shortlist what it cannot watch.
   */
  readonly barAgeHours?: (snapshot: TokenSnapshot) => Promise<number | null>
  /**
   * The newest candle's close, from the CANDLE provider, for the same token.
   *
   * Measured in the SAME fetch as `barAgeHours` — no extra request — and
   * compared against the market price by the `priceMismatch` gate. Two
   * providers that disagree by four orders of magnitude about what a token
   * costs cannot both be right, and the engine sizes from one while filling at
   * the other.
   */
  readonly lastCandlePriceUsd?: (snapshot: TokenSnapshot) => Promise<number | null>
}

export interface CachedSecurity {
  readonly security: SecurityReport
  readonly slippagePct: number | null
  readonly measuredAt: number
}

export interface SecurityCachePort {
  cachedSecurity(chain: Chain, address: string): Promise<CachedSecurity | null>
  recordSecurity(chain: Chain, address: string, security: SecurityReport, slippagePct: number | null, measuredAt: number): Promise<void>
}

export interface ScanConfig {
  readonly chain: Chain
  readonly ranking: RankingPolicy
  /** Size of the reference sell used for the honeypot probe and impact measurement. */
  readonly referenceUsd: number
  /** Venue round-trip cost at negligible size — AMM fee, in percent. */
  readonly spreadPct: number
  /** Cap on tokens whose MARKET data is fetched. Cheap: 30 per request. */
  readonly maxTokens: number
  /**
   * Addresses we already hold on this chain. They are never candidates.
   *
   * Every universe source is a list of what is POPULAR NOW — Jupiter's lists,
   * GeckoTerminal's trending pools, DexScreener's boosts. A token bought six
   * hours ago that has since stopped trending falls out of all of them, and
   * then gets cut twice more: by `maxTokens`, and by a security budget shared
   * out on opportunity score. Measured in production: most open positions
   * reporting "el escáner no la encontró en este ciclo".
   *
   * That is the priority exactly inverted. A token holding our money is not
   * competing for attention, it has already won — and its security status is
   * the one we most need current, because it is the one a rug would cost us.
   *
   * So they enter the universe FIRST, survive the cap, and take the security
   * budget ahead of any candidate.
   */
  readonly held?: readonly string[]
  /**
   * Cap on tokens given the expensive treatment — one throttled security call
   * and one sell quote each. Omitted means every token that cleared the free
   * gates, which is the honest default now that those gates run first.
   */
  readonly maxSecurityChecks?: number
  /**
   * How long an examination stands before it is worth repeating.
   *
   * Two hours, not a day: the honeypot answer inside a report is the one that
   * ages worst, and it is the one the whole thing rests on. A cached report is
   * why a token stays eligible between checks; it is NOT why it gets traded —
   * the sell path is re-confirmed before a position is opened.
   */
  readonly securityTtlMs?: number
  /** How stale the newest bar may be before a candidate is refused. */
  readonly maxBarAgeHours?: number
}

/**
 * Progress, for a caller that has to watch this from outside.
 *
 * A scan can spend ten minutes inside throttled network calls. Without this it
 * spends them in silence, and a silent process that gets killed by a timeout
 * tells you nothing about WHERE it was — which is the difference between
 * fixing the cause and guessing at it.
 */
export type ScanProgress =
  | { readonly stage: 'universe'; readonly chain: Chain; readonly discovered: number; readonly dropped: number }
  | { readonly stage: 'market'; readonly chain: Chain; readonly priced: number }
  | { readonly stage: 'budget'; readonly chain: Chain; readonly affordable: number; readonly checking: number }
  | { readonly stage: 'checked'; readonly chain: Chain; readonly done: number; readonly of: number }
  | { readonly stage: 'done'; readonly chain: Chain; readonly candidates: number; readonly elapsedMs: number }

export interface ScanError {
  readonly address: string
  readonly stage: 'market' | 'security' | 'quote' | 'history'
  readonly error: string
}

export interface ScanOutcome extends ScanResult {
  readonly snapshots: readonly TokenSnapshot[]
  readonly errors: readonly ScanError[]
  readonly scannedAt: number
}

/**
 * The opportunity score from market data alone — no security, no quote.
 *
 * Only used to decide who gets the expensive checks. The real score is
 * computed after them, with measured quality; this one exists because ranking
 * with free information beats ranking by arrival order.
 */
const provisionalScore = (market: Omit<TokenSnapshot, 'security' | 'historyBars'>, config: ScanConfig): number =>
  scoreOpportunity({ ...market, security: UNKNOWN_SECURITY, historyBars: null }, config.ranking.opportunity, null, {
    liquidityUsd: market.liquidityUsd,
    spreadPct: config.spreadPct,
    slippagePct: market.liquidityUsd > 0 ? estimatePriceImpactPct(config.referenceUsd, market.liquidityUsd) : 100,
    referenceUsd: config.referenceUsd,
    observedAt: market.observedAt,
  }).score

/** Two hours. See the note on `securityTtlMs`. */
const DEFAULT_SECURITY_TTL_MS = 2 * 60 * 60 * 1000

const UNKNOWN_SECURITY: SecurityReport = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null,
}

/**
 * Everything the expensive stage does to ONE token: security, the sell quote
 * that doubles as the honeypot test, and how much history its pool has.
 *
 * Extracted because a SECOND caller needed it — `confirmEntry`, the last look
 * before capital moves. Two implementations of "examine this token" would
 * eventually disagree about what makes one safe, and the one that disagreed
 * quietly would be the one standing between the money and a rug. This codebase
 * has already paid for that shape twice: a ladder sized only on the offline
 * path, and an execution step that existed nowhere but `replay.ts`.
 *
 * Three providers, three independent rate limiters, run as three branches — a
 * token costs the LONGEST of them rather than their sum. Measured at 16.8
 * seconds per token before that, against a 15-minute bar.
 */
export async function examineToken(
  deps: ScanDeps,
  config: Pick<ScanConfig, 'chain' | 'referenceUsd'>,
  market: Omit<TokenSnapshot, 'security' | 'historyBars'>,
  at: number,
  record: (stage: ScanError['stage'], error: unknown) => void,
): Promise<{ readonly snapshot: TokenSnapshot; readonly slippagePct: number | null }> {
  const askGoPlus = async (): Promise<Partial<SecurityReport> | null> => {
    try {
      return await deps.goplus.securityReport(config.chain, market.address)
    } catch (error) {
      record('security', error)
      return null
    }
  }

  const askMetadataProvider = async (): Promise<{
    audit: Partial<SecurityReport> | null
    sell: SellAssessment | null
  }> => {
    let audit: Partial<SecurityReport> | null = null
    if (deps.decimals.security) {
      try {
        audit = await deps.decimals.security(config.chain, market.address)
      } catch (error) {
        record('security', error)
      }
    }
    if (!deps.sellProbe) return { audit, sell: null }
    try {
      const decimals = await deps.decimals.decimals(config.chain, market.address)
      if (decimals === null || market.priceUsd <= 0) return { audit, sell: null }
      const amountRaw = BigInt(Math.floor((config.referenceUsd / market.priceUsd) * 10 ** decimals))
      // One quote answers both questions: whether the token can be SOLD at
      // all — the honeypot test, and the only one worth trusting because it
      // is a fact rather than a third party's flag — and what the impact of
      // a real order actually is.
      return { audit, sell: await deps.sellProbe.assessSell(market.address, amountRaw, decimals, config.referenceUsd) }
    } catch (error) {
      record('quote', error)
      return { audit, sell: null }
    }
  }

  const askHistory = async (): Promise<number | null> => {
    if (!deps.history) return null
    try {
      return await deps.history.historyBars(config.chain, market.pairAddress)
    } catch (error) {
      record('history', error)
      return null
    }
  }

  const [primary, metadata, historyBars] = await Promise.all([askGoPlus(), askMetadataProvider(), askHistory()])

  // Merged in TRUST order, which the concurrency must not disturb: GoPlus
  // first, then the metadata provider's audit, then venue heuristics.
  // Danger from any source wins; unknowns fill in from the next.
  const opinions: Partial<SecurityReport>[] = []
  if (primary) opinions.push(primary)
  if (metadata.audit) opinions.push(metadata.audit)
  if (config.chain === 'solana') opinions.push(lpLockFromVenue(market.dexId))

  let security: SecurityReport = opinions.length > 0 ? mergeSecurity(...opinions) : UNKNOWN_SECURITY
  let slippagePct: number | null = null
  if (metadata.sell) {
    // A probe result beats any reported flag, in both directions.
    const { sellQuote } = metadata.sell
    security = { ...security, honeypot: sellQuote === 'ok' ? false : sellQuote === 'unknown' ? security.honeypot : true }
    slippagePct = metadata.sell.priceImpactPct
  }

  await deps.securityCache?.recordSecurity(config.chain, market.address, security, slippagePct, at)

  // What the venue said, recorded on the snapshot — so the gate can refuse
  // an inescapable pool and the screen can show the real cost, instead of
  // both inferring a friendly number from reported liquidity.
  // `securityChecked: true` explicitly. A token examined THIS cycle left the
  // field undefined while one read from cache set true and one the budget
  // skipped set false — three values for two meanings. Readers survived it by
  // testing `!== false`, which is a trap waiting for the first reader that
  // tests `=== true`.
  const snapshot: TokenSnapshot = { ...market, security, historyBars, securityChecked: true, measuredImpactPct: slippagePct }
  return { snapshot, slippagePct }
}

/**
 * One pass of the scanner: discover → market → security → sell probe → rank.
 *
 * A token that errors at any stage is skipped and recorded; one bad token
 * never aborts the scan. A token whose security could not be read is passed
 * to the gates with an all-null report, which fails closed by design.
 */
export async function scanOnce(
  deps: ScanDeps,
  config: ScanConfig,
  previous: ReadonlyMap<string, TokenSnapshot> = new Map(),
): Promise<ScanOutcome> {
  const now = deps.now ?? Date.now
  const scannedAt = now()
  const errors: ScanError[] = []

  // ── 1. Universe: every source we have, deduplicated, capped ────────────────
  // What we hold goes in before anything is discovered, so the cap below can
  // never be what decides whether our own position is looked at.
  const held = new Set(config.held ?? [])
  const universe = new Set<string>(held)
  if (deps.decimals.discover) {
    try {
      for (const address of await deps.decimals.discover()) universe.add(address)
    } catch (error) {
      errors.push({ address: '*', stage: 'market', error: `universe: ${String(error)}` })
    }
  }
  if (deps.history?.discoverPools) {
    try {
      for (const { tokenAddress } of await deps.history.discoverPools(config.chain)) universe.add(tokenAddress)
    } catch (error) {
      errors.push({ address: '*', stage: 'market', error: `pool universe: ${String(error)}` })
    }
  }
  for (const address of await deps.dex.discoverTokens(config.chain)) universe.add(address)
  // The cap bounds DISCOVERY, never what we hold. A book wider than the cap
  // would otherwise start dropping its own positions out of the scan, which is
  // the failure this whole ordering exists to prevent.
  const discovered = [...universe].filter((address) => !held.has(address))
  const room = Math.max(0, config.maxTokens - held.size)
  const addresses = [...held, ...discovered.slice(0, room)]
  // What the cap THREW AWAY, not only what it kept. A cut this size is a
  // decision about the universe, and a log that prints the survivors alone
  // reads identically whether the cap bit or the day was quiet — so the number
  // that would tell you to raise it is the one nobody could see.
  deps.onProgress?.({
    stage: 'universe',
    chain: config.chain,
    discovered: addresses.length,
    dropped: Math.max(0, discovered.length - room),
  })

  // ── 2. Market, in batches of 30 ────────────────────────────────────────────
  // Deduplicated ACROSS batches, not only within one.
  //
  // `toMarketSnapshots` keeps the deepest pair per token, but it only sees one
  // request's worth. A token can come back in two different batches — the
  // endpoint returns every pair for the addresses asked, and a pair's base
  // token is not always the one requested — and the same token then entered
  // the universe twice, was examined twice, and was counted twice on screen.
  const bestByAddress = new Map<string, (typeof markets)[number]>()
  const markets: ReturnType<typeof deps.dex.toMarketSnapshots> = []
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30)
    try {
      const pairs = await deps.dex.tokens(config.chain, batch)
      for (const market of deps.dex.toMarketSnapshots(config.chain, pairs)) {
        const current = bestByAddress.get(market.address)
        if (!current || market.liquidityUsd > current.liquidityUsd) bestByAddress.set(market.address, market)
      }
    } catch (error) {
      for (const address of batch) errors.push({ address, stage: 'market', error: String(error) })
    }
  }
  markets.push(...bestByAddress.values())

  deps.onProgress?.({ stage: 'market', chain: config.chain, priced: markets.length })

  // ── 3. Free gates before paid ones ─────────────────────────────────────────
  // Security costs one throttled request per token and the universe is larger
  // than that budget, so what can be decided from the market snapshot alone is
  // decided first. A token rejected here was rejected on the same rules it
  // would have faced anyway — this reorders the work, it does not soften it.
  const snapshots: TokenSnapshot[] = []
  const quality = new Map<string, MarketQuality>()
  const affordable: typeof markets = []

  for (const market of markets) {
    // securityChecked: FALSE, and true for neither of them yet. A token
    // rejected here was never examined — saying otherwise made every thin pool
    // read as a safety failure downstream, because an all-null report fails
    // closed and nothing recorded that nobody had looked.
    const provisional: TokenSnapshot = { ...market, security: UNKNOWN_SECURITY, historyBars: null, securityChecked: false }
    const cheap = evaluateMarketGates(provisional, config.ranking.gates)
    // The FALLBACK has to be paid for too, or it can never exist.
    //
    // A token the free gates reject is never examined, so it carries an
    // all-null security report — which fails every safety gate closed, which
    // means `forgivableFailures` can never clear it and the reserve stays
    // empty by construction. Measured after the relaunch that shipped it: ONE
    // token held, ZERO in reserve, and 108 filtered by `turnover` alone.
    //
    // The cost is bounded by what is forgivable, and that set was chosen for
    // this reason as much as any other: `age` is the single largest rejection
    // here — most of what the deep sweep returns — and forgiving it would buy
    // a throttled request per newborn pool that no indicator could ever use.
    if (cheap.passed || forgivableFailures(cheap) !== null) affordable.push(market)
    else snapshots.push(provisional)
  }

  // ── 3b. What is already known does not need paying for again ──────────────
  // A cached report keeps the token fully evaluated at no network cost, which
  // is what frees the budget to reach the ones nobody has looked at yet.
  const ttl = config.securityTtlMs ?? DEFAULT_SECURITY_TTL_MS
  const remembered = new Map<string, CachedSecurity>()
  if (deps.securityCache) {
    for (const market of affordable) {
      const known = await deps.securityCache.cachedSecurity(config.chain, market.address)
      if (known && scannedAt - known.measuredAt < ttl) remembered.set(market.address, known)
    }
  }

  for (const market of affordable) {
    const known = remembered.get(market.address)
    if (!known) continue
    const snapshot: TokenSnapshot = {
      ...market,
      security: known.security,
      historyBars: null,
      securityChecked: true,
      measuredImpactPct: known.slippagePct,
    }
    snapshots.push(snapshot)
    quality.set(tokenKey(snapshot), {
      liquidityUsd: market.liquidityUsd,
      spreadPct: config.spreadPct,
      slippagePct: known.slippagePct ?? (market.liquidityUsd > 0 ? estimatePriceImpactPct(config.referenceUsd, market.liquidityUsd) : 100),
      referenceUsd: config.referenceUsd,
      observedAt: scannedAt,
    })
  }

  // ── 4. Rank BEFORE spending, when the budget cannot cover everyone ─────────
  // Ordered by the opportunity score computed from market data alone, which
  // costs nothing. Taking the first N in discovery order would spend a
  // throttled security call and a sell quote on whichever token a provider
  // happened to list first — and on a bounded budget, the order IS the choice.
  // Only what is NOT already known competes for the budget. That single line
  // is what makes the budget rotate: a token examined this cycle is cached
  // next cycle, so the next cycle's budget reaches further down the list.
  const unexamined = affordable.filter((market) => !remembered.has(market.address))
  const budget = config.maxSecurityChecks ?? unexamined.length
  const byScore =
    budget >= unexamined.length
      ? unexamined
      : [...unexamined].sort((a, b) => provisionalScore(b, config) - provisionalScore(a, config))
  // Ours first, unranked. A held token is not competing with candidates for a
  // look — the money is already in it, and an unexamined position is one whose
  // honeypot answer nobody has refreshed since it was bought.
  const ordered = [...byScore.filter((m) => held.has(m.address)), ...byScore.filter((m) => !held.has(m.address))]

  // What the budget could not reach still goes on the screen, marked unchecked.
  // The gates fail closed, so an unexamined token is never a candidate — but
  // "nobody has looked at this yet" and "we looked and it is dangerous" are
  // different claims and must not render the same.
  for (const market of ordered.slice(budget)) {
    snapshots.push({ ...market, security: UNKNOWN_SECURITY, historyBars: null, securityChecked: false })
  }

  deps.onProgress?.({
    stage: 'budget',
    chain: config.chain,
    affordable: affordable.length,
    checking: Math.min(budget, unexamined.length),
  })

  let done = 0
  for (const market of ordered.slice(0, budget)) {
    done += 1
    // Every tenth, not every one: a log that scrolls is a log nobody reads.
    if (done % 10 === 0) {
      deps.onProgress?.({ stage: 'checked', chain: config.chain, done, of: Math.min(budget, unexamined.length) })
    }
    // Three providers, three independent rate limiters — and until the first
    // real cycle measured it, three queues waited on each other for nothing.
    // 16.8 seconds per token against a 15-minute bar, because the sum of three
    // unrelated waits is not a cost anyone chose. A token now costs the
    // LONGEST branch rather than their total.
    //
    // The sell quote is the one real dependency: it needs the decimals to size
    // a $100 order, so it stays behind them, inside its own branch.
    const record = (stage: ScanError['stage'], error: unknown) =>
      errors.push({ address: market.address, stage, error: String(error) })

    const { snapshot, slippagePct } = await examineToken(deps, config, market, scannedAt, record)
    snapshots.push(snapshot)
    quality.set(tokenKey(snapshot), {
      liquidityUsd: market.liquidityUsd,
      spreadPct: config.spreadPct,
      // A measured impact beats the model; the model beats nothing.
      slippagePct: slippagePct ?? (market.liquidityUsd > 0 ? estimatePriceImpactPct(config.referenceUsd, market.liquidityUsd) : 100),
      referenceUsd: config.referenceUsd,
      observedAt: scannedAt,
    })
  }

  // ── 4. Gates → score → rank ────────────────────────────────────────────────
  let ranked = rankUniverse(snapshots, previous, (s) => quality.get(tokenKey(s))!, config.ranking)

  // ── 4b. And can we actually SEE it trade? ──────────────────────────────────
  //
  // Measured LAST, and only for what survived everything else, because it costs
  // one candle request each. Written onto the SNAPSHOT rather than filtered out
  // of the ranking: the dashboard re-evaluates the gates on the stored snapshot,
  // so a verdict kept only in the ranking meant the screen drew a token as
  // eligible while the engine refused it — the exact screen-versus-engine
  // disagreement the read model exists to prevent. Eighteen of twenty-seven
  // Solana tokens were in that state.
  if (deps.barAgeHours && config.maxBarAgeHours !== undefined) {
    const measured = new Map<string, number | null>()
    const priced = new Map<string, number | null>()
    for (const candidate of ranked.candidates) {
      const key = tokenKey(candidate.snapshot)
      try {
        measured.set(key, await deps.barAgeHours(candidate.snapshot))
        // The same fetch, so this costs nothing beyond what was already paid.
        if (deps.lastCandlePriceUsd) priced.set(key, await deps.lastCandlePriceUsd(candidate.snapshot))
      } catch (error) {
        errors.push({ address: candidate.snapshot.address, stage: 'history', error: String(error) })
        // NOT a verdict. `null` means the feed answered and nobody had traded —
        // the strongest form of "this engine cannot watch it", and rightly a
        // safety failure. A request that never got an answer says nothing about
        // the TOKEN; it says something about us.
        //
        // Collapsing the two turned 26 of 29 live positions red at once, Bonk
        // among them, the moment a tighter retry budget let 429s through. The
        // screen announced that the whole book had gone dangerous; what had
        // happened was that we had run out of quota. It is the sell probe's own
        // rule, broken here: an RPC failure is never read as "no route".
        //
        // Left ABSENT, the gate stays silent — it fires on evidence — and
        // `confirmEntry` asks again, live, before any capital moves.
      }
    }
    if (measured.size > 0) {
      const withAge = snapshots.map((s) =>
        measured.has(tokenKey(s))
          ? {
              ...s,
              lastTradeAgoHours: measured.get(tokenKey(s))!,
              ...(priced.has(tokenKey(s)) ? { lastCandlePriceUsd: priced.get(tokenKey(s))! } : {}),
            }
          : s,
      )
      snapshots.length = 0
      snapshots.push(...withAge)
      // Re-ranked on the completed evidence, so `staleBars` decides here exactly
      // as it will on the screen and at the door. One gate, one definition.
      ranked = rankUniverse(snapshots, previous, (s) => quality.get(tokenKey(s))!, config.ranking)
    }
  }

  deps.onProgress?.({
    stage: 'done',
    chain: config.chain,
    candidates: ranked.candidates.length,
    elapsedMs: now() - scannedAt,
  })
  return { ...ranked, snapshots, errors, scannedAt }
}
