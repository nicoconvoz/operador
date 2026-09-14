import { type Order } from '../strategy/state.js'

/**
 * Death exit — the one exception to "never exit at a loss".
 *
 *   A stop loss exits because the PRICE fell.
 *   A death exit exits because the ASSET stopped being an asset.
 *
 * Two stages, because acting late means not being able to act at all:
 *
 *   FROZEN  (suspicion)    — stop deploying DCA levels. Nothing is sold.
 *                            Reversible once the signals clear.
 *   DEAD    (confirmation) — liquidate at whatever price exists, blacklist.
 *                            Terminal.
 *
 * Freeze is cheap and fires on a single observation. Exit is expensive and
 * requires consecutive confirming observations — a lone RPC returning stale
 * or zero data must never liquidate a healthy position.
 */

export type SellQuoteResult = 'ok' | 'failed' | 'implausible' | 'unknown'
export type LpStatus = 'locked' | 'burned' | 'unlocked' | 'removed' | 'unknown'

/**
 * GUARDRAIL, enforced by the type system: no price-shaped field can enter an
 * observation. If price ever leaks into this path the death exit silently
 * degrades into a stop loss and the strategy's premise dies with it.
 */
type PriceFree = {
  readonly price?: never
  readonly close?: never
  readonly drawdown?: never
  readonly drawdownPct?: never
  readonly pnl?: never
  readonly openProfit?: never
  readonly roi?: never
  readonly level?: never
}

/** One look at the asset's health, from one monitor, at one moment. */
export interface AssetHealthObservation extends PriceFree {
  readonly observedAt: number
  /** Which monitor / RPC produced it — part of the evidence chain. */
  readonly source: string
  /** Result of quoting a SELL of the full position. The canonical honeypot test. */
  readonly sellQuote: SellQuoteResult
  /** Current pool depth, or null when the monitor could not read it. */
  readonly liquidityUsd: number | null
  readonly lpStatus: LpStatus
  readonly mintAuthorityActive: boolean | null
  readonly freezeAuthorityActive: boolean | null
  /** Transfers paused, or our wallet blacklisted. */
  readonly transfersBlocked: boolean | null
  /** Share of supply moved by top holders in the monitor's window, percent. */
  readonly topHolderMovedPct: number | null
  readonly hoursSinceLastTrade: number | null
}

export interface DeathExitPolicy {
  /** Freeze when liquidity drops below this fraction of the entry baseline. */
  readonly liquidityFreezeRatio: number
  /** Exit evidence when liquidity drops below this fraction of the baseline. */
  readonly liquidityExitRatio: number
  /** Exit evidence when liquidity is below this absolute floor, whatever the baseline. */
  readonly liquidityFloorUsd: number
  /** Freeze when top holders move at least this share of supply. */
  readonly holderDumpFreezePct: number
  readonly abandonmentFreezeHours: number
  readonly abandonmentExitHours: number
  /** Consecutive observations carrying stage-2 evidence required to declare death. */
  readonly exitConfirmations: number
  /** Consecutive clean observations required to lift a freeze. */
  readonly clearObservations: number
}

export const DEFAULT_DEATH_EXIT_POLICY: DeathExitPolicy = {
  liquidityFreezeRatio: 0.5,
  liquidityExitRatio: 0.2,
  liquidityFloorUsd: 5_000,
  holderDumpFreezePct: 10,
  abandonmentFreezeHours: 6,
  abandonmentExitHours: 24,
  exitConfirmations: 3,
  clearObservations: 6,
}

export type SignalKind =
  | 'sellPathBroken'
  | 'lpRemoved'
  | 'liquidityCollapse'
  | 'authorityReinstated'
  | 'transfersBlocked'
  | 'holderDump'
  | 'abandonment'

export interface InvalidationSignal {
  readonly kind: SignalKind
  /** 1 = suspicion (freeze), 2 = confirmation candidate (exit). */
  readonly stage: 1 | 2
  readonly detail: string
}

export type DeathStage = 'healthy' | 'frozen' | 'dead'
export type DeathVerdict = 'none' | 'freeze' | 'resume' | 'exit'

export interface EvidenceRecord {
  readonly observedAt: number
  readonly source: string
  readonly signals: readonly InvalidationSignal[]
  readonly stageAfter: DeathStage
  readonly verdict: DeathVerdict
}

/** Serialisable, like every piece of engine state. */
export interface DeathWatchState {
  readonly stage: DeathStage
  readonly entryLiquidityUsd: number
  readonly startedAt: number
  /** Consecutive observations carrying stage-2 evidence. */
  readonly exitEvidence: number
  /** Consecutive clean observations. */
  readonly cleanStreak: number
  /** Every observation that produced a signal or changed the stage. */
  readonly evidence: readonly EvidenceRecord[]
}

export function startDeathWatch(entryLiquidityUsd: number, startedAt: number): DeathWatchState {
  if (!(entryLiquidityUsd > 0)) throw new Error('startDeathWatch: entry liquidity must be positive')
  return { stage: 'healthy', entryLiquidityUsd, startedAt, exitEvidence: 0, cleanStreak: 0, evidence: [] }
}

/** Pure: which invalidation signals does this observation carry? */
export function evaluateSignals(
  obs: AssetHealthObservation,
  state: DeathWatchState,
  policy: DeathExitPolicy,
): InvalidationSignal[] {
  const signals: InvalidationSignal[] = []

  if (obs.sellQuote === 'failed' || obs.sellQuote === 'implausible') {
    signals.push({ kind: 'sellPathBroken', stage: 2, detail: `sell quote ${obs.sellQuote}` })
  }

  if (obs.lpStatus === 'removed' || obs.lpStatus === 'unlocked') {
    signals.push({ kind: 'lpRemoved', stage: 2, detail: `LP ${obs.lpStatus}` })
  }

  if (obs.liquidityUsd !== null) {
    const ratio = obs.liquidityUsd / state.entryLiquidityUsd
    if (obs.liquidityUsd < policy.liquidityFloorUsd || ratio < policy.liquidityExitRatio) {
      signals.push({
        kind: 'liquidityCollapse', stage: 2,
        detail: `liquidity $${obs.liquidityUsd.toFixed(0)} = ${(ratio * 100).toFixed(1)}% of entry`,
      })
    } else if (ratio < policy.liquidityFreezeRatio) {
      signals.push({
        kind: 'liquidityCollapse', stage: 1,
        detail: `liquidity $${obs.liquidityUsd.toFixed(0)} = ${(ratio * 100).toFixed(1)}% of entry`,
      })
    }
  }

  if (obs.mintAuthorityActive === true || obs.freezeAuthorityActive === true) {
    signals.push({
      kind: 'authorityReinstated', stage: 2,
      detail: `mint=${obs.mintAuthorityActive} freeze=${obs.freezeAuthorityActive}`,
    })
  }

  if (obs.transfersBlocked === true) {
    signals.push({ kind: 'transfersBlocked', stage: 2, detail: 'transfers paused or wallet blacklisted' })
  }

  if (obs.topHolderMovedPct !== null && obs.topHolderMovedPct >= policy.holderDumpFreezePct) {
    signals.push({ kind: 'holderDump', stage: 1, detail: `top holders moved ${obs.topHolderMovedPct}% of supply` })
  }

  if (obs.hoursSinceLastTrade !== null) {
    if (obs.hoursSinceLastTrade >= policy.abandonmentExitHours) {
      signals.push({ kind: 'abandonment', stage: 2, detail: `${obs.hoursSinceLastTrade}h without a trade` })
    } else if (obs.hoursSinceLastTrade >= policy.abandonmentFreezeHours) {
      signals.push({ kind: 'abandonment', stage: 1, detail: `${obs.hoursSinceLastTrade}h without a trade` })
    }
  }

  return signals
}

export interface Assessment {
  readonly state: DeathWatchState
  readonly verdict: DeathVerdict
  readonly signals: readonly InvalidationSignal[]
}

/**
 * Folds one observation into the watch. Pure.
 *
 *  - Any signal freezes a healthy watch immediately.
 *  - Stage-2 signals on `exitConfirmations` CONSECUTIVE observations kill it.
 *  - A clean observation (no signals AND a positive sell quote) resets the
 *    exit evidence; `clearObservations` of them in a row lift a freeze.
 *  - An inconclusive observation (no signals but the sell path could not be
 *    checked) changes nothing: it neither confirms nor clears.
 *  - Dead is terminal.
 */
export function assessAssetHealth(
  state: DeathWatchState,
  policy: DeathExitPolicy,
  obs: AssetHealthObservation,
): Assessment {
  if (state.stage === 'dead') return { state, verdict: 'none', signals: [] }

  const signals = evaluateSignals(obs, state, policy)

  if (signals.length === 0) {
    if (obs.sellQuote !== 'ok') return { state, verdict: 'none', signals } // inconclusive

    const cleanStreak = state.cleanStreak + 1
    if (state.stage === 'frozen' && cleanStreak >= policy.clearObservations) {
      const next: DeathWatchState = {
        ...state, stage: 'healthy', exitEvidence: 0, cleanStreak: 0,
        evidence: [...state.evidence, record(obs, signals, 'healthy', 'resume')],
      }
      return { state: next, verdict: 'resume', signals }
    }
    return { state: { ...state, exitEvidence: 0, cleanStreak }, verdict: 'none', signals }
  }

  const hasExitEvidence = signals.some((s) => s.stage === 2)
  const exitEvidence = hasExitEvidence ? state.exitEvidence + 1 : 0

  if (exitEvidence >= policy.exitConfirmations) {
    const next: DeathWatchState = {
      ...state, stage: 'dead', exitEvidence, cleanStreak: 0,
      evidence: [...state.evidence, record(obs, signals, 'dead', 'exit')],
    }
    return { state: next, verdict: 'exit', signals }
  }

  const verdict: DeathVerdict = state.stage === 'healthy' ? 'freeze' : 'none'
  const next: DeathWatchState = {
    ...state, stage: 'frozen', exitEvidence, cleanStreak: 0,
    evidence: [...state.evidence, record(obs, signals, 'frozen', verdict)],
  }
  return { state: next, verdict, signals }
}

const record = (
  obs: AssetHealthObservation,
  signals: readonly InvalidationSignal[],
  stageAfter: DeathStage,
  verdict: DeathVerdict,
): EvidenceRecord => ({ observedAt: obs.observedAt, source: obs.source, signals, stageAfter, verdict })

export const DEATH_EXIT_COMMENT = '☠️ Death Exit' as const

/**
 * What the executor does with the strategy's orders given the watch stage.
 *
 *  healthy → orders pass through untouched
 *  frozen  → entries are dropped; the strategy's own exits still pass
 *  dead    → entries are dropped forever; while in position, the ONLY order
 *            is the death exit (it replaces any strategy exit, so the audit
 *            log names the true reason)
 */
export function applyDeathVerdict(
  orders: readonly Order[],
  stage: DeathStage,
  inPosition: boolean,
): readonly Order[] {
  switch (stage) {
    case 'healthy':
      return orders
    case 'frozen':
      return orders.filter((o) => o.kind !== 'entry')
    case 'dead':
      return inPosition ? [{ kind: 'closeAll', comment: DEATH_EXIT_COMMENT }] : []
  }
}
