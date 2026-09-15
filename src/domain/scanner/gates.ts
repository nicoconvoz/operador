import { lpModelOf } from './lp-model.js'
import { hoursOld, type TokenSnapshot } from './snapshot.js'

/**
 * Safety gates — hard blockers evaluated before anything else.
 *
 * A token that fails ANY gate is never traded, regardless of how good its
 * market signal looks. And the gates FAIL CLOSED: when a critical security
 * fact is unknown, the token is treated as unsafe, not as unproven. The cost
 * of a false negative here is a wallet full of something unsellable.
 */

export interface GatePolicy {
  readonly minLiquidityUsd: number
  readonly minAgeHours: number
  readonly minVolume24hUsd: number
  readonly maxTransferTaxPct: number
  readonly minLpLockedPct: number
  readonly maxTopHoldersPct: number
  readonly maxCreatorPct: number
  /**
   * The strategy hunts small caps. Above this fully-diluted value a token is
   * not the kind of asset CASCADE DCA was tuned for; null disables the cap.
   */
  readonly maxFdvUsd: number | null
  /** Mints that are never a trade: stablecoins, wrapped natives, LSTs. */
  readonly denylist: readonly string[]
  /** Symbol → the only mint allowed to carry it. Anything else is an impostor. */
  readonly canonicalSymbols: Readonly<Record<string, string>>
  /**
   * Closed 1H candles the strategy needs before it can say anything.
   *
   * EMA-200 seeds at bar 199 and takes hundreds more to converge; the
   * Bollinger basis needs 50. Below this the indicators are not wrong, they
   * are ABSENT — and a strategy with absent indicators does not trade, it
   * guesses. Unknown history is tolerated: the gate only fires on a count
   * that was actually measured and came up short.
   */
  readonly minHistoryBars: number
  /**
   * Price impact of a reference sell, above which the token is not a trade.
   *
   * The score already penalises cost — `costEfficiency` reaches zero at a 6%
   * round trip — but a penalty only reorders a list. A pool where leaving
   * costs more than this is not a worse opportunity, it is not an opportunity:
   * no entry signal can pay for it and no sizing can shrink out of it, because
   * the measurement was taken at the smallest size worth quoting.
   *
   * Fires only on a MEASURED value. An impact nobody quoted is unknown, and
   * unknown cost is not evidence of a bad pool — unlike the safety gates,
   * which fail closed because unknown danger IS evidence.
   */
  readonly maxReferenceImpactPct: number
}

/** Solana mints the scanner must never propose — they are money, not trades. */
export const SOLANA_DENYLIST: readonly string[] = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]

/**
 * Symbols that belong to exactly one canonical mint. A token wearing one of
 * these names at a different address is an impersonation — the first live
 * scan surfaced a "USDC" on Raydium with a $96k pool and 39% in ten wallets.
 */
export const SOLANA_CANONICAL_SYMBOLS: Readonly<Record<string, string>> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  WBTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  WETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  // The UNWRAPPED names, pointed at the same wrapped mints.
  //
  // Bitcoin and Ether have no native mint on Solana — the wrapped tokens are
  // the only things those names can honestly refer to. The map knew WBTC and
  // not BTC, which left the most recognisable ticker in crypto as the one
  // symbol anybody could borrow: a fifteen-day-old memecoin was scanned,
  // ranked and ALLOCATED under the name "BTC" with a $267k pool and not one
  // blocker against it.
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  minLiquidityUsd: 20_000,
  minAgeHours: 24,
  minVolume24hUsd: 10_000,
  maxTransferTaxPct: 5,
  minLpLockedPct: 80,
  maxTopHoldersPct: 40,
  maxCreatorPct: 10,
  maxFdvUsd: 50_000_000,
  denylist: SOLANA_DENYLIST,
  canonicalSymbols: SOLANA_CANONICAL_SYMBOLS,
  minHistoryBars: 250,
  // CREPE measured 98% on a $285 sell while reporting $718k of liquidity.
  // Ten percent is already far beyond anything the 1%-per-fill and 3%-exit
  // budgets could rescue; past it there is nothing to size down to.
  maxReferenceImpactPct: 10,
}

export type GateName =
  | 'honeypot'
  | 'impact'
  | 'mintAuthority'
  | 'freezeAuthority'
  | 'blacklist'
  | 'transferTax'
  | 'lpLocked'
  | 'topHolders'
  | 'creatorShare'
  | 'liquidity'
  | 'age'
  | 'volume'
  | 'proxy'
  | 'denylist'
  | 'marketCap'
  | 'impersonation'
  | 'history'

export interface GateFailure {
  readonly gate: GateName
  /** 'unknown' when the gate failed closed on missing data. */
  readonly reason: 'failed' | 'unknown'
  readonly detail: string
}

export interface GateResult {
  readonly passed: boolean
  readonly failures: readonly GateFailure[]
}

const fail = (gate: GateName, reason: GateFailure['reason'], detail: string): GateFailure => ({ gate, reason, detail })

/** "usdc", " USDC ", "$USDC" and "USDC." all mean USDC to a victim. */
const normaliseSymbol = (symbol: string): string => symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The gates that need NO extra network call — everything decidable from the
 * market snapshot alone.
 *
 * Separated because the security gates cost one throttled request per token,
 * and the universe is larger than that budget. Deciding what is free before
 * paying for what is not lets the scanner cover every token it can see
 * instead of the first N it happens to reach.
 *
 * This is an optimisation of ORDER, not of strictness: a token that passes
 * here still faces the full gate set, security included.
 */
export function evaluateMarketGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const failures: GateFailure[] = []

  if (policy.denylist.includes(snapshot.address)) {
    failures.push(fail('denylist', 'failed', `${snapshot.symbol} is money, not a trade`))
  }
  const canonical = policy.canonicalSymbols[normaliseSymbol(snapshot.symbol)]
  if (canonical !== undefined && canonical !== snapshot.address) {
    failures.push(fail('impersonation', 'failed', `"${snapshot.symbol}" at ${snapshot.address} is not the canonical mint`))
  }
  if (policy.maxFdvUsd !== null && snapshot.fdvUsd !== null && snapshot.fdvUsd > policy.maxFdvUsd) {
    failures.push(fail('marketCap', 'failed', `FDV $${Math.round(snapshot.fdvUsd).toLocaleString()} > $${policy.maxFdvUsd.toLocaleString()} — not a small cap`))
  }
  if (snapshot.liquidityUsd < policy.minLiquidityUsd) {
    failures.push(fail('liquidity', 'failed', `liquidity $${snapshot.liquidityUsd.toFixed(0)} < $${policy.minLiquidityUsd}`))
  }
  const age = hoursOld(snapshot)
  if (age === null) failures.push(fail('age', 'unknown', 'pair creation time unknown'))
  else if (age < policy.minAgeHours) failures.push(fail('age', 'failed', `pair is ${age.toFixed(1)}h old < ${policy.minAgeHours}h`))

  if (snapshot.volumeUsd.h24 < policy.minVolume24hUsd) {
    failures.push(fail('volume', 'failed', `24h volume $${snapshot.volumeUsd.h24.toFixed(0)} < $${policy.minVolume24hUsd}`))
  }

  return { passed: failures.length === 0, failures }
}

export function evaluateGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const s = snapshot.security
  const failures: GateFailure[] = []

  // ── Not a trade at all ────────────────────────────────────────────────────
  if (policy.denylist.includes(snapshot.address)) {
    failures.push(fail('denylist', 'failed', `${snapshot.symbol} is money, not a trade`))
  }
  const canonical = policy.canonicalSymbols[normaliseSymbol(snapshot.symbol)]
  if (canonical !== undefined && canonical !== snapshot.address) {
    failures.push(fail('impersonation', 'failed', `"${snapshot.symbol}" at ${snapshot.address} is not the canonical mint`))
  }
  if (policy.maxFdvUsd !== null && snapshot.fdvUsd !== null && snapshot.fdvUsd > policy.maxFdvUsd) {
    failures.push(fail('marketCap', 'failed', `FDV $${Math.round(snapshot.fdvUsd).toLocaleString()} > $${policy.maxFdvUsd.toLocaleString()} — not a small cap`))
  }

  // ── Critical security facts: unknown is a failure ─────────────────────────
  const impact = snapshot.measuredImpactPct
  if (impact !== null && impact !== undefined && impact > policy.maxReferenceImpactPct) {
    failures.push(fail('impact', 'failed', `a reference sell moves the price ${impact.toFixed(1)}% — there is no way out`))
  }

  if (s.honeypot === null) failures.push(fail('honeypot', 'unknown', 'sell simulation unavailable'))
  else if (s.honeypot) failures.push(fail('honeypot', 'failed', 'sell simulation failed'))

  if (s.mintAuthorityActive === null) failures.push(fail('mintAuthority', 'unknown', 'mint authority unknown'))
  else if (s.mintAuthorityActive) failures.push(fail('mintAuthority', 'failed', 'mint authority still active'))

  if (s.freezeAuthorityActive === null) failures.push(fail('freezeAuthority', 'unknown', 'freeze authority unknown'))
  else if (s.freezeAuthorityActive) failures.push(fail('freezeAuthority', 'failed', 'freeze authority still active'))

  if (s.hasBlacklist === null) failures.push(fail('blacklist', 'unknown', 'blacklist capability unknown'))
  else if (s.hasBlacklist) failures.push(fail('blacklist', 'failed', 'contract can blacklist wallets'))

  if (s.transferTaxPct === null) failures.push(fail('transferTax', 'unknown', 'transfer tax unknown'))
  else if (s.transferTaxPct > policy.maxTransferTaxPct) {
    failures.push(fail('transferTax', 'failed', `transfer tax ${s.transferTaxPct}% > ${policy.maxTransferTaxPct}%`))
  }

  // An LP lock can only exist where LP tokens exist. On concentrated venues
  // the gate is skipped — not passed — and the liquidity gate plus the death
  // exit's monitoring carry the defense. See lp-model.ts.
  if (lpModelOf(snapshot.dexId, snapshot.dexLabels) === 'lp-token') {
    if (s.lpLockedPct === null) failures.push(fail('lpLocked', 'unknown', 'LP lock status unknown'))
    else if (s.lpLockedPct < policy.minLpLockedPct) {
      failures.push(fail('lpLocked', 'failed', `LP locked ${s.lpLockedPct}% < ${policy.minLpLockedPct}%`))
    }
  }

  if (s.topHoldersPct === null) failures.push(fail('topHolders', 'unknown', 'holder concentration unknown'))
  else if (s.topHoldersPct > policy.maxTopHoldersPct) {
    failures.push(fail('topHolders', 'failed', `top holders ${s.topHoldersPct}% > ${policy.maxTopHoldersPct}%`))
  }

  // Creator share is informative on both chains but only sometimes known;
  // unknown is tolerated because the holder concentration gate already covers
  // the dangerous case.
  if (s.creatorPct !== null && s.creatorPct > policy.maxCreatorPct) {
    failures.push(fail('creatorShare', 'failed', `creator holds ${s.creatorPct}% > ${policy.maxCreatorPct}%`))
  }

  // EVM-only: an upgradeable proxy can change the rules after you buy.
  if (snapshot.chain === 'bsc' && s.isProxy === true) failures.push(fail('proxy', 'failed', 'upgradeable proxy contract'))

  // ── Market facts: these are always known ──────────────────────────────────
  if (snapshot.liquidityUsd < policy.minLiquidityUsd) {
    failures.push(fail('liquidity', 'failed', `liquidity $${snapshot.liquidityUsd.toFixed(0)} < $${policy.minLiquidityUsd}`))
  }

  const age = hoursOld(snapshot)
  if (age === null) failures.push(fail('age', 'unknown', 'pair creation time unknown'))
  else if (age < policy.minAgeHours) failures.push(fail('age', 'failed', `pair is ${age.toFixed(1)}h old < ${policy.minAgeHours}h`))

  // Only fires on a measured count: a scanner pass that has not fetched
  // candles yet says nothing, and the executor checks again before trading.
  if (snapshot.historyBars !== null && snapshot.historyBars !== undefined && snapshot.historyBars < policy.minHistoryBars) {
    failures.push(fail('history', 'failed', `${snapshot.historyBars} bars of 1H history < ${policy.minHistoryBars} — EMA-200 cannot exist`))
  }

  if (snapshot.volumeUsd.h24 < policy.minVolume24hUsd) {
    failures.push(fail('volume', 'failed', `24h volume $${snapshot.volumeUsd.h24.toFixed(0)} < $${policy.minVolume24hUsd}`))
  }

  return { passed: failures.length === 0, failures }
}
