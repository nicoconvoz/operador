# CASCADE DCA, the reference strategy

This chapter documents `src/domain/strategy/` — the pure, deterministic, network-free port of `DCA.pine` (CASCADE DCA v1.5, Pine Script v6, spot long, bar-close driven). It covers the state machine and every transition in the order the machine evaluates them, both entry doors, the DCA ladder's trigger and sizing arithmetic, the five anti-stacking rebound locks, the one-fill-per-bar rule, the two exits and their precedence, the 50-signalled/10-fillable split, every parameter with its default and what that default means counted in *bars* at the production 15-minute timeframe, and the bar-close semantics that make the whole thing reproducible: decide at the close, fill at the next bar's open. It also documents what the machine deliberately does **not** do — it does not enforce the venue cap, it does not know what actually filled, and it cannot see the execution gap that once sold a position at −13.1% under the comment `🏁 Exit`.

Indicator internals live in `02-indicadores.md`; sizing, the capital floor and what the paper broker charges in `06-economia.md`; the broker simulators and the replay loop in `14-pruebas.md`; the death exit in `05-riesgo.md`; the live tick in `08-motor.md`.

---

## 1. Where the code is

| File | What it is |
|---|---|
| `src/domain/strategy/cascade.ts` | `stepCascade` — one 145-line function, the whole machine. A transcription of `DCA.pine`'s per-bar logic in the script's exact evaluation order. |
| `src/domain/strategy/state.ts` | The durable contract: `CascadeState`, `Bar`, `BarContext`, `PositionSnapshot`, `EntryOrder`, `CloseAllOrder`, `StepResult`, `initialState()`, `FLAT`. |
| `src/domain/strategy/params.ts` | `CascadeParams` — a one-to-one mirror of the Pine `input.*` block. `DEFAULT_PARAMS`, `PYRAMIDING = 10`, `MAX_SUPPORTED_LEVELS = 50`, `assertParams`. |
| `src/domain/strategy/ladder.ts` | The ladder arithmetic as four pure functions: `dropPct`, `triggerPrice`, `usdForLevel`, `ladderCapital`. |
| `src/domain/strategy/signals.ts` | `computeSignals` — composes the golden-tested indicator layer into the per-bar `BarContext` the machine consumes. The only place the strategy's indicator formulas live. |
| `src/domain/strategy/cascade.test.ts` | 39 scenario tests, one per `DCA.pine` transition, each naming its Pine condition. |
| `src/domain/strategy/ladder.test.ts` | Pins the ladder arithmetic and the params guardrails to exact numbers. |
| `src/domain/strategy/signals.test.ts` | Golden parity for every composed boolean, recomputed from TradingView's own exported columns. |
| `src/application/production-ladder.ts` | Not in the subsystem, but load-bearing: the two numbers that make production differ from the reference, isolated so neither engine nor dashboard owns them. |

The reference specification itself is `DCA.pine` at the repository root. Every deviation from it is decided, never drifted into — the table of known deviations is in `CLAUDE.md` and each one is restated in context below.

---

## 2. The contract: four inputs, two outputs

```ts
export function stepCascade(
  state: CascadeState,
  params: CascadeParams,
  bar: Bar,
  ctx: BarContext,
  position: PositionSnapshot,
): StepResult
```

It returns `{ state, orders }` — a new state and the orders to submit. It never reads a series, never touches a broker, never calls a clock or the network.

The two inputs worth dwelling on are `ctx` and `position`, because the Pine reference conflates them and the port deliberately does not.

**`BarContext` — indicator-derived facts.** Computed once over the whole series by `computeSignals`, handed in per bar:

| Field | Pine | Meaning |
|---|---|---|
| `isLateral` | `is_lateral` | BBW/ADX consolidation filter |
| `swingHigh` | `ta.highest(high, swing_lb)` | `null` during warmup |
| `trendBullish` | `trend_bullish` | the composite trend re-entry gate |
| `stBearFlip` | `ta.crossover(st_dir, 0)` | Supertrend just turned bearish |
| `vwm`, `vwmPrev`, `vwmLagged` | `vwm`, `vwm[1]`, `vwm[decay_req]` | the decay counter and the impulse check |

Because they are computed outside, "the machine itself never touches a series and stays trivially testable" (`state.ts`).

**`PositionSnapshot` — what the *broker* reports.** `strategy.position_size`, `strategy.position_avg_price`, `strategy.openprofit`:

```ts
export interface PositionSnapshot {
  readonly size: number          // units held, 0 when flat
  readonly avgPrice: number | null // average fill price, null when flat
  readonly openProfit: number    // unrealised P&L in quote currency
}
export const FLAT: PositionSnapshot = { size: 0, avgPrice: null, openProfit: 0 }
```

These come from **fills**, not from the machine's own bookkeeping, and the two legitimately disagree. `state.ts` states why:

> Pine sets `ep1 := close` on the signal bar while the fill lands at the next bar's open. Exit and rescue logic read the broker's numbers, exactly as the reference does.

Using `s.ep1` or `s.totalInvested` in the exit logic instead would drift from parity by exactly one bar's close-to-open gap on every rung. This is an invariant, not a style preference: **exits read the broker, never the machine.**

`avgPrice` is `null` when flat rather than `0`, so a "loss" cannot be manufactured out of a position that does not exist — `refusesToSellAtALoss` in `engine.ts` returns `false` on `null` for exactly that reason.

### Output

```ts
export type EntryOrder = {
  readonly kind: 'entry'
  readonly id: string       // 'Entry' for level 0 (both doors), 'DCA-n' for level n
  readonly level: number
  readonly usd: number
  readonly qty: number      // usd / close — Pine sizes in units at the signal close
  readonly comment: string
}
export type CloseAllOrder = {
  readonly kind: 'closeAll'
  readonly comment: '🏁 Exit' | '⚖️ BE Exit' | '☠️ Death Exit'
}
```

`qty` is computed at the **signal close** even though the fill lands at the next open. That is what Pine does, and the resulting notional mismatch is the broker's problem, not the machine's — `TradingViewSim` reproduces it including truncation to the contract step, and `PaperBroker` prices `notional = order.qty × open`, ignoring `order.usd` entirely. See `14-pruebas.md` and `06-economia.md`.

`☠️ Death Exit` appears in the union but is never emitted here. It is produced by `applyDeathVerdict` in `src/domain/risk/death-exit.ts`, which filters and replaces what the strategy wanted — see `05-riesgo.md`.

---

## 3. Bar-close semantics, and decide-at-close / fill-at-next-open

`DCA.pine` does not set `process_orders_on_close`. Consequently **every order fills at the next bar's open**, at open ± one tick of slippage, with 0.1% commission. The `strategy()` header is explicit:

```pine
strategy(
     title             = "CASCADE DCA 🌊 — Spot Long 1.5",
     pyramiding        = 10,
     initial_capital   = 10000,
     commission_type   = strategy.commission.percent,
     commission_value  = 0.1,
     slippage          = 1
     )
```

`replay()` in `src/application/replay.ts` makes that model explicit as a three-step bar loop, and the comment names the point that matters — nothing in the loop is specific to backtesting:

```
for each bar i:
  1. the broker executes the orders emitted at bar i-1, at bar i's OPEN
  2. the strategy sees the resulting position, marked at bar i's CLOSE
  3. the strategy evaluates bar i and emits orders for bar i+1
```

The live engine runs the same three steps across **process boundaries**: it decides at a close, persists the orders as `pendingOrders`, and the *next* tick executes them at that bar's open. That is what makes a crash between decision and submission survivable — and it is why the fill is keyed by the bar the order was **decided** on, not the one it filled at, because that is how recovery looks it up (`engine.ts`, step 0).

Three consequences:

1. **Signals only ever evaluate closed bars.** No intrabar execution, anywhere. This is core constraint 7 in `CLAUDE.md`.
2. **A cycle is not a bar.** The engine walks every bar it missed (`tickPosition`), bounded at `MAX_CATCH_UP_BARS = 96` — a day at 15 minutes. Past that "the engine was not late, it was DOWN". The bug that forced this is in §11.
3. **The machine cannot see the execution gap.** It compares against the signal-bar close; the fill happens at the next open, which can be anywhere. §9.4 covers what that cost.

---

## 4. The state

`CascadeState` is the `var` block of `DCA.pine`, name for name. Everything is serialisable on purpose: "an unattended engine WILL crash, and a position must be reconstructable from persisted state alone. No class instances, no closures, no hidden fields." It is persisted to Postgres as JSONB on `PersistedPosition.cascade` (see `09-persistencia.md`).

| Field | Pine | Meaning | Reset by the cycle reset? |
|---|---|---|---|
| `level` | `level` | 0 = flat; 1..`maxLevels` = open, next DCA to arm is `level`; `maxLevels + 1` = ladder exhausted | ✅ → 0 |
| `ep1` | `ep1` | anchor entry price — every DCA trigger is measured from here | ✅ → `null` |
| `totalInvested` | `total_inv` | **nominal** USD committed this cycle (`usd(n)` sums, not fills) | ✅ → 0 |
| `wasInTrade` | `was_in_trade` | detects a real position close, so the reset happens exactly once | ✅ → `false` |
| `cycleLow` | `cycle_low` | lowest low since the last fill — the bottom the rebound is measured from | ✅ → `null` |
| `lastFill` | `last_fill` | signal **close** of the last fill (Pine uses close, not the fill price) | ✅ → `null` |
| `dcaArmed` | `dca_armed` | the pending level touched its trigger and waits for the rebound | ✅ → `false` |
| `breakevenArmed` | `be_armed` | rescue mode has armed the breakeven exit | ✅ → `false` |
| `barsSinceLow` | `bars_since_low` | bars elapsed without a new cycle low | ✅ → 0 |
| `awaitReentry` | `await_reentry` | a sell just happened: the trend door is open, once | ⬆️ set to `true` |
| `decayCount` | `decay_count` | consecutive bars of falling VWM | ❌ **survives** |

`initialState()` returns all of it flat: level 0, every price `null`, every flag `false`, every counter 0.

`decayCount` surviving is not an oversight. In `DCA.pine` the line `decay_count := vwm < vwm[1] ? decay_count + 1 : 0` sits **above** the machine, with the indicators; it is global and has no notion of a cycle. The port computes it at the very top of the step, before the reset block, and the reset block deliberately clears ten fields and leaves that one. The test pins the exact value: a dirty state with `decayCount: 3` stepped through a reset on a falling-VWM bar must equal `{ ...initialState(), awaitReentry: true, decayCount: 4 }`.

---

## 5. Evaluation order is the semantics

The file header says it plainly, and it is the single most important thing about this module:

> In a state machine the order is the semantics: the cycle-low tracking runs before arming, arming before the locks, entries before the post-fill reset, and every entry before the exits. Reordering any of these changes which bar a fill lands on, and parity dies quietly.

The concrete order in `cascade.ts`:

| # | Block | Lines | What it does |
|---|---|---|---|
| 1 | VWM decay counter | 35–43 | `decayCount`, `impulseDead` |
| 2 | `wasInTrade` / cycle reset | 45–58 | reacts to the **broker** going flat |
| 3 | Cycle-low tracking | 60–65 | `cycleLow`, `barsSinceLow` |
| 4 | Locks 1 + 2 → arming | 67–76 | `triggerOk`, `gapOk`, sets `dcaArmed` |
| 5 | Locks 3 + 4 + 5 → `reboundFire` | 78–83 | `holdOk`, `reboundOk`, `greenOk` |
| 6 | Door 1 — classic entry | 102–112 | `openPosition('🟢 Entry')` |
| 7 | Door 2 — trend re-entry | 114–124 | `openPosition('🚀 Re-Entry')` |
| 8 | The DCA fill | 126–142 | one rung, at most |
| 9 | Post-fill reset | 144–150 | a new bottom is now required |
| 10 | Exits | 152–166 | normal, then rescue breakeven |

Two ordering traps follow directly from this table and are documented in §11: the arming block (4) runs **before** the doors (6, 7), so `currentTrigger` uses pre-entry state; and the cycle reset (2) happens *inside* the step, so reading `level` before calling `stepCascade` reads a stale value.

---

## 6. The transitions

```
level 0 ──(Door 1: classic entry)────────> level 1
level 0 ──(Door 2: trend re-entry)───────> level 1
level n ──(DCA-n fires, 1 ≤ n ≤ maxLevels)> level n+1
any     ──(broker goes flat)─────────────> level 0, awaitReentry = true
```

The last arrow is the one people get wrong. The machine does **not** transition to flat when an exit is *signalled*; it transitions when the broker *reports* flat:

```ts
if (inPosition) s.wasInTrade = true
if (!inPosition && s.wasInTrade) { /* reset ten fields, awaitReentry = true */ }
```

`inPosition` is `position.size > 0` — a broker fact. This has a direct operational consequence, documented in `engine.ts`: when the engine **refuses** a signalled sale because the next bar's open is below average cost, nothing has to be rolled back.

> A sale that does not happen leaves the broker holding, so the machine simply never resets and the ladder survives on its own. The fills are the facts, once again.

The obvious alternative design — a remembered pre-exit snapshot to roll back to — was rejected as unnecessary, and it would have needed a column the store does not have.

One more subtlety pinned by a test: a position that was **signalled but never filled** (`level = 1`, `wasInTrade = false`, broker flat) is *not* reset, because `wasInTrade` was never set. That is correct for the one bar between decision and fill — and it is also the shape of a much worse failure, covered in §11.

---

## 7. Both entry doors

They are two separate `if` blocks sharing one `openPosition(comment)` closure, not one combined condition. They are mutually exclusive per bar through `!boughtThisBar`, and **Door 1 is checked first**, so it wins when both are eligible.

### Door 1 — classic entry (`ini_cond`)

```ts
s.level === 0 &&
ctx.swingHigh !== null &&
bar.close <= ctx.swingHigh * (1 - params.dropInitPct / 100) &&
ctx.isLateral &&
bar.close > 0 &&
!boughtThisBar
```

A drop of at least `dropInitPct` (default 10%) from the 20-bar swing high, inside a lateral zone. Pinned facts:

- **The drop is inclusive.** Exactly 10% qualifies: swing high 100, close 90 → fires. Close 91 → does not.
- **`swingHigh === null` silently closes the door during warmup.** `ta.highest(high, 20)` is `na` for the first 19 bars.
- **`bar.close > 0` guards both doors.** Dropping that guard makes `qty = usd / close` produce `Infinity` on a zero or garbage price instead of an error.

### Door 2 — trend re-entry (`tr_cond`)

```ts
params.useTrendReentry &&
s.level === 0 &&
s.awaitReentry &&
ctx.trendBullish &&
bar.close > 0 &&
!boughtThisBar
```

`trendBullish` is composed in `signals.ts` and is a conjunction of five conditions plus a negation:

```ts
dir < 0                     // Supertrend bullish — Pine's convention: -1 = uptrend
&& adx >= params.trendAdxMin        // 30 — a trend with strength
&& dip > dim                        // +DI above -DI
&& close > emaTrend                 // above EMA-200
&& close > close[trendSlopeBars]    // positive slope over 1 bar
&& !isLateral                       // discard consolidations
```

**The Supertrend direction is inverted from intuition.** Pine's convention is kept: `-1` is an *uptrend*. So `trendBullish` requires `dir < 0`, and `stBearFlip` is `prevDir <= 0 && dir > 0` — a crossover *above* zero is the **bearish** flip. Reading `dir > 0` as bullish silently inverts both this door and the normal exit.

### What `openPosition` does

```ts
const openPosition = (comment: string): void => {
  const usd = usdForLevel(params, 0)
  orders.push({ kind: 'entry', id: 'Entry', level: 0, usd, qty: usd / bar.close, comment })
  boughtThisBar = true
  s.level = 1;  s.ep1 = bar.close;  s.totalInvested = usd
  s.lastFill = bar.close;  s.cycleLow = null
  s.dcaArmed = false;  s.barsSinceLow = 0;  s.awaitReentry = false
}
```

Both doors emit the **same order id**, `'Entry'`, and differ only in the comment — which is also what TradingView's trade list records, so parity depends on it. They are told apart on the dashboard and the phone by splitting the comment's leading icon (`entryAlertLabel` in `engine.ts`).

`awaitReentry = false` is set unconditionally, which makes **Door 2 fire at most once per sell**. It is re-armed only by the cycle-reset block, which requires the broker to actually go flat. A test pins the race: a classic entry on a bar where the trend door was also armed still clears `awaitReentry`, closing the trend door for that cycle.

---

## 8. The ladder

### 8.1 Triggers

```ts
export function dropPct(params: CascadeParams, level: number): number {
  return params.progression === 'linear'
    ? params.dcaBasePct + (level - 1) * params.linearIncrementPct
    : params.dcaBasePct * Math.pow(params.geometricMultiplier, level - 1)
}
export function triggerPrice(params: CascadeParams, ep1: number, level: number): number {
  return ep1 * (1 - dropPct(params, level) / 100)
}
```

With the defaults (`dcaBasePct 1.0`, `linearIncrementPct 3`), the linear ladder is `drop(n) = 1 + (n−1)·3`:

| n | 1 | 2 | 3 | 4 | 5 | 10 | 34 | 35 |
|---|---|---|---|---|---|---|---|---|
| `drop(n)` | 1% | 4% | 7% | 10% | 13% | 28% | 100% | 103% |
| `triggerPrice(100, n)` | 99 | 96 | 93 | 90 | 87 | 72 | **0** | **negative** |

**Linear triggers reach zero at n = 34 and go negative beyond.** A test walks all three cases. These levels are *signalled* by the machine and can never be filled. This is harmless in practice only because the broker rejects everything past the tenth open entry — a future change to `linearIncrementPct` or `PYRAMIDING` could make it reachable.

The geometric progression (`dcaBasePct × geoMult^(n−1)`, default multiplier 10) reaches 100% at n = 3, which is why `assertParams` refuses a multiplier `≤ 1` ("a geometric multiplier that does not grow") but cannot save you from one that grows too fast. Linear is the default and what the backtest ran.

### 8.2 Sizing

```ts
export function usdForLevel(params: CascadeParams, level: number): number {
  return Math.min(params.baseUsd * (1 + params.amountIncrement * level), params.maxUsdPerLevel)
}
```

With the reference defaults (`baseUsd 1000`, `amountIncrement 1.2`, `maxUsdPerLevel 5000`):

| level | 0 | 1 | 2 | 3 | 4 | 5+ |
|---|---|---|---|---|---|---|
| `usd(n)` | 1,000 | 2,200 | 3,400 | 4,600 | **5,000** (5,800 hits the cap) | 5,000 |

`maxUsdPerLevel` is described in `ladder.test.ts` as "the only thing standing between a typo and ruin": with `amountIncrement: 100`, level 1 already clamps to the cap.

`ladderCapital(params)` sums levels 0 through `maxLevels`. Two numbers matter:

- **Ten deployable entries** (Entry + DCA-1..DCA-9) = **$41,200**, against TradingView's `initial_capital = 10000`. That gap is exactly why the parity harness had to learn TradingView's *margin* capital rule — see `14-pruebas.md`.
- **The full 51-level signalled ladder** = 1000 + 2200 + 3400 + 4600 + 5000 × 47 = **$246,200**, a number that exists only on paper.

### 8.3 The DCA block

```ts
const n = s.level
const trigger = s.ep1 !== null && n >= 1 && n <= params.maxLevels
  ? triggerPrice(params, s.ep1, n) : null
if (trigger !== null &&
    (params.useRebound ? reboundFire : bar.close <= trigger) &&
    ctx.isLateral &&
    !boughtThisBar) { /* emit DCA-n, level = n + 1, totalInvested += usd */ }
```

`DCA.pine` writes this out as **fifty near-identical `if` blocks**, one per level, each guarded by `bought_this_bar`. The port collapses them into one check, and that is the only structural liberty taken in the whole transcription. The proof of equivalence is written into the comment:

> The reference has one block per level guarded by `bought_this_bar`; since each block advances `level`, at most the block matching the incoming level can ever fire. One check suffices.

Note the lateral filter applies to DCA rungs as well as to the initial entry — which matters more than it looks, because with the defaults `isLateral` is nearly a constant `true`. See §12.

---

## 9. The five rebound locks

Anti-stacking. Without them a single waterfall bar would fill several rungs at prices that have not stopped falling — which is exactly the failure the Pine comment block names ("los 50 bloques if se encadenan en la misma barra").

**All five must hold.** Locks 1 and 2 *arm* the level; locks 3, 4 and 5 *fire* it.

| # | Name | Condition | What it prevents |
|---|---|---|---|
| 1 | `triggerOk` | `cycleLow <= triggerPrice(ep1, level)` | buying before the level's price was reached |
| 2 | `gapOk` | `lastFill === null \|\| cycleLow <= lastFill * (1 - minGapPct/100)` | two fills landing on top of each other |
| 3 | `holdOk` | `barsSinceLow >= confirmBars` | the bar that made the bottom triggering on its own intrabar bounce |
| 4 | `reboundOk` | `close >= cycleLow * (1 + reboundPct/100)` | buying into a fall that has not turned |
| 5 | `greenOk` | `!requireGreen \|\| close > open` | buying a red candle |

```ts
if (inPosition && params.useRebound && !s.dcaArmed && triggerOk && gapOk) s.dcaArmed = true
const reboundFire = s.dcaArmed && holdOk && reboundOk && greenOk
```

### 9.1 `min_gap_pct` dominates the early rungs

With the defaults, DCA-1 triggers at −1% (99 from an `ep1` of 100) but lock 2 needs the cycle low at −5% (95). The test spells it out: *"the min_gap lock dominates the first trigger: −1% is not enough, −5% is."* Tuning `dcaBasePct` alone will appear to do nothing on the early rungs.

This is **known deviation #3** in `CLAUDE.md`, still open: "confirm against the tuned 10-level parameter set."

### 9.2 Arming only happens in rebound mode

The arming condition includes `params.useRebound`. In **classic mode** (`useRebound: false`) the fill condition bypasses `reboundFire` entirely and uses `bar.close <= trigger` directly, so `dcaArmed` stays permanently `false` and locks 2–5 do nothing at all. Reading `dcaArmed` as "the level is pending" is wrong in classic mode.

### 9.3 A new bottom is required to arm the next level

```ts
if (s.level > levelBefore && levelBefore >= 1) {
  s.lastFill = bar.close;  s.dcaArmed = false;  s.cycleLow = null;  s.barsSinceLow = 0
}
```

`levelBefore >= 1` excludes the entry doors — `openPosition` does its own reset inline. Combined with lock 2, this means rung *n+1* cannot arm until price makes a **fresh low at least `minGapPct` below the close at which rung *n* filled**.

`lastFill` is the signal **close**, not the fill price. That is what Pine does, and it is one more place where the machine's numbers and the broker's legitimately differ.

### 9.4 One fill per bar, always

`boughtThisBar` is set by `openPosition()` and by the DCA block, and every entry site checks `!boughtThisBar`. The test is unambiguous: an armed position at `ep1 = 100` whose cycle low is **50** — deep enough to have passed the triggers of a dozen rungs — still produces **exactly one order** and advances to level 2.

---

## 10. The exits

Both are evaluated after every entry site, and both read the broker.

```ts
const avgCost = position.avgPrice
const inProfit = inPosition && avgCost !== null && bar.close > avgCost * (1 + params.minProfitPct / 100)
const exitSignal = inProfit && (impulseDead || (params.useSupertrendExit && ctx.stBearFlip))

const filledDcas = s.level > 0 ? s.level - 1 : 0
const rescueMode = inPosition && filledDcas >= params.rescueLevels
if (rescueMode && avgCost !== null && bar.close >= avgCost * (1 + params.breakevenArmPct / 100)) s.breakevenArmed = true
const breakevenExit = inPosition && s.breakevenArmed && position.openProfit <= 0

if (exitSignal) orders.push({ kind: 'closeAll', comment: '🏁 Exit' })
else if (breakevenExit) orders.push({ kind: 'closeAll', comment: '⚖️ BE Exit' })
```

### 10.1 Normal exit — `🏁 Exit`

"It stalled at the top, take the money." Two conditions, AND-ed:

1. **In profit**: `close > avgCost × (1 + minProfitPct/100)`, default +2%.
2. **Momentum gone**: either `impulseDead`, or a Supertrend bearish flip when `useSupertrendExit` is on.

`impulseDead` is the VWM decay rule:

```ts
const vwmFalling = ctx.vwm !== null && ctx.vwmPrev !== null && ctx.vwm < ctx.vwmPrev
s.decayCount = vwmFalling ? s.decayCount + 1 : 0
const impulseDead = s.decayCount >= params.decayBarsRequired
  && ctx.vwmLagged !== null && ctx.vwmLagged > params.impulseThreshold
```

Read it in words: *the VWM has fallen for at least `decayBarsRequired` consecutive bars, and `decayBarsRequired` bars ago it was above `impulseThreshold`.* The second half is what makes it "the impulse died" rather than "the indicator is drifting" — there has to have been an impulse to die.

**Any `na` resets the count.** Pine's `decay_count := vwm < vwm[1] ? ... : 0` compares against `na` and a comparison against `na` is false, so the `else` branch runs. The port reproduces this rather than approximating it, and the test walks all four cases: 1 → 2 → reset on a rise → reset on a `null`.

`impulseThreshold` is **known deviation #2**. In `DCA.pine` it is a hardcoded `0.3` inside `impulse_dead`; the port promotes it to a named parameter, and `params.ts` states the reason plainly: *"Not an input in the reference; named here so it is configurable and, above all, visible."* The default is `0.3`, so behaviour is unchanged.

### 10.2 Rescue breakeven — `⚖️ BE Exit`

When a position has accumulated `rescueLevels` filled DCAs (default 10), rescue mode engages. Arming and firing are separate:

- **Arm**: price clears `avgCost × (1 + breakevenArmPct/100)` — default +1%.
- **Fire**: `position.openProfit <= 0` — the open P&L returns to zero.

The intent, from the Pine comment: *"Una posición rescatada nunca vuelve al rojo."* A deeply averaged-down position that claws its way back to a small profit will not be allowed to slide back under water.

**`breakevenArmed` is never disarmed except by the full cycle reset.** Once armed, *any* later bar where `openProfit <= 0` closes the whole position — many bars later, even if price recovered and fell back. There is no re-arm window and no expiry.

### 10.3 Precedence, and there is never more than one exit order

`if (exitSignal) … else if (breakevenExit) …` — the normal exit wins, pinned by the test *"the normal exit takes precedence over the breakeven exit."* Both close the **entire** position.

### 10.4 Never exit at a loss — and where that rule actually leaks

Both exits are gated on profit by construction: the normal exit needs `close > avgCost × 1.02`, and the breakeven exit only ever fires after having armed *above* `avgCost`. There is **no stop loss anywhere in this file**.

The reason is the strategy's whole premise: the ladder's argument is that a drop is an opportunity to average down, so selling into one destroys the edge the system exists to harvest. The test is blunt — `decayCount: 5`, price 80 against an `avgCost` of 100, `stBearFlip: true`, `openProfit: -200` → **zero orders**.

**But the invariant is only half-enforced here, and anyone reading `cascade.ts` alone will believe it is complete.** `stepCascade` compares against the signal-bar close; execution happens at the next bar's open. Production sold BinanceTown at **−13.1% under the comment `🏁 Exit`** because the gap between the deciding close and the filling open was **−14.8%**. On 15-minute small caps the execution gap is *routinely larger than the entire +2% profit target*, so a rule that only holds at the close does not hold at all.

The fix lives outside this subsystem, in `engine.ts`:

```ts
function refusesToSellAtALoss(order: Order, avgPrice: number | null, fillPrice: number): boolean {
  if (order.kind !== 'closeAll') return false
  if (order.comment === DEATH_EXIT_COMMENT) return false
  if (avgPrice === null) return false          // nothing held, no cost basis, no loss to make
  return fillPrice < avgPrice
}
```

The death exit is the one exemption, and it is not really an exception — it answers a different question. A stop loss sells because the *price* fell; a death exit sells because the *asset stopped being an asset*. See `05-riesgo.md`.

---

## 11. The 50-signalled / 10-fillable split

Both numbers are intentional and both are the validated production configuration. They live in different places on purpose:

```ts
/** `pyramiding = 10` from the strategy() header — max open entries per position. */
export const PYRAMIDING = 10
/** The reference input allows 1..50. */
export const MAX_SUPPORTED_LEVELS = 50
```

`params.ts` states the split in one line: **"The machine mirrors the script; the broker mirrors the venue."**

- The state machine keeps **signalling** DCA levels past the tenth — advancing `level`, summing `totalInvested`, resetting the cycle — exactly as the script does.
- TradingView's broker **rejects** every entry after the tenth open one (Entry + DCA-1..DCA-9). DCA-10 onward are signalled, never filled.

The rejection is an *execution* constraint, so it is enforced in `TradingViewSim.pyramiding` and `PaperBroker.maxOpenEntries`, never in the machine. `ladder.test.ts` asserts both constants side by side under the name *"the broker, not the strategy, caps fills at pyramiding = 10."*

**The consequence that surprises people:** `filledDcas = level - 1` counts **signalled** levels, not fills. So `rescueMode` (default `rescueLevels: 10`, i.e. `level >= 11`) can engage on a position where rungs 10 and up were never actually bought. `CLAUDE.md` names this explicitly — "This is also why `rescue_mode` can engage." Anyone "fixing" this to count real fills breaks parity with the reference.

One honest note about the reference: the Pine header carries the comment `pyramiding = 10, // Permite hasta 50 entradas simultáneas`. The comment contradicts its own value. The value is what TradingView enforced and what the trade list shows, so the value is what the port follows.

### A third bound the machine also does not enforce

`assertParams` is called by `replay()` and by nothing else — the live path (`tickPosition` → `advanceOneBar` → `stepCascade`) never validates its params. This is a real gap, stated here rather than glossed: today it is harmless because the only live composition is `{ ...DEFAULT_PARAMS, maxUsdPerLevel }` and `scaledParams`, neither of which can produce an invalid `maxLevels` — but nothing structurally prevents one.

---

## 12. Every parameter

`DEFAULT_PARAMS` is a one-to-one mirror of the `input.*` block in `DCA.pine`, with Pine identifiers in camelCase so a diff against the reference stays mechanical. **The Pine defaults ARE the production strategy configuration** (confirmed by the user), with exactly one runtime override, covered in §13.

The **Evidence** column answers: where does this number come from?

- **TV** — it is the `defval` of a Pine `input.*`, so it is what TradingView ran. `parity.test.ts` asserts five of them directly against the exported backtest inputs (`max_levels`, `confirm_bars`, `min_gap_pct`, `bbw_max`, `rescue_levels`) and runs the whole replay on `DEFAULT_PARAMS`, so the rest are under test as a set.
- **TV (literal)** — it was a hardcoded constant in the script, promoted to a named parameter with the same value.
- **Prod** — a production choice, expressed by composition on top of `DEFAULT_PARAMS`, never by editing it.

### 💰 DCA amounts

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `baseUsd` | `base_usd` | 1000 | — | TV | level 0 size; scaled at runtime by `scaledParams` |
| `amountIncrement` | `amt_inc` | 1.2 | — | TV | `usd(n) = base × (1 + 1.2n)` |
| `maxUsdPerLevel` | `max_usd_cap` | 5000 | — | TV (**overridden in prod → 15**) | the safety ceiling per rung |

### 📉 Drop progression

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `dropInitPct` | `drop_init` | 10 | — | TV | Door 1's drop from the swing high |
| `maxLevels` | `max_levels` | **50** | — | TV | levels the machine signals; input range 1..50 |
| `dcaBasePct` | `dca_base_pct` | 1.0 | — | TV | drop of DCA-1 |
| `progression` | `progression` | `'linear'` | — | TV | `"Linear (+)"` in the script |
| `linearIncrementPct` | `lin_inc` | 3 | — | TV | +3% of drop per level |
| `geometricMultiplier` | `geo_mult` | 10 | — | TV | unused while linear; must exceed 1 |

### 🎯 Rebound confirmation

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `useRebound` | `use_rebound` | `true` | — | TV | off = classic `close <= trigger` |
| `reboundPct` | `rebound_pct` | 2.5 | — | TV | lock 4 |
| `requireGreen` | `require_green` | `true` | — | TV | lock 5 |
| `minGapPct` | `min_gap_pct` | 5 | — | TV | lock 2 — the hard separation |
| `confirmBars` | `confirm_bars` | **20** | **5 h** (was 20 h @1H) | TV | lock 3 |

`confirmBars` is **known deviation #4**: the Pine input has `defval = 20` and `maxval = 20`, while its own tooltip recommends the opposite — *"1 = el fondo debe ser de una vela anterior (recomendado). 2-3 = confirmación más fuerte."* The port uses 20 because that is what the backtest ran and what the parity harness asserts. `CLAUDE.md` still flags it as "confirm which value is the tested one."

`cascade.test.ts` overrides it to `confirmBars: 1` in most scenarios, justified as *"the reference default of 20 only makes sequences longer, not different."* That is true of the *sequence*, and it is why a green `cascade.test.ts` says nothing about how `confirmBars: 20` behaves in wall-clock time — see §14.

### ⚖️ Rescue mode

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `rescueLevels` | `rescue_levels` | 10 | — | TV | signalled DCAs that engage rescue mode |
| `breakevenArmPct` | `be_arm_pct` | 1 | — | TV | profit above avg cost that arms the breakeven |

### 🚀 Trend re-entry

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `useTrendReentry` | `use_trend_reentry` | `true` | — | TV | Door 2 on/off |
| `trendAdxMin` | `tr_adx_min` | 30 | — | TV | minimum trend strength |
| `trendEmaLength` | `tr_ema_len` | 200 | **50 h** (was 200 h @1H) | TV | the EMA-200 trend filter |
| `trendSlopeBars` | `tr_slope` | 1 | **15 min** | TV | `close > close[1]` |

### 🔲 Lateral zone

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `swingLookback` | `swing_lb` | 20 | **5 h** (was 20 h @1H) | TV | `ta.highest(high, 20)` for Door 1 |
| `bbLength` | `bb_len` | 50 | **12.5 h** (was 50 h @1H) | TV | Bollinger basis |
| `bbStdev` | `bb_dev` | 1.0 | — | TV | band width in σ |
| `bbwMax` | `bbw_max` | 14 | — | TV | BBW ceiling for `is_lateral` |
| `adxLength` | `adx_len` | 15 | seeds at bar 29 ≈ **7.25 h** | TV | `ta.dmi(15, 15)` |
| `adxMax` | `adx_max` | 40 | — | TV | ADX ceiling for `is_lateral` |
| `requireBoth` | `require_both` | `false` | — | TV | `false` = OR, `true` = AND |

### 🏁 Exit

| Param | Pine | Default | In bars @15m | Evidence | Meaning |
|---|---|---|---|---|---|
| `minProfitPct` | `min_profit` | 2 | — | TV | the profit gate on the normal exit |
| `rocLength` | `roc_len` | 10 | **2.5 h** | TV | VWM's `ta.roc` |
| `rocSmooth` | `roc_sm` | 5 | **1.25 h** | TV | VWM's final EMA |
| `volumeLength` | `vol_sm_len` | 10 | **2.5 h** | TV | volume SMA for relative volume |
| `decayBarsRequired` | `decay_req` | 2 | **30 min** | TV | consecutive falling-VWM bars, and the VWM lag |
| `useSupertrendExit` | `use_st_exit` | `true` | — | TV | the Supertrend half of the exit |
| `supertrendAtrLength` | `st_atr_len` | 10 | **2.5 h** | TV | |
| `supertrendFactor` | `st_factor` | 3.0 | — | TV | |
| `impulseThreshold` | *(hardcoded `0.3`)* | 0.3 | — | TV (literal) | deviation #2 — named so it is visible |

### Warmup, in bars

Every boolean is `false` until all of its inputs exist (Pine `na` semantics, reproduced throughout `signals.ts`). The order in which they come alive matters:

| Series | First bar with a value | Note |
|---|---|---|
| `swingHigh(20)` | 19 | Door 1 is closed before this |
| ADX(15) | **29** | an RMA of an RMA: `2 × adxLength − 1` |
| BBW(50) | 49 | |
| EMA-200 | 199 (and converging long after) | Door 2's trend filter |

**ADX seeds before BBW, so `is_lateral` is true on bars 29–48 on half the evidence** — the OR makes `adx < 40` alone sufficient. `signals.test.ts` finds that index rather than assuming it and asserts `isLateral === (adx < adxMax)` there.

### The lateral filter is nearly inert, and that is deliberate

`DCA.pine:415` destructures Pine's `ta.bb` as `[bb_up, bb_mid, bb_lo]`, but **`ta.bb` returns `[basis, upper, lower]`** — the basis comes first. So the script's BBW computes `(basis − lower) / upper × 100` instead of `(upper − lower) / basis × 100`. `signals.ts` reproduces the bug exactly as `bbwAsWritten`, and the strategy reads only that. Measured over 4001 bars of BLESS 1H with Pine computing both side by side:

| | As written | Textbook |
|---|---|---|
| Mean BBW | 5.821 | 13.165 (**2.26×**) |
| `bbw < bbw_max(14)` passes | **92.5%** of bars | 74.3% |
| `is_lateral` differs | — | on 4.45% of bars |

OR'd with `ADX < 40`, the lateral gate is close to a constant `true`. `signals.test.ts` pins this as an *executable* assertion — `lateralShare > 0.9` over the converged window — so a future retune that accidentally makes the gate bite fails a test instead of silently changing behaviour.

**Do not "fix" this as a bugfix.** `bbw_max = 14` was tuned against this behaviour and parity with the validated backtest is the acceptance test. The corrected formula ships alongside as `bbwTextbook`, "exported for a future A/B; the strategy does not read it". Full treatment in `02-indicadores.md`; this is deviation #6.

The reason it matters *here* is that the DCA fill block also requires `ctx.isLateral`. A reader may believe DCA rungs are meaningfully gated by consolidation when in practice they are almost always let through.

---

## 13. How production differs, and how it says so

`DEFAULT_PARAMS` and `PYRAMIDING` are **evidence**, and `production-ladder.ts` states the rule that protects them:

> Neither number may be expressed by editing `DEFAULT_PARAMS` or `PYRAMIDING`. Those are what TradingView ran and the parity harness asserts them: they are EVIDENCE, and evidence that can be edited to express a preference stops being evidence. Production composes its own values on top.

Two numbers, in one module, because two things need them and neither may own them — the engine, which sizes and fills the ladder, and the dashboard, which draws it. (The dashboard drew `DEFAULT_PARAMS` instead and showed a $1,000 rung beside a $15 order for days.)

```ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15   // OPERADOR_MAX_USD_PER_LEVEL
export const DEFAULT_MAX_DCA_PER_TOKEN = 5    // OPERADOR_MAX_DCA  → maxOpenEntries 6
```

| | Reference | Production |
|---|---|---|
| `maxUsdPerLevel` | 5,000 | **15** |
| Ladder shape | growing: 1000, 2200, 3400, 4600, 5000… | **flat**: `min(1000 × (1 + 1.2n), 15)` = $15 everywhere |
| Open entries the venue holds | `PYRAMIDING = 10` | **6** (entry + 5 DCA rungs) |
| Nominal ladder | $41,200 over ten entries | **$90** over six rungs ($150 over ten) |
| Gas share per fill @ $0.05/swap | negligible | 0.33% |

Composed in `src/runtime/main.ts`:

```ts
params: { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel },
maxOpenEntries: config.maxDcaPerToken + 1,
sizing: { ...DEFAULT_SIZING_POLICY, maxOpenEntries: config.maxDcaPerToken + 1 },
```

The five-rung choice is the ladder's own geometry, from `production-ladder.ts`: with `linInc` at 3, **DCA-5 already needs a 13% fall and DCA-10 needs 28%.** A token down 28% is rarely an opportunity, and the capital those deep rungs reserve buys more by going to another token — which is finding 2 of the capital-floor experiment arriving by a different road. `06-economia.md` has that experiment in full.

Note that `maxOpenEntries` is **not** a `CascadeParams` field. It reaches the broker and the sizing policy; the machine never sees it and keeps signalling to 50.

### One more layer: the runtime shrinks the ladder again

`tickPosition` does not hand `config.params` to the machine directly. It sizes once per catch-up walk and rescales:

```ts
const sizing = sizeLadder(config.params, position.quality, policy, deployableCapital({ … }))
const params = sizing.tradeable ? scaledParams(config.params, sizing) : config.params
```

`scaledParams` multiplies `baseUsd` by the ratio the sizing allows for level 0 and clamps `maxUsdPerLevel` to match, so **the ladder keeps its shape and loses its scale**. It never drops a level, and the comment says why: "dropping a level would change the state machine's own transitions and break parity with the validated behaviour." A thin pool is therefore no longer *refused*, it is *shrunk*.

When the pool cannot be sized against at all (`!sizing.tradeable`), the engine filters entries out of what the machine produced but keeps exits: "A pool too thin to size against must not trap the money already in it: entries stop, exits never do."

This whole path is documented in `06-economia.md`. It is mentioned here because the params the live machine runs on are **not** `DEFAULT_PARAMS` and not even the composed production params — they are the scaled ones, and reading `cascade.ts` alone will not tell you that.

---

## 14. Bars are the unit, and the clock is a parameter

Every parameter above that is counted in bars changes meaning when the bar size changes. `OPERADOR_TIMEFRAME` defaults to `15m` (`src/runtime/config.ts` accepts `15m` or `1h` and throws on anything else). The user's reasoning: on young crypto an hour is long enough for the move to be over before the strategy has an opinion.

| Parameter | Bars | At 15m | At 1H |
|---|---|---|---|
| EMA-200 (Door 2's trend gate) | 200 | 50 h | 200 h |
| Bollinger basis | 50 | 12.5 h | 50 h |
| Swing high lookback (Door 1) | 20 | 5 h | 20 h |
| `confirmBars` (lock 3) | 20 | 5 h | 20 h |
| History gate (`minHistoryBars`, scanner) | 250 | 2.6 days | 10.4 days |

The 1H parity harness stays green and stays meaningful — it proves the **port** is faithful to `DCA.pine`. Bar size is a separate choice, and reproducing the backtest is not an argument for trading the bar the backtest used.

### The bug that proves bars are not time

The engine used to advance **one bar per call**, which is correct only while a cycle is faster than a bar. In production a cycle took ~37 minutes against 15-minute bars, so the engine saw **ten of every twenty-two** — and every parameter counted in bars silently changed meaning. `confirmBars: 20` stopped being five hours and became eleven, longer than these positions live, so **lock 3 could never complete**.

The measured result: **ten entries, six exits, and not one DCA fill.** The cascade never cascaded, and no parameter was wrong — the clock was.

The fix is the catch-up walk in `tickPosition`, bounded at `MAX_CATCH_UP_BARS = 96`. A slow scheduler is now a latency problem, which is what it should always have been. See `08-motor.md`.

---

## 15. What the machine cannot see, and other traps

A list of the things that are true about `stepCascade` and are not visible from inside it.

**1. Signalling is not holding: `level > 0` does not mean the position exists.** The machine advances on the *signal* because that is Pine's semantics and parity depends on it. A broker that refuses the order leaves the machine believing it holds a position nobody bought, waiting for a DCA trigger on a cost basis that never existed. This happened: *"Production ran five positions that way: level 1, zero tokens, a ladder of pure fiction, capital held hostage by a trade that never happened."* The guard is in `engine.ts`:

```ts
const desynced = beforeStrategy.size === 0
  && position.pendingOrders.length === 0
  && position.cascade.level > 0
```

Flat **and** nothing pending **and** the machine says in-trade is the one combination that cannot be honest; it resets to `initialState()` and alerts. The `pendingOrders.length === 0` term is what keeps it from firing on healthy positions — flat *with* something pending is normal for exactly one bar.

**2. The arming block uses pre-entry state.** `currentTrigger` is computed from the incoming `s.level` at step 4; the DCA block recomputes `trigger` from `s.level` at step 8, *after* the doors may have set it to 1. The doors are harmless only because `boughtThisBar` blocks the DCA block on the same bar. Move either block and an entry could immediately fill DCA-1 at the same close.

**3. The cycle reset happens inside `stepCascade`, so reading `level` before the call is a trap.** This caused a real alerting bug. The entry label was derived from the cascade level read *before* the step, so on the bar where a sale settles and the trend door fires again, the level still said "in trade" and a full re-opening went out as `➕ … Entry` — which live "read as the DCA ladder finally firing while the DCA count was zero, which is the one thing the reader was watching for." The fix (`entryAlertLabel`) derives the label from the **order**: both doors emit level 0 and carry their own comment.

**4. An exit signalled in profit can fill at a loss.** §10.4. Enforced in `engine.ts`, not here.

**5. `filledDcas` counts signals, not fills.** §11.

**6. `breakevenArmed` has no expiry.** §10.2.

**7. Classic mode makes `dcaArmed` meaningless.** §9.2.

**8. `is_lateral` is nearly always true.** §12.

**9. Supertrend direction is inverted.** §7.

**10. Test fixtures use `confirmBars: 1`, not the default 20.** `const P = { ...DEFAULT_PARAMS, confirmBars: 1 }` at the top of `cascade.test.ts`. A green suite therefore says nothing about how `confirmBars: 20` behaves against a real clock — §14.

---

## 16. What the tests pin

| Suite | What it proves | Oracle |
|---|---|---|
| `cascade.test.ts` (39 scenarios) | one per `DCA.pine` transition, each named for its Pine condition | hand-built scenarios, read off the script |
| `ladder.test.ts` | exact trigger and size arithmetic; the 1..50 params range; `PYRAMIDING = 10` beside `maxLevels = 50` | the Pine formulas |
| `signals.test.ts` | every composed boolean recomputed from **TradingView's own exported columns** (`bbw_as_written`, `adx`, `st_dir`, `dip`, `dim`, `ema_trend`, `vwm`, `swing_high`), bar for bar from bar 1000 onward | TradingView export |
| `replay.test.ts` | every fill lands one bar after its order at that bar's open ± a tick; pyramiding never exceeded; the machine sees the position the bar *after* the fill; a `close_all` resets the cycle on the next bar, which may already re-enter | golden BLESS 1H window |
| `parity.test.ts` | trade for trade against the real TradingView trade list: entry bar, entry price, exit bar, exit price, size, net profit, exit comment, plus the five-entry position still open at the end | `__golden__/bless-1h.trades.json` |

Two methodological rules carry over from the indicator layer. Golden values are an **external oracle** and are never regenerated from our own output — "or the test becomes a mirror instead of a check". And recursive indicators are compared **once converged** (`CONVERGED = 1000` in `signals.test.ts`, `CONVERGED_BAR = 2200` in `parity.test.ts`), because a wrong recursion cannot converge onto the right one.

A representative scenario, showing the whole rung in one assertion — armed at `ep1 = 100` with `cycleLow = 94`, on a green bar closing at 96.5 (94 × 1.025 = 96.35, so lock 4 clears):

```ts
expect(orders).toEqual([
  { kind: 'entry', id: 'DCA-1', level: 1, usd: 2200, qty: 2200 / 96.5, comment: 'DCA-1' },
])
expect(state).toMatchObject({
  level: 2, totalInvested: 3200, lastFill: 96.5,
  dcaArmed: false, cycleLow: null, barsSinceLow: 0,
})
```

---

## 17. Open items in this subsystem

Stated plainly rather than implied.

| Item | Status |
|---|---|
| Deviation #3 — `min_gap_pct` dominating the early DCA drops | **Open.** `CLAUDE.md` still says "confirm against the tuned 10-level parameter set." The behaviour is ported and tested; whether it is what the tuning intended is unresolved. |
| Deviation #4 — `confirm_bars` default 20 vs its own tooltip recommending 1 | **Open.** The port uses 20 because the backtest did and the parity harness asserts it. Which value is *the tested one* has not been settled. |
| Deviation #6 — the BBW tuple bug | **Decided, not fixed.** Ported as written; `bbwTextbook` ships unused so the correction can later be evaluated as an explicit A/B with a retuned `bbw_max`. |
| `assertParams` on the live path | **Gap.** Called by `replay()` only. Harmless today, structurally unguarded. §11. |
| `impulseThreshold` tuning | Named and configurable, never tuned — it is still the reference's `0.3`. |
| Geometric progression | Implemented and unit-tested, never run in anger. With the default multiplier of 10 it reaches a 100% drop at n = 3. |

---

## 18. Read next

| Chapter | For |
|---|---|
| `02-indicadores.md` | every `ta.*` port, the golden methodology, the `ta.bb` finding in full |
| `05-riesgo.md` | `applyDeathVerdict`, the two stages, and why price can never be a death signal |
| `06-economia.md` | `sizeLadder`, effective depth, `scaledParams`, the capital floor, and what `PaperBroker` charges per fill |
| `08-motor.md` | `tickPosition`, the catch-up walk, the desync guard, alerting, and `PaperBroker.seed` |
| `09-persistencia.md` | how `CascadeState` is stored and how recovery reconstructs it |
| `14-pruebas.md` | `TradingViewSim`, the margin capital rule, quantity truncation, the resync seed |
