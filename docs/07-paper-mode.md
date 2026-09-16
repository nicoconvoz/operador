# Paper mode and the honest broker

This chapter documents `src/infrastructure/brokers/paper-broker.ts` (260 lines) — the only component that decides what a paper result is worth. It covers what paper mode simulates and what it does not, the fill model on the way in and on the way out, the three reasons an order can be rejected and which of them nobody reads, the `entryMid` field and the gross-versus-net identity it exists for, how cost attribution is split by cause and why that split is what made the U-shaped cost finding visible, the reporting surface (`realisedGrossUsd`, `equityCash`, `totalCosts`), `seed` and its two caveats, and what `snapshot` actually computes. Charter constraint 1 is *"paper first, and paper must be honest"*; this file is where that constraint is either kept or broken, so the gaps are named rather than smoothed over.

Sizing — the budgets this broker's charges are measured against — lives in `06-economia.md`. The tick that calls it lives in `08-motor.md`. This chapter is the broker itself.

---

## 1. What is real, and what is simulated

Only the **fill** is simulated. Everything that decides is real, against the real market:

| Step | Paper mode | Live mode |
|---|---|---|
| Universe discovery | real (DexScreener, GeckoTerminal, Jupiter) | same |
| Safety gates, honeypot sell quote | real | same |
| Candles | real | same |
| Strategy, indicators, state machine | real | same |
| Death watch, its periodic sell probes | real | same |
| Sizing against pool depth and wallet | real | same |
| **The fill** | **`PaperBroker`** | a wallet adapter that does not exist |
| Gas actually paid | modelled, per swap | real |

`loadConfig` throws on `OPERADOR_MODE=live` (`src/runtime/config.ts`), so paper is not a default anyone drifts out of — it is the only mode the repository can run. See `12-runtime-despliegue.md`.

What follows from that split is the sentence worth keeping: **a paper run is not a rehearsal of the decisions, it IS the decisions.** The only difference from live is that no token moves because of us. Which puts all the weight on this broker being pessimistic where it is uncertain, and the source says so in its own header:

```
 *  - impact is charged on the way IN and again on the way OUT
 *  - gas is charged per swap, whatever the swap's size
 *  - a sell that cannot be routed does not happen (the caller sees it)
```

---

## 2. The files, and what each one owns

| File | Owns | Lines |
|---|---|---|
| `src/domain/execution/broker.ts` | `BrokerPort`, `OpenTrade`, `ClosedTrade`, `Fill`, `Rejection` — the port both simulators implement | 54 |
| `src/infrastructure/brokers/paper-broker.ts` | `PaperBroker`, `PaperBrokerConfig`, `PaperCosts`, `SeedFill` — the chain-shaped simulator | 260 |
| `src/infrastructure/brokers/tradingview-sim.ts` | `TradingViewSim` — the backtest-shaped simulator, for parity only | 215 |
| `src/application/replay.ts` | the bar loop that drives either one | 85 |

Tests: `paper-broker.test.ts` (129 lines, the fill model) and `paper-broker-seed.test.ts` (184 lines, the rebuild). Both are pure and offline — the broker imports no network, no clock and no store.

### 2.1 Two simulators, and why neither replaces the other

They implement the same port and answer different questions.

| | `TradingViewSim` | `PaperBroker` |
|---|---|---|
| Reproduces | a TradingView backtest | a chain |
| Slippage | `slippageTicks × mintick`, added to the open | `spreadPct + impact`, a **percentage** of the price |
| Commission | `commission_value = 0.1` percent, charged **on top** of the price | there is no separate fee: the slippage is the commission, plus gas |
| Quantities | truncated to `qtyStep` | untouched |
| Capital rule | `'margin'` — equity minus margin already used | cash: `cash < spent + gas` |
| Gas | none — TradingView has no chain | `gasUsdPerSwap` per swap |
| Impact of size | none: a $5 order and a $50,000 order slip one tick | superlinear, against measured depth |
| Used by | the parity harness | the engine, `retire.ts`, `paper-run.ts` |

The last row of that table is the whole argument for having both. A backtest that slips one tick regardless of size cannot see the capital floor; a broker that charges depth-based impact cannot reproduce TradingView's trade list. See `08-motor.md` and the parity notes in `03-estrategia-cascade-dca.md`.

### 2.2 The configuration

```ts
export interface PaperBrokerConfig {
  readonly gasUsdPerSwap: number
  readonly initialCapital: number
  /** Max simultaneous entries. Mirrors the validated `pyramiding = 10`. */
  readonly maxOpenEntries: number
  /** Current market quality for the token being traded, at fill time. */
  readonly quality: () => MarketQuality
}
```

`quality` is a **thunk, not a value**. Market quality is refreshed while a position is open, and a broker holding the quote it was constructed with would be pricing fills against a pool that has since changed — which on a dying token is exactly the case that matters. The thunk is read once per `execute` call, and again inside `impactPctFor`.

Production does not pass the reference `PYRAMIDING`:

```ts
maxOpenEntries: config.maxDcaPerToken + 1,   // five DCAs plus the entry → 6
```

`src/runtime/main.ts`. `OPERADOR_MAX_DCA` defaults to 5, so the live cap is **6 open entries**, not 10. The reference ten stays in `PYRAMIDING`, where the parity harness asserts it (`06-economia.md` §5).

---

## 3. The port, and the shapes that cross it

```ts
export interface BrokerPort {
  execute(orders: readonly Order[], open: number, time: number): readonly Fill[]
  snapshot(close: number): PositionSnapshot
  readonly openTrades: readonly OpenTrade[]
  readonly closedTrades: readonly ClosedTrade[]
  readonly rejections: readonly Rejection[]
}
```

Two properties of the signature are load-bearing:

- **`execute` takes the bar's `open`, never its close.** An order decided at a close fills at the *next* bar's open. That is the execution model the parity harness pinned, and it is why the engine writes its intentions down and the following tick carries them out.
- **`snapshot` takes the bar's `close`.** The strategy reads the position marked at the close it is evaluating — `strategy.position_size` and friends, as the reference does.

`PaperBroker` ignores `order.usd` entirely and prices `notional = order.qty × open`. `qty` was computed at the *signal* bar's close, so the whole close-to-open gap lands on the affordability check; `PRICE_HEADROOM_PCT` in `paper-run.ts` is what absorbs it (`06-economia.md` §6).

---

## 4. The fill model — a buy

```ts
const notional = order.qty * open
const costPct = quality.spreadPct + this.impactPctFor(notional)
const price = open * (1 + costPct / 100)
const spent = order.qty * price
const gas = this.config.gasUsdPerSwap
```

Three things are charged and only two of them are inside the price:

| Charge | Where it lands |
|---|---|
| venue spread | inside `price` |
| the order's own impact | inside `price` |
| gas | subtracted from cash separately, `spent + gas` |

Impact comes from **measured depth**, re-derived by the broker rather than taken from the sizing result:

```ts
private impactPctFor(usd: number): number {
  const depth = effectiveDepth(this.config.quality()).usd
  return depth > 0 ? (usd / (depth / 2)) * 100 : Infinity
}
```

`depth / 2` because only one side of the pool is the side you trade against. `effectiveDepth` inverts a measured quote — `depth = 200 × referenceUsd / slippagePct` — and falls back to reported liquidity only when nothing was measured. Reported TVL overstates what a concentrated pool absorbs by as much as 78× on the recorded dataset; see `06-economia.md` §3.

The trade is recorded with its commission stated against the **untouched** price:

```ts
entryCommission: spent - notional + gas,
```

which is the slippage that was baked into `price`, plus the gas that was not.

**Worked example**, the numbers in `paper-broker.test.ts`: spread 0.25%, 0.1% measured on $100 → $200,000 of usable depth. A 100-unit buy at an open of $1.00 is $100 of notional, impact `100 / 100,000 × 100 = 0.1%`, `costPct = 0.35%`, fill at **$1.0035**, cash down by **$100.40**, and the cost split is exactly `spread $0.25 / impact $0.10 / gas $0.05`.

---

## 5. The fill model — the exit

`closeAll` sells **everything in one swap**, so impact is charged on the total and gas is charged once:

```ts
const totalQty = this.open.reduce((sum, trade) => sum + trade.qty, 0)
const notional = totalQty * open
const costPct = quality.spreadPct + this.impactPctFor(notional)
const price = open * (1 - costPct / 100)
const received = totalQty * price
this.cash += received - gas
```

This is the behaviour `maxExitCostPct` is a budget for — the exit budget bounds the *whole position*, not each rung, because leaving is one order. On a thin pool it binds long before the per-fill budget does.

It then closes each open trade individually, because the ledger has to record which rung left:

```ts
const share = trade.qty / totalQty
const exitCommission = (notional - received) * share + gas * share
const profit = (price - trade.entryPrice) * trade.qty - gasEntry - gas * share
```

- **One fill per open entry, one gas charge for the swap**, split by quantity share. Pinned by *"charges gas ONCE for the exit, split across the closed trades"* and by the six-rung rebuild test, which asserts six fills out of one order.
- **`profit` subtracts only gas**, and that is correct rather than an omission: both fill prices already carry their slippage, so subtracting the commissions again would count them twice. `broker.ts` documents `profit` as "net of both commissions"; `PaperBroker` reaches that number by the price, `TradingViewSim` by the commission. §7 proves the two agree.

Note what the broker does **not** do: it has no opinion about selling at a loss. The "never exit at a loss" rule is enforced one layer up, in `tickPosition`'s `refusesToSellAtALoss`, before `execute` is ever called (`08-motor.md` §4).

---

## 6. The three rejections — and the one nobody reads

```ts
export interface Rejection {
  readonly time: number
  readonly order: Order
  readonly reason: 'pyramiding' | 'capital' | 'flat'
}
```

| Reason | Fires when | Line |
|---|---|---|
| `'pyramiding'` | an entry arrives with `this.open.length >= config.maxOpenEntries` | checked **first**, before any price is computed |
| `'capital'` | an entry's `this.cash < spent + gas` | checked after the fill price is known, so it includes slippage and gas |
| `'flat'` | a `closeAll` arrives with `this.open.length === 0` | the exit path's only guard |

Three properties of that table matter more than the table:

1. **Pyramiding is checked before quality is read.** A ladder at its ceiling never touches the market quote, so a rejected eleventh rung costs nothing and reports nothing about the pool.
2. **`'capital'` includes gas.** *"Refuses an entry the cash cannot cover, gas included"* is a test, because an order that is affordable except for its gas is still an order that does not happen.
3. **`'flat'` is a rejection, not a crash.** A `closeAll` against nothing returns `[]` and records the fact — which is what lets the engine's exit path be idempotent without a separate guard.

### 6.1 The silent rejection

`'capital'` is the failure mode this whole documentation set warns about, and **nothing in production reads `broker.rejections`.** The getter exists, the array fills, and the only readers in the repository are tests:

```
src/application/engine.test.ts:277      expect(r.broker.rejections).toEqual([])
src/infrastructure/brokers/paper-broker.test.ts        three reason assertions
src/infrastructure/brokers/paper-broker-seed.test.ts   two pyramiding assertions
```

No alert is raised, no row is persisted, nothing reaches the dashboard. So when it happened in production — a $285 position emitting the reference ladder's $1,000 nominal entries, every one refused for funds — the engine looked from outside exactly like a strategy with no signals. From `engine.ts`, in the comment above the sizing call:

> Unsized, a $285 position emits a $1,000 entry, the broker refuses it for funds, and nothing is recorded anywhere: a silent rejection is indistinguishable from a strategy with no signals. It ran that way in production.

The fix was to stop *producing* unaffordable orders — `tickPosition` now calls `sizeLadder` with `deployableCapital` and scales the params (`06-economia.md` §8.5). That removes the cause. It does not make the symptom observable: a `'capital'` rejection for any other reason would still be invisible today. **This is the largest open gap in this chapter** (§11).

---

## 7. `entryMid`, and the identity it exists for

`PaperBroker` keeps one field more than the port requires:

```ts
interface PaperOpenTrade extends OpenTrade {
  readonly entryMid: number
}
```

with the reason stated in the source:

> Slippage is already inside `entryPrice`, so charging it again as a commission would count it twice. Keeping the mid lets the books state both truths at once: what the position cost against an untouched price (gross), and what actually left the wallet (net).

`entryMid` is the bar's `open` at the fill — the price before this order touched it. It is used in exactly one place, and only to accumulate gross:

```ts
this.grossUsd += (open - trade.entryMid) * trade.qty
```

Mid-to-mid: **what the price move alone was worth, before the chain took its cut.**

### 7.1 The identity, proved

The claim is `gross − every commission = net, exactly`. For one trade, writing `in` and `out` for the two bar opens:

```
gross            = (out − in) · qty
entryCommission  = qty·(price_in − in) + gas_in
exitCommission   = qty·(out − price_out) + gas_out·share
profit           = (price_out − price_in)·qty − gas_in − gas_out·share
```

Substituting:

```
gross − entryCommission − exitCommission
  = (out − in)·qty − qty·(price_in − in) − gas_in − qty·(out − price_out) − gas_out·share
  = qty·(price_out − price_in) − gas_in − gas_out·share
  = profit                                                          ∎
```

Every `out` and `in` cancels. The identity is exact, not approximate, and it holds per trade and therefore over any set of them.

`paper-run.ts` relies on it directly:

```ts
const grossPnlUsd = broker.realisedGrossUsd
const closedCostsUsd = closed.reduce((sum, t) => sum + t.entryCommission + t.exitCommission, 0)
netPnlUsd: closed.reduce((sum, t) => sum + t.profit, 0)
```

with `closedCostsUsd` deliberately separated from the run's total costs:

> Costs on trades still open are real money already spent, but they have no realised P&L to net against — keeping the two apart is what makes the accounting identity below exact instead of approximately right.

### 7.2 A round trip at a flat price loses money

Take a 1,000-unit position at an open of $1.00, spread 0.25%, $200k of depth, gas $0.05, and sell it at the same $1.00:

| | |
|---|---|
| entry impact | `1,000 / 100,000 × 100 = 1%` → `costPct 1.25%` → fill **$1.0125** |
| `entryCommission` | `$12.50 + $0.05 = $12.55` |
| exit impact | same size, same 1% → `costPct 1.25%` → fill **$0.9875** |
| `exitCommission` | `$12.50 + $0.05 = $12.55` |
| **gross** | `(1.00 − 1.00) × 1,000 = **$0.00**` |
| **net** | `$0 − $12.55 − $12.55 = **−$25.10**` |

The price did not move and the wallet is $25.10 lighter, which is what would have happened on a chain. That is the test *"buying and selling at the same price costs spread twice, impact twice and two gas"*, and it is the single sentence that makes paper numbers worth arguing about.

---

## 8. Cost attribution — `chargeCosts`

```ts
private chargeCosts(notional: number, spreadPct: number, totalSlipUsd: number, gasUsd: number): void {
  const spreadUsd = (notional * spreadPct) / 100
  this.costs = {
    spreadUsd: this.costs.spreadUsd + spreadUsd,
    impactUsd: this.costs.impactUsd + Math.max(0, totalSlipUsd - spreadUsd),
    gasUsd: this.costs.gasUsd + gasUsd,
  }
}
```

The broker charges one blended `costPct` and then **splits it back into causes**: spread is the part a table could have told you, impact is everything left over. Called with `spent − notional` on a buy and `notional − received` on a sell, so the same line serves both directions.

`Math.max(0, …)` is defensive. `totalSlipUsd` is `notional × (spread + impact)/100` and impact is never negative, so the clamp cannot fire on any reachable input; it exists so a hand-built `MarketQuality` cannot drive `impactUsd` downwards.

**This split is what made the U-shaped cost finding visible.** Gas is fixed per swap, so its share of a position falls as the position grows; impact is superlinear, so its share rises. A single "costs" number would show a curve with no explanation. Three numbers show *which* arm of the U you are standing on:

| | small position | large position |
|---|---|---|
| `gasUsd` | dominant | negligible |
| `impactUsd` | negligible | dominant |
| `spreadUsd` | linear in size — a constant share | same |

`06-economia.md` §9 carries the measured table and the test that asserts the shape rather than any particular number.

---

## 9. The reporting surface

Four getters beyond the port, all read-only, none of which any decision depends on:

| Getter | Type | Is | Read by |
|---|---|---|---|
| `equityCash` | `number` | cash only — the open position is **not** marked into it | `paper-run.ts` (`endingCashUsd`, `equityUsd`), both test files |
| `realisedGrossUsd` | `number` | mid-to-mid realised P&L, accumulated only on `closeAll` | `paper-run.ts` (`grossPnlUsd`) |
| `totalCosts` | `PaperCosts` | `{ spreadUsd, impactUsd, gasUsd }`, everything the chain took, split by cause | `paper-run.ts` (`costsUsd`), `paper-broker.test.ts` |
| `openTrades` / `closedTrades` / `rejections` | port members | as declared | see §6.1 for `rejections` |

```ts
export interface PaperCosts {
  readonly spreadUsd: number
  readonly impactUsd: number
  readonly gasUsd: number
}
```

`equityCash` excludes the open position on purpose — `paper-run.ts` adds it back explicitly at the last close, so the two components of equity are never silently blended:

```ts
const openPositionUsd = broker.openTrades.reduce((sum, t) => sum + t.qty * lastClose, 0)
const equityUsd = broker.equityCash + openPositionUsd
```

**These getters are the OFFLINE reporting surface.** Production does not read any of them, and §10.2 is why.

---

## 10. `seed` — the fills are the facts

### 10.1 The problem it solves

The engine runs as a **one-shot process**: wake, advance the bars it missed, write everything down, exit. A broker that keeps its position in memory is therefore flat on every wake-up, and the strategy would never see the position it opened fifteen minutes ago. That is not a hypothetical — it is half of the bug in which five live positions showed `0 compra / 0 venta`:

> `PaperBroker` kept its position in memory, and the engine now wakes as a one-shot process. Every cycle started flat, so even with execution the strategy would never have seen what it opened fifteen minutes earlier.

```ts
/** A recorded fill, as the store keeps it. Structural, so the broker stays free of the persistence types. */
export interface SeedFill {
  readonly orderId: string
  readonly side: 'buy' | 'sell'
  readonly time: number
  readonly price: number
  readonly qty: number
  readonly costUsd: number
  readonly comment: string
}
```

`SeedFill` is **structurally** compatible with `PersistedFill` rather than importing it — which is what keeps an infrastructure broker from depending on the persistence module. `store.fillsFor(id)` rows satisfy it as they are.

### 10.2 What it rebuilds, and what it does not

```ts
seed(fills: readonly SeedFill[]): void {
  const ordered = [...fills].sort((a, b) => a.time - b.time)
  ...
}
```

Sorted first, *"because a store returns rows and rows are not a queue"* — pinned by a test that seeds the same history reversed and demands the same snapshot.

| Rebuilt exactly | Not rebuilt |
|---|---|
| `open` — every rung, with its id, price, qty, commission and comment | `closed` — a seeded sell removes the trade; it does not record one |
| `cash`, therefore `equityCash` | `costs` — `chargeCosts` is never called from `seed`, so `totalCosts` starts at zero |
| the snapshot the strategy reads | `grossUsd`, so `realisedGrossUsd` starts at zero |
| the pyramiding count a restart must respect | |

The source states the third of those. It is worth stating all three together, because the consequence is the same for each: **after a restart, the broker's three reporting getters describe only the current process**, and in production every cycle *is* a new process. Which is precisely why the screen and the allocator do not read them. `src/application/ledger.ts` walks the `fills` table instead — one implementation, because the dashboard, the allocator and the common fund all need the answer and any two of them disagreeing is how a trading dashboard starts lying. See `09-persistencia.md` §11.2 and `11-vistas.md`.

### 10.3 One gas charge per sell *timestamp*

```ts
let lastSellTime: number | null = null
...
this.cash += fill.price * fill.qty
if (lastSellTime !== fill.time) {
  this.cash -= this.config.gasUsdPerSwap
  lastSellTime = fill.time
}
```

> A close sells EVERYTHING in one swap, so its fills share a timestamp and one gas charge between them.

This is the mirror of §5: `execute` charges one gas for a `closeAll` that produced six fills, so the rebuild must charge one gas for those same six rows. Buys have no such rule — each buy fill is its own swap and pays its own gas, which matches `execute` charging gas per entry order.

The rule is **timestamp-keyed, not order-keyed**, and `lastSellTime` remembers only the previous sell. Both are fine for anything the engine can produce: sells arrive contiguously after the sort, and a buy between two sells of the same timestamp does not reset the marker (the buy branch `continue`s without touching it). Two genuinely distinct closes landing on the same millisecond would share one gas charge — unreachable, since a `closeAll` leaves the broker flat and the second would be rejected `'flat'`.

Correctness is pinned by round-trip tests rather than by arithmetic: seed a fresh broker with what a live one recorded, and `equityCash` must match to nine decimals — for two entries, for a ladder six rungs deep, and for one already at the pyramiding ceiling.

### 10.4 The `entryPrice`-as-mid caveat

```ts
entryPrice: fill.price,
entryMid: fill.price,
```

A recorded fill carries the price that was paid. It does **not** carry the untouched mid that price was derived from, and nothing in the schema does. So a seeded trade reports its entry price as its mid, and any gross figure computed from it reads as net.

Stated in the source rather than left to be discovered:

> Seeded trades report their entry price as their mid, so gross reads as net for them — stated here rather than silently wrong, and the number is a report, not a decision.

That last clause is the whole defence. `realisedGrossUsd` feeds a summary line in `paper-run.ts` and nothing else; no order size, no gate, no allocation reads it. A number that is a report may be approximate as long as it says so.

### 10.5 Seeding does not enforce the cap

`seed` pushes every buy onto `open` without consulting `maxOpenEntries`. If the recorded history holds more rungs than the current configuration allows — `OPERADOR_MAX_DCA` was lowered between cycles, say — the rebuild will hold them all.

This is the right behaviour, and only one of the two possible ones is: refusing to rebuild a rung that a wallet genuinely holds would make the engine's belief diverge from the fills, which is the failure `09-persistencia.md` calls the worst of the three. The cap still binds where it can act — on the next `execute`, pinned by *"rebuilds a ladder that is already at the pyramiding ceiling"*:

> The machine signals to 50; the venue fills ten. A restart must not be a way to get an eleventh past the cap.

---

## 11. `snapshot` — what the strategy actually reads

```ts
snapshot(close: number): PositionSnapshot {
  if (this.open.length === 0) return { size: 0, avgPrice: null, openProfit: 0 }
  let size = 0, cost = 0, openProfit = 0
  for (const trade of this.open) {
    size += trade.qty
    cost += trade.entryPrice * trade.qty
    openProfit += (close - trade.entryPrice) * trade.qty
  }
  return { size, avgPrice: cost / size, openProfit }
}
```

| Field | Is | Is not |
|---|---|---|
| `size` | units held | USD |
| `avgPrice` | `Σ(entryPrice · qty) / Σ qty` over **open trades only** | the average of the trigger prices, and not a basis that includes anything already sold |
| `openProfit` | marked at `close`, **gross of the exit** — nothing has been sold, so no exit cost exists yet | net of what leaving would cost |

Three consequences, each of which has bitten somewhere in this repository:

- **`entryPrice` carries its slippage**, so the basis is above the mids the ladder triggered at. Six rungs at 1, .95, .90, .85, .80, .75 have a nominal mid of 0.875 and come out at **0.8792 (+0.48%)**, because every rung paid the venue on the way in. A `+2%` profit target on a six-deep ladder therefore needs the price to travel nearly 2.5%. Asserted directly: `expect(avgPrice / nominal - 1).toBeCloseTo(0.0048, 3)`.
- **Open trades only.** A position that closed and re-entered has a basis for what it holds now, not for everything it ever bought. This is the same rule `positionLedger` implements as a walk, and for the same reason — the two agree by construction, which is what lets the screen and the strategy never disagree about what a position cost.
- **`avgPrice` is what `refusesToSellAtALoss` compares against**, and it compares it to the bar's **open** — the mid. The actual sell price is that mid *minus* spread and impact. So the guard permits a sale at `open ≥ avgPrice` that then realises slightly **below** the basis. It bounds the loss to the exit's own cost; it does not eliminate it. See `08-motor.md` §4.

The flat case returns a fresh literal rather than `state.ts`'s exported `FLAT`, so the two are equal by value and never the same object. Pinned by *"is flat before any fill"*, which asserts the shape with `toEqual`.

---

## 12. Where it is wired

| Caller | Construction | Seeded? |
|---|---|---|
| `src/runtime/main.ts` → `brokerFor` | one broker **per position**, cached in a `Map` by position id | yes, `store.fillsFor(position.id)` on first construction |
| `src/runtime/retire.ts` | one, for the manual retirement of a token | yes — *"exactly as the engine does it. The fills are the facts; anything else would be a second opinion about what is held."* |
| `src/application/paper-run.ts` | one per offline run | no — the run starts flat by definition |
| `src/application/replay.ts` | whatever the caller passes | n/a |

**One broker per position is charter constraint 8 (position isolation) implemented at the only layer that can implement it in paper mode:**

> In paper mode every position keeps its own broker, so one position's cash can never be spent by another — the same isolation the live wallets will need to enforce for real.

`brokerFor` is `async` precisely so it can await `fillsFor` before returning — the seed has to happen before the first `execute`, and the first `execute` is step 0 of the tick.

Inside `tickPosition`, the call is guarded twice:

```ts
if (await store.hasFill(key)) continue        // the store would reject it anyway…
if (refusesToSellAtALoss(...)) { ... continue }
const fills = broker.execute([order], barOpen, barTime)
```

> Guarded here as well as in SQL: the store would reject the duplicate anyway, but a second `execute()` would also move the broker's cash.

That is the difference between an idempotent *record* and an idempotent *simulation*. `ON CONFLICT DO NOTHING` protects the table; nothing protects the broker's cash except not calling it twice.

Orders are executed **one at a time**, not as a batch, so each fill can be keyed to the order that caused it — and keyed by the bar the order was *decided* on, which is how recovery looks it up. A `closeAll` producing six fills writes the first under the order's canonical key and suffixes the rest (`#1`, `#2`, …). See `08-motor.md` and `09-persistencia.md`.

---

## 13. Known gaps and traps

- **Nothing in production reads `rejections`** (§6.1). No alert, no persisted row, no screen. A `'capital'` or `'pyramiding'` rejection is invisible from outside, and "the broker refused every order" looks identical to "the strategy had no signals". The largest open gap in this chapter; the sizing fix removed the known cause, not the blind spot.
- **`totalCosts` and `realisedGrossUsd` reset on every cycle** (§10.2), because the engine is a one-shot process and `seed` does not rebuild them. Reading them from a production broker would report the costs of one tick as the costs of the run.
- **The broker never calls `assertMarketQuality`.** A quality with zero effective depth makes `impactPctFor` return `Infinity`: an entry then fails `cash < spent + gas` and is recorded as `'capital'` — the wrong cause on the record — and a `closeAll` would compute a **negative infinite** fill price and destroy the broker's cash. Unreachable from the runtime, where quality comes from a measured quote, but nothing in this file prevents it. `assertMarketQuality` exists and is called only by `expectedFillCostPct`.
- **`commonFund.netUsd` subtracts slippage that is already inside the fill prices.** `positionLedger` realises `sold × (fill.price − avg)` — both prices carrying their slippage — and `commonFund` then subtracts `costsUsd`, which is the sum of `fill.costUsd`, i.e. that same slippage plus gas. The broker avoids exactly this double count by keeping `entryMid` (§7); the fills-based path has no mid to keep. The error is in the **conservative** direction — the fund is understated, never overstated, so it can only make the allocator spend less than it could — but it is not the identity this chapter proves. Owned by `09-persistencia.md` §11.2 and `11-vistas.md`; recorded here because §7 is where the correct form of the arithmetic lives.
- **`gasUsdPerSwap` is a configured constant**, not a measurement. `OPERADOR_GAS_USD` defaults to `0.05`. Solana priority fees move; nothing re-reads them, and the derived gas floor moves with this number (`06-economia.md` §4).
- **`spreadPct` is configured too** — `0.3` in `main.ts` — so the term the broker charges first on every fill is the one nobody verifies per venue.
- **Solana's ~$0.40 ATA rent is not modelled.** The charter names it; the broker charges gas per swap and nothing else fixed.
- **No partial fills, no failed transactions, no MEV, no reverts.** An order either fills entirely at the modelled price or is rejected. A real chain has a fourth outcome — submitted, and then nothing — which is what makes recovery's `'unknown'` verdict necessary in live and lets it be `'not-filled'` in paper (`09-persistencia.md`).
- **Impact is a first-order model**, `usd / (depth/2)`, not a reproduction of any particular AMM curve. It is calibrated from a measured quote at one size and extrapolated to others. `14-pruebas.md` names the matching gap plainly: the charter asks for the slippage model to be validated against realised swaps, and no swap has ever been executed.

---

## 14. Cross-references

| Chapter | For |
|---|---|
| `01-vision-general.md` | what paper mode is inside the whole system; position isolation as constraint 8 |
| `03-estrategia-cascade-dca.md` | why `qty` is sized at the signal close and fills at the next open; the 50-signalled / 10-fillable split |
| `06-economia.md` | `sizeLadder`, the three budgets, effective depth, the gas floor, the capital floor experiment, cost as a U |
| `08-motor.md` | `tickPosition` step 0, `refusesToSellAtALoss`, the catch-up walk, `ledger.ts` |
| `09-persistencia.md` | the `fills` table, idempotency keys, `positionLedger`, recovery's three verdicts |
| `10-adaptadores.md` | where `MarketQuality` and the sell quote come from, and how each provider fails |
| `11-vistas.md` | what the screen shows and which walk it shows it from |
| `12-runtime-despliegue.md` | `loadConfig`, `brokerFor`, the composition root, why live mode refuses to start |
| `14-pruebas.md` | the two simulators as production code rather than doubles; the untested slippage claim |
