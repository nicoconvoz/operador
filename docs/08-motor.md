# The engine tick and the cycle

This chapter documents `src/application/` — the layer where every isolated decision in the codebase meets and becomes money moving. It covers `tickPosition` step by step, with the ordering of those steps treated as what it is: a safety property, not a style choice. It covers the catch-up walk and the production measurement that forced it (a cycle is not a bar); the execution layer, which for a period did not exist at all and produced five live positions showing `0 compra / 0 venta`; `refusesToSellAtALoss`, the no-loss rule enforced where it actually leaks; the desync guard that makes the broker, not the state machine, the truth about what is held; `runCycle` and its order of operations; the split between a cheap `watch` pass and an expensive `full` pass, and the two cadences that drive them; slot release, capital trim, the common fund and recall from the shelf; and `ledger.ts`, the single walk over fills that three separate decisions depend on.

The strategy this layer advances is in `03-estrategia-cascade-dca.md`; the indicators it feeds into it, in `02-indicadores.md`; the death watch, the portfolio allocator, idle-slot policy and the kill switch, in `05-riesgo.md`; sizing, the gas floor and the capital-floor experiment, in `06-economia.md`; the scanner whose candidates it allocates to, in `04-escaner.md`. `planRecovery` and the durable schema belong to the persistence chapter and are documented here only where the tick has to reproduce their key shape exactly.

---

## 1. Where the code is

| File | What it is |
|---|---|
| `src/application/engine.ts` | `tickPosition` — one position, from its last processed bar to the newest closed one. 402 lines. |
| `src/application/orchestrator.ts` | `runCycle` — one pass of the whole system. 432 lines. |
| `src/application/ledger.ts` | `positionLedger` and `commonFund` — the single walk over fills. 116 lines, pure. |
| `src/application/production-ladder.ts` | The two numbers where production deliberately differs from the Pine reference. 52 lines, no I/O of any kind. |
| `src/application/recall.ts` | `recallCandidates` — the last scan, re-ranked off the shelf with zero network. 90 lines. |
| `src/application/recovery.ts` | `planRecovery` and `orderKeyPart`. Called first by every cycle; its key shape is what the tick must reproduce. |
| `src/application/paper-run.ts` | Supplies the four sizing functions the tick and the cycle depend on, plus `PRICE_HEADROOM_PCT = 5`. |
| `src/domain/risk/idle-slots.ts` | `releasableSlots` — the pure rule behind slot release. Documented in full in `05-riesgo.md`. |
| `src/runtime/loop.ts` | `runLoop` — the supervised loop that chooses which kind of pass to run. |
| `src/runtime/main.ts` | Composition root: real adapters, real clock, the environment. |

Tests, each of which reads as a list of the rules:

| File | Covers |
|---|---|
| `src/application/engine.test.ts` | Never decides the same bar twice; writes before it sends; the death watch has the last word; the orders actually execute; the fill recovery will look for; the ladder is sized to the wallet, not to Pine; the broker is the truth about what is held; it advances every bar it missed; a falling price is not a reason to sell; a ladder six rungs deep; `entryAlertLabel`. |
| `src/application/orchestrator.test.ts` | Order of operations; halted containment; the kill switch; what it refuses to open; liveness; the sell path confirmed before money moves; a new position born knowing its price; slot release; watch vs full; capital trim; profit becomes capital; re-examination when flat; the derived slot floor; no ceiling means no ceiling. |
| `src/application/ledger.test.ts` | Banked vs at risk; flat but traded; closed positions still count; the chain's cut comes out; no basis leaks between positions; it goes negative honestly. |
| `src/application/recall.test.ts` | Reproduces the verdict with no network; refuses a stale shelf; still applies every gate; measured impact over reported liquidity; the model only as fallback; reports the oldest chain. |
| `src/application/production-ladder.test.ts` | The defaults; the entry-is-not-a-DCA arithmetic; env overrides; NaN rejection; and that these numbers never express themselves by editing the evidence. |

---

## 2. `tickPosition` — one position, one tick

```ts
export async function tickPosition(
  input: TickInput,
  config: EngineConfig,
  store: StatePort,
  alerts: AlertPort,
  throttle: AlertThrottle,
): Promise<TickResult>
```

It takes ports, returns what happened, and never reaches for a clock or a network of its own. Every time in it comes from a candle.

### 2.1 Inputs and outputs

```ts
export interface TickInput {
  readonly position: PersistedPosition
  /** Closed bars, oldest first. The last one is the newest closed bar. */
  readonly candles: Candles
  /** Latest health observation, or null when no monitor ran this tick. */
  readonly health: AssetHealthObservation | null
  readonly broker: BrokerPort
}

export interface EngineConfig {
  readonly params: CascadeParams
  readonly deathPolicy?: DeathExitPolicy
  readonly sizing?: SizingPolicy
  readonly gasUsdPerSwap?: number
  readonly maxOpenEntries?: number
}

export interface TickResult {
  readonly position: PersistedPosition
  readonly orders: readonly Order[]
  readonly vetoed: readonly Order[]
  readonly skipped: 'already-processed' | 'no-bars' | null
  readonly barsAdvanced: number
}
```

`orders` and `vetoed` are the LAST walked bar's, not the union over the walk — they are reassigned on each iteration. `barsAdvanced` is `last - first + 1`.

Two early exits, both returning the position untouched:

| Condition | `skipped` |
|---|---|
| `candles.time.length - 1 < 0` | `'no-bars'` |
| `firstUnprocessedBar(...) === null` | `'already-processed'` |

### 2.2 Work done once per tick, not once per bar

Two things are computed before the walk starts, and both are correctness arguments as much as performance ones.

**The ladder is sized once.** Neither the wallet's capital nor the pool's quality moves within a catch-up, so sizing per bar would be the same answer computed N times:

```ts
const sizing = sizeLadder(
  config.params,
  input.position.quality,
  config.sizing ?? DEFAULT_SIZING_POLICY,
  deployableCapital({
    initialCapital: input.position.capitalUsd,
    gasUsdPerSwap: config.gasUsdPerSwap ?? 0.05,
    maxOpenEntries: config.maxOpenEntries ?? PYRAMIDING,
    params: config.params,
  }),
)
const params = sizing.tradeable ? scaledParams(config.params, sizing) : config.params
```

`deployableCapital` subtracts gas for a full cycle of swaps and then 5% of price headroom — the gap between sizing at the signal bar's close and filling at the next bar's open (`PRICE_HEADROOM_PCT = 5`). `scaledParams` scales `baseUsd` and `maxUsdPerLevel` by the ratio the sizing allows for level 0, which preserves the SHAPE of the ladder (growing size as price falls) while matching its scale to the wallet and the pool. A level the pool cannot fund is clamped to the last fundable size rather than dropped, because dropping a level would change the state machine's own transitions and break parity. See `06-economia.md`.

**The indicators are computed once.** `computeSignals(candles, params)` returns a `contexts[]` array indexed by bar. Every indicator in the strategy is causal — each reads backwards only — so the context at bar *i* is identical whether the series ends at *i* or at the end of history. Computing them once turns a catch-up from quadratic into a linear walk.

### 2.3 `firstUnprocessedBar` and the bound on catching up

```ts
function firstUnprocessedBar(times: readonly number[], lastBarTime: number, last: number): number | null {
  if (lastBarTime < 0) return last

  const next = times.findIndex((time) => time > lastBarTime)
  if (next < 0) return null
  return Math.max(next, last - MAX_CATCH_UP_BARS + 1)
}
```

| Case | Answer | Why |
|---|---|---|
| `lastBarTime < 0` (a position the portfolio just opened) | `last` — the newest bar only | `-1` means "no history of its own", **not** "infinitely behind". Walking from the beginning would replay the provider's whole 1000-bar window and fill a ladder at prices days old. |
| No bar newer than `lastBarTime` | `null` → `skipped: 'already-processed'` | The never-decide-twice guard. |
| Behind by *n* ≤ 96 bars | the first unseen bar | Walk all of them. |
| Behind by more than 96 bars | `last - 95` | `MAX_CATCH_UP_BARS = 96` is one day at 15-minute bars. Past that the engine was not late, it was **down**, and replaying a week would decide orders against prices nobody can trade at any more — filling a ladder from a market that is gone. The position still ends up current. |

Tests: *a brand new position starts at the newest bar — it does not replay history* (`barsAdvanced === 1` from `lastBarTime: -1` over 300 candles), and *an outage longer than the cap resumes at the cap, not at the beginning* (400 candles, `lastBarTime = time[0]`, asserts `barsAdvanced === MAX_CATCH_UP_BARS` and `lastBarTime === time[399]`).

### 2.4 One health observation, one bar

```ts
health: barIndex === last ? input.health : null,
```

The health reading is a measurement of **now**, not of each bar that went by. The death-exit policy requires N consecutive confirming observations before Stage 2 (see `05-riesgo.md`); applying one observation to every replayed bar of a catch-up would let a single reading accumulate into a death sentence it never earned, and liquidate a healthy position.

---

## 3. `advanceOneBar` — the ordering IS the design

Five numbered steps plus two sub-steps, in this exact order.

### Step 0 — Execute what the PREVIOUS bar decided, at THIS bar's open

```ts
for (const order of position.pendingOrders) {
  const key = idempotencyKeyFor(position.id, position.lastBarTime, orderKeyPart(order))
  if (await store.hasFill(key)) continue
  if (refusesToSellAtALoss(order, broker.snapshot(barOpen).avgPrice, barOpen)) { exitRefused = true; continue }

  const fills = broker.execute([order], barOpen, barTime)
  for (const [index, fill] of fills.entries()) {
    await store.recordFill({ ..., idempotencyKey: index === 0 ? key : `${key}#${index}` })
  }
}
```

Five facts are packed into that loop.

**1. An order decided at a close fills at the NEXT bar's open, never at the close that decided it.** This is the execution model the TradingView parity harness pinned (`03-estrategia-cascade-dca.md`); deviating would silently break parity with the validated backtest. It is also what makes a crash between "decided" and "filled" survivable: the intent is on disk, and the following tick carries it out.

**2. It runs before anything else,** because every number the strategy is about to read — size, average cost, open profit — comes from the broker, and the broker is rebuilt from these fills on the next wake-up.

**3. Orders are executed one at a time,** not as a batch, so each fill can be keyed to the order that caused it.

**4. The key uses the bar the order was DECIDED on** — `position.lastBarTime` — not the bar it fills at. `planRecovery` looks a fill up by exactly `idempotencyKeyFor(position.id, position.lastBarTime, orderKeyPart(order))`. Writing the filling bar instead would leave recovery unable to find its own fills, and it would then halt every position the engine had just successfully traded — the exact opposite of what recovery is for. The two used to disagree. The test is named for it: *keys a fill so recovery recognises it, instead of halting a position it just traded*.

```ts
export const idempotencyKeyFor = (positionId: string, barTime: number, orderId: string): string =>
  `${positionId}:${barTime}:${orderId}`

export const orderKeyPart = (order: Order): string =>
  order.kind === 'entry' ? order.id : `closeAll:${order.comment}`
```

**5. One `closeAll` produces several fills — one per open rung — so only the FIRST carries the canonical key** and the rest are suffixed `${key}#${index}`. Without the suffix the store's `ON CONFLICT DO NOTHING` would silently swallow five of six sell fills, and the position would look permanently half-sold. The deep-ladder test asserts 6 sells with 6 distinct keys.

`store.hasFill(key)` is checked even though SQL already enforces uniqueness, because a second `broker.execute()` would still move the broker's cash even if the database rejected the duplicate row. The guard is about the broker, not the table.

### Step 0b — Say that the position was kept

If any exit was refused, one throttled alert, keyed per position:

| Field | Value |
|---|---|
| kind | `ladder-frozen` (level `warn`) |
| title | `🛡️ ${symbol} no se vendió a pérdida` |
| throttle key | `no-loss:${position.id}` |

**Nothing is rolled back,** and that is worth stating because the obvious design is to roll something back. `stepCascade` resets the cycle on `!inPosition && wasInTrade` — it reacts to the **broker** going flat, never to the exit being *signalled*. A sale that does not happen leaves the broker holding, so the machine never resets and the ladder survives on its own. A remembered pre-exit snapshot would need a column the store does not have, and would not improve on this. The test *keeps the ladder alive, so the drop can become a DCA instead of a loss* asserts the cascade is still at `level 3` with `ep1 === 1` after a refused exit.

### Step 1 — The death watch speaks FIRST

`assessAssetHealth(deathWatch, config.deathPolicy ?? DEFAULT_DEATH_EXIT_POLICY, input.health)`, and only when `input.health` is non-null.

| Verdict | Effect here |
|---|---|
| `exit` | `store.blacklist(chain, tokenAddress, evidence, barTime)` and an **unthrottled** `death-exit` alert (`☠️ ${symbol} murió`) carrying the full evidence chain. |
| `freeze` | A throttled `ladder-frozen` alert (`❄️ ${symbol} congelada`), key `ladder-frozen:${position.id}`. |
| `healthy` | Nothing. |

It runs before the strategy so that a freeze or a death is **already in force** when orders are decided. The signals themselves, the two stages and the price-free type are documented in `05-riesgo.md`.

### Step 1a — The desync guard: the broker is the truth about what is held

```ts
const beforeStrategy = broker.snapshot(barClose)
const desynced = beforeStrategy.size === 0 && position.pendingOrders.length === 0 && position.cascade.level > 0
const cascadeIn = desynced ? initialState() : position.cascade
```

The state machine advances on the **signal** — that is Pine's semantics and the parity harness depends on it. But an order the broker refused leaves the machine believing it holds a position nobody bought, waiting for a DCA trigger on a cost basis that never existed. Production ran five positions that way: level 1, zero tokens, a ladder of pure fiction, capital held hostage by a trade that never happened.

Flat **and** nothing pending **and** the machine says in-trade is the one combination that cannot be honest. Each clause matters:

- Dropping `size === 0` would fire on healthy positions.
- Dropping `cascade.level > 0` would fire on every flat position.
- **Dropping `pendingOrders.length === 0` would reset a healthy position's cascade on every bar between a decision and its fill** — flat-with-pending is the normal state for exactly one bar. The test *does NOT resync while a decided order is still waiting to fill* pins that.

The response is a **reset to `initialState()`, not a reconciliation attempt.** The fills are the facts; a machine that disagrees with the broker is wrong by definition, so the next order it can emit is an ENTRY rather than a DCA against a basis that never existed. An unthrottled `position-halted` alert goes out (`⚠️ ${symbol} desincronizada`) carrying the level it thought it was at.

### Step 2 — The strategy evaluates the closed bar

```ts
const stepped = stepCascade(
  cascadeIn,
  walk.params,
  { open: barOpen, high: candles.high[barIndex]!, low: candles.low[barIndex]!, close: barClose },
  walk.signals.contexts[barIndex]!,
  beforeStrategy,
)
```

Unchanged from the parity harness: the same `stepCascade` that reproduces the TradingView backtest, fed the same `BarContext` and the same broker-reported `PositionSnapshot` (`{ size, avgPrice, openProfit }`). The engine adds nothing to it and subtracts nothing from it. See `03-estrategia-cascade-dca.md`.

### Step 3 — The death watch gets the LAST word, and so does the pool

```ts
const inPosition = beforeStrategy.size > 0
const afterDeath = applyDeathVerdict(stepped.orders, deathWatch.stage, inPosition)
const orders = walk.tradeable ? afterDeath : afterDeath.filter((o) => o.kind !== 'entry')
const kept = new Set(orders)
const vetoed = stepped.orders.filter((o) => !kept.has(o))
```

`applyDeathVerdict` is `healthy → pass everything`, `frozen → drop entries`, `dead → replace everything with a single `closeAll` carrying `DEATH_EXIT_COMMENT` while in position, and emit nothing when flat`.

Then the second filter: **a pool too thin to size against stops entries but never exits.** Trapping money already inside an untradeable pool is worse than refusing to add to it. The test is *still lets a position LEAVE when the ladder cannot be sized at all*, run against a fixture pool of $900 liquidity and 60% slippage.

`vetoed` is computed by object identity, which has one consequence worth knowing: in the `dead` case `applyDeathVerdict` constructs a **new** `closeAll` object, so every order the strategy wanted appears in `vetoed` and the death exit itself appears only in `orders`. That reads correctly — the strategy's intentions were all overridden — but it is identity, not a diff.

### Step 4 — Write before sending

```ts
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
```

Orders are persisted as `pendingOrders` **before** any alert goes out and before anything is submitted. A process that dies at exactly this point is recoverable only because the intent was written down first — that is the entire premise of `planRecovery`. The test asserts `persisted[0].pendingOrders` equals `result.orders`.

Only then, the alerts:

| Order | Alert | Notes |
|---|---|---|
| `closeAll` with `comment === DEATH_EXIT_COMMENT` | *(skipped)* | Step 1 already alerted. Without this skip the human gets both `☠️ murió` and `🏁 cerrada` for one event. |
| other `closeAll` | `position-closed` — `🏁 ${symbol} cerrada` | Body is the order's own comment. |
| `entry` | `position-opened` or `dca-filled`, labelled by `entryAlertLabel` | Body is `$${usd} at ${close}`; `data.key` is the idempotency key the fill will carry. |

---

## 4. `refusesToSellAtALoss`

```ts
function refusesToSellAtALoss(order: Order, avgPrice: number | null, fillPrice: number): boolean {
  if (order.kind !== 'closeAll') return false
  if (order.comment === DEATH_EXIT_COMMENT) return false
  if (avgPrice === null) return false      // nothing held, so no basis and no loss to make
  return fillPrice < avgPrice
}
```

**"Never exit at a loss" is a premise of the whole strategy, not a preference.** The ladder's argument is that a drop is an opportunity to average down; selling into one destroys the edge the system exists to harvest.

**The rule was enforced at DECISION time, where price is above average cost by construction — and it leaked at EXECUTION time, where the next bar's open can be anywhere.** Production sold BinanceTown at **-13.1%** under the comment `🏁 Exit`, because the gap between the deciding close and the filling open was **-14.8%**. On 15-minute small caps the execution gap is routinely *larger than the entire +2% profit target*, so a rule that only holds at the close does not hold at all. A real venue can look at the price before sending the order, so now it does.

**The death exit is the one exception, and it is not really an exception** — it answers a different question. A stop loss sells because the PRICE fell; a death exit sells because the ASSET stopped being an asset, and holding out for a better price on something unsellable is how you hold it forever.

**The comparison is against the AVERAGE cost of everything held, never against the last rung.** Six rungs down the average sits far below the first entry, so a sale under the opening price can be a healthy profit — and a guard reading the wrong fill behaves backwards exactly at depth and nowhere shallower. The fixture in `engine.test.ts` seeds rungs at 1, 0.95, 0.9, 0.85, 0.8, 0.75 (100 units each, basis exactly **0.875**):

| Fill price | Outcome | Why |
|---|---|---|
| 0.92 | **Sells**, six fills | Under the 1.00 entry, over the 0.875 average: the position is green at a price the first rung is deeply red at. That is what averaging down is for. |
| 0.80 | **Refused** | Above the 0.75 last rung, below the 0.875 basis. A guard comparing against the most recent fill would let this out at a loss on the position as a whole. |
| 0.42 with `☠️ Death Exit` | **Sells** | A dead asset is the exception. |

Shallower fixtures pin the same rule at the other end: entry at 1.00 with a gap-down open to 0.87 (the -13% production actually booked) records **no sells at all**; the same setup gapping to 1.05 sells once, at 1.05 minus the venue spread.

---

## 5. `entryAlertLabel` — the order is the fact, not the machine

```ts
export function entryAlertLabel(order: Order & { kind: 'entry' }): { opening: boolean; icon: string; name: string }
```

| Order | Label |
|---|---|
| `level 0`, comment `🟢 Entry` | `{ opening: true, icon: '🟢', name: 'Entry' }` |
| `level 0`, comment `🚀 Re-Entry` | `{ opening: true, icon: '🚀', name: 'Re-Entry' }` |
| `level 3`, id `DCA-3` | `{ opening: false, icon: '➕', name: 'DCA-3' }` |

The label used to be read from the cascade level, **before** `stepCascade` ran its own reset. The machine resets on `!inPosition && wasInTrade` *inside* the step, so on the bar where a sale settles and the trend door fires again the level still said "in trade" and a full re-opening went out as `➕ … Entry`. Live, that read as the DCA ladder finally firing while the DCA count was zero — which was the one thing the reader was watching for. The order cannot be wrong about this: both entry doors emit level 0 and carry their own comment; a rung emits its own level and is named for it.

---

## 6. A cycle is not a bar

The engine used to advance **one bar per call**. That is correct only while a cycle is faster than a bar, and in production it was not.

| Measurement | Value |
|---|---|
| Production cycle time | ~37 minutes |
| Bar size | 15 minutes |
| Bars the engine actually saw | **ten of every twenty-two** |
| What `confirmBars: 20` meant on paper | five hours |
| What it meant in practice | **eleven hours** — longer than these positions live |
| Result over the run | ten entries, six exits, **zero DCA fills** |

Every parameter counted in BARS silently changed meaning, so the rebound confirmation could never complete and the cascade never cascaded. **No parameter was wrong — the clock was.**

Walking every missed bar turns a slow scheduler back into a **latency** problem, which is what it always should have been, instead of a silent change to what the strategy computes. `MAX_CATCH_UP_BARS = 96` bounds it.

One subtlety the walk had to get right: advancing only the newest bar during a catch-up looks harmless and is not. An order decided at bar 294 would book bar 299's open — five bars away from the decision that caused it. The test *executes a pending order at the bar that FOLLOWS the decision, not at the newest* asserts `entry.time === candles.time[295]`. Because `advanceOneBar` returns the updated position and the loop feeds it back in, each bar of the walk carries its own `lastBarTime`, so orders decided at bar *i* fill at bar *i+1* with a key naming bar *i* — the same shape as the single-bar case.

---

## 7. The execution layer, and how it went missing

This is the most instructive bug in the repository, and it has two halves.

**Half one: the engine decided orders, wrote them as `pendingOrders`, alerted — and never sent them anywhere.** `recordFill` had no caller outside the stores that implement it, and `broker.execute` was reached only from `replay.ts`. Five positions ran in production showing `0 compra / 0 venta`, which is what a decision engine with no execution looks like from outside: busy and completely still. Step 0 of `advanceOneBar` **is** that missing execution layer.

**Half two: `PaperBroker` kept its position in memory, and the engine wakes as a one-shot process.** Every cycle started flat, so even *with* execution the strategy would never have seen what it opened fifteen minutes earlier. `PaperBroker.seed(fills)` rebuilds it — `brokerFor` in `src/runtime/main.ts` calls `broker.seed(await store.fillsFor(position.id))` on first construction. Forget that and every position re-opens from level zero forever.

A third instance of the same shape: **`sizeLadder` was written, tested and documented as the fix for oversized orders, then never called from `tickPosition`.** Production ran a $285 position emitting $1,000 nominal entries, silently rejected for funds, for hours.

The generalisation is the lesson, and it is worth stating as a rule: **a silent broker rejection is indistinguishable from a strategy with no signals** — and anything the offline experiment (`paper-run.ts`) does that the engine does not is a rehearsal of a fix, not a fix. The test *emits an entry the position can actually afford* reproduces the exact production configuration — $285 of capital, a strategy whose nominal level 0 is $1,000 — and asserts `entry.usd < 285`, one recorded fill, and `broker.rejections === []`.

---

## 8. `runCycle` — one pass of the whole system

```ts
export async function runCycle(
  deps: CycleDeps,
  config: CycleConfig,
  throttle: AlertThrottle,
  kind: CycleKind = 'full',
): Promise<CycleResult>
```

> recover → halt what cannot be trusted → tick what can → open new positions with what is left → checkpoint → heartbeat

**The order is the safety property.** Recovery runs first because an engine that scans and allocates before reconciling its own past is building on state it has not verified. New positions come last because capital that might belong to an unresolved position is not capital to spend.

`runCycle` **decides and returns**; submitting orders and moving money is the caller's job, because a function that both decides and acts cannot be tested without a chain.

### What a pass returns

`CycleDeps` and `CycleConfig` — the ports and the knobs — are composed by the runtime and documented where they are built (`12-runtime-despliegue.md` §2.3 and §2.4). What comes back is this:

```ts
export interface CycleResult {
  readonly kind: CycleKind
  readonly recovery: RecoveryPlan
  readonly ticks: readonly TickResult[]
  readonly opened: readonly PersistedPosition[]
  readonly haltedIds: readonly string[]
  /** Slots reclaimed from positions that reserved them and never traded. */
  readonly releasedIds: readonly string[]
  readonly killSwitchEngaged: boolean
  readonly at: number
}
```

| Field | What it holds | Where it was decided |
|---|---|---|
| `kind` | the pass's own kind, echoed back so the caller never has to remember what it asked for | the `kind` argument — §9 |
| `recovery` | the whole `RecoveryPlan`: `positions`, `halted`, `blacklisted`, `resumedFromBar`, `killSwitchEngaged` | §8.1 |
| `ticks` | one `TickResult` per position that was actually advanced | §8.3 |
| `opened` | the positions saved this pass, **already persisted** — this is a report, not a request | §8.12 |
| `haltedIds` | `recovery.halted.map((h) => h.position.id)` — the ids, flattened, for a caller that only needs to name them | §8.1 |
| `releasedIds` | slots handed back by `releasableSlots`; **always empty on a watch pass** | §8.6 |
| `killSwitchEngaged` | `recovery.killSwitchEngaged`, the same value written into the checkpoint | §8.2 |
| `at` | `deps.now()`, read **once** at the top of the cycle | every timestamp this pass writes |

Two of those rows are easy to misread.

**`ticks.length` counts positions *ticked*, not positions *open*.** A position whose candles come back `null` is skipped with `continue` (§8.3) and contributes no entry, so a provider outage shows up as a pass that advanced fewer positions than the book holds — which is the honest reading, not a lost position.

**`at` is read once, not per step.** The alerts, the trimmed positions, the positions born this pass and the checkpoint all carry the same instant, so a cycle is one point in the record rather than a smear across however long it took. `elapsedMs` — how long it *actually* took — is the loop's to measure, not the cycle's.

**This record is what the operator reads.** `runLoop` passes it straight to `onPass` (`src/runtime/loop.ts`), and `main.ts` prints one line per pass out of it:

```ts
onPass: (result, elapsedMs) => {
  const bars = result.ticks.reduce((most, tick) => Math.max(most, tick.barsAdvanced), 0)
  console.log(`[${result.kind}]`, JSON.stringify({
    positions: result.ticks.length,
    bars,
    opened: result.opened.length,
    released: result.releasedIds.length,
    halted: result.haltedIds.length,
    seconds: Math.round(elapsedMs / 1000),
  }))
}
```

So `[full] {"positions":5,"bars":1,"opened":2,"released":1,"halted":0,"seconds":1834}` is `CycleResult` read field by field: `kind` is the prefix, the four counts are the lengths of `ticks`, `opened`, `releasedIds` and `haltedIds`, and only `bars` and `seconds` come from outside it — `bars` derived from the ticks' own `barsAdvanced` (§2.1), `seconds` from the loop's stopwatch. `recovery`, `killSwitchEngaged` and `at` are not logged; the first two reach the operator as alerts and the dashboard instead, and `at` is already in every row the pass wrote. `12-runtime-despliegue.md` §4.6 and §10.1 teach reading that line.

### 8.1 Step 1 — Reconcile the past

`planRecovery(store, probe)` returns `{ positions, halted, blacklisted, resumedFromBar, killSwitchEngaged }`. Every halted position raises a **critical, never-throttled** `position-halted` alert naming the unconfirmable order keys. A halted position is never ticked.

The orchestrator reads only `positions`, `halted`, `blacklisted`, `resumedFromBar` and `killSwitchEngaged`; it does **not** act on the individual `PendingResolution.action` values. In practice the two non-halt actions are implemented by the tick instead: `record-and-continue` by `store.hasFill(key)` skipping the order in step 0, and `resubmit` by step 0 executing it. See §13 for the one case where that mapping is incomplete.

### 8.2 Step 1b — The kill switch

```ts
if (recovery.killSwitchEngaged) { /* throttled 'kill-switch' alert */ }
```

It gates the whole *open new positions* block (§8.4 onward) and nothing else. **Open positions are still ticked and their death watches still run**, because a stopped engine that leaves a dying token unattended has stopped the wrong thing. Releasing it is a separate, explicit act — see `05-riesgo.md`.

Note that `kill-switch` is a `critical` alert kind, so the `throttle.shouldSend` call around it always returns true; the throttle is a no-op there.

### 8.3 Step 2 — Advance what can be trusted

For each resumable position: `candlesFor` → `healthFor` → `brokerFor` → `tickPosition`. A position whose candles come back `null` is **skipped without stopping the cycle** (`if (!candles) continue`) — one failing provider must not cost every other position its tick.

### 8.4 Step 3 — Where the candidates come from

```ts
const found = kind === 'full' ? await deps.scan() : ((await deps.recall?.())?.candidates ?? [])
const candidates = found.filter((c) => !recovery.blacklisted.has(`${c.snapshot.chain}:${c.snapshot.address}`))
```

An empty candidate list raises a throttled `scan-empty` alert. (Its Spanish body says the *scanner* returned nothing, which on a watch pass is imprecise — the shelf did.)

### 8.5 Step 3a — One ledger map, read once

```ts
const ledgers = new Map<string, PositionLedger>()
for (const recovered of recovery.positions) {
  ledgers.set(recovered.position.id, positionLedger(await deps.store.fillsFor(recovered.position.id)))
}
```

Three decisions below need the same answer — *what does this position hold, and what has it made* — and **any two of them disagreeing is how a book starts double-spending**. One walk over the fills, shared by slot release (`qty`, `hasFills`), the capital trim (`deployedUsd`) and nothing else. The common fund is a separate walk over `allFills()`, because it must include positions that have closed and left.

### 8.6 Step 3b — Slots that are not earning them

```ts
const release = kind !== 'full' ? [] : releasableSlots(holders, waiting.map((c) => c.opportunity.score), at, config.idleSlots ?? DEFAULT_IDLE_SLOT_POLICY)
```

The rule itself is pure and lives in `src/domain/risk/idle-slots.ts` (documented in `05-riesgo.md`). What the orchestrator contributes:

- **`openQty` and `hasFills` come from the FILLS**, never from `cascade.level`. A machine can sit at level 1 believing it holds something the broker refused — precisely the desync case — and reading the level would misread a reservation as a commitment, so the slot would never be reclaimed.
- **`score` comes from today's candidate list**, or `null` when the token is not in it at all. `null` covers two different things (it stopped clearing the gates, or it ranked below the watch-slot cut) and the alert text deliberately does not claim which.
- **Releasing never blacklists.** The token did not fail a safety gate; it merely stopped being the best use of a slot, and it is welcome back. `store.closePosition(holder.id)` plus a `token-retired` alert (`🔄 ${symbol} cede su ranura`). `token-retired` is a `critical` kind precisely so it is never throttled — it is the one event class the system did not decide entirely on its own terms.
- **Only on a full pass.** Taking a slot off one token and giving it to another is a judgement about which is better RIGHT NOW, and it deserves data gathered right now. Filling a slot that is already *empty* does not, which is why a watch pass may open positions but never swaps one.
- **A released token cannot win its slot straight back**: `justReleased` excludes it from `eligible` for this cycle. Re-opening it in the same breath is a round trip through the database, not a reallocation. The test uses a freshly evicted token scoring 99 at the top of the ranking.

### 8.7 Step 3c — Capital trim

```ts
const ladderNeeds = ladderCapitalUsd(config.params, config.maxOpenEntries ?? PYRAMIDING, config.gasUsdPerSwap ?? 0.05)
...
const deployed = ledgers.get(id)?.deployedUsd ?? 0
const needs = Math.max(ladderNeeds, deployed)
if (position.capitalUsd <= needs + 0.01) { keep as is }
else { save { ...position, capitalUsd: needs } }
```

A slot used to keep whatever the portfolio handed it at birth, and that was far more than its ladder can ever spend. Measured: **five positions holding $285 each while a flat six-rung $15 ladder can only ever deploy about $95** — nine hundred and fifty dollars counted as committed, which the engine could neither spend nor open anything with.

The arithmetic, for production's ladder (`maxUsdPerLevel = 15`, six open entries, $0.05 gas):

```
nominal  = 6 rungs × $15                    = $90
headroom = $90 / (1 − 5/100)                = $94.74
gas      = (6 entries + 1 exit) × $0.05     = $0.35
ladderCapitalUsd                            ≈ $95.09
```

The test asserts a $285 position lands at **≈ $95.1**.

Two bounds, both load-bearing:

- **Never below what is already deployed.** That money is *in* the token; pretending otherwise would let the same dollars be handed out twice. The test seeds a $400 basis against a $900 allocation and asserts the position keeps exactly $400.
- **It only ever goes DOWN.** Raising a small allocation would be re-risking money the allocator never agreed to put there. A $40 position stays at $40 — a ladder that cannot fill its deeper rungs simply does not fill them.

### 8.8 Step 3d — Committed, the common fund, and what is free

```ts
const committed = kept.reduce((s, p) => s + p.capitalUsd, 0)
               + recovery.halted.reduce((s, r) => s + r.position.capitalUsd, 0)
const fund = commonFund(await deps.store.allFills())
const free = Math.max(0, config.portfolio.totalCapitalUsd + fund.netUsd - committed)
```

**A halted position keeps BOTH its capital and its slot.** Treating either as free is how an engine quietly doubles its own exposure after a bad restart. The test rig makes this concrete: $2,000 total with $1,990 committed to a halted position leaves $10 — under the gas floor for a single rung, so nothing new opens.

**The common fund is capital.** What the system has made was being ignored, so the book was sized against a fixed environment number forever and a profitable engine never got any bigger. `netUsd` is realised **minus costs**, because that cash was paid in real terms at the moment of each fill.

### 8.9 Step 3e — `maxPositions: 0` means no ceiling, everywhere

```ts
const uncapped = config.portfolio.maxPositions <= 0
const slotsLeft = uncapped ? Number.POSITIVE_INFINITY
                           : config.portfolio.maxPositions - keeping.length - recovery.halted.length
```

and on the way back into the allocator, `maxPositions: uncapped ? 0 : slotsLeft`.

`planPortfolio` had already given `0` the meaning "the capital decides". The orchestrator went on computing `maxPositions - open`, which with five positions open is **minus five** — and the guard is `slotsLeft > 0`, so **the book froze at five while $950 of freed capital and thirty-eight candidates sat waiting**. With an empty book it gives zero, which fails the same guard, so nothing would ever have opened at all.

> A sentinel that means one thing in one file and another next door is not a sentinel, it is a trap.

Tests: *keeps opening past the number already held*, *fills the book to what the capital carries, not to what is already in it* (≥ 13 positions from $1,500 against a $95 ladder), and *still stops at an explicit ceiling*.

### 8.10 Step 3f — The allocation call

```ts
if (slotsLeft > 0 && free > 0) {
  const plan = planPortfolio(eligible.map(...), config.params, {
    ...config.portfolio,
    totalCapitalUsd: free,
    maxPositions: uncapped ? 0 : slotsLeft,
    targetPositionUsd: ladderNeeds,
    minPositionUsd: slotFloorUsd(config.params, config.maxOpenEntries ?? PYRAMIDING, config.gasUsdPerSwap ?? 0.05, (config.sizing ?? DEFAULT_SIZING_POLICY).minFillUsd),
  })
```

Three of those overrides are decisions in their own right.

**`targetPositionUsd: ladderNeeds`** — what a full ladder needs and not a dollar more. This makes the **width** of the book the division, rather than the size of each slot. It is finding 2 of the capital-floor experiment arriving in code: above a pool's capacity extra capital does nothing, so scale comes from more tokens, not more size per token (`06-economia.md`). Without it, the split is *deployable ÷ slots*, which hands each slot an even share of everything and sends most of it straight back as idle capital.

**`minPositionUsd: slotFloorUsd(...)`** — the floor is **derived every cycle**, never remembered. `minPositionUsd: 200` was a real measurement (the first capital-floor run placed no orders below it), taken BEFORE sizing began reserving gas and 5% of price headroom. That change dropped the real floor to under $50 and the number never moved, so it kept capping the book at four slots however much capital was free. The derived floor is the same ladder priced at the gas floor — every rung at `minFillUsd`, grossed up for headroom, plus gas for a full cycle:

```
slotFloorUsd = ladderCapitalUsd({ ...params, maxUsdPerLevel: minFillUsd, baseUsd: minFillUsd, amountIncrement: 0 }, ...)
```

With production's six rungs and `minFillUsd = gasFloorUsd(0.05, 1) = $5`, that is `6 × $5 / 0.95 + 7 × $0.05 ≈ $31.93` — against the stale $200. A slot below the nominal ladder does not fail; `scaledParams` shrinks it and it trades smaller rungs. What it cannot do is trade rungs the chain's fixed cost would eat.

**`plan.floorOverrodeCap`** raises a `provider-degraded` alert naming the concentration percentage. Letting the floor beat the concentration cap is deliberate: a position below the floor is a *guaranteed* zero, while concentration is a *probabilistic* loss, and refusing to trade in order to stay diversified is diversifying into nothing.

### 8.11 Step 3g — The sell path, re-confirmed at the moment capital moves

```ts
if (deps.confirmSellable && !(await deps.confirmSellable(allocation.snapshot))) { /* refuse, alert, continue */ }
```

The scanner's security verdict can be a couple of hours old **by design** — reports are cached so the examination budget can rotate and reach the whole universe instead of re-checking the same twenty tokens forever. That trade is right for ranking and wrong at the moment capital is committed, because the honeypot answer is the one that ages worst and the one everything else rests on.

It is an **addition, not a gate that fails closed on its own absence**: with no port wired, positions open on the scanner's verdict as before (test: *opens when no confirmation port is wired*). When the port *is* wired, `unknown` is not a yes — `main.ts` returns `assessment.sellQuote === 'ok'` and `false` on any thrown error. The refusal alert is throttled per token (`unsellable:${address}`).

### 8.12 Step 3h — A position is born

```ts
const position: PersistedPosition = {
  id: `${chain}:${address}:${at}`,
  cascade: initialState(),
  deathWatch: startDeathWatch(allocation.quality.liquidityUsd, at),
  quality: allocation.quality,
  capitalUsd: allocation.capitalUsd,
  lastBarTime: -1,
  lastPriceUsd: allocation.snapshot.priceUsd > 0 ? allocation.snapshot.priceUsd : null,
  pendingOrders: [],
  openedAt: at, updatedAt: at,
}
```

- The **liquidity at entry** is the baseline every future collapse is measured against, so the death watch is born with the position.
- **`lastBarTime: -1`** means "no history of its own" — §2.3.
- **`lastPriceUsd` is the price the scanner just measured, or `null`.** Never a stand-in. The death watch sizes its sell probe from this number; a placeholder of `1` asked *"if I sell 285 units do I get $285 back?"* of a token trading at less than a cent, got a fraction of that, called it implausible, and **froze every new position on its first observation**. Skipping an observation it cannot size is honest; inventing one is not.

### 8.13 Step 4 — Checkpoint, then say you are alive

```ts
const lastCompletedBar = ticks.reduce((latest, t) => Math.max(latest, t.position.lastBarTime), recovery.resumedFromBar ?? 0)
await deps.store.saveCheckpoint({ savedAt: at, lastCompletedBar, killSwitchEngaged: recovery.killSwitchEngaged })
```

Then a throttled `heartbeat` naming the counts: `${n} en curso · ${n} detenidas · ${n} abiertas` on a full pass, `… · vigilancia` on a watch pass. The heartbeat test asserts the **counts**, not the wording: a heartbeat that stops saying how many positions ran is broken; one that says it in another language is not.

---

## 9. Watch and full: two cadences for two costs

```ts
export type CycleKind = 'full' | 'watch'
```

**`watch` is a strict PREFIX of `full`.** It still recovers, still halts, still ticks, still checkpoints, still heartbeats. It skips exactly two things: running a scan (it reads the shelf instead), and reallocating slots between tokens.

| | `full` | `watch` |
|---|---|---|
| `planRecovery` | yes | yes |
| halt alerts | yes | yes |
| tick every position | yes | yes |
| candidate source | `deps.scan()` — hundreds of throttled calls, ~30 minutes | `deps.recall()` — the shelf, no network, milliseconds |
| `releasableSlots` | yes | **never** (`kind !== 'full' ? [] : …`) |
| capital trim, common fund, allocation | yes | yes |
| checkpoint + heartbeat | yes | yes |

**The asymmetry is the whole argument: a token you HOLD can rug in ten minutes; an opportunity missed by an hour is only a missed opportunity.** Fused into one cycle, the cheap half ran at the pace of the expensive one and a held token got attention once every ~35 minutes on 15-minute bars.

The choice is made in `src/runtime/loop.ts`:

```ts
const kind: CycleKind =
  options.scanIntervalMs === undefined || lastScanAt === null || deps.now() - lastScanAt >= options.scanIntervalMs
    ? 'full' : 'watch'
```

and three properties of that loop matter here:

1. **`lastScanAt` is seeded from the shelf at boot** — `(await deps.recall?.())?.scannedAt ?? null`. The first pass always scanned, so every restart spent half an hour of throttled discovery before it could put anything in a free slot, with a scan minutes old sitting in the database. **Three relaunches in twenty-three minutes never once reached the allocation step**, which from outside is indistinguishable from a book that refuses to grow. A shelf fresh enough to ALLOCATE from is fresh enough to START from; when `recall` returns nothing, this stays `null` and the first pass scans, which is the right answer then.
2. **`lastScanAt` is stamped AFTER the pass**, so a scan that took half an hour does not immediately owe another one.
3. **Every pass is logged** through `onPass`, not just the ones that scan. A watch pass prints nothing of its own, and four minutes of empty log looked exactly like a hung process when it was a working engine advancing bars.

Failure handling: a thrown cycle increments `consecutiveFailures`, raises a throttled `provider-degraded` alert, and sleeps `min(30s × 2^(n-1), 10 min)` before retrying. A recovery after failures sends an explicit `✅ Recuperado`, because an error with no resolution is an error the human keeps carrying. `shutdownSignal` resolves on the first SIGINT/SIGTERM and lets the current cycle finish; a second signal exits immediately.

### Cadences in production

| Setting | Env | Default |
|---|---|---|
| Time between passes | `OPERADOR_CYCLE_MS` | 5 minutes |
| Time between scans | `OPERADOR_SCAN_MS` | 1 hour |
| Cycles before exiting | `OPERADOR_MAX_CYCLES` | 0 = run forever; the workflow sets **120** against a 350-minute job timeout, so the timeout is what ends a run |
| Shelf window for recall | derived in `main.ts` | `2 × scanIntervalMs` — one missed scan is a delay, two is a shelf nobody should be spending from |
| Idle-slot window | `OPERADOR_IDLE_HOURS` | 3 hours |
| Score edge to swap a slot | `OPERADOR_MIN_SCORE_EDGE` | 10 |
| Ladder cap per rung | `OPERADOR_MAX_USD_PER_LEVEL` | 15 |
| DCA rungs per token | `OPERADOR_MAX_DCA` | 5 (→ `maxOpenEntries` 6) |

---

## 10. `recall.ts` — the last scan, re-ranked off the shelf

```ts
export async function recallCandidates(store: StatePort, options: RecallOptions): Promise<RecalledScan | null>
```

Opening a position was fused to *running* a scan, so a free slot waited out half an hour of throttled discovery before anything could go in it — with candidates already examined, already stored, already good. **The fusion was never necessary: the expensive half of a scan is fetching, not deciding.** Gates, scoring and ranking are pure domain functions, so the snapshots the last scan wrote down reproduce its verdict offline, in milliseconds, with no network.

The sequence:

1. `store.latestScansByChain()` — null when there has never been a scan.
2. `scannedAt = Math.min(...scans.map(s => s.scannedAt))` — **the OLDEST chain's time**, because a universe is only as fresh as its stalest half.
3. `if (now() - scannedAt > maxAgeMs) return null` — **a stale shelf is refused outright**, not served as something old.
4. Flatten every chain's snapshots; read `store.cachedSecurity(chain, address)?.slippagePct` into a map (once, because `rankUniverse` is synchronous and the cache is not).
5. `rankUniverse(snapshots, new Map(), qualityFn, options.ranking)`.

Three properties worth stating:

- **It re-runs every GATE.** The shelf stores *snapshots*, not a pass list, so a token that has since become too thin is still rejected offline. Test: *still applies every gate — the shelf is snapshots, not a pass list*.
- **It sizes against MEASURED impact first**, falling back to `estimatePriceImpactPct(referenceUsd, liquidityUsd)` only for tokens nothing ever quoted, and to a flat `100` when liquidity is zero — the same order the live scan uses, because sizing a ladder against reported liquidity is the one thing the executor refuses to do. Test fixture: HEV reported $186k of liquidity and quoted **5.2% impact on $100**, i.e. $3.8k of real depth; recall replays the 5.2%.
- **It passes an EMPTY previous-scan map**, so volume expansion and liquidity growth score on their neutral values. Understating a token's momentum is the safe direction to be wrong in when spending from a shelf.

---

## 11. `ledger.ts` — one walk, because three things need the answer

```ts
export function positionLedger(fills: readonly PersistedFill[]): PositionLedger
export function commonFund(fills: readonly PersistedFill[]): CommonFund
```

| Field | Meaning |
|---|---|
| `qty` | Units still held. Zero means flat — it may still have traded. |
| `deployedUsd` | Cost basis of what is **still held**, not of everything ever bought. |
| `avgCostUsd` | `deployedUsd / qty`, or `null` when flat. |
| `realisedUsd` | Profit already banked by sales, at the basis those sales left behind. |
| `costsUsd` | Spread, impact and gas charged on every fill so far. |
| `hasFills` | Whether anything was ever bought. Different from `qty > 0`. |

**It is a WALK, not a set of sums, and that is the whole correctness argument.** Totalling every buy ever made counts entries that were already sold, so a position that closed once and re-entered would report twice the capital it holds — and dividing that blend by every unit ever bought produces a cost basis the position never paid, which then feeds the unrealised number on the screen. A sale realises against the basis *at that moment* and leaves the basis unchanged for what remains, which is precisely why realised and deployed can be separated at all.

Average-cost accounting, matching what the broker itself reports, so the screen and the strategy can never disagree about what a position cost.

Two defensive details:

```ts
const sold = Math.min(fill.qty, qty)          // a bad fill cannot invent profit from a negative position
if (qty <= 0) return { qty: 0, deployedUsd: 0, avgCostUsd: null, realisedUsd, costsUsd, hasFills: true }
```

The second is not cosmetic: floating point leaves a basis of ~1e-17 on zero units after a full exit, and that is noise, not a cost.

**`commonFund` groups by `positionId` first, then calls `positionLedger` per group.** Realised profit is defined against a cost basis, and a basis only means anything within one position's own history — pooling every fill computes a basis neither position ever paid. The test that catches this uses a $1 buy in one position and a $100 buy in another.

**Costs are subtracted** (`netUsd = realisedUsd - costsUsd`), because that cash was paid in real terms at the moment of each fill. A fund built on gross profit hands the allocator dollars the chain already took — on small caps, the single largest way a strategy that looks profitable is not. The test compares $300 realised with $0 of costs against $300 realised with $320 of costs and asserts the second opens **fewer** positions.

The fund is built from **every fill ever recorded, including positions that have closed and left** — which is most of it. This is why `fills` deliberately has no foreign key to `positions`.

### The single implementation

| Consumer | What it reads |
|---|---|
| `src/application/orchestrator.ts:206` | `positionLedger` per open position → slot release and capital trim |
| `src/application/orchestrator.ts:299` | `commonFund(allFills)` → free capital |
| `src/application/operations-view.ts:147` | `positionLedger` → `qty`, `deployedUsd`, `avgCostUsd`, `realisedUsd` on the screen |
| `src/application/operations-view.ts:210` | `commonFund(allFills)` → the totals row |

Two implementations of "how much are we up" will eventually disagree, and the one on the screen is the one you will believe. That rule from `CLAUDE.md` applies harder here than anywhere else in the codebase.

---

## 12. `production-ladder.ts` — the two numbers that differ from the reference

```ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15
export const DEFAULT_MAX_DCA_PER_TOKEN = 5
export function productionLadder(env): { maxUsdPerLevel: number; maxOpenEntries: number }
```

| Number | Production | Reference (evidence) |
|---|---|---|
| USD cap per rung | `OPERADOR_MAX_USD_PER_LEVEL`, default **15** | `DEFAULT_PARAMS.maxUsdPerLevel = 5000` |
| Open entries at the venue | `OPERADOR_MAX_DCA + 1`, default **6** | `PYRAMIDING = 10` |

Three rules, each with a bug behind it.

**1. Neither number may be expressed by editing `DEFAULT_PARAMS` or `PYRAMIDING`.** Those are what TradingView ran and the parity harness asserts them: they are **evidence**, and evidence that can be edited to express a preference stops being evidence. Production composes `{ ...DEFAULT_PARAMS, maxUsdPerLevel }` on top. The test asserts the inequality directly — `DEFAULT_MAX_USD_PER_LEVEL !== DEFAULT_PARAMS.maxUsdPerLevel` and `DEFAULT_MAX_DCA_PER_TOKEN + 1 !== PYRAMIDING`.

**2. The entry is not a DCA rung**, so five DCAs means six open entries and `productionLadder` adds 1. Off by one here either reserves capital for a rung that is never coming, or refuses one that is.

**3. It has no dependencies at all** — no database, no clock, no network — so the Next.js dashboard can import it without dragging the runtime into its build. It exists as its own module because the dashboard once imported `DEFAULT_PARAMS` directly and **drew a $1,000 rung beside a $15 order for days**: a screen disagreeing with the engine about the size of a trade, which is the exact failure `buildDashboard` exists to prevent. Both `dashboard/app/page.tsx` and `dashboard/app/api/view/route.ts` call `productionLadder(process.env)`.

A non-positive or non-finite env value is silently ignored in favour of the default, rather than trading on `NaN`.

Why five rungs: with `linInc = 3`, **DCA-5 already needs a 13% fall and DCA-10 needs 28%**. A token down 28% is rarely an opportunity, and the capital those deep rungs reserve buys more by going to another token — finding 2 of the capital floor arriving by a different road. Why $15: `min(1000 × (1 + 1.2n), 15)` is $15 at **every** level, i.e. a flat ladder of $90 over six fills, where gas at $0.05 is 0.33% of each fill.

---

## 13. Known gaps and things this layer does not do

Stated plainly, because a document that only describes what works is a document you cannot trust about what does not.

1. **`CycleConfig.heartbeatMs` is declared and never read.** `main.ts` sets it to one hour; `runCycle` emits the heartbeat through `throttle.shouldSend(beat)`, so the real cadence is the `AlertThrottle` window — 30 minutes in `main.ts`. The field is dead today.
2. **Nothing submits `TickResult.orders`.** In the current runtime, orders reach the broker exclusively through the `pendingOrders` path in step 0 of the *next* tick. `runCycle`'s contract ("submitting orders is the caller's job") describes a caller that does not yet exist; the paper path does not need one, and a live path will have to either submit here or keep using step 0.
3. **A recovery verdict of `'filled'` from the probe records no fill.** `planRecovery` maps it to `record-and-continue`, but nothing writes the fill, so `store.hasFill(key)` is still false when step 0 runs and the order would be executed again. This is unreachable today — `main.ts` returns `'not-filled'` in paper and `'unknown'` in live, and live mode refuses to start — but it is a real hole that a wallet adapter must close before it can answer `'filled'`.
4. **A position whose candle provider fails is silently skipped.** `if (!candles) continue` is right for containment, but the tick count alone cannot distinguish "no candles" from "nothing to do", so a persistently failing provider looks like a quiet, healthy engine.
5. **The `PaperBroker` map in `buildRuntime` is never pruned.** Brokers are cached by position id and released positions' brokers stay in it. Correctness is unaffected (ids are unique per opening), but a long-lived process grows slowly.
6. **The `scan-empty` alert text names the scanner** even when the empty list came from the shelf on a watch pass.

---

## 14. Summary of the invariants

| # | Invariant | Enforced in |
|---|---|---|
| 1 | An order decided at bar *n*'s close fills at bar *n+1*'s open | `advanceOneBar` step 0 |
| 2 | The idempotency key names the bar the order was DECIDED on | step 0, matching `planRecovery` |
| 3 | One `closeAll` → one fill per rung, each keyed apart | step 0, `#index` suffix |
| 4 | `lastBarTime` makes deciding twice impossible | `firstUnprocessedBar` |
| 5 | Never exit at a loss — enforced at execution, not only at decision | `refusesToSellAtALoss` |
| 6 | The death exit is exempt from rule 5 | `comment === DEATH_EXIT_COMMENT` |
| 7 | The comparison is against the average basis, never the last rung | `broker.snapshot(barOpen).avgPrice` |
| 8 | Nothing is rolled back when an exit is refused | `stepCascade` resets on the broker, not the signal |
| 9 | The broker is the truth about what is held | step 1a desync guard |
| 10 | The death watch speaks first and gets the last word | steps 1 and 3 |
| 11 | One health observation applies to at most one bar | `barIndex === last` |
| 12 | Orders are persisted before they are sent | step 4, before the alert loop |
| 13 | An untradeable pool stops entries, never exits | step 3 filter |
| 14 | Ladder and indicators are computed once per tick | `tickPosition` before the walk |
| 15 | recover → halt → tick → allocate → checkpoint | `runCycle` |
| 16 | A halted position keeps its capital and its slot | `committed`, `slotsLeft` |
| 17 | The kill switch stops new risk only | the `if (!recovery.killSwitchEngaged)` block |
| 18 | `watch` is a strict prefix of `full` | `runCycle(…, 'watch')` |
| 19 | A watch pass may fill an empty slot but never swaps one | `kind !== 'full' ? [] : releasableSlots(…)` |
| 20 | A position holding tokens never loses its slot | `openQty` from the fills |
| 21 | Releasing a slot never blacklists the token | `closePosition`, no `blacklist` call |
| 22 | Capital trim only goes down, never below what is deployed | `Math.max(ladderNeeds, deployed)` |
| 23 | The common fund is per position, net of costs | `commonFund` |
| 24 | `maxPositions: 0` means no ceiling everywhere it is read | `uncapped` |
| 25 | The slot floor is derived every cycle | `slotFloorUsd` |
| 26 | A stale shelf is refused, not served | `recallCandidates` |
| 27 | `DEFAULT_PARAMS` and `PYRAMIDING` are evidence and are never edited | `production-ladder.ts` |
| 28 | Risk alerts are never throttled | `AlertThrottle` passes every `critical` |
