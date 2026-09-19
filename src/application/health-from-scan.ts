import { type LpStatus } from '../domain/risk/death-exit.js'
import { evaluateSafetyGates, type GatePolicy } from '../domain/scanner/gates.js'
import { withLiveMarket, type LiveMarket } from '../domain/scanner/live-market.js'
import { lpModelOf } from '../domain/scanner/lp-model.js'
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
 *
 * `hoursSinceLastTrade` used to be on that list, and it did not belong there.
 * The argument was that we measure volume, not the time of the last trade — true
 * of the SCAN, which is all this file sees. It is false of the CANDLES, where
 * the newest bar carrying volume IS when somebody last traded. `idle-hours.ts`
 * reads it there, and the engine hands it over per tick, because that is the
 * layer holding the measurement.
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
  /**
   * Which SAFETY gates fail on this token now, or null when nobody examined it.
   *
   * The four fields above are the ones that map onto a named invalidation
   * signal. Everything else the scan measures — a transfer tax appearing, a
   * blacklist function appearing, concentration spiking, a contract turning
   * into a proxy, an impersonated symbol — had nowhere to go, so a gate could
   * turn on a token holding our money and the engine would never learn of it.
   *
   * ANSEM is the token that proved it: the screen drew it `turnedUnsafe` with
   * its blockers listed while the engine reported `deathStage: healthy` over a
   * live position. Two implementations of "is this dangerous" always drift, and
   * the one on the screen is the one the operator believes.
   */
  readonly safetyFailed: readonly string[] | null
}

export const UNMEASURED: ScannerHealth = {
  liquidityUsd: null,
  lpStatus: 'unknown',
  mintAuthorityActive: null,
  freezeAuthorityActive: null,
  safetyFailed: null,
}

/**
 * One cycle's worth of health, with the two halves on their own clocks.
 *
 * The SCAN's half — security, the LP, the authorities, the gate verdict — folds
 * only when the scan is new. `exitConfirmations` counts CONSECUTIVE
 * observations carrying stage-2 evidence, so handing the same hourly answer to
 * every five-minute pass would turn one reading into twelve confirmations: the
 * precise false positive that rule exists to prevent, wearing its clothes.
 *
 * The LIQUIDITY half is a fresh measurement every cycle, because the engine
 * already fetches it for every held token and used to throw it away. Passing it
 * on is reporting, not repeating — three confirmations then come from three
 * genuine readings fifteen minutes apart, which is what the rule always meant.
 *
 * It matters because of what a freeze DOES. `exitOnFreeze` sells, and a freeze
 * exit is exempt from the no-loss guard, so it takes whatever price is left. A
 * pool can empty inside the twenty minutes between held scans, and the signal
 * whose entire purpose is to leave BEFORE leaving is impossible was arriving
 * after the pool had already gone.
 *
 * It lives here rather than in the composition root on purpose. Every wiring
 * bug this project has paid for was out there — a missing `discover`, a missing
 * `poolMarkets`, a capital trim that wrote over the tick — because nothing out
 * there is tested. A decision belongs where it can be.
 */
export function healthForCycle(
  stored: TokenSnapshot | null,
  policy: GatePolicy,
  live: LiveMarket | undefined,
  scanIsFresh: boolean,
): ScannerHealth {
  if (scanIsFresh) return healthFromSnapshot(stored, policy, live)
  // Silence on everything the scan owns, and the one number that is genuinely
  // new. `null` where no feed answered: a quiet provider is not an empty pool.
  return { ...UNMEASURED, liquidityUsd: live?.liquidityUsd ?? null }
}

/**
 * `minLpLockedPct` is the gate's own threshold, so "unlocked" here means
 * exactly what it means when the scanner refuses to open a position — one
 * definition, not two that drift.
 */
export function healthFromSnapshot(
  stored: TokenSnapshot | null,
  policy: GatePolicy,
  live: LiveMarket | undefined,
): ScannerHealth {
  const minLpLockedPct = policy.minLpLockedPct
  if (!stored) return UNMEASURED

  // The MARKET half, as of the last cycle rather than the last scan.
  //
  // The engine already asks DexScreener for every held token once a cycle and
  // the response carries liquidity, volume and the counts — it kept the price
  // and discarded the rest, while this read liquidity from a scan up to twenty
  // minutes old. A pool can empty inside twenty minutes, and `exitOnFreeze`
  // then sells into what is left of it, exempt from the no-loss guard. The one
  // signal whose purpose is to leave BEFORE leaving is impossible was the one
  // arriving late.
  //
  // `withLiveMarket` is the ONE definition of which half a feed may refresh,
  // shared with the universe view and the recall — never a second copy. It
  // leaves the security report, the history count and the candle measurements
  // exactly as the scan left them, because a market response knows none of
  // them and those gates fail CLOSED.
  //
  // `undefined` means no feed answered, and that changes nothing: silence is
  // not a collapse, or one rate-limited minute would freeze and sell the book.
  const snapshot = withLiveMarket(stored, live)

  // An unexamined token carries UNKNOWN_SECURITY, and passing that through
  // would report "mint authority is null" as a reading rather than as the
  // absence of one. It is the same value either way, but the distinction
  // matters if this ever grows a freshness rule.
  if (snapshot.securityChecked === false) {
    return { ...UNMEASURED, liquidityUsd: snapshot.liquidityUsd }
  }

  // The gate set's OWN verdict, not a second reading of the same facts.
  //
  // `evaluateSafetyGates` is exactly what `confirmEntry` asks at the door, so a
  // token we hold is judged by the rule that would refuse to buy it today. The
  // opportunity half is deliberately excluded: turnover, volume and market cap
  // are preferences the reserve already forgives, and freezing a position over
  // one would turn the shortlist's taste into a sell signal.
  //
  // Reached only past the `securityChecked` guard above, and that ordering is
  // the safety. The safety gates fail CLOSED, so an unexamined token fails all
  // of them by design — reporting that as "it turned" would freeze every
  // position the security budget has not got to yet, and with `exitOnFreeze`
  // on that is not a pause, it is the whole book sold.
  // MEASURED failures only. The gates fail CLOSED on missing data, which is
  // the right answer at the door — a token nobody can vouch for is not bought.
  // It is the wrong answer here: a GoPlus rate limit leaves the whole report
  // null while the scan still marks the token examined, so every gate would
  // report a failure and `exitOnFreeze` would sell the book because we ran out
  // of quota. Twenty-six positions once turned red for exactly that.
  //
  // The sell probe's rule, in the mirror: an RPC failure is never read as "no
  // route" — one is inconclusive, the other is a death signal, and confusing
  // them either liquidates a healthy position or holds a dead one.
  const safetyFailed = evaluateSafetyGates(snapshot, policy)
    .failures.filter((failure) => failure.reason === 'failed')
    .map((failure) => failure.gate)

  // "Is the LP locked?" only means something where LP TOKENS EXIST. On Orca
  // whirlpools, Raydium CLMM and Meteora DLMM, positions are NFTs — there is
  // nothing to lock, and `lpLockedPct` comes back null or zero because the
  // question does not apply, not because the answer is bad.
  //
  // Reading it anyway froze a healthy position twice: PURR opened green and
  // went to stage 1 on the evidence "LP unlocked", while the scanner's own
  // gates passed it with no blockers. The gate consults `lpModelOf` and SKIPS
  // the question on those venues; this did not, so the two disagreed about the
  // same token — the exact drift the comment above claims to prevent.
  //
  // lp-model.ts states the rule for the gate: it does not PASS a concentrated
  // pool by pretending a lock exists. The mirror of that is what this got
  // wrong — it FAILED one by pretending a lock was missing.
  const hasLpTokens = lpModelOf(snapshot.dexId, snapshot.dexLabels) === 'lp-token'
  const locked = snapshot.security.lpLockedPct
  return {
    liquidityUsd: snapshot.liquidityUsd,
    // 'burned' is not distinguishable from 'locked' in what the providers
    // report, and 'removed' would need a withdrawal event nobody watches for.
    // Claiming either would be claiming a measurement we do not have.
    lpStatus: !hasLpTokens || locked === null ? 'unknown' : locked >= minLpLockedPct ? 'locked' : 'unlocked',
    mintAuthorityActive: snapshot.security.mintAuthorityActive,
    freezeAuthorityActive: snapshot.security.freezeAuthorityActive,
    safetyFailed,
  }
}
