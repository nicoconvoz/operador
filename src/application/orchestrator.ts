import { alert, AlertThrottle, type AlertPort } from '../domain/notifications/alerts.js'
import { sweepStops, exitLevelsFor, buyFirstStepOnSelection, STOP_SWEEP_MS, type ExitSizing, type PressureLadder, type DropLadder, type DeepRung, type DipBounce } from './stop-sweep.js'

import { type BrokerPort } from '../domain/execution/broker.js'
import { type AssetHealthObservation, type DeathExitPolicy, startDeathWatch } from '../domain/risk/death-exit.js'
import { planPortfolio, type PortfolioPolicy } from '../domain/risk/portfolio.js'
import { type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { initialState } from '../domain/strategy/state.js'
import { type Candles } from './replay.js'
import { type EntryConfirmation } from './confirm-entry.js'
import { tickPosition, type EngineConfig, type TickResult } from './engine.js'
import { releasableSlots, DEFAULT_IDLE_SLOT_POLICY, type IdleSlotPolicy } from '../domain/risk/idle-slots.js'
import { rotateOnSwitchOff, ROTATION_EXIT_COMMENT, SWAP_EXIT_COMMENT } from '../domain/risk/rotation.js'
import { scoreFell, SCORE_STOP_COMMENT } from '../domain/risk/score-stop.js'
import { type GainLockPolicy } from '../domain/risk/gain-lock.js'
import { pricesDisagree } from '../domain/market/price-agreement.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { shouldStopOut, stopLossPctFor, drawdownPct, STOP_LOSS_COMMENT, NO_STOP_LOSS, type StopLossPolicy } from '../domain/risk/stop-loss.js'
import { type SwitchedOff, type Rejected } from '../domain/scanner/ranking.js'
import { settle } from './engine.js'
import { positionLedger, openLotCostsUsd, type PositionLedger } from './ledger.js'
import { bookCapital, freeSlots } from './free-capital.js'
import { ladderCapitalUsd, slotFloorUsd } from './paper-run.js'
import { DEFAULT_SIZING_POLICY, positionTollPct } from '../domain/economics/sizing.js'
import { PYRAMIDING } from '../domain/strategy/params.js'
import { type SizingPolicy } from '../domain/economics/sizing.js'
import { planRecovery, type OrderProbe, type RecoveredPosition, type RecoveryPlan } from './recovery.js'
import { resyncCascade, RESYNC_TOLERANCE_PCT } from './resync.js'
import { type Candidate } from '../domain/scanner/ranking.js'
import { meetsAnyDoor, type ComponentFloors } from '../domain/scanner/opportunity.js'
import { dailySample } from '../domain/reporting/daily-pnl.js'
import { bookNetUsd } from './book-value.js'

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
   * The DCA ladder, bought on a floor of one-minute candles by the same sweep
   * that runs the stop. Absent: no ladder.
   */
  readonly pressureLadder?: PressureLadder
  /** The chained ladder on price, off in production. Absent: no ladder. */
  readonly dropLadder?: DropLadder
  /**
   * The ONE rung a holding may buy after its first: more than 80% down, then a
   * 10% rebound off the low, while still at a loss. Absent: no deep rung.
   */
  readonly deepRung?: DeepRung
  /**
   * Every buy of a holding, the first included: $1 on a 3% dip and a 2% bounce,
   * twenty at most. The only path that buys in production. Absent: none.
   */
  readonly dipBounce?: DipBounce
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
  readonly scan: (
    kind: 'full' | 'held',
    /**
     * Handed to the scanner so it can give the thread back between units of
     * work. The cycle puts the STOP in here; the scanner is not told that.
     */
    betweenSteps?: () => Promise<void>,
    /**
     * How many more tokens the free capital can take — `freeSlots`, counted
     * by the cycle before it scans. The scan reads, examines and keeps only
     * as many candidates as that; zero reads nothing new at all. Absent: the
     * cycle has no fixed slot and says nothing.
     */
    slots?: number,
  ) => Promise<readonly Candidate[]>
  /**
   * The LAST scan, re-ranked from the shelf. No network.
   *
   * What a watch pass allocates from. Opening a position needs a scan that is
   * RECENT, not one that is running: the expensive half of a scan is fetching,
   * and the deciding half is pure. Returns nothing when the shelf is empty or
   * too old to count as evidence.
   */
  readonly recall?: (
    /** The free slots, as for `scan`: a stale shelf never hands out more candidates than this. */
    slots?: number,
  ) => Promise<{
    readonly candidates: readonly Candidate[]
    readonly switchedOff: readonly SwitchedOff[]
    readonly rejected?: readonly Rejected[]
    readonly scannedAt: number
  } | null>
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
  /**
   * What the last scan REJECTED, scored anyway. Only ever read for tokens we
   * hold, so the score stop is never blinded by a gate: *cayó de puntaje y
   * nunca vendió tampoco.*
   */
  readonly rejected?: () => readonly Rejected[]
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
  /**
   * How far a position may fall below what was paid before it is closed.
   *
   * Absent means the default, which is the operator rule: one twentieth of the
   * run, floored at 5% and capped at 50%. The whole stop is switched off by a
   * zero share AND a zero floor, and both have to be said out loud — a
   * strategy that never stops out is the reference behaviour, not an accident.
   */
  readonly stopLoss?: StopLossPolicy
  /**
   * Fixed dollars per token, or absent to split the capital among whoever
   * qualified.
   *
   * Absent is the old behaviour exactly, so a caller that does not know about
   * this is not silently given a different rule.
   */
  readonly usdPerToken?: number | null
  /**
   * What a candidate needs to be OPENED, on top of the floors every held and
   * listed token answers to — any one of these doors. Absent: nothing more.
   * See `DEFAULT_ENTRY_DOORS`.
   */
  readonly entryDoors?: readonly ComponentFloors[]
  /**
   * Points under its ENTRY score at which a held position is sold, as it is.
   * *Cuando el puntaje cae 5 puntos, SL.* Absent or zero: off.
   */
  readonly scoreStopPoints?: number
  /**
   * Whether a held position rotates out when its filter switches off. Absent
   * means yes, as it always has; production turns it off — *lo demás, sólo
   * salí si el TP se cumple.*
   */
  readonly rotateOnFilter?: boolean
  /** Passed through to the tick, which derives the exit target from it. */
  readonly maxCostSharePct?: number
  /**
   * How many times the stop a winner must make, net of costs. Travels with
   * `stopLoss`, which is already on this config — a ratio needs a risk.
   */
  readonly rewardRiskRatio?: number
  /**
   * A position that reached its target may never close at a loss: it leaves
   * at break-even instead of riding back down to the stop. The operator's
   * choice over a hard target, because a hard target would also have cut the
   * runner that went to +28%.
   */
  readonly breakEven?: boolean
  /**
   * Where the break-even arms and where an armed position sells, in percent
   * over its average cost — both 7.5 in production: *poné el break-even en
   * 7.5.* Absent: derived from the exit target and the round trip, as the
   * ratchet first ran. See `ExitSizing.breakEvenArmPct`.
   */
  readonly breakEvenArmPct?: number
  readonly breakEvenFloorPct?: number
  /**
   * The stepped gain lock: from +20%, a floor of +10% under the average cost,
   * ten more for every twenty. *Si pasás el 20% de ganancia, break-even en el
   * 10%; con cada aumento de 20%, aumentar el break-even 10%.* Absent or null:
   * off — the old behaviour exactly, so a caller that says nothing is not
   * handed a new exit. Production composes it ON in `main.ts`.
   */
  readonly gainLock?: GainLockPolicy | null
  /** The widest the derived stop may ever be. See `ExitSizing.maxStopPct`. */
  readonly maxStopPct?: number
  /**
   * Entries' worth of capital a position is ALLOCATED, and so what the tick
   * divides its capital by. Twenty in production: every dip-bounce step, the
   * slot's whole ladder. Absent: the whole ladder, `maxOpenEntries`, which is
   * what every caller before this did.
   */
  readonly reservedEntries?: number
  /**
   * Blacklist a token when its frozen slot is released, so it is never bought
   * back. Absent: off — the old behaviour, where a freeze-exited token was an
   * ordinary candidate again from the next pass.
   */
  readonly blacklistOnFreeze?: boolean
  /**
   * What ONE slot is given, exactly — steps × step, $20 in production. When
   * set, the allocator hands out this much and not a dollar more or less, the
   * trim keeps it, and the free slots — `freeSlots`, capital over this — decide
   * how far the scan looks. *El tope son 5000 dividido 50, que es lo que tengo.*
   * Absent: the slot is priced from the ladder, as before.
   */
  readonly slotUsd?: number
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
  // The rules a position runs under, assembled ONCE — see `tickConfigFrom`.
  const tickConfig = tickConfigFrom(config)
  const { reservedEntries } = tickConfig

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

  /**
   * Each position as it stands AFTER its tick — the only version later steps
   * may read or write.
   *
   * `recovery.positions` is a snapshot taken BEFORE the tick, and everything
   * downstream used to read it. The capital trim then wrote that snapshot back
   * with `savePosition`, silently reverting every field the tick had just
   * decided: `cascade`, `deathWatch`, `lastBarTime`, `lastPriceUsd` and
   * `pendingOrders`.
   *
   * Measured in production: EVERY position carried two `Entry` fills one bar
   * apart, same id, the second sized from the capital the first had just been
   * trimmed to. The machine reached level 1, the trim put it back to 0, and the
   * entry gate fired again on the next bar.
   *
   * The double buy was the cheapest symptom. A reverted `deathWatch` means a
   * freeze can never accumulate its observations, and a reverted `lastBarTime`
   * means the same bars are replayed for ever.
   */
  const current = new Map<string, PersistedPosition>(recovery.positions.map((r) => [r.position.id, r.position]))
  const now = (id: string, fallback: PersistedPosition) => current.get(id) ?? fallback


  // ── 1d. The stop, before anything that costs a call PER POSITION ────────
  //
  // The operator's rule: *si por alguna causa perdemos más de un dólar nos
  // retiramos de ese token... con stops proporcionales al % de crecimiento.*
  //
  // Here rather than in `tickPosition` because the tick only advances on a
  // NEW BAR, and a stop that waits for a fifteen-minute candle is not a stop.
  //
  // **And FIRST inside the cycle — ahead of the tick loop AND the scan.**
  // That is the harder half of the same sentence, and it took two goes.
  //
  // It was moved above the scan first, which was right and not enough: the
  // TICK loop is also O(positions) network calls, one candle download plus one
  // sell probe each, in series and throttled. Measured on the tape the
  // operator pulled — eight positions bought at 22:00:00 and all eight stopped
  // at 22:24:34.021, the same millisecond, the very next look:
  //
  // | fall when finally cut | | |
  // |---|---|---|
  // | jtojto −1.50% | CbyTNf −4.83% | CFNRDa **−6.13%** |
  //
  // Every one qualified at −1%. Cutting on time would have cost $2.76; cutting
  // 25 minutes late cost $6.05, so the LATENESS was $3.29 — more than half the
  // damage, and more than the threshold itself is worth arguing about.
  //
  // A stop that waits for a candle is not a stop. Neither is one that waits
  // for the book to be re-priced one token at a time.
  //
  // It needs NOTHING the scan produces. A position, its ledger, a live price
  // and a policy — all of them already in hand — which is what makes the
  // move a reordering rather than a redesign. The rotation and the release
  // genuinely do need candidates, so they stay where they are and skip what
  // this already sold.
  //
  // Everything it reads is already in hand: `marketPrices` is ONE batched
  // request, made just above, and `ledgers` is a walk over fills already in
  // the database. Neither scales with the book, which is the whole reason
  // this can sit where it now sits.
  //
  // It keeps the kill-switch guard it has always had. The death watch runs
  // under an engaged switch and a death exit still sells, so an argument
  // exists for this selling too — but that is a decision about what the
  // operator's own stop button means, not a consequence of this measurement,
  // and changing two things at once is how you cannot tell which one did what.
  //
  // It is the third RISK exit and the only one caused by price. That is a
  // real departure and it is named as one: `stop-loss.ts` says so in its
  // first line, and it stays out of the death watch, whose observation type
  // is built so no price-shaped field can exist on it. Routing this through
  // there would break the single structural guarantee that keeps the death
  // exit from becoming what this openly is.
  const stopPolicy: StopLossPolicy = config.stopLoss ?? NO_STOP_LOSS
  /**
   * The stop, sized from what THIS pool charges.
   *
   * *Una relación 1:4 es que en un lado tengas tp 3.9 y el otro sl en 9.52.*
   * Small target, wide stop, one loss for every four wins — so the stop is
   * derived from the target rather than the target from the stop, which is the
   * reverse of what shipped an hour ago and is the operator's correction.
   */
  const sizing = exitSizingFrom(config)
  const stopSizing = (position: PersistedPosition) => exitLevelsFor(position, sizing)
  const stoppedIds: string[] = []
  // The TOKEN, not the position: a re-entry arrives under a brand new
  // position id, so an id cannot recognise it. See `justFreed` below.
  const stoppedTokens: string[] = []
  /** Sold by the stop already — nothing downstream may re-sell or re-tick it. */
  const stopped = new Set<string>()

  /**
   * One pass of the stop over the whole book, against the prices given.
   *
   * A FUNCTION rather than a block because it runs many times in a cycle now:
   * once here, and again whenever the scan hands the thread back. Its own
   * ledger read is what makes that safe — the fills move underneath it as it
   * sells, so reading them once at the top would let a later pass act on a
   * position it had already closed.
   */
  /**
   * One pass of the stop over the book, at the prices given.
   *
   * The RULE lives in `stop-sweep.ts` because `runLoop` calls it too, between
   * cycles. A position opened in step 3 is opened near the END of a pass, so
   * no sweep is left in that cycle to catch it — and that window is the first
   * half hour of its life, which on these tokens is when it moves most.
   */
  const sweep = async (prices: ReadonlyMap<string, number>) => {
    // The live book, not the start-of-cycle snapshot: positions opened by this
    // very cycle have to be reachable, and `loadPositions` is one query with
    // no network in it.
    const book = (await deps.store.loadPositions()).filter((p) => !stopped.has(p.id))
    for (const id of await sweepStops(deps, stopSizing, throttle, book, prices, at)) {
      const position = book.find((p) => p.id === id)!
      stoppedIds.push(id)
      stoppedTokens.push(`${position.chain}:${position.tokenAddress}`)
      stopped.add(id)
    }
  }

  await sweep(marketPrices)

  /**
   * The book as the sweeps LEFT it — the only version the next step may start
   * from.
   *
   * A sweep writes: it arms the ratchet, and it raises a position's capital
   * when a rung fires and takes its money from the free pool. Every snapshot
   * taken before it is stale in exactly those fields, and the step after it
   * saves the whole row. The ratchet survives that because the store keeps its
   * flag with OR; the capital cannot be kept that way, because the trim
   * lowers it on purpose. So the next step reads the store instead — the same
   * lesson as "the trim wrote over what the tick had just decided", arriving
   * from the sweep's side: a tick that saved its pre-sweep copy would put the
   * capital back under what the rung had just put in the token, and the
   * allocator would hand those dollars out again.
   *
   * One query, no network. Only positions this cycle already knows are
   * refreshed; one closed by the sweep is simply gone from the store and is
   * skipped as stopped.
   */
  const refreshFromStore = async () => {
    for (const stored of await deps.store.loadPositions()) {
      if (current.has(stored.id)) current.set(stored.id, stored)
    }
  }
  await refreshFromStore()

  /**
   * The same sweep, handed to the scan so a long sweep cannot hold the book
   * hostage — and RATE LIMITED, because it is not free.
   *
   * Each pass costs ONE batched DexScreener request for the whole book (thirty
   * addresses per call) against a limit of three hundred a minute, so twice a
   * minute spends under one percent of the allowance. The ceiling is what
   * makes this safe to call from inside a loop that runs hundreds of times.
   *
   * Thirty seconds is the cadence, and it is bounded by the provider rather
   * than chosen: closer together would re-ask a question whose answer has not
   * had time to change, further apart would reintroduce the latency this
   * exists to remove. Against a twenty-minute cycle it is forty checks where
   * there was one.
   *
   * A failure is not evidence, exactly as at the top of the cycle: an empty
   * map leaves every position alone rather than selling it on silence.
   */
  let lastSweepAt = at
  const betweenSteps = async () => {
    if (deps.now() - lastSweepAt < STOP_SWEEP_MS) return
    lastSweepAt = deps.now()
    if (!deps.marketPrices) return
    const open = recovery.positions.filter((r) => !stopped.has(r.position.id)).map((r) => r.position)
    if (open.length === 0) return
    try {
      await sweep(await deps.marketPrices(open))
    } catch {
      // A provider having a bad minute is not a reason to abandon the scan.
    }
  }

  for (const recovered of recovery.positions) {
    // As the sweep left it, never as recovery first read it. See
    // `refreshFromStore`.
    const position = now(recovered.position.id, recovered.position)
    if (latestClosedBar !== null && position.lastBarTime >= latestClosedBar) continue
    // Sold moments ago by the stop. Ticking it would advance a machine over a
    // position that no longer holds anything, and cost a candle download to
    // do it.
    if (stopped.has(position.id)) continue

    const candles = await deps.candlesFor(position)
    if (!candles) {
      // Never silently. A position was skipped here without a word, and the
      // book drifted into bars four hours apart while every pass logged
      // healthy — the failure that looks exactly like nothing happening.
      unreachableIds.push(position.id)
      const unreachable = alert(
        'provider-degraded',
        `📡 ${position.symbol} sin datos`,
        'No se pudieron traer sus velas, así que esta pasada no avanzó ni corrió su vigilancia de muerte. Suele ser un límite de tasa del proveedor; si se repite durante horas, la posición está sin vigilar.',
        at,
        { position: position.id },
      )
      if (throttle.shouldSend(unreachable, `unreachable:${position.id}`)) await deps.alerts.send(unreachable)
      continue
    }

    const result = await tickPosition(
      {
        position,
        candles,
        health: await deps.healthFor(position, candles),
        broker: await deps.brokerFor(position),
        marketPriceUsd: marketPrices.get(`${position.chain}:${position.tokenAddress}`) ?? null,
      },
      tickConfig,
      deps.store,
      deps.alerts,
      throttle,
    )
    ticks.push(result)
    current.set(position.id, result.position)
  }

  // ── 3. Open new positions with what is genuinely free ──────────────────────
  //
  // (`tickConfig` is assembled once above, because step 3b ticks the positions
  // this step opens and two copies of it would eventually disagree about which
  // rules a brand new position runs under.)
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
    // How many more tokens the free capital can take, counted BEFORE the scan
    // so the scan reads and examines only as far as they need. *No hacemos
    // lectura y búsqueda al pedo.* The same `freeSlots` the allocator's count
    // comes to below; slots a release frees later in this cycle are the next
    // scan's to fill.
    const slots = config.slotUsd === undefined
      ? undefined
      : freeSlots(bookCapital(config.portfolio.totalCapitalUsd, await deps.store.allFills(), await deps.store.loadPositions()), config.slotUsd)
    const recalled = kind === 'watch' ? await deps.recall?.(slots) : null
    const found = kind === 'watch' ? (recalled?.candidates ?? []) : await deps.scan(kind, betweenSteps, slots)
    // The scan handed the thread to the sweep, and the sweep may have funded a
    // rung since the ticks ran. Everything below writes whole rows — the score
    // baseline, the trim — so it starts from the store, not from the ticks.
    await refreshFromStore()
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
    //
    // Read HERE rather than beside the stop's, and the duplication is the
    // point: the stop runs before the tick and again during the scan, so its
    // view is deliberately the one from before either. These three want what
    // is true after both. One map serving both clocks would be wrong for one
    // of them, silently.
    const ledgers = new Map<string, PositionLedger>()
    /** Fees of the round trip still open, per position. */
    const openCosts = new Map<string, number>()
    for (const recovered of recovery.positions) {
      if (stopped.has(recovered.position.id)) continue
      const own = await deps.store.fillsFor(recovered.position.id)
      ledgers.set(recovered.position.id, positionLedger(own))
      openCosts.set(recovered.position.id, openLotCostsUsd(own))
    }
    /**
     * Where a position stands and what its whole round trip costs, both in
     * percent. The swap for a better token and the rotation by filter sell a
     * position only when the first is larger than the second: *no cierres en
     * negativo; un porcentaje que contemple la comisión.* Null when nobody
     * could measure it — and an unmeasured position is never sold by either.
     */
    const standingOf = (position: PersistedPosition): { unrealisedPct: number | null; tollPct: number | null } => {
      const ledger = ledgers.get(position.id)
      const price = marketPrices.get(`${position.chain}:${position.tokenAddress}`)
      if (!ledger || ledger.avgCostUsd === null || price === undefined || price <= 0) return { unrealisedPct: null, tollPct: null }
      return {
        unrealisedPct: (price / ledger.avgCostUsd - 1) * 100,
        tollPct: positionTollPct(
          openCosts.get(position.id) ?? 0,
          ledger.deployedUsd,
          ledger.qty * price,
          position.quality,
          config.gasUsdPerSwap ?? 0.05,
        ),
      }
    }

    // ── 3a-ter. The switch went off on a position holding money ─────────────
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
    // On EVERY kind of pass, and from the source that pass actually read.
    //
    // A watch used to be excluded, on the argument that it re-ranks the shelf
    // with numbers nobody re-examined. That stopped being true: a watch
    // refreshes the shelf's market half with one batched request, and the
    // market half is exactly where `headroom` and `momentum` come from.
    //
    // What the exclusion cost, measured: the operator watched a position sit
    // below the floor on a screen that re-scores held tokens live every ten
    // seconds, while the engine went on holding it for twenty-one minutes
    // because it only looked on a scan.
    //
    // Never the SCAN's verdict on a watch pass, though. That one can be half
    // an hour old and the token may have recovered since; selling on a stale
    // answer is the false positive this design keeps trying to avoid.
    const offNow = new Map<string, SwitchedOff>(
      (kind === 'watch' ? (recalled?.switchedOff ?? []) : (deps.switchedOff?.() ?? []))
        .map((s) => [`${s.snapshot.chain}:${s.snapshot.address}`, s]),
    )
    const stillListed = new Set(candidates.map((c) => `${c.snapshot.chain}:${c.snapshot.address}`))

    // ── 3a-bis. The score stop ────────────────────────────────────────────────
    //
    // *Cuando el puntaje cae 5 puntos, SL.* The operator, after PEPE: bought at
    // 93.2, down to 65.9 ten minutes later, still held an hour after at −11.6%.
    // The score of a held token comes from whichever list this pass put it on;
    // one the gates rejected has none, and silence never sells.
    //
    // A position with no baseline — opened before the rule existed — takes
    // this reading as its first; the store keeps the first one it is given.
    const rejectedNow = kind === 'watch' ? (recalled?.rejected ?? []) : (deps.rejected?.() ?? [])
    const scoreNow = new Map<string, number>([
      ...rejectedNow.flatMap((r) =>
        r.opportunity ? [[`${r.snapshot.chain}:${r.snapshot.address}`, r.opportunity.score] as const] : [],
      ),
      ...candidates.map((c) => [`${c.snapshot.chain}:${c.snapshot.address}`, c.opportunity.score] as const),
      ...[...offNow.values()].map((o) => [`${o.snapshot.chain}:${o.snapshot.address}`, o.opportunity.score] as const),
    ])
    for (const r of recovery.positions) {
      if (stopped.has(r.position.id)) continue
      const position = now(r.position.id, r.position)
      const key = `${position.chain}:${position.tokenAddress}`
      const score = scoreNow.get(key) ?? null
      if (score === null) continue
      const baseline = position.entryScore ?? null
      if (baseline === null) {
        await deps.store.savePosition({ ...position, entryScore: score })
        continue
      }
      if (!scoreFell({ entryScore: baseline, score }, config.scoreStopPoints ?? 0)) continue
      if (!((ledgers.get(position.id)?.qty ?? 0) > 0)) continue
      // Exempt from the no-loss guard, so it takes the stop's own second-source
      // check: a unit nobody agreed on is how CWZ6Bs left at a
      // hundred-and-eighty-thousandth of its price.
      const price = marketPrices.get(key)
      if (price === undefined || !(price > 0)) continue
      if (position.lastPriceUsd == null || pricesDisagree(price, position.lastPriceUsd, DEFAULT_GATE_POLICY.maxPriceRatio)) continue
      const broker = await deps.brokerFor(position)
      const refused = await settle(
        [{ kind: 'closeAll', comment: SCORE_STOP_COMMENT }],
        position.lastBarTime,
        price,
        at,
        position,
        broker,
        deps.store,
      )
      if (refused) continue
      await deps.store.closePosition(position.id)
      stoppedIds.push(position.id)
      stoppedTokens.push(key)
      stopped.add(position.id)
      const cut = alert(
        'token-stopped',
        `📉 ${position.symbol} cortada: el puntaje cayó`,
        `Se compró con ${baseline.toFixed(1)} y ahora tiene ${score.toFixed(1)}, ${(baseline - score).toFixed(1)} puntos menos. Se vendió todo a ${price}. El token NO queda vetado.`,
        at,
        { position: position.id, token: position.tokenAddress },
      )
      if (throttle.shouldSend(cut, `score-stop:${position.id}`)) await deps.alerts.send(cut)
    }

    const rotations = config.rotateOnFilter === false ? [] : rotateOnSwitchOff(
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
          ...standingOf(r.position),
        }
      }),
    )

    const rotatedIds: string[] = []
    for (const { holder, reason } of rotations) {
      // Already sold by the stop, moments ago and above. Selling twice is how
      // a book goes short on a spot engine.
      if (stopped.has(holder.id)) continue
      const found = recovery.positions.find((r) => r.position.id === holder.id)
      const recovered = found === undefined ? undefined : { ...found, position: now(holder.id, found.position) }
      const price = marketPrices.get(`${holder.chain}:${holder.tokenAddress}`)
      // No live price, no sale. Selling at a number nobody confirmed is how a
      // position once left at a ten-thousandth of its value.
      if (recovered === undefined || price === undefined || price <= 0) continue
      const broker = await deps.brokerFor(recovered.position)
      // The SAME `settle` the engine tick uses — the idempotency key, the
      // no-loss guard and the per-fill suffix all come from one place. A
      // second copy of that is how a retry sells twice.
      const refused = await settle(
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
      // REFUSED means the no-loss guard held it: the switch is off but the
      // position is under water, and the operator's rule is *si está en pérdida
      // lo deja.* Closing it anyway would retire a slot that still holds
      // tokens — the quantity orphaned, neither realised nor unrealised, and
      // the position gone from the screen that was supposed to watch it.
      //
      // Found by the test written for the rule, not in production, which is
      // the only reason it is a line here rather than a paragraph.
      if (refused) continue
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
    const rotated = new Set([...rotatedIds, ...stoppedIds])

    // What "better" means when a slot changes hands: the score, or — the
    // operator's order — cost efficiency in points, 0..100. *Que elija los que
    // tengan mejor eficiencia de costos.* The holder and the queue are measured
    // in the same unit, so the edge is read in it too.
    const byEfficiency = config.idleSlots?.measure === 'costEfficiency'
    const merit = (c: Candidate) => (byEfficiency ? c.opportunity.components.costEfficiency * 100 : c.opportunity.score)
    const scoreOf = new Map(candidates.map((c) => [`${c.snapshot.chain}:${c.snapshot.address}`, merit(c)]))
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
    // Nothing is blacklisted here, with ONE exception: a slot released because
    // it froze (see below, where it is released). Every other token did not
    // fail anything, it merely stopped being the best use of a slot, and it is
    // welcome back.
    // Only on a full pass. Taking a slot off one token and giving it to another
    // is a judgement about which is better RIGHT NOW, and it deserves data
    // gathered right now. Filling a slot that is already empty does not.
    // On a WATCH pass the queue is passed empty, and that is not a shortcut —
    // it is the exact meaning. Nobody is competing for a slot on a light pass,
    // so `releasableSlots` returns only the TERMINAL cases: a dead token, and a
    // frozen reservation holding nothing. Neither is a judgement about which
    // token is better right now, so neither needs the data a full scan gathers,
    // and making them wait up to an hour is what left them stuck on the screen.
    // The toll, read once so the decision and the sale cannot disagree about
    // how much a move is allowed to cost.
    const swapTolerance = (config.idleSlots ?? DEFAULT_IDLE_SLOT_POLICY).maxSwapLossPct ?? 0
    const release = releasableSlots(
      recovery.positions.map((r) => ({
        id: r.position.id,
        chain: r.position.chain,
        tokenAddress: r.position.tokenAddress,
        symbol: r.position.symbol,
        openedAt: r.position.openedAt,
        openQty: ledgers.get(r.position.id)?.qty ?? 0,
        hasFills: ledgers.get(r.position.id)?.hasFills ?? false,
        frozen: now(r.position.id, r.position).deathWatch.stage === 'frozen',
        dead: now(r.position.id, r.position).deathWatch.stage === 'dead',
        score: scoreOf.get(`${r.position.chain}:${r.position.tokenAddress}`) ?? null,
        // Where it stands against what was paid, and what the trip costs —
        // live. Null without a price, and the swap rule then declines to judge.
        ...standingOf(r.position),
      })),
      kind === 'full' ? waiting.map(merit) : [],
      at,
      config.idleSlots ?? DEFAULT_IDLE_SLOT_POLICY,
    )

    for (const { holder, reason } of release) {
      // A slot HOLDING something has to be SOLD before it is closed, and this
      // is the line that makes the operator's swap rule safe rather than
      // catastrophic.
      //
      // Until now this loop only ever received empty slots, so closing was the
      // whole job. A slot with tokens closed the same way would orphan the
      // quantity — neither realised nor unrealised, and gone from the screen
      // that was supposed to be watching it. That is the exact shape of the
      // bug the rotation step already carries a paragraph about.
      if (holder.openQty > 0) {
        const found = recovery.positions.find((r) => r.position.id === holder.id)
        const position = found === undefined ? undefined : now(holder.id, found.position)
        const price = marketPrices.get(`${holder.chain}:${holder.tokenAddress}`)
        // No live price, no sale, no close. The slot keeps its token and gets
        // judged again next pass, which is the honest answer to not knowing.
        if (position === undefined || price === undefined || price <= 0) continue
        const broker = await deps.brokerFor(position)
        const refused = await settle(
          [{ kind: 'closeAll', comment: SWAP_EXIT_COMMENT }],
          position.lastBarTime,
          price,
          at,
          position,
          broker,
          deps.store,
          swapTolerance,
        )
        // REFUSED means the loss is deeper than the toll allows, which the
        // domain already checked — but it checks against a price from the
        // start of the cycle and this fills at one fetched since. Closing
        // anyway would retire a slot that still holds tokens.
        if (refused) continue
      }
      await deps.store.closePosition(holder.id)
      releasedIds.push(holder.id)

      // ── A frozen token is never bought back ─────────────────────────────
      //
      // *No me gustó que las congeladas llegaran a valer 8 o 9 dólares ... y
      // además que no pasen a la lista negra.* The operator, and the replay
      // agreed: blacklisting after any freeze cost about $6 over 336 entries
      // and removed GO — bought back thirty minutes after a half-liquidity
      // freeze, now −54% — and ASTEROID, bought back and $9.29 more lost. A
      // freeze is the one exit that says something about the TOKEN, and a
      // token that froze once is not a stranger the scanner should meet fresh.
      //
      // HERE, at the release, and never at the verdict. When the freeze fires
      // the position still holds its tokens, and `planRecovery` refuses to
      // resume a blacklisted position — a freeze-exit sale waiting for the next
      // open would be orphaned, the money neither sold nor watched. By the time
      // the slot is released it holds nothing: the sale filled, or nothing was
      // ever bought. Sell, close, THEN blacklist — the order `retire.ts` keeps
      // for the same reason.
      const known = recovery.positions.find((r) => r.position.id === holder.id)
      const banned = config.blacklistOnFreeze === true && holder.frozen === true && holder.dead !== true
      // The evidence is on the position itself — its death watch kept every
      // observation that froze it — so the ban carries its reason for good.
      const evidence = banned && known !== undefined ? freezeEvidence(now(holder.id, known.position)) : []
      if (banned) {
        await deps.store.blacklist(
          holder.chain,
          holder.tokenAddress,
          `frozen: ${evidence.length > 0 ? evidence.join('; ') : 'no evidence recorded'}`,
          at,
        )
      }
      const handed = alert(
        'token-retired',
        banned ? `❄️ ${holder.symbol} cede su ranura y queda vetado` : `🔄 ${holder.symbol} cede su ranura`,
        banned
          ? `${reason}. El capital y la ranura vuelven al reparto, y el token queda vetado: una moneda que se congeló no se vuelve a comprar.${evidence.length > 0 ? ` Por qué se congeló: ${evidence.join('; ')}.` : ''}`
          : `${reason}. El capital y la ranura vuelven al reparto; el token no queda vetado y puede volver a entrar cuando sea el mejor candidato otra vez.`,
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
    //
    // What a slot NEEDS is the entries it was allocated, not the ladder it may
    // one day climb. A rung pays for itself out of the free capital when it
    // fires, and the deployed floor keeps whatever it bought. Measured live
    // before this: $2,887 committed against $1,395 deployed — half the book
    // reserved against rungs that almost never fired.
    // With a fixed slot, exactly that: the fees a step asked of the free
    // capital were paid, and the common fund already carries them.
    const ladderNeeds = config.slotUsd ?? ladderCapitalUsd(
      config.params,
      reservedEntries,
      config.gasUsdPerSwap ?? 0.05,
    )
    const kept: PersistedPosition[] = []
    for (const recovered of keeping) {
      // The TICKED position, never the pre-tick snapshot. Writing the latter
      // back is what put every ladder into an infinite first rung.
      const position = now(recovered.position.id, recovered.position)
      const deployed = ledgers.get(position.id)?.deployedUsd ?? 0
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
      const needs = position.deathWatch.stage === 'frozen' ? deployed : Math.max(ladderNeeds, deployed)
      if (position.capitalUsd <= needs + 0.01) {
        kept.push(position)
        continue
      }
      const trimmed = { ...position, capitalUsd: needs, updatedAt: at }
      await deps.store.savePosition(trimmed)
      kept.push(trimmed)
    }

    // ── 3d. The common fund ──────────────────────────────────────────────────
    //
    // What the system has MADE is capital too, and it was being ignored: the
    // book was sized against a fixed number from the environment forever, so a
    // profitable engine never got any bigger. Built from every fill ever
    // recorded, including those of positions that have closed and left — which
    // is most of it. Costs come out, because that cash is already gone.
    //
    // `bookCapital` is the ONE definition of free, shared with the sweep that
    // funds a rung when it fires. Two copies would each be right alone and
    // spend the same dollar twice together.
    //
    // Capital committed to halted positions is NOT free. Treating it as free is
    // how an engine quietly doubles its own exposure after a bad restart.
    const book = bookCapital(
      config.portfolio.totalCapitalUsd,
      await deps.store.allFills(),
      [...kept, ...recovery.halted.map((r) => r.position)],
    )
    const free = book.freeUsd
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
    //
    // **The STOP is in here too, and it is the case that makes the lock pay
    // for itself.** A released slot was empty, so re-opening it merely wasted
    // a scan; a stopped one just SOLD, so re-opening it pays the whole round
    // trip. And the stop is the one exit whose cause leaves the token still
    // qualifying — liquidity and concentration do not move on a one percent
    // dip, so the coin the engine just cut is still near the top of the same
    // shortlist, every cycle, for as long as it hovers near the line.
    //
    // At a flat 1% the stop cuts BELOW that round trip (~1.29% on a $15 fill),
    // so each lap of the loop would lose more than the fall that triggered it.
    // The operator asked for *rotás a OTRA moneda*, and this is the word
    // "otra" being enforced rather than assumed.
    //
    // Nothing is blacklisted here: the token failed no gate, it merely fell,
    // and it is an ordinary candidate again next pass. The one exception is a
    // FROZEN slot, which the release path above banned for good.
    const justFreed = new Set([
      ...release.map((d) => `${d.holder.chain}:${d.holder.tokenAddress}`),
      ...stoppedTokens,
    ])
    const eligible = candidates
      .filter((c) => !held.has(`${c.snapshot.chain}:${c.snapshot.address}`))
      .filter((c) => !justFreed.has(`${c.snapshot.chain}:${c.snapshot.address}`))
      // The FIRST-buy door: *expansión del volumen más del 50% y tendencia más
      // del 50%.* Here and not in the ranking, so a held token is never judged
      // by the way it was bought.
      .filter((c) => meetsAnyDoor(c.opportunity.components, config.entryDoors))

    if (slotsLeft > 0 && free > 0) {
      const plan = planPortfolio(
        eligible.map((c) => ({
          snapshot: c.snapshot,
          quality: c.marketQuality,
          score: c.opportunity.score,
          costEfficiency: c.opportunity.components.costEfficiency,
        })),
        config.params,
        {
          ...config.portfolio,
          totalCapitalUsd: free,
          // The concentration cap is a share of the WHOLE book, never of what
          // is left of it. Computed against `free` it tightened with every
          // position opened, and past a point it fell below what a ladder costs
          // and dragged the slot size to the gas floor: 40 positions where the
          // capital funds 31, the tail of them too small to hold a second rung.
          concentrationBasisUsd: book.totalUsd,
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
          // A FIXED size when one is configured, and the even split otherwise.
          //
          // The split was right while the rules were strict: eight survivors
          // handed a nominal ladder each would have left $1,120 idle. It is
          // wrong now that the shortlist is wide — an even split across two
          // hundred names gives each a rung too small to pay its own gas, and
          // the count is no longer bounded by how strict the rules are.
          //
          // Fixed, the BOOK grows with the shortlist instead of the positions
          // shrinking with it. The operator asked for it in one line: *comprá
          // solo 15 usd por moneda.*
          // A FIXED slot when one is set — exactly steps × step, the count the
          // free capital over it — and otherwise what came before.
          targetPositionUsd: config.slotUsd ?? config.usdPerToken ?? (eligible.length > 0 ? free / eligible.length : ladderNeeds),
          // Priced for the entries a slot is ALLOCATED, like the trim above: a
          // floor priced for the whole ladder would refuse a slot that only
          // ever has to pay for its first buy.
          //
          // With a fixed slot the floor IS the slot: nothing grossed up raises
          // it past the $20 a slot is given, so the count stays capital / $20.
          minPositionUsd: config.slotUsd ?? slotFloorUsd(
            config.params,
            reservedEntries,
            config.gasUsdPerSwap ?? 0.05,
            (config.sizing ?? DEFAULT_SIZING_POLICY).minFillUsd,
          ),
        },
        // The sizing the ENGINE runs — its fill floor and the entries the
        // venue holds — so a $1 step is not refused by a floor priced for $5.
        config.sizing,
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
            //
            // And an ACTIVITY refusal — no bars — is not reported at all. *Sacá
            // las notificaciones también, sobre la actividad.* The operator.
            // The token is still not bought; only the line goes.
            const aboutActivity =
              confirmation.reason === 'stale-bars' ||
              (confirmation.reason === 'gates' && confirmation.failures.every((f) => f.gate === 'staleBars'))
            if (aboutActivity) continue
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
          // What the token had already done when we arrived, kept because the
          // stop is sized by it. Six hours is the window the entry rule reads.
          runAtEntryPct: allocation.snapshot.priceChangePct?.h6 ?? null,
          // The score it was bought at: the baseline the score stop falls from.
          entryScore: allocation.score,
          pendingOrders: [],
          openedAt: at,
          updatedAt: at,
        }
        await deps.store.savePosition(position)
        opened.push(position)
      }
    }
  }

  // ── 3e. And they BUY now, not next cycle ──────────────────────────────────
  //
  // The operator: *si hay tokens elegidos no los cargues uno por uno, cargalos
  // todos de una vez con la primer compra inmediatamente.*
  //
  // A position used to be created here and ticked on the NEXT pass, so it sat
  // at zero for up to a cycle before it held anything. That was harmless while
  // the selection rule read a day; it is not now that it reads FIVE MINUTES.
  // The cycle is also five, so the signal that chose the token could be spent
  // before the money moved — the engine buying on a reason that had expired.
  //
  // It is the same `tickPosition` and the same config, deliberately. A second
  // path into the first buy would be a second set of rules for it, and door 3
  // is what makes this cheap: it asks for no indicator, so a position can act
  // on the bar it was born on.
  //
  // A failure here costs the BUY, never the position. It is already saved and
  // the next pass ticks it exactly as before, which is the behaviour this
  // replaces — so the worst case is the old one.
  for (const position of opened) {
    try {
      const candles = await deps.candlesFor(position)
      if (candles === null) continue
      const result = await tickPosition(
        {
          position,
          candles,
          health: await deps.healthFor(position, candles),
          broker: await deps.brokerFor(position),
          // The SCANNER measured this one minutes ago, and the batched price
          // fetch above ran over the book as it stood BEFORE these existed —
          // so without this the newest position is the one with no live price,
          // and its order waits for a bar it was created to get ahead of.
          //
          // It is a second source in exactly the sense `pricesDisagree` wants:
          // DexScreener measured it, the candles come from GeckoTerminal, and
          // the tick still refuses to trade when the two do not agree.
          marketPriceUsd:
            marketPrices.get(`${position.chain}:${position.tokenAddress}`) ?? position.lastPriceUsd,
        },
        tickConfig,
        deps.store,
        deps.alerts,
        throttle,
      )
      ticks.push(result)
      current.set(position.id, result.position)
    } catch {
      // One token that cannot be priced must not cost the others their entry.
    }
  }

  // ── 3f. The FIRST step, bought on selection ───────────────────────────────
  //
  // *Y además que la primera compra entre automáticamente.* The operator. The
  // cascade's doors stay shut; the first dollar is a dip-bounce step bought
  // NOW, at the live price, instead of on a 3% dip and a 2% bounce — past the
  // door's safety re-check above, and after the tick that put a candle close
  // on record for the price guard to compare against. One batched request
  // prices every slot this pass opened: the book's prices were fetched before
  // they existed.
  //
  // A failure costs the BUY, never the position: no live price, a price that
  // disagrees with the candle, nothing free for the fees — the slot is saved
  // and its first step waits for a dip and a bounce, which is the rule this
  // replaces, so the worst case is the old one.
  if (deps.dipBounce?.onSelection === true && deps.marketPrices && opened.length > 0) {
    const fresh = opened.map((p) => current.get(p.id) ?? p)
    let live: ReadonlyMap<string, number> = new Map()
    try {
      live = await deps.marketPrices(fresh)
    } catch {
      // Silence, not a price: nothing is bought on it.
    }
    for (const position of fresh) {
      try {
        await buyFirstStepOnSelection(deps, position, live.get(`${position.chain}:${position.tokenAddress}`) ?? null, at, throttle)
      } catch {
        // One slot's first step must not cost the others theirs.
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

  // ── 4. Write the day down, checkpoint, then say you are alive ──────────────
  await recordTheDay(deps, marketPrices, throttle)

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

/**
 * One reading of the book's net, folded into today's row of the day log.
 *
 * *Un Log para llevar el control de cuánto va ganando cada día, el mínimo y el
 * máximo de ese día también.* The ENGINE writes it because the dashboard has no
 * write path, by design — and it writes the headline's own figure through
 * `bookNetUsd`, the function the screen draws it with, so a row in the Log can
 * never be a number the headline did not show.
 *
 * At the END of the pass, over the book as the pass left it: what the stop
 * sold, what the tick filled and what 3e just bought are all in the fills by
 * now. Valued at the prices this pass already fetched, not at a fresh request
 * — a position opened this pass is not in that map and falls back to its last
 * price, the same rule the screen follows when the feed is silent.
 *
 * NEVER fatal. A reading the Log misses costs the Log one sample of a thousand
 * that day; a cycle that dies over it costs the book its watch. So a failure
 * is said once, at info, and the pass goes on.
 */
async function recordTheDay(
  deps: CycleDeps,
  prices: ReadonlyMap<string, number>,
  throttle: AlertThrottle,
): Promise<void> {
  const at = deps.now()
  try {
    const [book, tape] = await Promise.all([deps.store.loadPositions(), deps.store.allFills()])
    await deps.store.recordDailyPnl(dailySample(bookNetUsd(book, tape, prices), at))
  } catch (error) {
    const missed = alert(
      'pnl-unrecorded',
      '📒 No se anotó el resultado de este ciclo',
      `El Log del día queda con una lectura menos; el motor sigue y el próximo ciclo vuelve a anotarlo. ${String(error).slice(0, 200)}`,
      at,
    )
    if (throttle.shouldSend(missed)) await deps.alerts.send(missed)
  }
}

/**
 * Why a position froze, newest first and without repeats — at most three, the
 * same cut the dashboard shows under `❄️ congelada`. From its own death watch,
 * which records every observation that produced a signal.
 */
function freezeEvidence(position: PersistedPosition): string[] {
  const details = [...position.deathWatch.evidence].reverse().flatMap((record) => record.signals.map((signal) => signal.detail))
  return [...new Set(details)].slice(0, 3)
}

/**
 * The rules a position runs under, assembled ONCE.
 *
 * Two tick sites read it — the ordinary pass over the book, and the first tick
 * of a position opened this same cycle. Two copies would eventually disagree
 * about which rules a brand new position runs under, which is the drift this
 * codebase has paid for at every seam it has. Exported so the composition root
 * is tested on the path the engine runs, not on a copy of it.
 */
export function tickConfigFrom(config: CycleConfig): EngineConfig & { readonly reservedEntries: number } {
  // Entries' worth of capital a slot is ALLOCATED: every step in production,
  // the whole ladder when a caller says nothing. Never more than the venue holds.
  const reservedEntries = Math.min(
    config.reservedEntries ?? config.maxOpenEntries ?? PYRAMIDING,
    config.maxOpenEntries ?? PYRAMIDING,
  )
  return {
    params: config.params,
    ...(config.deathPolicy ? { deathPolicy: config.deathPolicy } : {}),
    ...(config.exitOnFreeze === true ? { exitOnFreeze: true } : {}),
    ...(config.gasUsdPerSwap !== undefined ? { gasUsdPerSwap: config.gasUsdPerSwap } : {}),
    ...(config.maxOpenEntries !== undefined ? { maxOpenEntries: config.maxOpenEntries } : {}),
    // What the slot's capital pays for: the tick divides by it. The SAME
    // number the trim and the slot floor read, or a slot would be sized for
    // one entry and divided by six.
    reservedEntries,
    // Absent means the reference exit target, so the parity harness keeps
    // meaning what it meant. Present, the tick derives the target from what
    // this pool actually charges to leave.
    ...(config.maxCostSharePct !== undefined ? { maxCostSharePct: config.maxCostSharePct } : {}),
    // The bar the engine trades, so the DCA scale is measured over the bars
    // that had CLOSED before the first buy — not over a width guessed from
    // the candles' own spacing.
    ...(config.barMs !== undefined ? { barMs: config.barMs } : {}),

    ...(config.sizing ? { sizing: config.sizing } : {}),
  }
}

/**
 * What the stop, the target and the ratchet are sized from — built in ONE
 * place because two callers need it: the cycle, and the loop between cycles.
 * Two copies of "where may this position live" would eventually disagree, and
 * one of them would be holding money.
 */
export function exitSizingFrom(config: CycleConfig): ExitSizing {
  return {
    stop: config.stopLoss ?? NO_STOP_LOSS,
    rewardRiskRatio: config.rewardRiskRatio,
    maxCostSharePct: config.maxCostSharePct,
    gasUsdPerSwap: config.gasUsdPerSwap ?? 0.05,
    floorPct: config.params.minProfitPct,
    breakEven: config.breakEven === true,
    maxStopPct: config.maxStopPct,
    breakEvenArmPct: config.breakEvenArmPct,
    breakEvenFloorPct: config.breakEvenFloorPct,
    gainLock: config.gainLock ?? null,
  }
}
