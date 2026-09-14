import { estimatePriceImpactPct, type MarketQuality } from '../domain/market/market-quality.js'
import { rankUniverse, tokenKey, type RankingPolicy, type ScanResult } from '../domain/scanner/ranking.js'
import { type Chain, type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { type GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { type Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'

/** Token decimals — needed to size a reference sell in base units. */
export interface DecimalsPort {
  decimals(chain: Chain, address: string): Promise<number | null>
}

export interface ScanDeps {
  readonly dex: DexScreener
  readonly goplus: GoPlus
  readonly jupiter: Jupiter
  readonly decimals: DecimalsPort
  readonly now?: () => number
}

export interface ScanConfig {
  readonly chain: Chain
  readonly ranking: RankingPolicy
  /** Size of the reference sell used for the honeypot probe and impact measurement. */
  readonly referenceUsd: number
  /** Venue round-trip cost at negligible size — AMM fee, in percent. */
  readonly spreadPct: number
  /** Cap on tokens examined per scan, to respect rate limits. */
  readonly maxTokens: number
}

export interface ScanError {
  readonly address: string
  readonly stage: 'market' | 'security' | 'quote'
  readonly error: string
}

export interface ScanOutcome extends ScanResult {
  readonly snapshots: readonly TokenSnapshot[]
  readonly errors: readonly ScanError[]
  readonly scannedAt: number
}

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

  // ── 1. Universe ────────────────────────────────────────────────────────────
  const addresses = (await deps.dex.discoverTokens(config.chain)).slice(0, config.maxTokens)

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

  // ── 3. Security + sell probe, one token at a time (rate limits) ────────────
  const snapshots: TokenSnapshot[] = []
  const quality = new Map<string, MarketQuality>()

  for (const market of markets) {
    let security: SecurityReport = UNKNOWN_SECURITY
    try {
      security = (await deps.goplus.securityReport(config.chain, market.address)) ?? UNKNOWN_SECURITY
    } catch (error) {
      errors.push({ address: market.address, stage: 'security', error: String(error) })
    }

    let slippagePct: number | null = null
    if (config.chain === 'solana') {
      try {
        const decimals = await deps.decimals.decimals('solana', market.address)
        if (decimals !== null && market.priceUsd > 0) {
          const amountRaw = BigInt(Math.floor((config.referenceUsd / market.priceUsd) * 10 ** decimals))
          const probe = await deps.jupiter.probeSellPath(market.address, amountRaw, config.referenceUsd)
          // GoPlus has no honeypot flag on Solana: the sell probe IS the honeypot test.
          security = { ...security, honeypot: probe === 'ok' ? false : probe === 'unknown' ? null : true }
          slippagePct = await deps.jupiter.measureSlippagePct(market.address, decimals, market.priceUsd, config.referenceUsd)
        }
      } catch (error) {
        errors.push({ address: market.address, stage: 'quote', error: String(error) })
      }
    }

    const snapshot: TokenSnapshot = { ...market, security }
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

  return { ...ranked, snapshots, errors, scannedAt }
}
