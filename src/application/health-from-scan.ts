import { type LpStatus } from '../domain/risk/death-exit.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

/**
 * The scanner's verdict, turned into evidence the death watch can act on.
 *
 * `healthFor` in the composition root reported the sell probe and NOTHING
 * else — seven of the eight invalidation signals hardcoded to null:
 *
 *     liquidityUsd: null, lpStatus: 'unknown', mintAuthorityActive: null,
 *     freezeAuthorityActive: null, transfersBlocked: null,
 *     topHolderMovedPct: null, hoursSinceLastTrade: null
 *
 * So a token whose mint authority came back, or whose LP was unlocked, or
 * whose pool drained, could not be seen at all. The death exit is complete and
 * has twenty-two scenario tests; the runtime fed it one fact. The same shape as
 * the missing execution layer — written, tested, documented, and reached only
 * by the offline path.
 *
 * The scan already measures every one of these. It was never handed over.
 *
 * WHAT IS DELIBERATELY NOT MAPPED, and why each would be a lie:
 *
 *  - `topHolderMovedPct` ← `topHoldersPct` is a LEVEL, not a MOVE. A token
 *    where ten wallets have always held 35% has moved nothing; reporting the
 *    level as a movement would fire the dev-dump signal on every concentrated
 *    token in the book, permanently.
 *  - `transfersBlocked` ← `hasBlacklist` says the contract HAS a blacklist
 *    function, not that we are on it. The sell probe is the test that answers
 *    the real question, and it already runs.
 *  - `hoursSinceLastTrade` ← we measure volume, not the time of the last
 *    trade. Deriving one from the other would be inventing a number the
 *    abandonment signal then treats as measured.
 *
 * Four honest readings beat eight where half are guesses: the death exit
 * requires CONFIRMATION, and confirmations built on invented data confirm
 * nothing while looking exactly like proof.
 */

export interface ScannerHealth {
  readonly liquidityUsd: number | null
  readonly lpStatus: LpStatus
  readonly mintAuthorityActive: boolean | null
  readonly freezeAuthorityActive: boolean | null
}

export const UNMEASURED: ScannerHealth = {
  liquidityUsd: null,
  lpStatus: 'unknown',
  mintAuthorityActive: null,
  freezeAuthorityActive: null,
}

/**
 * `minLpLockedPct` is the gate's own threshold, so "unlocked" here means
 * exactly what it means when the scanner refuses to open a position — one
 * definition, not two that drift.
 */
export function healthFromSnapshot(snapshot: TokenSnapshot | null, minLpLockedPct: number): ScannerHealth {
  if (!snapshot) return UNMEASURED

  // An unexamined token carries UNKNOWN_SECURITY, and passing that through
  // would report "mint authority is null" as a reading rather than as the
  // absence of one. It is the same value either way, but the distinction
  // matters if this ever grows a freshness rule.
  if (snapshot.securityChecked === false) {
    return { ...UNMEASURED, liquidityUsd: snapshot.liquidityUsd }
  }

  const locked = snapshot.security.lpLockedPct
  return {
    liquidityUsd: snapshot.liquidityUsd,
    // 'burned' is not distinguishable from 'locked' in what the providers
    // report, and 'removed' would need a withdrawal event nobody watches for.
    // Claiming either would be claiming a measurement we do not have.
    lpStatus: locked === null ? 'unknown' : locked >= minLpLockedPct ? 'locked' : 'unlocked',
    mintAuthorityActive: snapshot.security.mintAuthorityActive,
    freezeAuthorityActive: snapshot.security.freezeAuthorityActive,
  }
}
