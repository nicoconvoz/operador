import { estimatePriceImpactPct, type MarketQuality } from '../domain/market/market-quality.js'
import { rankUniverse, tokenKey, type RankingPolicy, type ScanResult } from '../domain/scanner/ranking.js'
import { evaluateMarketGates } from '../domain/scanner/gates.js'
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
   * Cap on tokens given the expensive treatment — one throttled security call
   * and one sell quote each. Omitted means every token that cleared the free
   * gates, which is the honest default now that those gates run first.
   */
  readonly maxSecurityChecks?: number
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
  | { readonly stage: 'universe'; readonly chain: Chain; readonly discovered: number }
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

const UNKNOWN_SECURITY: SecurityReport = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null,
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
  const universe = new Set<string>()
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
  const addresses = [...universe].slice(0, config.maxTokens)
  deps.onProgress?.({ stage: 'universe', chain: config.chain, discovered: addresses.length })

  // ── 2. Market, in batches of 30 ────────────────────────────────────────────
  const markets = []
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30)
    try {
      const pairs = await deps.dex.tokens(config.chain, batch)
      markets.push(...deps.dex.toMarketSnapshots(config.chain, pairs))
    } catch (error) {
      for (const address of batch) errors.push({ address, stage: 'market', error: String(error) })
    }
  }

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
    const provisional: TokenSnapshot = { ...market, security: UNKNOWN_SECURITY, historyBars: null, securityChecked: true }
    const cheap = evaluateMarketGates(provisional, config.ranking.gates)
    if (cheap.passed) affordable.push(market)
    else snapshots.push(provisional)
  }

  // ── 4. Rank BEFORE spending, when the budget cannot cover everyone ─────────
  // Ordered by the opportunity score computed from market data alone, which
  // costs nothing. Taking the first N in discovery order would spend a
  // throttled security call and a sell quote on whichever token a provider
  // happened to list first — and on a bounded budget, the order IS the choice.
  const budget = config.maxSecurityChecks ?? affordable.length
  const ordered =
    budget >= affordable.length
      ? affordable
      : [...affordable].sort((a, b) => provisionalScore(b, config) - provisionalScore(a, config))

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
    checking: Math.min(budget, affordable.length),
  })

  let done = 0
  for (const market of ordered.slice(0, budget)) {
    done += 1
    // Every tenth, not every one: a log that scrolls is a log nobody reads.
    if (done % 10 === 0) {
      deps.onProgress?.({ stage: 'checked', chain: config.chain, done, of: Math.min(budget, affordable.length) })
    }
    // Sources in trust order: GoPlus, then the metadata provider's audit,
    // then venue heuristics. Danger from any source wins; unknowns fill in.
    const opinions: Partial<SecurityReport>[] = []
    try {
      const primary = await deps.goplus.securityReport(config.chain, market.address)
      if (primary) opinions.push(primary)
    } catch (error) {
      errors.push({ address: market.address, stage: 'security', error: String(error) })
    }
    if (deps.decimals.security) {
      try {
        const second = await deps.decimals.security(config.chain, market.address)
        if (second) opinions.push(second)
      } catch (error) {
        errors.push({ address: market.address, stage: 'security', error: String(error) })
      }
    }
    if (config.chain === 'solana') opinions.push(lpLockFromVenue(market.dexId))
    let security: SecurityReport = opinions.length > 0 ? mergeSecurity(...opinions) : UNKNOWN_SECURITY

    let slippagePct: number | null = null
    if (deps.sellProbe) {
      try {
        const decimals = await deps.decimals.decimals(config.chain, market.address)
        if (decimals !== null && market.priceUsd > 0) {
          const amountRaw = BigInt(Math.floor((config.referenceUsd / market.priceUsd) * 10 ** decimals))
          // One quote answers both questions: whether the token can be SOLD at
          // all — the honeypot test, and the only one worth trusting because it
          // is a fact rather than a third party's flag — and what the impact of
          // a real order actually is.
          const sell = await deps.sellProbe.assessSell(market.address, amountRaw, decimals, config.referenceUsd)
          // A probe result beats any reported flag, in both directions.
          security = { ...security, honeypot: sell.sellQuote === 'ok' ? false : sell.sellQuote === 'unknown' ? security.honeypot : true }
          slippagePct = sell.priceImpactPct
        }
      } catch (error) {
        errors.push({ address: market.address, stage: 'quote', error: String(error) })
      }
    }

    let historyBars: number | null = null
    if (deps.history) {
      try {
        historyBars = await deps.history.historyBars(config.chain, market.pairAddress)
      } catch (error) {
        errors.push({ address: market.address, stage: 'history', error: String(error) })
      }
    }

    const snapshot: TokenSnapshot = { ...market, security, historyBars }
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
  const ranked = rankUniverse(snapshots, previous, (s) => quality.get(tokenKey(s))!, config.ranking)

  deps.onProgress?.({
    stage: 'done',
    chain: config.chain,
    candidates: ranked.candidates.length,
    elapsedMs: now() - scannedAt,
  })
  return { ...ranked, snapshots, errors, scannedAt }
}
