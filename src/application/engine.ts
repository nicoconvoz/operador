import { type AlertPort, AlertThrottle, alert } from '../domain/notifications/alerts.js'
import { ROTATION_EXIT_COMMENT, BUYERS_GONE_COMMENT } from '../domain/risk/rotation.js'
import { applyDeathVerdict, assessAssetHealth, DEFAULT_DEATH_EXIT_POLICY, DEATH_EXIT_COMMENT, FROZEN_EXIT_COMMENT, type AssetHealthObservation, type DeathExitPolicy } from '../domain/risk/death-exit.js'
import { idempotencyKeyFor, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { stepCascade } from '../domain/strategy/cascade.js'
import { computeSignals, type Signals } from '../domain/strategy/signals.js'
import { initialState } from '../domain/strategy/state.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { type Order } from '../domain/strategy/state.js'
import { type BrokerPort } from '../domain/execution/broker.js'
import { orderKeyPart } from './recovery.js'
import { sizeLadder, DEFAULT_SIZING_POLICY, type SizingPolicy } from '../domain/economics/sizing.js'
import { deployableCapital, scaledParams } from './paper-run.js'
import { minProfitPctFor, roundTripCostForFill } from '../domain/economics/sizing.js'
import { PYRAMIDING } from '../domain/strategy/params.js'
import { BREAK_EVEN_COMMENT, STOP_LOSS_COMMENT } from '../domain/risk/stop-loss.js'
import { SWAP_EXIT_COMMENT } from '../domain/risk/rotation.js'
import { type Candles } from './replay.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { priceRatio, pricesDisagree } from '../domain/market/price-agreement.js'

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
  /** Closed bars, oldest first. The last one is the newest closed bar. */
  readonly candles: Candles
  /** Latest health observation, or null when no monitor ran this tick. */
  readonly health: AssetHealthObservation | null
  /**
   * What the MARKET says this token is worth, from a source independent of the
   * candles. Absent means nobody offered a second opinion, and the check then
   * stays silent — silence is not evidence.
   */
  readonly marketPriceUsd?: number | null
  readonly broker: BrokerPort
}

export interface EngineConfig {
  readonly params: CascadeParams
  /**
   * How much of a winner's gross gain the chain may eat, in percent.
   *
   * The exit target is derived from it: at a third, the target is three times
   * the round trip and two thirds of every winner is ours. Absent leaves the
   * reference behaviour, so the parity harness keeps meaning what it meant.
   */
  readonly maxCostSharePct?: number
  readonly deathPolicy?: DeathExitPolicy
  /**
   * How far the candle price and the market price may diverge before the engine
   * refuses to trade the token at all. Defaults to the GATE's own band, so the
   * screen and the machine cannot drift apart about which tokens are priceable.
   */
  readonly maxPriceRatio?: number
  /**
   * Sell the whole position the moment its ladder freezes.
   *
   * The operator's decision: recover the funds and put them into another token
   * rather than hold a position that cannot buy — frozen blocks entries — and
   * cannot sell, because the strategy's own exit wants a profit it will never
   * reach. Six positions sat exactly like that.
   *
   * The cost is real and is written down in `DeathVerdictOptions`: it collapses
   * the graded response into one stage, so a single bad reading liquidates
   * instead of pausing. The token is NOT blacklisted — it goes back to being
   * merely filtered and may be bought again.
   */
  readonly exitOnFreeze?: boolean
  readonly sizing?: SizingPolicy
  /** Needed to reserve gas out of the position's capital before sizing. */
  readonly gasUsdPerSwap?: number
  readonly maxOpenEntries?: number
}

export interface TickResult {
  readonly position: PersistedPosition
  /** Orders to submit, after the death watch has had its say. */
  readonly orders: readonly Order[]
  /** Orders the strategy wanted that the death watch removed. */
  readonly vetoed: readonly Order[]
  readonly skipped: 'already-processed' | 'no-bars' | 'price-mismatch' | null
  /** Closed bars this tick advanced. One in the ordinary case, more after a slow cycle. */
  readonly barsAdvanced: number
  /**
   * The profit the exit required on this bar, in percent.
   *
   * Reported because it is DERIVED and therefore not knowable from the
   * configuration alone: it depends on the fill this pool would actually
   * absorb, which the impact budget may have shrunk. Without it, *why did it
   * not sell* is a question answerable only by rerunning the arithmetic by
   * hand — and this project has paid for unanswerable screens before.
   *
   * It is also what makes the derivation TESTABLE. A mutation showed it could
   * stop reaching the engine with no test dying, which is the blind spot that
   * hid a missing `discover` and a missing `poolMarkets`.
   */
  readonly minProfitPct: number
}

/**
 * How far behind the engine is willing to walk in one tick.
 *
 * 96 bars is a day at 15 minutes. Past that the engine was not late, it was
 * DOWN — and replaying a week of history would decide orders against prices
 * nobody can trade at any more, filling a ladder from a market that is gone.
 */
export const MAX_CATCH_UP_BARS = 96

/**
 * Advances one position to the latest closed bar.
 *
 * It used to advance ONE bar per call, which was correct only while a cycle
 * was faster than a bar. In production a cycle took ~37 minutes against
 * 15-minute bars, so the engine saw ten of every twenty-two — and every
 * parameter counted in BARS silently changed meaning. `confirmBars: 20` stopped
 * being five hours and became eleven, which is longer than these positions
 * live: the rebound confirmation could never complete, and the DCA ladder never
 * fired once. Ten entries, six exits, zero DCAs.
 *
 * So the engine walks every bar it missed. A slow scheduler is now a latency
 * problem, which is what it should have been all along, instead of a silent
 * change to what the strategy computes.
 *
 * `lastBarTime` is still the guard against deciding twice: a process that
 * crashes after saving but before submitting comes back, sees those bars are
 * already processed, and does nothing.
 */
export async function tickPosition(
  input: TickInput,
  config: EngineConfig,
  store: StatePort,
  alerts: AlertPort,
  throttle: AlertThrottle,
): Promise<TickResult> {
  const { candles, broker } = input
  const last = candles.time.length - 1
  if (last < 0) return { position: input.position, orders: [], vetoed: [], skipped: 'no-bars', barsAdvanced: 0, minProfitPct: config.params.minProfitPct }

  // ── A token it cannot PRICE is a token it does not trade ──────────────────
  //
  // The operator's rule, and it is broader than the bug that prompted it: if
  // the two sources disagree about the price, do not work that coin at all.
  //
  // `priceMismatch` already refuses such a token at the door, but it is only
  // ever asked at the scan and at the entry — and the damage lands at the EXIT.
  // USDF was bought at 0.031564 and sold two and a half hours later by a freeze
  // exit at 0.0000021879, **14,426x lower**, turning $15.06 into a tenth of a
  // cent. The no-loss guard deliberately lets a risk exit fill below cost,
  // which is right, and that turned "accept whatever price exists" into "accept
  // any number at all".
  //
  // Refusing to act is the honest answer, not a timid one. Both of the two
  // numbers cannot be right, and neither the strategy nor the death exit can be
  // carried out correctly on a price nobody can confirm — the same rule
  // recovery runs on: an unattended system is allowed to stop, it is not
  // allowed to guess.
  //
  // It blocks the ORDERS, never the observation. The death watch is price-free
  // by construction and goes on running: a position nobody is watching is the
  // failure this engine has paid for more than once, and a feed that lost the
  // decimal point is not a reason to look away from a token that might be dying.
  if (pricesDisagree(input.marketPriceUsd, candles.close[last], config.maxPriceRatio ?? DEFAULT_GATE_POLICY.maxPriceRatio)) {
    const watched = await assessHealth(input, config, store, alerts, throttle)
    const ratio = priceRatio(input.marketPriceUsd!, candles.close[last]!)!
    // CRITICAL, and never throttled. Only a person can tell a broken feed from
    // a token that really collapsed, and until they do the position is frozen
    // in place holding real money.
    await alerts.send(alert(
      'position-halted',
      `🧮 ${input.position.symbol} — no se puede precificar`,
      `El mercado dice $${input.marketPriceUsd} y las velas dicen $${candles.close[last]} — ${ratio.toFixed(0)}× de diferencia. `
        + 'No se opera: ni compra ni venta, hasta que las dos fuentes vuelvan a coincidir. La vigilancia de muerte sigue corriendo.',
      candles.time[last]!,
      { position: input.position.id, ratio: ratio.toFixed(0) },
    ))
    return { position: watched, orders: [], vetoed: [], skipped: 'price-mismatch', barsAdvanced: 0, minProfitPct: config.params.minProfitPct }
  }

  const first = firstUnprocessedBar(candles.time, input.position.lastBarTime, last)
  if (first === null) {
    // No new bar, but the DEATH WATCH still runs.
    //
    // It used to return here, before any health was assessed, and that shut a
    // door in both directions on exactly the wrong tokens. A pool that stops
    // producing candles gets no tick, so no observation, so no clean streak —
    // a position frozen on a quiet token could never be cleared, and one dying
    // on a quiet token could never be condemned. PURR sat frozen for four
    // hours and would have stayed that way for good.
    //
    // A pool that stopped trading is the profile of one being abandoned, and
    // that is when the watch should be most awake. It is meant to evaluate
    // continuously and INDEPENDENTLY of price; tying it to candles was the
    // mistake.
    const watched = await assessHealth(input, config, store, alerts, throttle)
    return { position: watched, orders: [], vetoed: [], skipped: 'already-processed', barsAdvanced: 0, minProfitPct: config.params.minProfitPct }
  }

  // ── Sized once, not per bar ────────────────────────────────────────────────
  //
  // The strategy speaks in Pine's nominal sizes — level 0 is $1,000 — and a
  // position holds whatever the portfolio allotted it. Unsized, a $285
  // position emits a $1,000 entry, the broker refuses it for funds, and
  // nothing is recorded anywhere: a silent rejection is indistinguishable
  // from a strategy with no signals. It ran that way in production.
  //
  // Neither the wallet's capital nor the pool's quality moves within a
  // catch-up, so this is constant across the walk.
  // ── The rung is DERIVED from the slot, not a constant ─────────────────────
  //
  // The operator's rule: split the total among whatever survives the filters,
  // keeping the two steps of depth. With eight positions on $1,500 that is
  // ~$187 a slot and ~$62 a rung — not the $15 a flat cap allowed.
  //
  // Dividing the capital alone does NOTHING, and that is the part worth
  // remembering: `scaledParams` only ever shrinks, because its scale is
  // `sized / nominal` and sizing takes the minimum of the pool's impact budget
  // and the wallet. A $187 slot under a $15 cap still deploys $47.57 and leaves
  // $140 idle. The cap has to follow the capital, or the capital does nothing.
  //
  // It supersedes `OPERADOR_MAX_USD_PER_LEVEL`, which was a constant argued
  // from the GAS floor — a flat $15 ladder where gas is 0.33% of each fill. A
  // bigger rung only makes that argument stronger, so nothing is lost.
  //
  // What still binds is the POOL. The 1% impact budget shrinks a rung a thin
  // venue cannot absorb, exactly as it took PURR's $15 down to $9.46. Depth
  // outranks capital, and that is the order it has to be in.
  const rungs = config.maxOpenEntries ?? PYRAMIDING
  const deployable = deployableCapital({
    initialCapital: input.position.capitalUsd,
    gasUsdPerSwap: config.gasUsdPerSwap ?? 0.05,
    maxOpenEntries: rungs,
    params: config.params,
  })
  const sizing = sizeLadder(
    { ...config.params, maxUsdPerLevel: deployable / rungs },
    input.position.quality,
    config.sizing ?? DEFAULT_SIZING_POLICY,
    deployable,
  )
  const sized = sizing.tradeable
    ? scaledParams({ ...config.params, maxUsdPerLevel: deployable / rungs }, sizing)
    : config.params

  // The exit target, DERIVED from what leaving this pool actually costs.
  //
  // A flat 2% was below the economic floor on the book the operator was
  // running. Measured on his numbers: a $15 position in a deep pool pays about
  // 1.3% to go in and out — ten cents of gas and nine of spread — so a 2%
  // target left ELEVEN CENTS of gross per winner while the losers had no bound
  // at all. Winners capped and losers open cannot work however good the
  // selection is.
  //
  // Derived, it adapts to the SIZE, because gas is fixed and its share is not:
  // $15 needs 3.9%, $100 needs 2.2%, for the same net. That is the capital
  // floor's own finding — *tiny positions are eaten by gas* — stated as a rule
  // instead of rediscovered.
  //
  // It uses the rung the position will ACTUALLY fill, after the pool's impact
  // budget has shrunk it, rather than the nominal one. Asking a $9.46 fill to
  // clear the target computed for $15 would leave it below its own costs, and
  // that is precisely the position least able to afford it.
  // Absent means the REFERENCE exactly, and that is deliberate rather than a
  // convenience. Left to its own default the derivation applied everywhere and
  // the parity harness passed only by luck — its rungs are large enough that
  // the derived target falls under the flat floor. A departure that survives
  // by coincidence is one nobody will notice breaking.
  const fillUsd = sizing.tradeable ? sized.maxUsdPerLevel : deployable / rungs
  // Scaled to the fill, as the broker charges it. The raw $100 reading made
  // the target on a thin pool demand a move the trade was never going to pay
  // for, and the ratchet arms at this same number — so the two must agree.
  const roundTrip = roundTripCostForFill(fillUsd, input.position.quality, config.gasUsdPerSwap ?? 0.05)
  // The target answers ONE question — does a winner cover what leaving costs,
  // with room to spare. What a LOSER costs is the stop's question, and the
  // stop is derived from this number rather than the other way round: see
  // `stopForRatio`. The operator's reversal, and it is the bet that matches
  // *aguanta mejor* — small target taken often, wide stop, one loss in four.
  const params = config.maxCostSharePct === undefined ? sized : {
    ...sized,
    minProfitPct: minProfitPctFor(roundTrip, config.maxCostSharePct, sized.minProfitPct),
  }

  // Indicators are causal — every one of them reads backwards only — so the
  // context at bar i is the same whether the series ends at i or at the end.
  // Computing them once turns a catch-up from quadratic into a walk.
  const signals = computeSignals(candles, params)

  let position = input.position
  let orders: readonly Order[] = []
  let vetoed: readonly Order[] = []

  for (let barIndex = first; barIndex <= last; barIndex++) {
    const advanced = await advanceOneBar(
      {
        position,
        candles,
        // The health reading is a measurement of NOW, not of each bar that
        // went by. Applying it once per replayed bar would let one observation
        // accumulate into a death sentence it never earned.
        health: barIndex === last ? input.health : null,
        // Only on the LAST bar, and for the same reason as the health reading:
        // it is a measurement of NOW. A catch-up replaying twenty missed bars
        // must fill each of them at its own open, as it always did — filling a
        // bar from four hours ago at today's price would rewrite history with a
        // number that did not exist then.
        marketPriceUsd: barIndex === last ? (input.marketPriceUsd ?? null) : null,
        broker,
      },
      barIndex,
      { params, signals, tradeable: sizing.tradeable },
      config,
      store,
      alerts,
      throttle,
    )
    position = advanced.position
    orders = advanced.orders
    vetoed = advanced.vetoed
  }

  return { position, orders, vetoed, skipped: null, barsAdvanced: last - first + 1, minProfitPct: params.minProfitPct }
}

/**
 * The first bar this position has not seen, or null when it is up to date.
 *
 * A position the portfolio just opened carries `lastBarTime: -1`, which does
 * not mean "infinitely behind" — it means "no history of its own". It starts at
 * the newest bar, because replaying the provider's whole window would open a
 * ladder at prices that are days old.
 */
function firstUnprocessedBar(times: readonly number[], lastBarTime: number, last: number): number | null {
  if (lastBarTime < 0) return last

  const next = times.findIndex((time) => time > lastBarTime)
  if (next < 0) return null
  return Math.max(next, last - MAX_CATCH_UP_BARS + 1)
}

/** What the whole walk shares: the sized params and the indicators over them. */
interface WalkContext {
  readonly params: CascadeParams
  readonly signals: Signals
  readonly tradeable: boolean
}

async function advanceOneBar(
  input: TickInput,
  barIndex: number,
  walk: WalkContext,
  config: EngineConfig,
  store: StatePort,
  alerts: AlertPort,
  throttle: AlertThrottle,
): Promise<{ position: PersistedPosition; orders: readonly Order[]; vetoed: readonly Order[] }> {
  const { position, candles, broker } = input
  const barTime = candles.time[barIndex]!
  const barOpen = candles.open[barIndex]!
  const barClose = candles.close[barIndex]!

  // ── 0. Execute what the PREVIOUS bar decided, at THIS bar's open ──────────
  //
  // This is the execution model the parity harness pinned: an order decided at
  // a close fills at the NEXT bar's open, never at the close that decided it.
  // The engine writes its intentions down and the following tick carries them
  // out, which is also what makes a crash between the two survivable.
  //
  // Before anything else runs, because every number the strategy is about to
  // read — size, average cost, open profit — comes from the broker, and the
  // broker is rebuilt from these fills on the next wake-up.
  // Executed ORDER BY ORDER, not all at once, so each fill can be keyed to the
  // order that caused it — and keyed the way RECOVERY looks it up: by the bar
  // the order was DECIDED on, which is the position's last bar, not the one it
  // fills at. Writing the filling bar instead would leave recovery unable to
  // find its own fills and it would halt every position it had just traded.
  let exitRefused = false
  const rejectedBefore = broker.rejections.length
  exitRefused = await settle(position.pendingOrders, position.lastBarTime, barOpen, barTime, position, broker, store)

  // ── 0b. Say that the position was kept ────────────────────────────────────
  //
  // Nothing has to be rolled back here, and that is worth stating because the
  // obvious design is to roll something back. `stepCascade` resets the ladder
  // on `!inPosition && wasInTrade` — it reacts to the BROKER going flat, never
  // to the exit being signalled. A sale that does not happen leaves the broker
  // holding, so the machine simply never resets and the ladder survives on its
  // own. The fills are the facts, once again.
  // WHY an order did not fill, because the broker knew and nobody was asking.
  //
  // Thirty positions carried a pending order for over an hour with zero fills,
  // and the only record of the refusal was `broker.rejections` — written on
  // every rejection since the simulator was built, read by the parity harness
  // and by nothing else. From outside it looked like an engine deciding orders
  // into a void, which is precisely what it was.
  const refusals = broker.rejections.slice(rejectedBefore)
  if (refusals.length > 0) {
    const why = refusals.map((r) => `${r.order.comment}: ${r.reason}`).join('\n')
    const refused = alert(
      'order-refused',
      `🚫 ${position.symbol} — el bróker rechazó ${refusals.length} orden(es)`,
      why,
      barTime,
      { position: position.id, reasons: refusals.map((r) => r.reason).join(',') },
    )
    if (throttle.shouldSend(refused, `refused:${position.id}`)) await alerts.send(refused)
  }

  if (exitRefused) {
    const kept = alert(
      'ladder-frozen',
      `🛡️ ${position.symbol} no se vendió a pérdida`,
      'La salida se decidió con ganancia y la apertura siguiente quedó por debajo del costo promedio. La posición se mantiene y la escalera sigue viva.',
      barTime,
      { position: position.id },
    )
    if (throttle.shouldSend(kept, `no-loss:${position.id}`)) await alerts.send(kept)
  }

  // ── 1. The death watch speaks first ────────────────────────────────────────
  let deathWatch = position.deathWatch
  if (input.health) {
    const assessment = assessAssetHealth(deathWatch, config.deathPolicy ?? DEFAULT_DEATH_EXIT_POLICY, input.health)
    deathWatch = assessment.state

    if (assessment.verdict === 'exit') {
      await store.blacklist(position.chain, position.tokenAddress, assessment.signals.map((s) => s.detail).join('; '), barTime)
      await alerts.send(alert('death-exit', `☠️ ${position.symbol} murió`, assessment.signals.map((s) => s.detail).join('\n'), barTime, { position: position.id }))
    } else if (assessment.verdict === 'freeze') {
      const frozen = alert('ladder-frozen', `❄️ ${position.symbol} congelada`, assessment.signals.map((s) => s.detail).join('\n'), barTime, { position: position.id })
      if (throttle.shouldSend(frozen, `${frozen.kind}:${position.id}`)) await alerts.send(frozen)
    }
  }

  // ── 1a. The broker is the truth about what is held ────────────────────────
  //
  // The state machine advances on the SIGNAL — that is Pine's semantics and
  // the parity harness depends on it. But an order the broker refused leaves
  // the machine believing it holds a position nobody bought, waiting for a DCA
  // trigger on a cost basis that never existed. Production ran five positions
  // that way: level 1, zero tokens, a ladder of pure fiction, capital held
  // hostage by a trade that never happened.
  //
  // Flat AND nothing pending AND the machine says in-trade is the one
  // combination that cannot be honest. Flat WITH something pending is normal
  // for exactly one bar — decided at a close, filled at the next open — so the
  // pending check is what keeps this from firing on healthy positions.
  const beforeStrategy = broker.snapshot(barClose)
  const desynced = beforeStrategy.size === 0 && position.pendingOrders.length === 0 && position.cascade.level > 0
  const cascadeIn = desynced ? initialState() : position.cascade
  if (desynced) {
    await alerts.send(alert(
      'position-halted',
      `⚠️ ${position.symbol} desincronizada`,
      'La máquina creía estar en posición y el bróker no tiene nada. Se reinicia al estado plano, que es el que los fills respaldan.',
      barTime,
      { position: position.id, level: position.cascade.level },
    ))
  }

  // ── 2. The strategy evaluates the closed bar ───────────────────────────────
  const stepped = stepCascade(
    cascadeIn,
    walk.params,
    { open: barOpen, high: candles.high[barIndex]!, low: candles.low[barIndex]!, close: barClose },
    walk.signals.contexts[barIndex]!,
    beforeStrategy,
  )

  // ── 3. The death watch gets the last word ──────────────────────────────────
  const inPosition = beforeStrategy.size > 0
  const afterDeath = applyDeathVerdict(stepped.orders, deathWatch.stage, inPosition, {
    ...(config.exitOnFreeze === true ? { exitOnFreeze: true } : {}),
  })
  // A pool too thin to size against must not trap the money already in it:
  // entries stop, exits never do.
  const orders = walk.tradeable ? afterDeath : afterDeath.filter((o) => o.kind !== 'entry')
  const kept = new Set(orders)
  const vetoed = stepped.orders.filter((o) => !kept.has(o))

  // ── 4. Write before sending ────────────────────────────────────────────────
  // The order is persisted as pending FIRST. If the process dies here, recovery
  // finds it and asks the venue whether it happened — which is only possible
  // because it was written down first.
  //
  const next: PersistedPosition = {
    ...position,
    cascade: stepped.state,
    deathWatch,
    lastBarTime: barTime,
    lastPriceUsd: barClose,
    pendingOrders: orders,
    updatedAt: barTime,
  }
  await store.savePosition(next)

  // ── 5. And send it NOW, if there is a price we have already checked ────────
  //
  // The creator's decision, and the reason is fifteen minutes of nothing: a
  // slot opens, the next tick with a new bar decides, and the tick AFTER that
  // fills at the following open. Up to half an hour before a token the scanner
  // chose holds anything at all — and the second wait protects nothing, because
  // the decision is already taken on a bar that already closed.
  //
  // **Bar-close semantics are untouched.** What moves is when the order reaches
  // the venue, not what it was decided on. A real venue does not make you wait
  // for a candle to send an order it already agreed to.
  //
  // It is safe now and would not have been this morning: the live market price
  // arrives every cycle for everything held, and this tick REFUSES to trade at
  // all when that price and the candle disagree. So an immediate fill is priced
  // against a number already checked against a second source — which is exactly
  // what the old path could not say about the next bar's open.
  //
  // Written down BEFORE it is sent, above, and cleared after. A crash in
  // between leaves a pending order whose fill is already recorded under the
  // same key, and recovery's first question — "is a fill recorded?" — answers
  // itself.
  const live = input.marketPriceUsd
  const settled = orders.length > 0 && live !== null && live !== undefined && live > 0
  if (settled) {
    exitRefused = (await settle(orders, barTime, live, barTime, next, broker, store)) || exitRefused
    await store.savePosition({ ...next, pendingOrders: [] })
  }

  for (const order of orders) {
    if (order.kind === 'closeAll' && order.comment === DEATH_EXIT_COMMENT) continue // already alerted
    if (order.kind === 'entry') {
      const { opening, icon, name } = entryAlertLabel(order)
      await alerts.send(alert(opening ? 'position-opened' : 'dca-filled', `${icon} ${position.symbol} ${name}`, `$${order.usd.toFixed(2)} at ${barClose.toPrecision(6)}`, barTime, { position: position.id, key: idempotencyKeyFor(position.id, barTime, orderKeyPart(order)) }))
    } else {
      await alerts.send(alert('position-closed', `🏁 ${position.symbol} cerrada`, order.comment, barTime, { position: position.id }))
    }
  }

  // The CLEARED position when it was settled, or the next tick would see a
  // pending order that already filled — the exact state recovery exists to
  // untangle, handed to it for nothing.
  return { position: settled ? { ...next, pendingOrders: [] } : next, orders, vetoed }
}

/**
 * Whether this pending sale must not go through at this price.
 *
 * "Never exit at a loss" is a premise of the whole strategy, not a preference:
 * the ladder's argument is that a drop is an opportunity to average down, so
 * selling into one destroys the edge the system exists to harvest.
 *
 * The rule was enforced at DECISION time, where price is above average cost by
 * construction — and leaked at EXECUTION time, where the next bar's open can be
 * anywhere. Production sold at -13.1% under the comment "🏁 Exit" because the
 * gap between that close and that open was -14.8%. On 15-minute small caps the
 * execution gap is routinely larger than the entire +2% profit target, so a
 * rule that only holds at the close does not hold at all.
 *
 * The death exit is the one exception, and it is not really an exception — it
 * answers a different question. A stop loss sells because the PRICE fell; a
 * death exit sells because the ASSET stopped being an asset, and holding out
 * for a better price on something unsellable is how you hold it forever.
 */
/**
 * Send orders to the venue and write down what came back.
 *
 * One implementation, two callers: the orders a PREVIOUS bar decided, filled at
 * this bar's open, and the ones just decided, filled at the market price right
 * now. They must agree about every detail that matters — the idempotency key,
 * the no-loss guard, the per-fill suffix — because a second copy of this is how
 * a retry buys twice.
 *
 * `keyBarTime` is the bar the order was DECIDED on, never the one it fills at.
 * Recovery looks a fill up by exactly that, and keying it the other way would
 * leave it unable to find its own work and halt every position it had traded.
 */
export async function settle(
  orders: readonly Order[],
  keyBarTime: number,
  price: number,
  time: number,
  position: PersistedPosition,
  broker: BrokerPort,
  store: StatePort,
  /** How much of a loss a SWAP exit may pay. Nothing else reads it. */
  swapTolerancePct = 0,
): Promise<boolean> {
  let exitRefused = false
  for (const order of orders) {
    const key = idempotencyKeyFor(position.id, keyBarTime, orderKeyPart(order))
    // Guarded here as well as in SQL: the store would reject the duplicate
    // anyway, but a second execute() would also move the broker's cash.
    if (await store.hasFill(key)) continue

    // The position's own measured quality: the venue spread plus the impact
    // its size causes. This is what the sale will actually cost to make.
    const exitCostPct = position.quality.spreadPct + position.quality.slippagePct
    if (refusesToSellAtALoss(order, broker.snapshot(price).avgPrice, price, exitCostPct, swapTolerancePct)) {
      exitRefused = true
      continue
    }

    const fills = broker.execute([order], price, time)
    for (const [index, fill] of fills.entries()) {
      await store.recordFill({
        positionId: position.id,
        orderId: fill.id,
        side: fill.side,
        time: fill.time,
        price: fill.price,
        qty: fill.qty,
        costUsd: fill.commission,
        comment: fill.comment,
        // One close sells every open entry, so it produces several fills for a
        // single order. The FIRST carries the order's canonical key, which is
        // the one recovery asks about; the rest are suffixed.
        idempotencyKey: index === 0 ? key : `${key}#${index}`,
      })
    }
  }
  return exitRefused
}

/**
 * Never sell at a loss — measured on what the position will RECEIVE.
 *
 * Found in production by the operator: a `🔁 Rotación` marked -$2.07. Bought
 * at 0.05076167, the guard looked at 0.05078 and allowed it, and the fill
 * landed at 0.0506076. The 0.34% in between is the venue's cut on the way out.
 *
 * CLAUDE.md already records this exact mistake once, about the strategy's own
 * exit: *the rule was enforced at DECISION time, where price is above average
 * cost by construction; it leaked at EXECUTION time.* Fixing it there and
 * leaving it here was the same bug twice, a day apart.
 *
 * `exitCostPct` is what leaving takes — the venue spread plus the impact this
 * position's own size will cause. Zero reproduces the old behaviour exactly,
 * so a caller that cannot measure it is not silently given a different rule.
 */
export function refusesToSellAtALoss(
  order: Order,
  avgPrice: number | null,
  fillPrice: number,
  exitCostPct = 0,
  swapTolerancePct = 0,
): boolean {
  if (order.kind !== 'closeAll') return false
  // Neither exit may be blocked by the no-loss rule, and for the same reason:
  // both leave because the ASSET stopped working, not because the price fell.
  // A guard that held them would hold exactly the positions that most need to
  // get out.
  // THREE risk exits now, and all three leave for the same kind of reason:
  // something other than a price the strategy can wait out. The first two leave
  // because the asset stopped being an asset; the stop leaves because the
  // strategy that bought it says so, and a stop loss that cannot sell at a loss
  // is not a stop loss.
  if (
    order.comment === DEATH_EXIT_COMMENT ||
    order.comment === FROZEN_EXIT_COMMENT ||
    order.comment === STOP_LOSS_COMMENT ||
    // *Si la presión compradora cae a menos del 1%, se vende como esté.* The
    // operator's order, and it is his to give: the buyers left, so the
    // position leaves at whatever the market pays.
    order.comment === BUYERS_GONE_COMMENT
    // The break-even is NOT exempt any more. It was, on the argument that the
    // alternative was riding the position down to the stop — and there is no
    // stop now: *no cierres en negativo; sólo el death o congelamiento.* Three
    // break-evens closed between −$0.10 and −$0.18 the morning that shipped.
    // Refused, the position is held and the ladder averages it down.
  ) {
    return false
  }
  // The ALLOCATOR's exit is NOT exempt, and that is the operator's later
  // decision: *las salidas nunca en pérdida, siempre en ganancias. Si algo
  // está en ganancias y el interruptor marca off, cierra posición; si está en
  // pérdida, lo deja.*
  //
  // It WAS exempt, asked for with *aunque se pierda*, and that exemption was
  // the single thing making it a stop loss in disguise — the objection stated
  // when it was built, since `momentum` is one of the floors and momentum is
  // price. Subject to the guard it stops being one outright: the switch can
  // only ever take a PROFIT, and no path in this engine sells because the
  // price fell. The two RISK exits below remain the only exceptions, and both
  // leave because the asset stopped being an asset.
  // Nothing held, so no cost basis and no loss to make.
  if (avgPrice === null) return false
  // The SWAP exit pays a bounded toll to move a slot somewhere better. It is
  // not exempt like the two risk exits: it has a ceiling, and past that
  // ceiling it is refused exactly like the others. A toll with no limit is
  // just a stop loss that nobody named.
  if (order.comment === SWAP_EXIT_COMMENT) {
    return fillPrice * (1 - exitCostPct / 100) < avgPrice * (1 - swapTolerancePct / 100)
  }
  // What the position RECEIVES, not what the screen quotes.
  return fillPrice * (1 - exitCostPct / 100) < avgPrice
}

/**
 * How to announce an entry, taken from the ORDER rather than from the machine.
 *
 * The label used to come from the cascade level read BEFORE `stepCascade` ran.
 * But the machine resets on `!inPosition && wasInTrade`, INSIDE the step — so
 * on the bar where a sale settles and the trend door fires again, the level
 * still said "in trade" and a full re-opening went out as "➕ … Entry". Live,
 * that read as the DCA ladder finally firing while the DCA count was zero,
 * which is the one thing the reader was watching for.
 *
 * The order cannot be wrong about this: both entry doors emit level 0 and
 * carry their own comment — '🟢 Entry' or '🚀 Re-Entry' — while a rung emits
 * its own level and is named for it.
 */
export function entryAlertLabel(order: Order & { kind: 'entry' }): { opening: boolean; icon: string; name: string } {
  if (order.level !== 0) return { opening: false, icon: '➕', name: order.id }

  // The comment leads with the door's own icon. Splitting it keeps the two
  // doors distinguishable on the phone, where they are otherwise both "Entry"
  // and a re-entry looks like a position that opened twice.
  const space = order.comment.indexOf(' ')
  if (space <= 0) return { opening: true, icon: '🟢', name: order.comment }
  return { opening: true, icon: order.comment.slice(0, space), name: order.comment.slice(space + 1) }
}

/**
 * The death watch, run on a position the strategy has nothing to say about.
 *
 * Returns the position with its watch advanced, persisted. Orders are NOT
 * placed: a death exit decided here has no bar to fill at, and inventing one
 * would be inventing a price. It alerts, it records, and the exit goes out on
 * the first bar that does arrive — which for a truly dead pool may be never,
 * and is exactly why CLAUDE.md says a death exit may fail and why detection
 * runs continuously rather than waiting for one.
 */
async function assessHealth(
  input: TickInput,
  config: EngineConfig,
  store: StatePort,
  alerts: AlertPort,
  throttle: AlertThrottle,
): Promise<PersistedPosition> {
  const { position } = input
  if (!input.health) return position

  const assessment = assessAssetHealth(position.deathWatch, config.deathPolicy ?? DEFAULT_DEATH_EXIT_POLICY, input.health)
  const at = input.health.observedAt

  if (assessment.verdict === 'exit') {
    await store.blacklist(position.chain, position.tokenAddress, assessment.signals.map((s) => s.detail).join('; '), at)
    await alerts.send(alert('death-exit', `☠️ ${position.symbol} murió`, assessment.signals.map((s) => s.detail).join('\n'), at, { position: position.id }))
  } else if (assessment.verdict === 'freeze') {
    const frozen = alert('ladder-frozen', `❄️ ${position.symbol} congelada`, assessment.signals.map((s) => s.detail).join('\n'), at, { position: position.id })
    if (throttle.shouldSend(frozen, `${frozen.kind}:${position.id}`)) await alerts.send(frozen)
  }

  // Persisted, or the streak restarts from zero on every pass and a freeze
  // clears exactly never — which is the shape of the bug this replaces.
  //
  // And STAMPED, because writing the row without touching `updatedAt` left the
  // dashboard reporting "sin barras nuevas hace más de 2h" about a position the
  // death watch was observing every five minutes. Ten of them at once, under a
  // warning whose whole purpose is to name the right suspect — and it named the
  // token while the engine was doing exactly its job.
  const next: PersistedPosition = { ...position, deathWatch: assessment.state, updatedAt: at }
  await store.savePosition(next)
  return next
}
