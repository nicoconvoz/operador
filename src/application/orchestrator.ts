import { alert, AlertThrottle, type AlertPort } from '../domain/notifications/alerts.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { type AssetHealthObservation, type DeathExitPolicy, startDeathWatch } from '../domain/risk/death-exit.js'
import { planPortfolio, type PortfolioPolicy } from '../domain/risk/portfolio.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { type Candles } from './replay.js'
import { tickPosition, type TickResult } from './engine.js'
import { planRecovery, type OrderProbe, type RecoveryPlan } from './recovery.js'
import { type Candidate } from '../domain/scanner/ranking.js'

/**
 * The orchestrator — one cycle of the whole system.
 *
 * Everything before this file decides something in isolation. This is where
 * the pieces meet, and the ORDER they meet in is the safety property:
 *
 *   recover → halt what cannot be trusted → tick what can →
 *   open new positions only with what is left → checkpoint
 *
 * Recovery runs before anything else because an engine that scans and
 * allocates before reconciling its own past is building on a state it has not
 * verified. New positions come LAST because capital that might belong to an
 * unresolved position is not capital to spend.
 */

export interface CycleDeps {
  readonly store: StatePort
  readonly alerts: AlertPort
  readonly probe: OrderProbe
  /** Candles for a position, oldest first. Null when unavailable this cycle. */
  readonly candlesFor: (position: PersistedPosition) => Promise<Candles | null>
  /** Latest health observation, or null when no monitor ran. */
  readonly healthFor: (position: PersistedPosition) => Promise<AssetHealthObservation | null>
  /** The broker for a position — paper or live. */
  readonly brokerFor: (position: PersistedPosition) => BrokerPort
  /** Fresh scanner output. Empty is a valid answer and is alerted on. */
  readonly scan: () => Promise<readonly Candidate[]>
  readonly now: () => number
}

export interface CycleConfig {
  readonly params: CascadeParams
  readonly portfolio: PortfolioPolicy
  readonly deathPolicy?: DeathExitPolicy
  readonly chain: string
  /** Emit a heartbeat when this long has passed since the last one. */
  readonly heartbeatMs: number
}

export interface CycleResult {
  readonly recovery: RecoveryPlan
  readonly ticks: readonly TickResult[]
  readonly opened: readonly PersistedPosition[]
  readonly haltedIds: readonly string[]
  readonly killSwitchEngaged: boolean
  readonly at: number
}

/**
 * Runs one full cycle. Returns what happened; submitting orders and moving
 * money is the caller's job, because a function that both decides and acts is
 * a function that cannot be tested without a chain.
 */
export async function runCycle(
  deps: CycleDeps,
  config: CycleConfig,
  throttle: AlertThrottle,
): Promise<CycleResult> {
  const at = deps.now()

  // ── 1. Reconcile the past before touching the present ──────────────────────
  const recovery = await planRecovery(deps.store, deps.probe)

  for (const halted of recovery.halted) {
    await deps.alerts.send(alert(
      'position-halted',
      `⛔ ${halted.position.symbol} halted`,
      'An order in flight could not be confirmed either way. The position keeps its state and will not trade until a human resolves it.',
      at,
      { position: halted.position.id, orders: halted.resolutions.filter((r) => r.action === 'halt').map((r) => r.key).join(', ') },
    ))
  }

  // The kill switch stops NEW risk. It does not abandon open positions: their
  // death watches keep running, because a stopped engine that leaves a dying
  // token unattended has stopped the wrong thing.
  if (recovery.killSwitchEngaged) {
    const killed = alert('kill-switch', '🛑 Kill switch engaged', 'No new positions will be opened. Open positions keep their death watch.', at)
    if (throttle.shouldSend(killed)) await deps.alerts.send(killed)
  }

  // ── 2. Advance every position that can be trusted ──────────────────────────
  const ticks: TickResult[] = []
  for (const recovered of recovery.positions) {
    const candles = await deps.candlesFor(recovered.position)
    if (!candles) continue

    const result = await tickPosition(
      { position: recovered.position, candles, health: await deps.healthFor(recovered.position), broker: deps.brokerFor(recovered.position) },
      { params: config.params, ...(config.deathPolicy ? { deathPolicy: config.deathPolicy } : {}) },
      deps.store,
      deps.alerts,
      throttle,
    )
    ticks.push(result)
  }

  // ── 3. Open new positions with what is genuinely free ──────────────────────
  const opened: PersistedPosition[] = []
  if (!recovery.killSwitchEngaged) {
    const held = new Set(recovery.positions.map((r) => `${r.position.chain}:${r.position.tokenAddress}`))
    // Capital committed to halted positions is NOT free. Treating it as free is
    // how an engine quietly doubles its own exposure after a bad restart.
    const committed = [...recovery.positions, ...recovery.halted].reduce((sum, r) => sum + r.position.capitalUsd, 0)
    const free = Math.max(0, config.portfolio.totalCapitalUsd - committed)
    const slotsLeft = config.portfolio.maxPositions - recovery.positions.length - recovery.halted.length

    const candidates = (await deps.scan())
      .filter((c) => !held.has(`${c.snapshot.chain}:${c.snapshot.address}`))
      .filter((c) => !recovery.blacklisted.has(`${c.snapshot.chain}:${c.snapshot.address}`))

    if (candidates.length === 0) {
      const empty = alert('scan-empty', '🔍 Nothing passed the gates', 'The scanner returned no tradeable candidates this cycle.', at)
      if (throttle.shouldSend(empty)) await deps.alerts.send(empty)
    }

    if (slotsLeft > 0 && free > 0) {
      const plan = planPortfolio(
        candidates.map((c) => ({ snapshot: c.snapshot, quality: c.marketQuality, score: c.opportunity.score })),
        config.params,
        { ...config.portfolio, totalCapitalUsd: free, maxPositions: slotsLeft },
      )

      if (plan.floorOverrodeCap) {
        const concentrated = alert('provider-degraded', '⚠️ Running over the concentration target', `Capital allows only ${plan.allocations.length} slots, so each exceeds the ${config.portfolio.maxPositionPct}% cap.`, at)
        if (throttle.shouldSend(concentrated)) await deps.alerts.send(concentrated)
      }

      for (const allocation of plan.allocations) {
        const position: PersistedPosition = {
          id: `${allocation.snapshot.chain}:${allocation.snapshot.address}:${at}`,
          chain: allocation.snapshot.chain,
          tokenAddress: allocation.snapshot.address,
          pairAddress: allocation.snapshot.pairAddress,
          symbol: allocation.snapshot.symbol,
          cascade: initialState(),
          // The liquidity at entry is the baseline every future collapse is
          // measured against — so the watch is born with the position.
          deathWatch: startDeathWatch(allocation.quality.liquidityUsd, at),
          quality: allocation.quality,
          capitalUsd: allocation.capitalUsd,
          lastBarTime: -1,
          pendingOrders: [],
          openedAt: at,
          updatedAt: at,
        }
        await deps.store.savePosition(position)
        opened.push(position)
      }
    }
  }

  // ── 4. Checkpoint, then say you are alive ──────────────────────────────────
  const lastCompletedBar = ticks.reduce((latest, t) => Math.max(latest, t.position.lastBarTime), recovery.resumedFromBar ?? 0)
  await deps.store.saveCheckpoint({ savedAt: at, lastCompletedBar, killSwitchEngaged: recovery.killSwitchEngaged })

  const beat = alert('heartbeat', '💓 Operador by Open Doors', `${recovery.positions.length} running · ${recovery.halted.length} halted · ${opened.length} opened`, at, {
    killSwitch: recovery.killSwitchEngaged,
  })
  if (throttle.shouldSend(beat)) await deps.alerts.send(beat)

  return {
    recovery,
    ticks,
    opened,
    haltedIds: recovery.halted.map((h) => h.position.id),
    killSwitchEngaged: recovery.killSwitchEngaged,
    at,
  }
}
