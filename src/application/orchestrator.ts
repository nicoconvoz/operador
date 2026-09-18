import { alert, AlertThrottle, type AlertPort } from '../domain/notifications/alerts.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { type AssetHealthObservation, type DeathExitPolicy, startDeathWatch } from '../domain/risk/death-exit.js'
import { planPortfolio, type PortfolioPolicy } from '../domain/risk/portfolio.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { type Candles } from './replay.js'
import { type EntryConfirmation } from './confirm-entry.js'
import { tickPosition, type TickResult } from './engine.js'
import { releasableSlots, DEFAULT_IDLE_SLOT_POLICY, type IdleSlotPolicy } from '../domain/risk/idle-slots.js'
import { rotateOnSwitchOff, ROTATION_EXIT_COMMENT } from '../domain/risk/rotation.js'
import { type SwitchedOff } from '../domain/scanner/ranking.js'
import { settle } from './engine.js'
import { commonFund, positionLedger, type PositionLedger } from './ledger.js'
import { ladderCapitalUsd, slotFloorUsd } from './paper-run.js'
import { DEFAULT_SIZING_POLICY } from '../domain/economics/sizing.js'
import { PYRAMIDING } from '../domain/strategy/params.js'
import { type SizingPolicy } from '../domain/economics/sizing.js'
import { planRecovery, type OrderProbe, type RecoveredPosition, type RecoveryPlan } from './recovery.js'
import { resyncCascade, RESYNC_TOLERANCE_PCT } from './resync.js'
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
  /**
   * What the MARKET says every held token is worth, keyed `chain:address`.
   *
   * A SECOND opinion, from a source that is not the candle feed, so the engine
   * can tell a token that collapsed from one whose price it simply cannot read.
   * USDF was sold by a freeze exit at 14,426x below what it was bought for,
   * which was neither a rug nor a crash but a unit nobody agreed on.
   *
   * Batched for the whole book rather than asked per position: it is one
   * DexScreener call per thirty tokens, so the check costs a request or two a
   * cycle. Optional — without it the engine stays silent rather than halting
   * everything, because silence is not evidence.
   */
  readonly marketPrices?: (positions: readonly PersistedPosition[]) => Promise<ReadonlyMap<string, number>>
  /** Latest health observation, or null when no monitor ran. */
  /**
   * Takes the CANDLES as well as the position, because the abandonment signal
   * is measured from them: the newest bar with volume is when this pool was
   * last traded. It went unmeasured for the life of the project, and the
   * signal it feeds never fired once.
   */
  readonly healthFor: (position: PersistedPosition, candles: Candles) => Promise<AssetHealthObservation | null>
  /** The broker for a position — paper or live. */
  /**
   * Async, because a broker has to be rebuilt from the position's recorded
   * fills. The engine wakes as a fresh process every cycle; a broker that
   * remembered only what happened in THIS process would report every position
   * as flat and the strategy would keep re-opening what it already holds.
   */
  readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
  /**
   * Re-examines a chosen token from scratch, right now, before anything is
   * bought — and re-runs the WHOLE gate set on what comes back.
   *
   * The scanner's verdict is deliberately not fresh. Security reports are
   * cached so the examination budget can rotate and reach every token instead
   * of re-checking the same twenty forever, and a WATCH pass allocates from
   * `recall`, a shelf up to twice the scan interval old. Both are right for
   * RANKING and wrong at the moment capital is committed.
   *
   * It used to re-ask ONE question — can this still be sold. That is the answer
   * that ages worst, and it is one of eight: a token that became mintable an
   * hour ago still quotes a perfectly good sell, and was bought.
   *
   * Optional: absent, positions open on the scanner's verdict as before. It is
   * a second look, not a gate that should fail closed on its own absence — but
   * when it RUNS and cannot see, it refuses. See `confirm-entry.ts`.
   */
  readonly confirmEntry?: (snapshot: Candidate['snapshot']) => Promise<EntryConfirmation>
  /** Fresh scanner output. Empty is a valid answer and is alerted on. */
  readonly scan: (kind: 'full' | 'held') => Promise<readonly Candidate[]>
  /**
   * The LAST scan, re-ranked from the shelf. No network.
   *
   * What a watch pass allocates from. Opening a position needs a scan that is
   * RECENT, not one that is running: the expensive half of a scan is fetching,
   * and the deciding half is pure. Returns nothing when the shelf is empty or
   * too old to count as evidence.
   */
  readonly recall?: () => Promise<{ readonly candidates: readonly Candidate[]; readonly scannedAt: number } | null>
  /**
   * What the LAST scan refused on a component floor — the switch, off.
   *
   * Optional, and absent means NOTHING HAPPENS. That default is the safety:
   * "we did not measure it" and "it failed" must never be the same state, and
   * read the wrong way here a rate limit would not colour a screen, it would
   * liquidate the whole book at market.
   *
   * A separate dep rather than a wider `scan` return, so the twenty existing
   * callers that hand back a plain candidate list keep working — and keep
   * working SAFELY, since not supplying it means no position is ever rotated.
   */
  readonly switchedOff?: () => readonly SwitchedOff[]
  readonly now: () => number
}

export interface CycleConfig {
  readonly params: CascadeParams
  readonly portfolio: PortfolioPolicy
  readonly deathPolicy?: DeathExitPolicy
  /** Sell a position the moment its ladder freezes, instead of holding it. */
  readonly exitOnFreeze?: boolean
  /** Passed to the tick, which sizes each position's ladder against them. */
  readonly gasUsdPerSwap?: number
  readonly maxOpenEntries?: number
  /** Sizing policy, including how many rungs the venue will hold open. */
  readonly sizing?: SizingPolicy
  /**
   * Bar size in milliseconds, so the cycle can tell whether a position has
   * anything new to look at before it pays a throttled request to find out.
   *
   * Omitted, every position is refreshed every pass — which is what this did
   * before, and what put ~216 candle requests an hour against a provider that
   * rate-limits by IP.
   */
  readonly barMs?: number
  /** Emit a heartbeat when this long has passed since the last one. */
  readonly heartbeatMs: number
  /** When a reserved slot that never traded may be handed to somebody else. */
  readonly idleSlots?: IdleSlotPolicy
}

/**
 * How much of the cycle to run.
 *
 * `watch` is a strict PREFIX of `full`: recover, halt what cannot be trusted,
 * advance what can, checkpoint. It stops before discovery and allocation.
 *
 * The split exists because the two halves cost wildly different amounts. A scan
 * is hundreds of throttled calls and about half an hour; advancing five open
 * positions is one candle request and one sell probe each, under a minute. In
 * one cycle the cheap half ran at the pace of the expensive one, so a held
 * token got attention every ~35 minutes on 15-minute bars.
 *
 * The asymmetry is the whole argument: a token you HOLD can rug in ten minutes,
 * while an opportunity missed by an hour is only a missed opportunity.
 */
/**
 * What a pass is allowed to spend.
 *
 * `full` discovers and examines everything. `held` re-examines only the book —
 * the same gates, the same security call, the same sell quote, over about
 * thirty tokens instead of five hundred. `watch` touches no network for the
 * shortlist at all.
 *
 * The split exists because the full scan was doing two jobs at one rate: seeing
 * whether our own positions have turned, and looking for new ones. The first is
 * urgent and small, the second is patient and enormous — the asymmetry the
 * cadences were built on, finally applied to the scan itself.
 */
export type CycleKind = 'full' | 'held' | 'watch'

export interface CycleResult {
  readonly kind: CycleKind
  readonly recovery: RecoveryPlan
  readonly ticks: readonly TickResult[]
  readonly opened: readonly PersistedPosition[]
  readonly haltedIds: readonly string[]
  /** Slots reclaimed from positions that reserved them and never traded. */
  readonly releasedIds: readonly string[]
  /**
   * Positions whose candles could not be fetched this pass.
   *
   * Not merely a statistic. Skipping the tick skips the DEATH WATCH with it,
   * so an unreachable position is an UNWATCHED one — and the token a provider
   * is failing on is exactly the kind worth worrying about.
   */
  readonly unreachableIds: readonly string[]
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
  kind: CycleKind = 'full',
): Promise<CycleResult> {
  const at = deps.now()

  // ── 1. Reconcile the past before touching the present ──────────────────────
  const reconciled = await planRecovery(deps.store, deps.probe)

  // ── 1b. And reconcile the LADDERS against what was actually paid ───────────
  //
  // A rule change used to mean a wipe: the book had been chosen and anchored by
  // rules that no longer existed, so keeping it meant judging new work on an old
  // one. That reasoning was right about the SCORES, which are re-derived every
  // scan anyway, and wrong about the FILLS — which are the only real data this
  // system has, and which a truncate throws away with everything else.
  //
  // So the cycle repairs instead. `ep1` is the price the ladder measures every
  // rung from, and the engine spent its life setting it from bars that had not
  // finished: BinanceTown was anchored at 0.0013161 and bought at 0.0010038.
  // The fills know better, and they are right here.
  //
  // Before the tick, deliberately. A position ticked on a bad anchor decides
  // its rungs on it, and then the repair is one bar late.
  const resyncNotes: string[] = []
  const positions: RecoveredPosition[] = []
  for (const recovered of reconciled.positions) {
    const fixed = resyncCascade(
      recovered.position.cascade,
      await deps.store.fillsFor(recovered.position.id),
      RESYNC_TOLERANCE_PCT,
    )
    if (fixed === null) {
      positions.push(recovered)
      continue
    }
    const position = { ...recovered.position, cascade: fixed.cascade, updatedAt: at }
    await deps.store.savePosition(position)
    positions.push({ ...recovered, position })
    resyncNotes.push(`${position.symbol}: ${fixed.reasons.join('; ')}`)
  }
  const recovery = { ...reconciled, positions }

  if (resyncNotes.length > 0) {
    // ONE line for the cycle, like the refusals. A repair is not an incident:
    // nothing was bought, nothing was sold, and the engine carried on with a
    // number closer to the truth than the one it had.
    await deps.alerts.send(alert(
      'resynced',
      `🧭 ${resyncNotes.length} escalera(s) re-ancladas a lo que de verdad se pagó`,
      resyncNotes.join('\n'),
      at,
    ))
  }

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
  const unreachableIds: string[] = []
  // Bars are stamped by their OPEN, so the newest CLOSED bar opened two bar
  // widths ago. A position already standing on it has nothing to do, and the
  // engine acts on closed bars only — asking anyway is how it spends the quota
  // that the positions with real work to do then cannot get.
  const latestClosedBar = config.barMs === undefined ? null : Math.floor(at / config.barMs) * config.barMs - config.barMs

  // One batched ask for the whole book, before the loop. A failure is not
  // fatal and not evidence: an empty map leaves every position exactly as it
  // was, which is the same rule the live prices on the screen already follow.
  let marketPrices: ReadonlyMap<string, number> = new Map()
  if (deps.marketPrices) {
    try {
      marketPrices = await deps.marketPrices(recovery.positions.map((r) => r.position))
    } catch {
      marketPrices = new Map()
    }
  }

  for (const recovered of recovery.positions) {
    if (latestClosedBar !== null && recovered.position.lastBarTime >= latestClosedBar) continue

    const candles = await deps.candlesFor(recovered.position)
    if (!candles) {
      // Never silently. A position was skipped here without a word, and the
      // book drifted into bars four hours apart while every pass logged
      // healthy — the failure that looks exactly like nothing happening.
      unreachableIds.push(recovered.position.id)
      const unreachable = alert(
        'provider-degraded',
        `📡 ${recovered.position.symbol} sin datos`,
        'No se pudieron traer sus velas, así que esta pasada no avanzó ni corrió su vigilancia de muerte. Suele ser un límite de tasa del proveedor; si se repite durante horas, la posición está sin vigilar.',
        at,
        { position: recovered.position.id },
      )
      if (throttle.shouldSend(unreachable, `unreachable:${recovered.position.id}`)) await deps.alerts.send(unreachable)
      continue
    }

    const result = await tickPosition(
      {
        position: recovered.position,
        candles,
        health: await deps.healthFor(recovered.position, candles),
        broker: await deps.brokerFor(recovered.position),
        marketPriceUsd: marketPrices.get(`${recovered.position.chain}:${recovered.position.tokenAddress}`) ?? null,
      },
      {
        params: config.params,
        ...(config.deathPolicy ? { deathPolicy: config.deathPolicy } : {}),
        ...(config.exitOnFreeze === true ? { exitOnFreeze: true } : {}),
        ...(config.gasUsdPerSwap !== undefined ? { gasUsdPerSwap: config.gasUsdPerSwap } : {}),
        ...(config.maxOpenEntries !== undefined ? { maxOpenEntries: config.maxOpenEntries } : {}),
        ...(config.sizing ? { sizing: config.sizing } : {}),
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
  /** Entries the last look declined, summarised ONCE at the end of the cycle. */
  const refused: { symbol: string; why: string }[] = []
  if (!recovery.killSwitchEngaged) {
    // A watch pass does not RUN a scan. It reads the last one off the shelf and
    // re-ranks it, which costs nothing: the expensive half of a scan is
    // fetching, not deciding, and gates, scoring and ranking are pure.
    //
    // Opening was fused to scanning, so a free slot waited out half an hour of
    // throttled discovery before anything could go in it — with candidates
    // already examined, already stored, already good. The fusion was never
    // necessary.
    const found = kind === 'watch' ? ((await deps.recall?.())?.candidates ?? []) : await deps.scan(kind)
    const candidates = found
      .filter((c) => !recovery.blacklisted.has(`${c.snapshot.chain}:${c.snapshot.address}`))

    if (candidates.length === 0) {
      const empty = alert('scan-empty', '🔍 Nada pasó los filtros', 'El escáner no devolvió candidatos operables en este ciclo.', at)
      if (throttle.shouldSend(empty)) await deps.alerts.send(empty)
    }

    // ── 3a. Every position's ledger, read once ───────────────────────────────
    //
    // Three decisions below need the same answer — what does this position
    // hold, and what has it made — and any two of them disagreeing is how a
    // book starts double-spending. One walk over the fills, shared.
    const ledgers = new Map<string, PositionLedger>()
    for (const recovered of recovery.positions) {
      ledgers.set(recovered.position.id, positionLedger(await deps.store.fillsFor(recovered.position.id)))
    }

    // ── 3a-bis. The switch went off on a position holding money ─────────────
    //
    // The operator's rule, and the largest departure from the reference in
    // this file: *si el interruptor on/off se desactiva en vivo y en directo,
    // vender todo y redistribuir en un token nuevo, aunque se pierda.*
    //
    // It is deliberately NOT routed through the death watch.
    // `AssetHealthObservation` is typed so no price-shaped field can exist on
    // it, and that typing is what stops the death exit degrading into a stop
    // loss. One of these floors — `momentum` — IS price, so folding it in
    // would put price into the one path typed to refuse it. Its own comment,
    // its own function, its own line in the tape.
    //
    // Never on a `watch` pass. A watch re-ranks the SHELF, so a token can drop
    // below a floor on numbers nobody re-examined; selling a position is worth
    // a scan that actually looked.
    const offNow = new Map<string, SwitchedOff>(
      kind === 'watch' ? [] : (deps.switchedOff?.() ?? []).map((s) => [`${s.snapshot.chain}:${s.snapshot.address}`, s]),
    )
    const stillListed = new Set(candidates.map((c) => `${c.snapshot.chain}:${c.snapshot.address}`))
    const rotations = rotateOnSwitchOff(
      recovery.positions.map((r) => {
        const key = `${r.position.chain}:${r.position.tokenAddress}`
        const off = offNow.get(key)
        return {
          id: r.position.id,
          symbol: r.position.symbol,
          chain: r.position.chain,
          tokenAddress: r.position.tokenAddress,
          openQty: ledgers.get(r.position.id)?.qty ?? 0,
          // THREE states, and the third is the one that matters. Examined and
          // failed, examined and passed, or never examined at all — and only
          // the first sells. A token missing from both lists is silence.
          switchOff: off !== undefined ? true : stillListed.has(key) ? false : null,
          failed: off?.failed ?? [],
        }
      }),
    )

    const rotatedIds: string[] = []
    for (const { holder, reason } of rotations) {
      const recovered = recovery.positions.find((r) => r.position.id === holder.id)
      const price = marketPrices.get(`${holder.chain}:${holder.tokenAddress}`)
      // No live price, no sale. Selling at a number nobody confirmed is how a
      // position once left at a ten-thousandth of its value.
      if (recovered === undefined || price === undefined || price <= 0) continue
      const broker = await deps.brokerFor(recovered.position)
      // The SAME `settle` the engine tick uses — the idempotency key, the
      // no-loss guard and the per-fill suffix all come from one place. A
      // second copy of that is how a retry sells twice.
      await settle(
        [{ kind: 'closeAll', comment: ROTATION_EXIT_COMMENT }],
        // Keyed by the bar the position last evaluated, not by the clock: a
        // re-run of this cycle then collides with itself instead of selling
        // the same position again.
        recovered.position.lastBarTime,
        price,
        at,
        recovered.position,
        broker,
        deps.store,
      )
      await deps.store.closePosition(holder.id)
      rotatedIds.push(holder.id)
      const rotated = alert(
        'token-rotated',
        `🔁 ${holder.symbol} sale y el capital rota`,
        `${reason}. Se vendió todo a ${price} y la ranura vuelve al reparto. El token NO queda vetado: puede volver a entrar el día que califique.`,
        at,
        { position: holder.id, token: holder.tokenAddress },
      )
      if (throttle.shouldSend(rotated, `rotated:${holder.id}`)) await deps.alerts.send(rotated)
    }
    const rotated = new Set(rotatedIds)

    const scoreOf = new Map(candidates.map((c) => [`${c.snapshot.chain}:${c.snapshot.address}`, c.opportunity.score]))
    const heldNow = new Set(recovery.positions.map((r) => `${r.position.chain}:${r.position.tokenAddress}`))
    // What is QUEUING for a slot, which is not the same as what is on the list.
    //
    // A reservation is handed on when something better is waiting for it. A
    // FORGIVEN token is not better: it is what the allocator reaches for once
    // the qualified list runs out, so it may fill a slot that is already free
    // and may never take one that is not. Otherwise the book would trade a
    // token the gates approved for one they refused, and pay gas to do it.
    const waiting = candidates.filter(
      (c) => c.forgiven === undefined && !heldNow.has(`${c.snapshot.chain}:${c.snapshot.address}`),
    )

    // ── 3b. Slots that are not earning them ──────────────────────────────────
    //
    // Two cases, one rule. A reservation the gates never armed, and a position
    // that took its profit and went flat — both hold NOTHING, so handing the
    // slot on costs nothing, and both are re-examined against what the scanner
    // thinks today. A position still HOLDING tokens is never touched: its slot
    // cannot come back without selling, and selling is the strategy's call.
    //
    // Nothing is blacklisted here. The token did not fail a safety gate, it
    // merely stopped being the best use of a slot, and it is welcome back.
    // Only on a full pass. Taking a slot off one token and giving it to another
    // is a judgement about which is better RIGHT NOW, and it deserves data
    // gathered right now. Filling a slot that is already empty does not.
    const release = kind !== 'full' ? [] : releasableSlots(
      recovery.positions.map((r) => ({
        id: r.position.id,
        chain: r.position.chain,
        tokenAddress: r.position.tokenAddress,
        symbol: r.position.symbol,
        openedAt: r.position.openedAt,
        openQty: ledgers.get(r.position.id)?.qty ?? 0,
        hasFills: ledgers.get(r.position.id)?.hasFills ?? false,
        frozen: r.position.deathWatch.stage === 'frozen',
        score: scoreOf.get(`${r.position.chain}:${r.position.tokenAddress}`) ?? null,
      })),
      waiting.map((c) => c.opportunity.score),
      at,
      config.idleSlots ?? DEFAULT_IDLE_SLOT_POLICY,
    )

    for (const { holder, reason } of release) {
      await deps.store.closePosition(holder.id)
      releasedIds.push(holder.id)
      const handed = alert(
        'token-retired',
        `🔄 ${holder.symbol} cede su ranura`,
        `${reason}. El capital y la ranura vuelven al reparto; el token no queda vetado y puede volver a entrar cuando sea el mejor candidato otra vez.`,
        at,
        { position: holder.id, token: holder.tokenAddress },
      )
      if (throttle.shouldSend(handed, `released:${holder.id}`)) await deps.alerts.send(handed)
    }

    const released = new Set([...releasedIds, ...rotatedIds])
    const keeping = recovery.positions.filter((r) => !released.has(r.position.id) && !rotated.has(r.position.id))
    const held = new Set(keeping.map((r) => `${r.position.chain}:${r.position.tokenAddress}`))

    // ── 3c. Trim each position to the wallet its ladder actually needs ───────
    //
    // A slot used to keep whatever the portfolio handed it at birth, and that
    // was far more than its ladder can ever spend: five positions held $285
    // each while a flat six-rung $15 ladder can only deploy about $95. The
    // surplus was counted as committed, so the engine could neither spend it
    // nor open anything with it — nine hundred and fifty dollars doing nothing.
    //
    // Never below what is already deployed: that money is in the token, and
    // pretending otherwise would let the same dollars be handed out twice.
    const ladderNeeds = ladderCapitalUsd(
      config.params,
      config.maxOpenEntries ?? PYRAMIDING,
      config.gasUsdPerSwap ?? 0.05,
    )
    const kept: PersistedPosition[] = []
    for (const recovered of keeping) {
      const deployed = ledgers.get(recovered.position.id)?.deployedUsd ?? 0
      // A FROZEN ladder needs nothing beyond what it already holds.
      //
      // Frozen means no new capital enters — that is the whole definition — so
      // every dollar reserved against future rungs is dead until the freeze
      // clears or the position dies. Six frozen positions were sitting on about
      // thirty dollars each of reserve that could not be spent, while the book
      // is bounded by CAPITAL rather than by slot count.
      //
      // The slot itself stays, and must: it holds tokens, and selling them is
      // the strategy's decision and never the allocator's. What moves is only
      // the money nothing can reach.
      //
      // The cost, stated rather than hidden: a freeze that later CLEARS finds
      // its position smaller, because the trim only ever goes down. A thawed
      // ladder therefore climbs fewer rungs than it would have. That is the
      // cheaper side — the alternative is reserving capital for hours against a
      // rung that may never fire, on a book whose whole thesis is that scale
      // comes from more tokens rather than more size per token.
      const needs = recovered.position.deathWatch.stage === 'frozen' ? deployed : Math.max(ladderNeeds, deployed)
      if (recovered.position.capitalUsd <= needs + 0.01) {
        kept.push(recovered.position)
        continue
      }
      const trimmed = { ...recovered.position, capitalUsd: needs, updatedAt: at }
      await deps.store.savePosition(trimmed)
      kept.push(trimmed)
    }

    // Capital committed to halted positions is NOT free. Treating it as free is
    // how an engine quietly doubles its own exposure after a bad restart.
    const committed =
      kept.reduce((sum, p) => sum + p.capitalUsd, 0) +
      recovery.halted.reduce((sum, r) => sum + r.position.capitalUsd, 0)
    // ── 3d. The common fund ──────────────────────────────────────────────────
    //
    // What the system has MADE is capital too, and it was being ignored: the
    // book was sized against a fixed number from the environment forever, so a
    // profitable engine never got any bigger. Built from every fill ever
    // recorded, including those of positions that have closed and left — which
    // is most of it. Costs come out, because that cash is already gone.
    const fund = commonFund(await deps.store.allFills())
    const free = Math.max(0, config.portfolio.totalCapitalUsd + fund.netUsd - committed)
    // Zero is NOT a ceiling of zero — it means the capital decides, and that
    // meaning has to hold here as well as inside planPortfolio. Subtracting the
    // open positions from it gave MINUS FIVE with five open, and minus five
    // fails the guard below: the book froze while $950 of freed capital and
    // thirty-eight candidates sat waiting. With an empty book it gave zero,
    // which fails the same guard, so nothing would ever have opened at all.
    //
    // A sentinel that means one thing in one file and another next door is not
    // a sentinel, it is a trap.
    const uncapped = config.portfolio.maxPositions <= 0
    const slotsLeft = uncapped
      ? Number.POSITIVE_INFINITY
      : config.portfolio.maxPositions - keeping.length - recovery.halted.length

    // A token that just gave up its slot must not win it straight back in the
    // same breath: that is not a reallocation, it is a round trip through the
    // database. It is eligible again next cycle.
    const justReleased = new Set(release.map((d) => `${d.holder.chain}:${d.holder.tokenAddress}`))
    const eligible = candidates
      .filter((c) => !held.has(`${c.snapshot.chain}:${c.snapshot.address}`))
      .filter((c) => !justReleased.has(`${c.snapshot.chain}:${c.snapshot.address}`))

    if (slotsLeft > 0 && free > 0) {
      const plan = planPortfolio(
        eligible.map((c) => ({ snapshot: c.snapshot, quality: c.marketQuality, score: c.opportunity.score })),
        config.params,
        {
          ...config.portfolio,
          totalCapitalUsd: free,
          // The concentration cap is a share of the WHOLE book, never of what
          // is left of it. Computed against `free` it tightened with every
          // position opened, and past a point it fell below what a ladder costs
          // and dragged the slot size to the gas floor: 40 positions where the
          // capital funds 31, the tail of them too small to hold a second rung.
          concentrationBasisUsd: config.portfolio.totalCapitalUsd + fund.netUsd,
          // Back into planPortfolio's own convention on the way out.
          maxPositions: uncapped ? 0 : slotsLeft,
          // The floor is DERIVED, never remembered. `minPositionUsd` was 200
          // from a real measurement — the first capital-floor run placed no
          // orders below it — taken BEFORE sizing began reserving gas and 5%
          // of price headroom. That change dropped the floor to under $50, and
          // the number never moved: it kept capping the book at four slots
          // however much capital was free.
          //
          // And it is the GAS floor, not the nominal ladder. `scaledParams`
          // shrinks the ladder to what the wallet allows, so a smaller slot
          // does not fail — it trades smaller rungs. What it cannot do is
          // trade rungs the chain's fixed cost would eat.
          // What a slot SHOULD get: the wallet a full ladder needs, and not a
          // dollar more. Without it the split is deployable/slots, which hands
          // each slot an even share of everything — and a flat six-rung $15
          // ladder can only ever spend $95, so the rest comes straight back as
          // idle capital.
          // Split among whatever SURVIVED, not sized to a nominal ladder.
          //
          // The operator's rule, and it reverses an earlier decision for a
          // reason that did not exist then: the floors on cost, headroom and
          // trend cut a live book of 29 candidates to 8. Handing each of those
          // eight the $47.57 a nominal ladder costs would leave **$1,120
          // idle** — the exact failure the nominal sizing was introduced to
          // FIX, arriving from the other side once the shortlist got short.
          //
          // The rung follows, in `tickPosition`: capital alone changes nothing
          // while a flat cap holds the ladder to $15 a step.
          targetPositionUsd: eligible.length > 0 ? free / eligible.length : ladderNeeds,
          minPositionUsd: slotFloorUsd(
            config.params,
            config.maxOpenEntries ?? PYRAMIDING,
            config.gasUsdPerSwap ?? 0.05,
            (config.sizing ?? DEFAULT_SIZING_POLICY).minFillUsd,
          ),
        },
      )

      if (plan.floorOverrodeCap) {
        const concentrated = alert('provider-degraded', '⚠️ Por encima del objetivo de concentración', `El capital solo alcanza para ${plan.allocations.length} ranuras, así que cada una supera el límite del ${config.portfolio.maxPositionPct}%.`, at)
        if (throttle.shouldSend(concentrated)) await deps.alerts.send(concentrated)
      }

      for (const allocation of plan.allocations) {
        if (deps.confirmEntry) {
          const confirmation = await deps.confirmEntry(allocation.snapshot)
          if (!confirmation.ok) {
            // Collected, not announced. One refusal per token meant a cycle
            // that declined a dozen candidates sent a dozen warnings — and a
            // phone that buzzes for opportunities NOT taken is a phone whose
            // notifications get turned off, after which the death exit does not
            // arrive either.
            refused.push({
              symbol: allocation.snapshot.symbol,
              why:
                confirmation.reason === 'gates'
                  ? confirmation.failures.map((f) => f.detail).slice(0, 1).join('')
                  : confirmation.detail,
            })
            continue
          }
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

  // ONE line for everything the last look declined, not one alert each.
  //
  // A refused entry is an opportunity not taken: nothing was bought and no
  // money is at stake, so it is `info` and it never becomes a notification. It
  // used to be a per-token WARNING, so a cycle that declined a dozen candidates
  // buzzed a dozen times — and a phone that buzzes for opportunities is a phone
  // whose notifications get turned off, after which the death exit does not
  // arrive either.
  if (refused.length > 0) {
    await deps.alerts.send(alert(
      'entry-refused',
      `🔍 ${refused.length} entrada(s) descartada(s) en el último chequeo`,
      refused.slice(0, 8).map((r) => `${r.symbol}: ${r.why}`).join('\n'),
      at,
      { refused: refused.length },
    ))
  }

  // ── 4. Checkpoint, then say you are alive ──────────────────────────────────
  const lastCompletedBar = ticks.reduce((latest, t) => Math.max(latest, t.position.lastBarTime), recovery.resumedFromBar ?? 0)
  await deps.store.saveCheckpoint({ savedAt: at, lastCompletedBar, killSwitchEngaged: recovery.killSwitchEngaged })

  const beat = alert(
    'heartbeat',
    '💓 Operador by Open Doors',
    kind === 'full'
      ? `${recovery.positions.length} en curso · ${recovery.halted.length} detenidas · ${opened.length} abiertas`
      : `${recovery.positions.length} en curso · ${recovery.halted.length} detenidas · vigilancia`,
    at,
    { killSwitch: recovery.killSwitchEngaged, kind },
  )
  if (throttle.shouldSend(beat)) await deps.alerts.send(beat)

  return {
    kind,
    recovery,
    ticks,
    opened,
    haltedIds: recovery.halted.map((h) => h.position.id),
    releasedIds,
    unreachableIds,
    killSwitchEngaged: recovery.killSwitchEngaged,
    at,
  }
}

