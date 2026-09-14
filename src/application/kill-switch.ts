import { alert, type AlertPort } from '../domain/notifications/alerts.js'
import { type StatePort } from '../domain/persistence/store.js'

/**
 * The kill switch.
 *
 * It lives in the STORE, not in the process — which is the whole point. A
 * switch held in memory can only be thrown by a healthy engine, and a healthy
 * engine is exactly the case where you least need one. Writing it to durable
 * state means a phone can stop a machine it cannot reach, and a crash-looping
 * process comes back already stopped.
 *
 * What it does and does not do:
 *
 *   STOPS   opening any new position
 *   KEEPS   the death watch running on everything already open
 *
 * That asymmetry is deliberate. A switch that froze the death watch too would
 * mean "stop the engine" also meant "stop protecting the money", and the
 * moment you most want to stop taking new risk is often the moment an open
 * position most needs watching.
 *
 * Disengaging is a separate, explicit act. Nothing re-enables it by itself.
 */

export type KillSwitchReason = 'manual' | 'loss-limit' | 'provider-failure' | 'reconciliation'

export interface KillSwitchStatus {
  readonly engaged: boolean
  readonly since: number | null
}

export async function engageKillSwitch(
  store: StatePort,
  alerts: AlertPort,
  reason: KillSwitchReason,
  detail: string,
  at: number,
): Promise<void> {
  const previous = await store.loadCheckpoint()
  await store.saveCheckpoint({
    savedAt: at,
    lastCompletedBar: previous?.lastCompletedBar ?? 0,
    killSwitchEngaged: true,
  })
  // Critical, so it is never throttled: the one message that must always land.
  await alerts.send(alert('kill-switch', '🛑 Kill switch ENGAGED', detail, at, { reason }))
}

export async function disengageKillSwitch(store: StatePort, alerts: AlertPort, at: number): Promise<void> {
  const previous = await store.loadCheckpoint()
  await store.saveCheckpoint({
    savedAt: at,
    lastCompletedBar: previous?.lastCompletedBar ?? 0,
    killSwitchEngaged: false,
  })
  await alerts.send(alert('kill-switch', '▶️ Kill switch released', 'New positions may be opened again.', at))
}

export async function killSwitchStatus(store: StatePort): Promise<KillSwitchStatus> {
  const checkpoint = await store.loadCheckpoint()
  return {
    engaged: checkpoint?.killSwitchEngaged ?? false,
    since: checkpoint?.killSwitchEngaged ? checkpoint.savedAt : null,
  }
}

export interface LossLimitPolicy {
  /** Engage the switch when equity falls this far below starting capital, in percent. */
  readonly maxDrawdownPct: number
  /** Engage when this many positions die in one window. */
  readonly maxDeathsPerWindow: number
  readonly windowMs: number
}

export const DEFAULT_LOSS_LIMITS: LossLimitPolicy = {
  maxDrawdownPct: 35,
  maxDeathsPerWindow: 3,
  windowMs: 24 * 60 * 60 * 1000,
}

export interface RiskSnapshot {
  readonly startingCapitalUsd: number
  readonly equityUsd: number
  /** Times a death exit fired, most recent first. */
  readonly deathTimes: readonly number[]
}

/**
 * Whether the automatic limits say to stop. Pure, so the rule can be tested
 * without a store: the decision and the act are separate on purpose.
 */
export function shouldEngage(snapshot: RiskSnapshot, policy: LossLimitPolicy, at: number): { engage: boolean; reason: KillSwitchReason; detail: string } {
  const drawdownPct = snapshot.startingCapitalUsd > 0
    ? ((snapshot.startingCapitalUsd - snapshot.equityUsd) / snapshot.startingCapitalUsd) * 100
    : 0

  if (drawdownPct >= policy.maxDrawdownPct) {
    return {
      engage: true,
      reason: 'loss-limit',
      detail: `Equity $${snapshot.equityUsd.toFixed(2)} is ${drawdownPct.toFixed(1)}% below the $${snapshot.startingCapitalUsd.toFixed(2)} starting capital (limit ${policy.maxDrawdownPct}%).`,
    }
  }

  const recentDeaths = snapshot.deathTimes.filter((t) => at - t <= policy.windowMs).length
  if (recentDeaths >= policy.maxDeathsPerWindow) {
    // Several tokens dying at once is rarely a coincidence. It is either a bad
    // market or a bad scanner, and neither is a reason to keep buying.
    return {
      engage: true,
      reason: 'loss-limit',
      detail: `${recentDeaths} death exits in ${policy.windowMs / 3_600_000}h (limit ${policy.maxDeathsPerWindow}). Either the market turned or the gates are letting rugs through.`,
    }
  }

  return { engage: false, reason: 'manual', detail: '' }
}
