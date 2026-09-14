import { type AlertPort, AlertThrottle, alert } from '../domain/notifications/alerts.js'
import { applyDeathVerdict, assessAssetHealth, DEFAULT_DEATH_EXIT_POLICY, DEATH_EXIT_COMMENT, type AssetHealthObservation, type DeathExitPolicy } from '../domain/risk/death-exit.js'
import { idempotencyKeyFor, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { stepCascade } from '../domain/strategy/cascade.js'
import { computeSignals } from '../domain/strategy/signals.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { type Order, type PositionSnapshot } from '../domain/strategy/state.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { orderKeyPart } from './recovery.js'
import { type Candles } from './replay.js'

/**
 * One tick of the live engine, for one position.
 *
 * The loop is the same three steps the replay runner already proved out —
 * execute what was pending, look at the position, evaluate the closed bar —
 * with the three things a live system needs and a backtest does not:
 *
 *  1. the death watch runs BEFORE the strategy, and can veto it
 *  2. every order is written down before it is sent
 *  3. nothing is decided twice for the same bar
 *
 * Pure-ish on purpose: it takes ports, returns what happened, and never
 * reaches for a clock or a network of its own.
 */

export interface TickInput {
  readonly position: PersistedPosition
  /** Closed bars, oldest first. The last one is the bar being evaluated. */
  readonly candles: Candles
  /** Latest health observation, or null when no monitor ran this tick. */
  readonly health: AssetHealthObservation | null
  readonly broker: BrokerPort
}

export interface EngineConfig {
  readonly params: CascadeParams
  readonly deathPolicy?: DeathExitPolicy
}

export interface TickResult {
  readonly position: PersistedPosition
  /** Orders to submit, after the death watch has had its say. */
  readonly orders: readonly Order[]
  /** Orders the strategy wanted that the death watch removed. */
  readonly vetoed: readonly Order[]
  readonly skipped: 'already-processed' | 'no-bars' | null
}

/**
 * Advances one position by one closed bar.
 *
 * `lastBarTime` is the guard against deciding twice: a process that crashes
 * after saving but before submitting comes back, sees the bar is already
 * processed, and does nothing — rather than re-emitting an order it has no
 * way to know was already sent.
 */
export async function tickPosition(
  input: TickInput,
  config: EngineConfig,
  store: StatePort,
  alerts: AlertPort,
  throttle: AlertThrottle,
): Promise<TickResult> {
  const { position, candles, broker } = input
  const barIndex = candles.time.length - 1
  if (barIndex < 0) return { position, orders: [], vetoed: [], skipped: 'no-bars' }

  const barTime = candles.time[barIndex]!
  if (barTime <= position.lastBarTime) {
    return { position, orders: [], vetoed: [], skipped: 'already-processed' }
  }

  // ── 1. The death watch speaks first ────────────────────────────────────────
  let deathWatch = position.deathWatch
  if (input.health) {
    const assessment = assessAssetHealth(deathWatch, config.deathPolicy ?? DEFAULT_DEATH_EXIT_POLICY, input.health)
    deathWatch = assessment.state

    if (assessment.verdict === 'exit') {
      await store.blacklist(position.chain, position.tokenAddress, assessment.signals.map((s) => s.detail).join('; '), barTime)
      await alerts.send(alert('death-exit', `☠️ ${position.symbol} is dead`, assessment.signals.map((s) => s.detail).join('\n'), barTime, { position: position.id }))
    } else if (assessment.verdict === 'freeze') {
      const frozen = alert('ladder-frozen', `❄️ ${position.symbol} frozen`, assessment.signals.map((s) => s.detail).join('\n'), barTime, { position: position.id })
      if (throttle.shouldSend(frozen, `${frozen.kind}:${position.id}`)) await alerts.send(frozen)
    }
  }

  // ── 2. The strategy evaluates the closed bar ───────────────────────────────
  const signals = computeSignals(candles, config.params)
  const snapshot: PositionSnapshot = broker.snapshot(candles.close[barIndex]!)
  const stepped = stepCascade(
    position.cascade,
    config.params,
    { open: candles.open[barIndex]!, high: candles.high[barIndex]!, low: candles.low[barIndex]!, close: candles.close[barIndex]! },
    signals.contexts[barIndex]!,
    snapshot,
  )

  // ── 3. The death watch gets the last word ──────────────────────────────────
  const inPosition = snapshot.size > 0
  const orders = applyDeathVerdict(stepped.orders, deathWatch.stage, inPosition)
  const kept = new Set(orders)
  const vetoed = stepped.orders.filter((o) => !kept.has(o))

  // ── 4. Write before sending ────────────────────────────────────────────────
  // The order is persisted as pending FIRST. If the process dies here, recovery
  // finds it and asks the venue whether it happened — which is only possible
  // because it was written down before it was sent.
  const next: PersistedPosition = {
    ...position,
    cascade: stepped.state,
    deathWatch,
    lastBarTime: barTime,
    pendingOrders: orders,
    updatedAt: barTime,
  }
  await store.savePosition(next)

  for (const order of orders) {
    if (order.kind === 'closeAll' && order.comment === DEATH_EXIT_COMMENT) continue // already alerted
    if (order.kind === 'entry') {
      const opened = position.cascade.level === 0
      await alerts.send(alert(opened ? 'position-opened' : 'dca-filled', `${opened ? '🟢' : '➕'} ${position.symbol} ${order.id}`, `$${order.usd.toFixed(2)} at ${candles.close[barIndex]!.toPrecision(6)}`, barTime, { position: position.id, key: idempotencyKeyFor(position.id, barTime, orderKeyPart(order)) }))
    } else {
      await alerts.send(alert('position-closed', `🏁 ${position.symbol} closed`, order.comment, barTime, { position: position.id }))
    }
  }

  return { position: next, orders, vetoed, skipped: null }
}
