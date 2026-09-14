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
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  minLiquidityUsd: 20_000,
  minAgeHours: 24,
  minVolume24hUsd: 10_000,
  maxTransferTaxPct: 5,
  minLpLockedPct: 80,
  maxTopHoldersPct: 40,
  maxCreatorPct: 10,
}

export type GateName =
  | 'honeypot'
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

export function evaluateGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const s = snapshot.security
  const failures: GateFailure[] = []

  // ── Critical security facts: unknown is a failure ─────────────────────────
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

  if (snapshot.volumeUsd.h24 < policy.minVolume24hUsd) {
    failures.push(fail('volume', 'failed', `24h volume $${snapshot.volumeUsd.h24.toFixed(0)} < $${policy.minVolume24hUsd}`))
  }

  return { passed: failures.length === 0, failures }
}
