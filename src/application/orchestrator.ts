import { alert, AlertThrottle, type AlertPort } from '../domain/notifications/alerts.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { type AssetHealthObservation, type DeathExitPolicy, startDeathWatch } from '../domain/risk/death-exit.js'
import { planPortfolio, type PortfolioPolicy } from '../domain/risk/portfolio.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { type Candles } from './replay.js'
import { tickPosition, type TickResult } from './engine.js'
import { releasableSlots, DEFAULT_IDLE_SLOT_POLICY, type IdleSlotPolicy, type SlotHolder } from '../domain/risk/idle-slots.js'
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
  /**
   * Async, because a broker has to be rebuilt from the position's recorded
   * fills. The engine wakes as a fresh process every cycle; a broker that
   * remembered only what happened in THIS process would report every position
   * as flat and the strategy would keep re-opening what it already holds.
   */
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  /**
   * Re-confirms, right now, that this token can still be sold.
   *
   * The scanner's security verdict can be up to a couple of hours old: its
   * reports are cached so the examination budget can rotate and reach every
   * token instead of re-checking the same twenty forever. That trade is fine
   * for ranking and wrong at the moment capital is committed, because the
   * honeypot answer is the one that ages worst and the one everything rests
   * on. So it is asked again here, for the handful about to be opened.
   *
   * Optional: absent, positions open on the scanner's verdict as before. It is
   * a second look, not a gate that should fail closed on its own absence.
   */
  readonly confirmSellable?: (snapshot: Candidate['snapshot']) => Promise<boolean>
  /** Fresh scanner output. Empty is a valid answer and is alerted on. */
  readonly scan: () => Promise<readonly Candidate[]>
  readonly now: () => number
}

export interface CycleConfig {
  readonly params: CascadeParams
  readonly portfolio: PortfolioPolicy
  readonly deathPolicy?: DeathExitPolicy
  /** Passed to the tick, which sizes each position's ladder against them. */
  readonly gasUsdPerSwap?: number
  readonly maxOpenEntries?: number
  /** Emit a heartbeat when this long has passed since the last one. */
  readonly heartbeatMs: number
  /** When a reserved slot that never traded may be handed to somebody else. */
  readonly idleSlots?: IdleSlotPolicy
}

export interface CycleResult {
  readonly recovery: RecoveryPlan
  readonly ticks: readonly TickResult[]
  readonly opened: readonly PersistedPosition[]
  readonly haltedIds: readonly string[]
  /** Slots reclaimed from positions that reserved them and never traded. */
  readonly releasedIds: readonly string[]
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
    const killed = alert('kill-switch', '🛑 Corte de emergencia activo', 'No se abrirán posiciones nuevas. Las abiertas mantienen su vigilancia de muerte.', at)
    if (throttle.shouldSend(killed)) await deps.alerts.send(killed)
  }

  // ── 2. Advance every position that can be trusted ──────────────────────────
  const ticks: TickResult[] = []
  for (const recovered of recovery.positions) {
    const candles = await deps.candlesFor(recovered.position)
    if (!candles) continue

    const result = await tickPosition(
      { position: recovered.position, candles, health: await deps.healthFor(recovered.position), broker: await deps.brokerFor(recovered.position) },
      {
        params: config.params,
        ...(config.deathPolicy ? { deathPolicy: config.deathPolicy } : {}),
        ...(config.gasUsdPerSwap !== undefined ? { gasUsdPerSwap: config.gasUsdPerSwap } : {}),
        ...(config.maxOpenEntries !== undefined ? { maxOpenEntries: config.maxOpenEntries } : {}),
      },
      deps.store,
      deps.alerts,
      throttle,
    )
    ticks.push(result)
  }

  // ── 3. Open new positions with what is genuinely free ──────────────────────
  const opened: PersistedPosition[] = []
  const releasedIds: string[] = []
  if (!recovery.killSwitchEngaged) {
    const candidates = (await deps.scan())
      .filter((c) => !recovery.blacklisted.has(`${c.snapshot.chain}:${c.snapshot.address}`))

    if (candidates.length === 0) {
      const empty = alert('scan-empty', '🔍 Nada pasó los filtros', 'El escáner no devolvió candidatos operables en este ciclo.', at)
      if (throttle.shouldSend(empty)) await deps.alerts.send(empty)
    }

    // ── 3a. Take back the slots nobody used ──────────────────────────────────
    //
    // A slot is handed to a token BEFORE the strategy enters it, and CASCADE
    // DCA then waits for its own gates. When those never line up the position
    // sits at level 0 indefinitely, holding a slot and its capital against
    // nothing — measured live at five hours and twenty minutes with candidates
    // scoring 76 and 72 waiting outside.
    //
    // Only reservations are taken back, never commitments: a position with
    // fills cannot give up its slot without selling, and selling is the
    // strategy's decision, not the allocator's. Nothing is blacklisted here —
    // the token did nothing wrong, it simply never set up, and it is welcome
    // back the day it does.
    const release = await releasable(deps, recovery.positions.map((r) => r.position), candidates.length, at, config)
    for (const holder of release) {
      await deps.store.closePosition(holder.id)
      releasedIds.push(holder.id)
      const handed = alert(
        'token-retired',
        `🔄 ${holder.symbol} cede su ranura`,
        `Reservó una ranura y ${Math.round((at - holder.openedAt) / 3_600_000)}h después no había comprado nada. El capital y la ranura vuelven al reparto; el token no queda vetado y puede volver a entrar cuando arme.`,
        at,
        { position: holder.id, token: holder.tokenAddress },
      )
      if (throttle.shouldSend(handed, `released:${holder.id}`)) await deps.alerts.send(handed)
    }

    const released = new Set(releasedIds)
    const keeping = recovery.positions.filter((r) => !released.has(r.position.id))
    const held = new Set(keeping.map((r) => `${r.position.chain}:${r.position.tokenAddress}`))
    // Capital committed to halted positions is NOT free. Treating it as free is
    // how an engine quietly doubles its own exposure after a bad restart.
    const committed = [...keeping, ...recovery.halted].reduce((sum, r) => sum + r.position.capitalUsd, 0)
    const free = Math.max(0, config.portfolio.totalCapitalUsd - committed)
    const slotsLeft = config.portfolio.maxPositions - keeping.length - recovery.halted.length

    // A token that just gave up its slot must not win it straight back in the
    // same breath: that is not a reallocation, it is a round trip through the
    // database. It is eligible again next cycle.
    const justReleased = new Set(release.map((h) => `${h.chain}:${h.tokenAddress}`))
    const eligible = candidates
      .filter((c) => !held.has(`${c.snapshot.chain}:${c.snapshot.address}`))
      .filter((c) => !justReleased.has(`${c.snapshot.chain}:${c.snapshot.address}`))

    if (slotsLeft > 0 && free > 0) {
      const plan = planPortfolio(
        eligible.map((c) => ({ snapshot: c.snapshot, quality: c.marketQuality, score: c.opportunity.score })),
        config.params,
        { ...config.portfolio, totalCapitalUsd: free, maxPositions: slotsLeft },
      )

      if (plan.floorOverrodeCap) {
        const concentrated = alert('provider-degraded', '⚠️ Por encima del objetivo de concentración', `El capital solo alcanza para ${plan.allocations.length} ranuras, así que cada una supera el límite del ${config.portfolio.maxPositionPct}%.`, at)
        if (throttle.shouldSend(concentrated)) await deps.alerts.send(concentrated)
      }

      for (const allocation of plan.allocations) {
        if (deps.confirmSellable && !(await deps.confirmSellable(allocation.snapshot))) {
          const refused = alert(
            'provider-degraded',
            `⚠️ ${allocation.snapshot.symbol} no se pudo confirmar`,
            'La ruta de venta no respondió al re-confirmarla. No se abre la posición.',
            at,
            { token: allocation.snapshot.address },
          )
          if (throttle.shouldSend(refused, `unsellable:${allocation.snapshot.address}`)) await deps.alerts.send(refused)
          continue
        }

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
          // The price the scanner just measured, never a placeholder. The
          // death watch sizes its sell probe from this, so a stand-in value
          // makes the very first observation ask an absurd question and
          // freezes the position before it has done anything.
          // null, not a stand-in, when the scanner has no price: the death
          // watch skips an observation it cannot size, and skipping is honest.
          lastPriceUsd: allocation.snapshot.priceUsd > 0 ? allocation.snapshot.priceUsd : null,
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

  const beat = alert('heartbeat', '💓 Operador by Open Doors', `${recovery.positions.length} en curso · ${recovery.halted.length} detenidas · ${opened.length} abiertas`, at, {
    killSwitch: recovery.killSwitchEngaged,
  })
  if (throttle.shouldSend(beat)) await deps.alerts.send(beat)

  return {
    recovery,
    ticks,
    opened,
    haltedIds: recovery.halted.map((h) => h.position.id),
    releasedIds,
    killSwitchEngaged: recovery.killSwitchEngaged,
    at,
  }
}

/**
 * Which open positions reserved a slot and never used it.
 *
 * `hasFills` is read from the FILLS, never from the cascade level: a machine can
 * sit at level 1 believing it holds something the broker refused, and a
 * reservation dressed as a position is exactly the case this must not misread.
 */
async function releasable(
  deps: CycleDeps,
  positions: readonly PersistedPosition[],
  waiting: number,
  at: number,
  config: CycleConfig,
): Promise<readonly SlotHolder[]> {
  if (waiting <= 0 || positions.length === 0) return []

  const holders: SlotHolder[] = []
  for (const position of positions) {
    holders.push({
      id: position.id,
      chain: position.chain,
      tokenAddress: position.tokenAddress,
      symbol: position.symbol,
      openedAt: position.openedAt,
      hasFills: (await deps.store.fillsFor(position.id)).length > 0,
    })
  }

  return releasableSlots(holders, waiting, at, config.idleSlots ?? DEFAULT_IDLE_SLOT_POLICY)
}
