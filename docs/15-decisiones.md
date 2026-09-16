# Decision log and lessons paid for

This chapter is the record of what the live market taught this system, in roughly the order it taught it. Every entry is a decision that exists because something broke, and every one of them is still visible in the code — as a guard, a derived number, a test name, or a comment that reads like an incident report. The format is uniform on purpose: **symptom** (what was observed, usually on the production dashboard), **root cause** (what was actually wrong, which is almost never what it looked like), **fix** (the code, with file and signature), and **lesson** (the general rule, stated so it can be applied to code that has not been written yet). The engine's mechanics are in `08-motor.md`, the scanner's in `04-escaner.md`, the sizing arithmetic in `06-economia.md`; this chapter does not re-derive them. It records why they are shaped the way they are.

Two things to keep in mind while reading. First, almost none of these were caught by a type error or a failing test — they were caught by looking at a screen and finding a number that could not be true. Second, the same three shapes recur: *a fix that was written but never wired*, *a number that was documented but never configured*, and *a sentinel or a unit that meant one thing in one file and another next door*. Section 13 names those shapes explicitly, because recognising them is worth more than any individual fix below.

---

## 1. The log at a glance

Chronological. Commit hashes are on `main`; the dates are the commit dates.

| # | Date | Incident | Symptom on the screen | Commit |
|---|---|---|---|---|
| 1 | 2026-09-14 | **The missing execution layer** | Five positions, $1,425 committed, `0 compra / 0 venta` | `4184665` |
| 2 | 2026-09-14 | **The broker state that did not survive a process** | (same commit) every cycle would have re-opened what it already held | `4184665` |
| 3 | 2026-09-14 | The ladder sized against the pool but not the wallet | A $285 position emitting $1,000 entries, silently rejected | `11d7319` |
| 4 | 2026-09-14 | The machine that believed in a trade the broker refused | Five positions at level 1 holding nothing, waiting forever | `d6b9e5f` |
| 5 | 2026-09-14 | **The documented-but-unconfigured $15 cap** | Production running the TradingView backtest's $1,000 level 0 | `d68eb8b` |
| 6 | 2026-09-15 | **The clock that made `confirmBars` mean eleven hours** | Ten entries, six exits, zero DCA fills | `d21b745` |
| 7 | 2026-09-15 | **The exit that filled below cost** | BinanceTown sold at **-13.1%** under the comment `🏁 Exit` | `d21b745` |
| 8 | 2026-09-15 | **The impersonation gate that knew WBTC and not BTC** | A 15-day-old memecoin allocated under the ticker `BTC` | `6b06db2` |
| 9 | 2026-09-15 | **The stale $200 slot floor** | $950 freed, and the book still capped at four slots | `83702bf` |
| 10 | 2026-09-15 | **Profit vanishing with a closed position** | The best-performing token ceded its slot and its gain disappeared | `017b87c` |
| 11 | 2026-09-15 | **The sentinel that meant two things** | `slotsLeft = -5`, the book frozen at five, 38 candidates waiting | `d4c0465` |

And the companion set — same shapes, smaller blast radius, documented in section 12:

| Date | Incident | Commit |
|---|---|---|
| 2026-09-14 | The examination budget that never rotated (106 tokens permanently unchecked) | `2d99bee` |
| 2026-09-14 | A thin pool counted as a bullet dodged (`insegura 219, filtrada 6`) | `9e2f6a3` |
| 2026-09-14 | The placeholder price that froze every new Solana position; BSC with no death watch | `8418e75` |
| 2026-09-14 | CREPE: $718k reported liquidity, 98% impact on a $285 sell | `24c88d4` |
| 2026-09-14 | Recovery halting five healthy positions on a venue we own | `2248f97` |
| 2026-09-15 | GitHub's cron treated as a clock (three runs in twelve hours) | `d9f416e` |
| 2026-09-15 | The entry alert that called a re-opening a DCA | `80c1c53` |
| 2026-09-15 | A reservation holding a slot for five hours and twenty minutes | `46d1ed2` |
| 2026-09-15 | Capital immobilised against rungs that do not exist ($950 idle) | `12be8ad` |
| 2026-09-15 | A restart that owed a scan it already had | `2ade823` |
| 2026-09-15 | A working engine that looked hung (four minutes of empty log) | `edbb3c6` |

---

## 2. The missing execution layer

**Commit `4184665`, 2026-09-14 — `feat(engine): actually execute the orders`.**

### Symptom

The dashboard went live and showed five open positions, $1,425 committed, and `0 compra / 0 venta`. It was telling the truth.

### Root cause

`tickPosition` decided orders, wrote them to `pendingOrders`, sent the alerts, and returned. Nothing ever submitted them. `recordFill` had no caller anywhere outside the two stores that implement it, and `broker.execute` was reached only from `replay.ts` — the backtest path. The live engine was a decision engine with no execution: busy, and completely still.

The thing that makes this hard to see from inside is that every individual piece was correct and tested. The strategy emitted the right orders. The store persisted them. The broker knew how to fill them. The alert went out. Only the edge between "decided" and "sent" was missing, and no unit test covers an edge that does not exist.

### Fix

Step 0 of `advanceOneBar` in `src/application/engine.ts` **is** that missing layer. It runs before anything else in the bar, because every number the strategy is about to read — size, average cost, open profit — comes from the broker, and the broker is rebuilt from these fills on the next wake-up:

```ts
for (const order of position.pendingOrders) {
  const key = idempotencyKeyFor(position.id, position.lastBarTime, orderKeyPart(order))
  if (await store.hasFill(key)) continue
  ...
  const fills = broker.execute([order], barOpen, barTime)
  for (const [index, fill] of fills.entries()) await store.recordFill({ ... })
}
```

Three details in there are each their own small decision:

- **Order by order, not all at once**, so each fill can be keyed to the order that caused it.
- **Keyed by the bar the order was DECIDED on** (`position.lastBarTime`), not the bar it fills at. The first version wrote the filling bar. Recovery looks a fill up by exactly the deciding-bar key, so the two would never have matched — and recovery would have **halted every position the engine had just successfully traded**, the precise opposite of what recovery is for. Pinned by `engine.test.ts`: *"keys a fill so recovery recognises it, instead of halting a position it just traded"*.
- **`store.hasFill(key)` is checked even though SQL enforces uniqueness**, because the store rejecting a duplicate row does not stop a second `broker.execute()` from moving the broker's cash.

One `closeAll` sells every open rung, so it produces several fills for one order. The first carries the canonical key; the rest are suffixed `${key}#${index}`. Without the suffix the store's `ON CONFLICT DO NOTHING` would silently swallow five of six sell fills. Pinned by *"records one fill per rung, each keyed apart so none collides"* — 6 sells, 6 distinct keys.

### Lesson

**A silent rejection is indistinguishable from a strategy with no signals.** This is the single most dangerous failure shape in the system, and it has now appeared three times (here, in §4, and in §5). Anything that quietly does nothing looks exactly like a component being appropriately conservative.

And the corollary that became a rule in `CLAUDE.md`: **anything the offline experiment does and the engine does not is not a fix; it is a rehearsal of one.** `paper-run.ts` had been calling the real thing for weeks.

---

## 3. The broker state that did not survive a process

**Same commit, `4184665`.** It is listed separately because it is a different bug that would have made the first fix useless.

### Symptom

None yet — this one was caught before it could produce one, by reasoning about what the first fix would do.

### Root cause

`PaperBroker` keeps its open trades, cash and pyramiding count in memory. The engine wakes as a **one-shot process**: read the database, decide, write, exit. So every cycle started with a flat broker. Adding execution alone would have had the strategy re-open, every fifteen minutes, a position it already held — and the pyramiding cap would have reset with it.

This is a direct consequence of the runtime decision documented in `12-runtime-despliegue.md`: the engine does not need a server because nothing lives in memory between cycles. That is true *only* if nothing is allowed to live in memory between cycles.

### Fix

`PaperBroker.seed(fills: readonly SeedFill[]): void` in `src/infrastructure/brokers/paper-broker.ts` rebuilds open trades and cash from the recorded fills, and `CycleDeps.brokerFor` is async precisely so it can do so:

```ts
readonly brokerFor: (position: PersistedPosition) => Promise<BrokerPort>
```

`main.ts` wires it as `broker.seed(await store.fillsFor(position.id))`. Forget that call and every position re-opens from level zero forever.

The seed sorts the fills first (*"a store returns rows and rows are not a queue"*), and charges one gas per sell *timestamp* rather than per sell fill, because a close sells everything in one swap.

What it explicitly cannot rebuild is `realisedGrossUsd`, which needs each entry's untouched mid and that is not a field on a fill. Seeded trades report their entry price as their mid, so gross reads as net for them. The code says so:

> stated here rather than silently wrong, and the number is a report, not a decision.

### Lesson

**The fills are the facts.** This sentence appears in four separate places in the codebase and it is the same principle each time: the broker's memory, the cascade's level and the dashboard's totals are all derived views, and when any of them disagrees with the recorded fills, the fills win. §4 and §10 are both this same rule applied elsewhere.

Second lesson: **a process-model decision creates obligations elsewhere.** "One-shot process" is a deployment choice that silently imposed "nothing may be stateful" on every component, and the component that violated it was not in the deployment layer.

---

## 4. The ladder sized against the pool but not the wallet

**Commit `11d7319`, 2026-09-14 — `fix(engine): size the ladder to the wallet, not to Pine`.**

### Symptom

Five positions, each allotted $285, each emitting a $1,000 entry. The broker refused every one of them for funds and recorded nothing, so the screen showed what it always shows in that case: a strategy that appears to have no signals.

### Root cause

The ladder in the strategy speaks in Pine's nominal sizes — level 0 is $1,000, level 1 is $2,200 — and a position holds whatever the portfolio allotted it. `sizeLadder` and `scaledParams` exist to reconcile those two, were tested, and were named in `CLAUDE.md` as the fix for exactly this. **Only `paper-run.ts` ever called them.** The live tick never did.

This was the second time in one day that the same shape surfaced: a function written, tested, documented as the answer, and reached only by the offline path.

### Fix

`tickPosition` now sizes once per tick, before the bar walk:

```ts
const sizing = sizeLadder(
  config.params,
  input.position.quality,
  config.sizing ?? DEFAULT_SIZING_POLICY,
  deployableCapital({ initialCapital: input.position.capitalUsd, gasUsdPerSwap: ..., maxOpenEntries: ..., params: config.params }),
)
const params = sizing.tradeable ? scaledParams(config.params, sizing) : config.params
```

It scales the **params**, not the orders, which keeps the shape of the ladder — growing size as price falls — while matching its scale to the venue and the wallet. Once per tick rather than per bar, because neither the wallet's capital nor the pool's quality moves within a catch-up.

One rule shipped alongside it, in step 3 of `advanceOneBar`:

```ts
const orders = walk.tradeable ? afterDeath : afterDeath.filter((o) => o.kind !== 'entry')
```

**A pool too thin to size against stops entries and never stops exits.** Trapping money already in an untradeable pool is worse than refusing to add to it.

### Lesson

Same as §2 — a written, tested, documented fix that nothing calls is not a fix — plus a specific one: **when two layers speak in different units (Pine's nominal USD and the wallet's actual USD), the translation between them is a component, and a component nobody calls is not a translation.**

---

## 5. The machine that believed in a trade the broker refused

**Commit `d6b9e5f`, 2026-09-14 — `fix(engine): the broker is the truth about what is held`.**

### Symptom

Five positions sat at `level: 1` holding nothing. It would have waited forever.

### Root cause

The entry had been signalled, the broker refused it for funds (§4), and the state machine advanced anyway — so it waited for a DCA trigger against a cost basis that never existed, on a ladder of pure fiction, with the capital held hostage by a trade that never happened.

The machine advancing on the **signal** is Pine's semantics and the parity harness depends on it, so that behaviour stays. What was missing was the reconciliation.

### Fix

Step 1a of `advanceOneBar`:

```ts
const beforeStrategy = broker.snapshot(barClose)
const desynced = beforeStrategy.size === 0 && position.pendingOrders.length === 0 && position.cascade.level > 0
const cascadeIn = desynced ? initialState() : position.cascade
```

All three clauses are load-bearing. **Flat WITH something pending is a normal state for exactly one bar** — decided at a close, filled at the next open — so dropping the `pendingOrders.length === 0` clause would reset a healthy position's cascade on every bar between a decision and its fill. Pinned by *"does NOT resync while a decided order is still waiting to fill"*.

It resets to flat rather than attempting to reconcile, so the next order the machine can emit is an **entry** — correctly sized this time — rather than a DCA against a basis that never existed. And it sends an unthrottled `position-halted` alert, because *"a silent resync would hide the very rejections this is compensating for."*

### Lesson

**When a derived view and the ledger disagree, the derived view is wrong by definition, and the disagreement must be loud.** A reconciliation that fixes itself quietly removes the evidence of whatever caused it.

---

## 6. The documented-but-unconfigured $15 cap

**Commit `d68eb8b`, 2026-09-14 — `fix(config): the $15 ladder was documented, never configured`.**

### Symptom

Production ran a $1,000 level 0 and a $2,200 level 1 — the TradingView backtest's sizes — against positions holding $285.

### Root cause

`CLAUDE.md` had described a $15-per-level ladder as *the* production setting ever since the 15-minute bar decision. The runtime passed `DEFAULT_PARAMS` straight through. The charter described a configuration that the code had never been given.

And `DEFAULT_PARAMS` could not simply be edited, which is why this had drifted: the parity harness asserts those params are exactly the inputs TradingView ran with. They are **evidence**, not preference, and editing evidence to express a preference destroys the one proof the whole port rests on.

### Fix

Production composes its own values on top, rather than editing the reference. `src/runtime/main.ts`:

```ts
params: { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel },
```

And the two numbers that differ were later (commit `b029fad`) moved into their own dependency-free module, `src/application/production-ladder.ts`, because two things need them and neither may own them:

```ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15
export const DEFAULT_MAX_DCA_PER_TOKEN = 5
export function productionLadder(env): { maxUsdPerLevel: number; maxOpenEntries: number }
```

`productionLadder` adds 1 to `OPERADOR_MAX_DCA` because the entry is not a DCA rung: five DCAs means six open entries. It falls back silently on any non-positive or non-finite env value rather than trading on `NaN`.

What the cap actually does is change the ladder's **shape**, not just its size: `min(1000 × (1 + 1.2n), 15)` is $15 at every level, so the ladder is flat rather than growing. Six fills come to about $90, where gas at $0.05 a swap is 0.33% of each — which is what makes a ladder this small viable at all. The old hardcoded $20 minimum fill would have refused it outright; see the derived gas floor in `06-economia.md`.

The reference values are protected by an assertion in `production-ladder.test.ts` — *"never expresses itself by editing the evidence"* — which checks literally that `DEFAULT_MAX_USD_PER_LEVEL !== DEFAULT_PARAMS.maxUsdPerLevel` (15 vs 5,000) and `DEFAULT_MAX_DCA_PER_TOKEN + 1 !== PYRAMIDING` (6 vs 10).

### Lesson

**Documenting a choice is not making it.** This is now stated verbatim in `CLAUDE.md` at the place where the choice is claimed, along with the admission that the charter asserted it for weeks while the code did something else.

The structural half of the lesson: **evidence and preference must live in different files.** `DEFAULT_PARAMS` and `PYRAMIDING` are what TradingView ran; `production-ladder.ts` is what this operator prefers. A codebase where the two share a home will eventually have someone edit the evidence, and then the parity harness proves nothing.

---

## 7. The clock that made `confirmBars` mean eleven hours

**Commit `d21b745`, 2026-09-15 — `fix(engine): walk every bar, and never sell into a fall`.**

### Symptom

Ten entries, six exits, and **not one DCA fill**. The cascade never cascaded. No parameter was wrong.

### Root cause

The engine advanced **one bar per call**, which is correct only while a cycle is faster than a bar. Measured in production: ten cycles in five hours forty minutes, gaps of 30 to 67 minutes, against 15-minute bars. The engine saw **ten of every twenty-two bars**.

Every parameter counted in BARS therefore silently changed meaning. With `DEFAULT_PARAMS.confirmBars = 20`:

| | Intended at 15m | Actual, seeing 10 of 22 bars |
|---|---|---|
| `confirmBars: 20` | 5 hours | **~11 hours** |
| Swing-high lookback 20 | 5 hours | ~11 hours |
| EMA-200 | 50 hours | ~110 hours |

Eleven hours is longer than these positions live. The rebound confirmation — lock 3 of the five anti-stacking locks (see `03-estrategia-cascade-dca.md`) — could never complete, so the ladder never armed a single rung.

This is the most instructive bug in the log because **nothing was broken**. Every indicator was right, every lock was right, every threshold was the tested one. The unit in which one of the inputs was denominated had quietly changed underneath all of them.

### Fix

`tickPosition` walks every missed bar. `firstUnprocessedBar` finds where to start and the loop runs to the newest closed bar:

```ts
function firstUnprocessedBar(times: readonly number[], lastBarTime: number, last: number): number | null {
  if (lastBarTime < 0) return last
  const next = times.findIndex((time) => time > lastBarTime)
  if (next < 0) return null
  return Math.max(next, last - MAX_CATCH_UP_BARS + 1)
}
```

Four decisions are encoded in those five lines:

| Line | Decision | Why |
|---|---|---|
| `lastBarTime < 0 → last` | A brand-new position starts at the **newest** bar | `-1` means "no history of its own", not "infinitely behind". Replaying the provider's 1000-bar window would open a ladder at prices days old. |
| `findIndex(time > lastBarTime)` | Strictly after the last processed bar | `lastBarTime` remains the never-decide-twice guard: a crash after saving but before submitting comes back and does nothing. |
| `next < 0 → null` | Up to date is a first-class result (`skipped: 'already-processed'`) | |
| `Math.max(next, last - 95)` | **`MAX_CATCH_UP_BARS = 96`** — a day at 15m | Past that the engine was not late, it was **down**, and replaying a week would fill a ladder from a market that is gone. The position still ends up current. |

Two performance properties make the walk viable rather than quadratic:

- **The ladder is sized once**, not per bar (§4) — neither the wallet nor the pool moves within a catch-up.
- **Indicators are computed once** over the whole series via `computeSignals(candles, params)`, because every indicator in the port is causal (reads backwards only), so the context at bar *i* is identical whether the series ends at *i* or at the end.

And one correctness guard that is easy to miss:

```ts
health: barIndex === last ? input.health : null,
```

**One health observation is applied to at most one bar of a walk.** The reading is a measurement of *now*, not of each bar that went by; applying it per replayed bar would let a single observation accumulate into the N consecutive confirmations the death-exit policy requires, and liquidate a healthy position. See `05-riesgo.md` for why the policy demands consecutive readings.

The pending-order execution is also indexed to the right bar: pinned by *"executes a pending order at the bar that FOLLOWS the decision, not at the newest"*, which asserts `entry.time === candles.time[295]` for an order decided at bar 294 in a series ending at 299. Booking it five bars away from the decision that caused it would have been a subtler version of the same unit error.

Separately, the scheduling half of this was fixed in `d9f416e`: a `*/15` GitHub Actions cron produced three runs in twelve hours, 137 and 172 minutes apart. GitHub deprioritises high-frequency schedules and says so — best effort is the contract. The run therefore stopped being one cycle and became the loop (~20 cycles at 15-minute pacing, ~5 hours per run), with a concurrency group turning the schedule into a queue rather than a clock. See `12-runtime-despliegue.md`.

### Lesson

**A slow scheduler must be a latency problem, never a semantic one.** If any parameter in a system is counted in units of "things the loop observed", then the loop missing observations silently rewrites the configuration. The fix is not to make the loop faster; it is to make the work independent of how often the loop runs.

Stated generally: **when a system counts events, it must consume every event, not every event it happened to be awake for.** Everything else follows.

---

## 8. The exit that filled below cost

**Same commit, `d21b745`.** The second defect in it, and independent of the first.

### Symptom

Production sold BinanceTown at **-13.1%** under the comment `🏁 Exit`.

### Root cause

"Never exit at a loss" was enforced at **decision** time, where price is above average cost by construction — the normal exit rule is `close > avg_cost * (1 + min_profit/100)`. It leaked at **execution** time, where the next bar's open can be anywhere. The gap between that deciding close and that filling open was **-14.8%**.

On 15-minute small caps the execution gap is routinely **larger than the entire +2% profit target**, so a rule that only holds at the close does not hold at all. This is not a tuning problem; it is a rule enforced in the wrong place.

It is worth being explicit that this is not a preference. The no-loss rule is a premise of the strategy: the ladder's whole argument is that a drop is an opportunity to average down, so selling into one destroys the edge the system exists to harvest.

### Fix

A real venue can look at the price before sending the order, so now it does. In `src/application/engine.ts`:

```ts
function refusesToSellAtALoss(order: Order, avgPrice: number | null, fillPrice: number): boolean {
  if (order.kind !== 'closeAll') return false
  if (order.comment === DEATH_EXIT_COMMENT) return false
  if (avgPrice === null) return false
  return fillPrice < avgPrice
}
```

Four properties of that function, each with a reason:

1. **The death exit is exempt**, and it is not really an exception — it answers a different question. A stop loss sells because the **price** fell; a death exit sells because the **asset stopped being an asset**, and holding out for a better price on something unsellable is how you hold it forever. See `05-riesgo.md`.
2. **The comparison is against the AVERAGE cost of everything held**, never the last rung. Six rungs down, the average sits far below the first entry, so a sale under the opening price can be a healthy profit. A guard reading the wrong fill behaves backwards exactly at depth and nowhere shallower — which is precisely where it matters. Pinned by the deep-ladder fixture: rungs at 1, 0.95, 0.9, 0.85, 0.8, 0.75 give a basis of exactly **0.875**; an exit at **0.92** is allowed (green on the position, deeply red on the first rung) and an exit at **0.80** is refused (above the 0.75 last rung, below the basis).
3. **`avgPrice === null` is not a refusal.** Nothing held means no basis and no loss to make.
4. **Nothing is rolled back**, and that is deliberate rather than lazy. `stepCascade` resets the cycle on `!inPosition && wasInTrade` — it reacts to the **broker** going flat, never to the exit being *signalled*. A sale that does not happen leaves the broker holding, so the machine never resets and the ladder survives on its own. The obvious design here is a remembered pre-exit snapshot; it is unnecessary, and it would have needed a column the store does not have.

The human is told, throttled under the key `no-loss:${position.id}`:

> 🛡️ {symbol} no se vendió a pérdida — La salida se decidió con ganancia y la apertura siguiente quedó por debajo del costo promedio. La posición se mantiene y la escalera sigue viva.

### Lesson

**Enforce an invariant where it can actually be violated, not where it is convenient to state.** The decision site is where the rule is *expressed*; the execution site is where it is *tested*. A rule checked only where it is trivially true is decoration.

And the design note worth keeping: **when a refusal leaves the system in a state the state machine already handles correctly, adding rollback is adding a second source of truth.** The reason nothing needed rolling back is that the cascade already listens to the broker rather than to its own intentions — which is the same principle as §3 and §5.

---

## 9. The impersonation gate that knew WBTC and not BTC

**Commit `6b06db2`, 2026-09-15 — `fix(gates): the unwrapped majors were the one ticker anyone could borrow`.**

### Symptom

Found live, holding money. A fifteen-day-old Solana memecoin at `E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx`, wearing the ticker **`BTC`**, with a $267k pool, was scanned, ranked and **allocated** with not one blocker against it.

### Root cause

The impersonation gate (added in `9da417a`, after the first live scan proposed a fake "USDC" on Raydium with a $96k pool and 39% of supply in ten wallets) is a symbol → canonical-mint map:

```ts
const canonical = policy.canonicalSymbols[normaliseSymbol(snapshot.symbol)]
if (canonical !== undefined && canonical !== snapshot.address) {
  failures.push(fail('impersonation', 'failed', `"${snapshot.symbol}" at ${snapshot.address} is not the canonical mint`))
}
```

The map knew `WBTC` and did not know `BTC`. Bitcoin and Ether have **no native mint on Solana** — the wrapped tokens are the only things those names can honestly refer to — so the most recognisable tickers in crypto were the two symbols left completely unguarded. The gate was built from the list of tokens that exist, not from the list of names a victim would recognise.

Note how every other gate let it through *correctly*: a $267k pool is liquid enough, fifteen days is older than 24 hours, the security report was presumably clean. Nothing was wrong with the token as a token. It was wrong as a **name**.

### Fix

Both unwrapped names now point at the same wrapped mints in `SOLANA_CANONICAL_SYMBOLS` (`src/domain/scanner/gates.ts`):

```ts
BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',   // same mint as WBTC
ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',   // same mint as WETH
```

Which blocks every other address wearing those names and still lets the real ones through — pinned by a three-line test that asserts the live impostor address fails, a fake `ETH` fails, and the genuine wrapped mint passes under the name `BTC`.

The map now holds **13 symbols over 10 distinct mints**, with `BTC`/`WBTC`, `ETH`/`WETH` and `SOL`/`WSOL` each sharing one. Matching is lenient by design:

```ts
/** "usdc", " USDC ", "$USDC" and "USDC." all mean USDC to a victim. */
const normaliseSymbol = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
```

The gate lives in **both** `evaluateGates` and `evaluateMarketGates`, because it costs no network call and should therefore decide before the paid checks are spent.

### Lesson

**A denylist of identities does not protect against an attack on names.** The gate's model was "these mints are canonical"; the attack's model was "this string is recognisable". Enumerating what exists will always lag enumerating what can be claimed.

The operational version: **when a safety check is a list, ask what the shortest, most valuable item missing from it is.** Here it was three characters long and it was the most famous ticker in the asset class.

Shipped in the same commit, and a small instance of the same category of error: the dashboard rendered a checkpoint of `lastCompletedBar: 0` as **1 Jan 1970**. Zero is not a bar, it is the absence of one — which is exactly what a cycle that opens positions without ticking any produces — and an epoch date on a money screen reads as a dead engine, a worse lie than showing nothing.

---

## 10. The stale $200 slot floor

**Commit `83702bf`, 2026-09-15 — `fix(portfolio): the slot floor was a measurement that had been superseded`.**

### Symptom

Freeing $950 of capital (see §12, `12be8ad`) opened no new tokens. The book stayed capped.

### Root cause

`minPositionUsd: 200` in `DEFAULT_PORTFOLIO_POLICY` was a **real measurement**: the first capital-floor run placed literally zero orders below $200, because the pool-sized ladder had its own minimum and under it the broker rejected every entry for want of funds (finding 1 of the capital-floor experiment, `06-economia.md`).

Then sizing changed. `deployableCapital` began reserving gas for every swap of a full cycle plus `PRICE_HEADROOM_PCT = 5`, and the real floor where the system trades at all dropped to **under $50**. `CLAUDE.md` records that supersession a few sections after it records the original measurement. **The number never moved.** It kept dividing free capital by 200 and handing back four slots, however much was free.

The book was in fact capped twice over, and the lower cap was the stale one.

### Fix

The floor is **derived every cycle**, never remembered. `src/application/paper-run.ts`:

```ts
export function slotFloorUsd(params, maxOpenEntries, gasUsdPerSwap, minFillUsd): number {
  return ladderCapitalUsd({ ...params, maxUsdPerLevel: minFillUsd, baseUsd: minFillUsd, amountIncrement: 0 }, maxOpenEntries, gasUsdPerSwap)
}
```

The subtlety is **which ladder it prices**. Not the nominal one: `scaledParams` shrinks the ladder to what the wallet allows, so a smaller slot does not fail, it trades smaller rungs. What it *cannot* do is trade rungs the chain's fixed cost would eat. So the floor is the same ladder priced entirely at `minFillUsd` — which is itself `gasFloorUsd(gasUsdPerSwap, maxGasSharePct)`, another derived number (`06-economia.md`) — grossed up for price headroom, plus gas for a full cycle. About **$32** for six rungs at $0.05 a swap, and it rises with gas as it should.

The orchestrator overrides `policy.minPositionUsd` with it on every allocation, so the environment's value is a fallback for offline experiments only. The first attempt at this demanded the full **nominal** ladder and broke four tests by refusing to open anything at all; the tests were right and the attempt was wrong.

Two decisions rode along:

- **`targetPositionUsd: ladderNeeds`** — what a slot *should* get is the wallet a full ladder needs and not a dollar more, so the width of the book is the division rather than the size of each slot. This is finding 2 of the capital floor: **scale comes from more tokens, not more size per token.**
- **The floor is allowed to beat the concentration cap, loudly.** A position below the floor is a guaranteed zero while concentration is a probabilistic loss; refusing to trade in order to stay diversified is diversifying into nothing. `plan.floorOverrodeCap` raises a `provider-degraded` alert naming the percentage.

Three older tests had asserted slot *counts* that only held under the $200 floor. They were rewritten to assert the **intent** — halted capital stays committed, the fund buys more tokens than no fund, the net fund buys fewer than the gross — which is what each was actually about.

### Lesson

**A measurement that is copied into a constant stops being a measurement.** It becomes a claim, and claims do not update when the thing they measured changes. If a number can be derived from the code that determines it, derive it; a derived floor cannot go stale.

Second lesson, from the rewritten tests: **a test that asserts a count is coupled to every constant that feeds the count.** Asserting the intent survives the constants moving, which is the whole point given that the constants above are supposed to move.

---

## 11. Profit vanishing with a closed position

**Commit `017b87c`, 2026-09-15 — `fix(operations): profit does not leave when the position does`.**

### Symptom

Reported live by the user: a token that had made the most money ceded its slot, and its gain **vanished** — not shown as banked anywhere, as if it had never won.

### Root cause

`buildOperations` read `store.loadPositions()` and summed only those. A position that closed — released, retired or dead — leaves the working set, and its realised profit left the screen with it.

The fills were never lost. `fills` deliberately has **no foreign key** to `positions` for exactly this reason (see `09-persistencia.md`). Nothing was reading them.

And the part that makes it worse than cosmetic: the **allocator** counted that money, through `commonFund` over every fill, while the screen did not. Two answers to "how much have we made", disagreeing — and the one on the screen is the one you would believe.

### Fix

Both now come from the same walk. `src/application/operations-view.ts` reads `store.allFills()` and computes totals from `commonFund(allFills)`:

```ts
realisedUsd: fund.realisedUsd,
costsUsd: fund.costsUsd,
netUsd: fund.netUsd + built.reduce((s, p) => s + (p.unrealisedUsd ?? 0), 0),
```

The tape keeps departed fills too, labelled by the token address the position id carries (`chain:address:at`), *because the winning trade is exactly the one worth being able to read back*.

The single implementation is `src/application/ledger.ts`, and it is worth stating what it is, because three separate correctness arguments live in it:

```ts
export function positionLedger(fills: readonly PersistedFill[]): PositionLedger
export function commonFund(fills: readonly PersistedFill[]): CommonFund
```

- **It is a forward WALK, not a set of sums.** Totalling every buy ever made counts entries that were already sold, so a position that closed once and re-entered would report twice the capital it holds — and dividing that blend by every unit ever bought produces a cost basis the position never paid. A sale realises against the basis **at that moment** and leaves the basis unchanged for what remains, which is exactly why `realisedUsd` and `deployedUsd` can be separated at all.
- **`commonFund` groups by `positionId` before calling `positionLedger`.** Realised profit is defined against a cost basis, and a basis only means something within one position's own history; pooling every fill computes a basis neither position ever paid. Pinned by *"does not let one position's basis leak into another's profit"*, which uses a $1 buy and a $100 buy to catch precisely that.
- **Costs are subtracted**, because that cash was paid in real terms at the moment of each fill. A fund built on gross profit hands the allocator dollars the chain already took — on small caps, the single largest way a strategy that looks profitable is not. Pinned by a test comparing $300 realised with $0 costs against $300 realised with $320 of costs, and asserting the second opens **fewer** positions.

Two smaller guards in the same walk: `qty <= 0` returns a hard zero (floating point leaves a basis of ~1e-17 on zero units after a full exit, and that is noise, not a cost), and a sale larger than the recorded holding is capped with `Math.min(fill.qty, qty)` so a bad fill cannot invent profit out of a negative position.

### Lesson

**A read model that filters by "currently open" is answering a different question from the one on the label.** "How much have we made" is a question about history; "what do we hold" is a question about now. Joining the first to the second silently discards the answer.

The structural lesson is already in `CLAUDE.md` and this is the case that hardened it: **the numbers live in the application layer, not in the view, and there is exactly one implementation.** Two implementations of "how much are we up" will eventually disagree, and the one on the screen is the one you will believe. `positionLedger` is now read by the operations view, the allocator's capital trim, slot release and the common fund — one walk, shared, because any two of them disagreeing is how a book starts double-spending.

---

## 12. The sentinel that meant two things

**Commit `d4c0465`, 2026-09-15 — `fix(portfolio): zero means no ceiling everywhere it is read`.**

### Symptom

The book froze at five positions with **$950 of freed capital and thirty-eight candidates waiting**. The trim had worked perfectly — every position sat at exactly $95.087, committed down from $1,425 to $475 — and nothing opened.

### Root cause

`maxPositions: 0` had been given the meaning *"no ceiling — the capital decides"* inside `planPortfolio`, which is the honest default once every slot is the same size: what bounds the damage one token can do is then the **size** of a slot, not how many there are, and a count cap only leaves capital idle.

The orchestrator went on computing:

```ts
const slotsLeft = config.portfolio.maxPositions - keeping.length - recovery.halted.length
```

With five open that is **minus five**, and the guard is `slotsLeft > 0`. With an **empty** book it is zero, which fails the same guard — so under this configuration nothing would ever have opened at all.

### Fix

Read as infinity where a count is being subtracted, and converted back to `planPortfolio`'s own convention on the way out:

```ts
const uncapped = config.portfolio.maxPositions <= 0
const slotsLeft = uncapped
  ? Number.POSITIVE_INFINITY
  : config.portfolio.maxPositions - keeping.length - recovery.halted.length
// ...and on the way into planPortfolio:
maxPositions: uncapped ? 0 : slotsLeft,
```

Pinned by three tests under *"no ceiling means no ceiling"*: it keeps opening past the number already held, it fills the book to what the capital carries rather than to what is already in it, and it **still stops at an explicit ceiling**. Production runs `OPERADOR_MAX_POSITIONS` defaulting to `0`; at a ~$95 ladder, $1,500 is about fourteen tokens.

### Lesson

Stated in the code, and it generalises past sentinels:

> A sentinel that means one thing in one file and another next door is not a sentinel, it is a trap.

The arithmetic property is what makes this class of bug nasty: the magic value was chosen so that it is a **valid operand** of the operation that misinterprets it. `0 - 5` does not throw, does not warn, and produces a number that fails a plausible guard. A sentinel outside the domain of the surrounding arithmetic (`null`, `Infinity`) would have failed loudly at the first subtraction.

Corollary for review: **the dangerous case for a "means unlimited" sentinel is not the empty state, it is the populated one** — and here the empty state was broken too, which nobody had noticed because the book had never started empty with this configuration.

---

## 13. The companion set

Same three shapes, smaller blast radius. Each is documented in full in its own chapter; this is the incident and the rule.

### The examination budget that never rotated — `2d99bee`, 2026-09-14

**106 tokens sat permanently `sin revisar` in production.** They were not waiting in a queue; their turn never came. The security budget examines twenty per chain in provisional-score order, that order is deterministic, so every cycle examined the same twenty and everything below the cut waited forever. The fix is one line in `src/application/scan.ts`:

```ts
const unexamined = affordable.filter((market) => !remembered.has(market.address))
```

Only what is **not** already known competes for the budget, so a token examined this cycle is cached next cycle and the next cycle's budget reaches further down the list.

That trade lands on the one answer that matters most — a cached report can be two hours old and **the honeypot flag inside it is the part that ages worst** — so the other half shipped with it: `confirmSellable` asks the sell path again, right now, for the handful of tokens about to be opened. It is an addition, not a gate that fails closed on its own absence: when the port is not wired, positions open on the scanner's verdict as before. **Lesson: a deterministic priority order over a bounded budget is a starvation bug, not a prioritisation.**

### A thin pool counted as a bullet dodged — `9e2f6a3`, 2026-09-14

Production read **`insegura 219, filtrada 6`**. That imbalance is the tell: almost none of those 219 were dangerous. A token rejected by the free market gates is never examined, so it carries an all-null security report, and the gates **fail closed by design** — so every one of them came out the other side as a safety failure. Measured: **180 of 185** filtered tokens led with security blockers that were true and useless.

Fixed in two places. The scan marks unexamined tokens `securityChecked: false` (it had been marking them `true`, which was simply untrue — nobody had looked), and `universe-view.ts` reads an unexamined token by **why** it was rejected: a market failure makes it `filtered`, no market failure makes it `pending`. Only a token that was actually examined can be called `unsafe`. Note the three-state field: `true`, `false`, and **absent** — absent means "the scan did not say" and is treated as checked, for snapshots written before the field existed, which is why the code tests `securityChecked !== false` and never `!securityChecked`.

**Lesson: fail-closed is correct for a decision and wrong for a label.** "Nobody looked at this" and "we looked and it is dangerous" are different claims, and rendering them identically devalues the label that is supposed to make you look.

### The placeholder price, and the death watch BSC never had — `8418e75`, 2026-09-14

Two causes, three hours, five positions and no trades.

A position was created with `lastPriceUsd: 1`, and **the death watch sizes its sell probe from exactly that number**. So the first observation of a token trading under a cent asked "if I sell 285 units, do I get $285 back?", got about two dollars, called it implausible and **froze the position before it had done anything at all**. The orchestrator had the real price in its hand the whole time — the scanner had just measured it. Now:

```ts
lastPriceUsd: allocation.snapshot.priceUsd > 0 ? allocation.snapshot.priceUsd : null,
```

`null`, not a stand-in, when there is no price: the death watch skips an observation it cannot size, and skipping is honest.

The second half: the decimals lookup was Jupiter's token list for **both** chains, and Jupiter is Solana-only. It returned null for every BSC address — and that lookup stands in **front** of every sell probe, so the probe was never reached, `healthFor` returned null, and **a BSC position could not be frozen or exited no matter what happened to it.** The PancakeSwap probe was written, wired, documented as closing this exact gap, and never once called. (Third instance of the shape in §2.) `Erc20Decimals` asks the token itself, returning null on anything unreadable rather than defaulting to 18 — because assuming 18 on a 6-decimal token sizes a probe a million times wrong, and a probe that large comes back looking exactly like a honeypot on a healthy pool.

One test fixture is also fixed in that commit, **and it is the reason the placeholder survived**: it built a snapshot with `as TokenSnapshot` over an object with no price. *A cast that claims a shape it does not have is how a placeholder reaches production.*

### CREPE — `24c88d4`, 2026-09-14

The scanner checked honeypot, authorities, LP lock, holder concentration, liquidity, age, volume, FDV and history — and had **no gate on what it costs to leave**. CREPE made the case: **$718,000 of reported liquidity, and a $285 sell moves the price 98%.** It passed every gate and became a position.

`measuredImpactPct` now travels on the snapshot and the `impact` gate refuses above `maxReferenceImpactPct: 10`. The argument for a hard gate rather than the score penalty already there: **a penalty only reorders a list.** A pool where leaving costs more than this is not a worse opportunity, it is not an opportunity — no entry signal pays for it, and no sizing shrinks out of it, because the measurement was taken at the smallest size worth quoting.

It fires only on a **measured** value, and the comment states the principle that separates it from the safety gates: *unknown cost is not evidence of a bad pool — unlike the safety gates, which fail closed because unknown **danger** is evidence. Those are different unknowns and they deserve different answers.*

**Lesson: reported depth is a claim an aggregator makes; a quote is what the venue says when you ask it.** The same measurement drives `effectiveDepth` in sizing (`06-economia.md`), where HEV reported $186k and had $3.8k of real depth.

### Recovery halting five healthy positions — `2248f97`, 2026-09-14

After a database reset, five clean positions came up halted: *"5 position(s) have an unconfirmed order in flight"*. Nothing was wrong with any of them.

Recovery asks "did this pending order happen?" and paper mode answered `'unknown'`, which halts. That answer was **honest when the engine had no execution step** — an order written down and never sent really is unknowable. It became a lie the moment orders started filling (§2), because recovery runs *before* the tick and the tick is what executes. Every position was halted for an order that was merely still scheduled.

```ts
probe: async () => (config.mode === 'paper' ? 'not-filled' : 'unknown'),
```

In paper the broker is ours: deterministic, in-process, and the fills table is the complete record. No recorded fill is a **fact about a venue we own**, not a guess. Live keeps `'unknown'`, written as an explicit branch rather than left to be rediscovered.

**Lesson: an answer can be correct and then become wrong without being edited.** This one was made false by a change in a different file, and nothing in the type system connects them.

### The entry alert that called a re-opening a DCA — `80c1c53`, 2026-09-15

The label was read from the **cascade level before `stepCascade` ran**. But the machine resets on `!inPosition && wasInTrade` *inside* the step — so on the bar where a sale settles and the trend door fires again, the level still said "in trade" and a full re-opening went out as `➕ … Entry`. Live, that read as the DCA ladder finally firing while the DCA count was zero, which is the one thing the reader was watching for.

`entryAlertLabel(order)` now derives it from the **order**, which cannot be wrong about this: both entry doors emit level 0 and carry their own comment (`🟢 Entry` / `🚀 Re-Entry`), while a rung emits its own level and is named for it.

**Lesson: read a fact from the artifact that carries it, not from state that is about to change.**

### A reservation holding a slot for five hours — `46d1ed2`, 2026-09-15

Found live: a token open **five hours and twenty minutes with zero fills**, holding $285 and one of five slots, while candidates scoring 76 and 72 waited outside. A slot is handed to a token *before* the strategy enters it, so when CASCADE DCA's own gates never line up, the position sits at level 0 indefinitely — and `slotsLeft` and `committed` counted it exactly as they counted a position three DCA levels deep.

The distinction they were missing: **a position with fills is a commitment**, whose slot cannot come back without selling, and selling is the strategy's decision rather than the allocator's. **A position with no fills is a reservation**, and cancelling it costs nothing. `releasableSlots` (`src/domain/risk/idle-slots.ts`) releases only reservations, only when something is waiting to use what they give up (freeing a slot into an empty queue is pure loss), and `hasFills`/`openQty` come from the **fills**, never from the cascade level — because a machine can sit at level 1 believing it holds something the broker refused, which is exactly the §5 case this must not misread.

`DEFAULT_IDLE_SLOT_POLICY = { idleAfterMs: 3h, minScoreEdge: 10 }`. The edge is not zero on purpose: the opportunity score is an untuned heuristic that moves bar to bar, and swapping on any difference at all trades the book against its own noise and pays gas for the privilege.

### Capital immobilised against rungs that do not exist — `12be8ad`, 2026-09-15

Five positions holding **$285 each while a flat six-rung $15 ladder can only ever deploy about $95** — $950 reserved against rungs that do not exist, counted as committed, so the engine could neither spend it nor open anything with it. `ladderCapitalUsd` is the exact inverse of `deployableCapital` (run one on the other's answer and the nominal ladder comes back exactly), and every cycle trims to it:

```ts
const needs = Math.max(ladderNeeds, deployed)
if (recovered.position.capitalUsd <= needs + 0.01) { kept.push(...); continue }
```

**Never below what is already deployed** — that money is in the token, and pretending otherwise would let the same dollars be handed out twice — and **never up**, because raising an allocation is re-risking money nobody agreed to put there. The trim test asserts the position lands at ≈$95.1.

The same commit introduced the common fund (§11) and moved the fill walk into `ledger.ts`, because all three decisions needed the same answer.

### A restart that owed a scan it already had — `2ade823`, 2026-09-15

The first pass always scanned, so every restart spent half an hour of throttled discovery before it could put anything in a free slot — with a scan minutes old sitting in the database. **Three relaunches in twenty-three minutes never once reached the allocation step**, which from outside is indistinguishable from a book that refuses to grow.

`runLoop` now seeds its scan clock from the shelf: `let lastScanAt = (await deps.recall?.())?.scannedAt ?? null`. A shelf fresh enough to **allocate** from is fresh enough to **start** from. `recall` returns nothing when the shelf is missing or past its window, so the clock stays null and the first pass scans — which is the right answer then, and the only time the wait is actually owed.

This depends on the decoupling from `017b87c`: the expensive half of a scan is fetching, and gates, scoring and ranking are pure, so `recallCandidates` re-ranks the last stored scan with **no network at all** — re-running every gate, because the shelf stores snapshots rather than a pass list.

### A working engine that looked hung — `edbb3c6`, 2026-09-15

Four minutes of empty log after `[boot]`, and it read as a hung process. It was a working engine: the positions had advanced to the 20:30 bar exactly as they should. A **watch** pass prints nothing of its own — it runs no scan, so there is no progress to report — and `[boot]`, `[scan:*]` and `[exit]` were the only lines the runtime ever wrote. On a one-hour scan interval that is an hour of silence between the only two things it says.

`CLAUDE.md` already stated the principle for the alert channel: *a silent engine is indistinguishable from a dead one.* The log did not have the same courtesy. `LoopOptions.onPass` now reports every completed pass — its kind, positions advanced, bars, opened, released, elapsed.

---

## 14. The recurring shapes

Eleven incidents, three shapes. Recognising the shape is worth more than any individual fix.

### Shape 1 — the fix that was written but never wired

| Instance | The component that existed | What called it | What did not |
|---|---|---|---|
| §2 | `broker.execute`, `store.recordFill` | `replay.ts` | `tickPosition` |
| §4 | `sizeLadder`, `scaledParams` | `paper-run.ts` | `tickPosition` |
| `8418e75` | `PancakeSwap.assessSell` | nothing | `healthFor`, blocked by a null decimals lookup |
| `b029fad` | `production-ladder` numbers | the engine | the dashboard, which drew `DEFAULT_PARAMS` |

All four were written, tested, and documented as the answer to the exact problem they were then not applied to. The rule in `CLAUDE.md`:

> Anything the experiment does and the engine does not is not a fix; it is a rehearsal of one.

The detection method that works: **trace the production call path, not the test call path.** A test calling a function proves the function works; it proves nothing about whether the engine reaches it. `rg` for the export name and check whether any caller is on the live path.

### Shape 2 — the number documented but never configured

| Instance | The claim | The code |
|---|---|---|
| §6 | "$15 per level is the production setting" | `DEFAULT_PARAMS.maxUsdPerLevel = 5000` |
| §10 | "the floor dropped to under $50" | `minPositionUsd: 200` |
| `b029fad` | "five DCA rungs in production" | `PYRAMIDING = 10` in three composition sites |

The general rule: **documenting a choice is not making it**, and its structural companion, **derive what can be derived**. A number that follows from other numbers (`gasFloorUsd`, `slotFloorUsd`, `ladderCapitalUsd`) cannot go stale; a number copied out of a measurement inevitably does.

Where a number genuinely must be constant, it belongs in exactly one module that everything imports — `production-ladder.ts` exists because the dashboard and the engine disagreed about the size of a trade for days.

### Shape 3 — a unit or sentinel that meant two things

| Instance | The ambiguity |
|---|---|
| §7 | "bars" meant *bars that elapsed* to the strategy and *bars the loop observed* to the engine |
| §12 | `maxPositions: 0` meant *no ceiling* in one file and *a ceiling of zero* next door |
| §2 | the idempotency key's bar meant *decided* to recovery and *filled* to the first execution step |
| `8418e75` | `lastPriceUsd: 1` meant *one dollar* to the probe and *unset* to whoever wrote it |
| `6b06db2` | `lastCompletedBar: 0` meant *1 Jan 1970* to the date formatter and *no bar yet* to the cycle |

Every one of these is a value that is a **valid operand** of the operation that misreads it. None of them threw. The mitigations that actually worked: use a sentinel outside the arithmetic's domain (`null`, `-1` handled explicitly, `Infinity`), and test the boundary in the file that *consumes* the convention rather than the one that defines it.

### The meta-shape: what caught these

Almost none of the eleven were caught by a test or a type error. They were caught by **a person looking at a production screen and finding a number that could not be true** — `0 compra / 0 venta`, `insegura 219, filtrada 6`, a slot open five hours with zero fills, a position ticker reading `BTC`, `slotsLeft = -5`, an epoch date.

That is the argument for the dashboard and the universe view (`11-vistas.md`) being as detailed as they are, and for `CLAUDE.md`'s rule that **every decision is auditable**. A system whose internal state is not visible is a system whose bugs are found by their consequences instead of their symptoms.

It is also the argument for the two diagnostic rules paid for during the scan-performance work (`930ba7b`, `91959d8`): **instrument before optimising** — the bottleneck was in neither hypothesis, and turned out to be GeckoTerminal consuming 80% of a cycle in rate-limit backoff — and **a diagnostic that misleads is worse than none**, which the first version of those counters proved by reporting a cumulative total as a per-chain one and printing 556 seconds of waiting inside a 356-second scan.

---

## 15. What these lessons hardened into standing rules

Each of these is now enforced somewhere rather than remembered.

| Rule | Enforced by | Paid for in |
|---|---|---|
| The fills are the facts | `PaperBroker.seed`, the desync guard, `positionLedger`, `openQty` from fills | §3, §5, §11, `46d1ed2` |
| Evidence may not be edited to express a preference | `production-ladder.test.ts` asserts the values differ from `DEFAULT_PARAMS` / `PYRAMIDING` | §6 |
| Derive, do not remember | `gasFloorUsd`, `slotFloorUsd`, `ladderCapitalUsd` | §6, §10 |
| One implementation of every number | `ledger.ts`, `production-ladder.ts`, `application/dashboard.ts` | §11 |
| Enforce invariants where they can be violated | `refusesToSellAtALoss` at execution, not at decision | §8 |
| Consume every event, not every event you were awake for | the catch-up walk, `MAX_CATCH_UP_BARS = 96` | §7 |
| Fail closed for a decision, never for a label | `securityChecked` three-state, `SAFETY_GATES` | `9e2f6a3` |
| Unknown **danger** is evidence; unknown **cost** is not | safety gates vs. `impact` / `history` / `freefall` | `24c88d4`, `eeaa7d9`, `8fd4216` |
| Price may gate an entry and may never cause an exit | `freefall` lives with the entry gates; `AssetHealthObservation` is typed so no price-shaped field can exist | `8fd4216`, `05-riesgo.md` |
| A halted position keeps both its capital and its slot | `committed` adds `recovery.halted`; `slotsLeft` subtracts its length | §12 and the recovery design |
| Risk alerts are never throttled | `alerts.send` unthrottled for death-exit, position-halted, kill-switch | `08-motor.md`, `13-telefono-alertas.md` |
| Say what you did, every pass | `LoopOptions.onPass` | `edbb3c6` |

---

## 16. Open items and honest gaps

Recorded here because a decision log that only lists resolved things is a marketing document.

- **`observedAt` staleness is carried but never checked.** `MarketQuality` documents "stale quality is no quality" and `CLAUDE.md` lists staleness as one of the contract's two rules, but no code in the economics layer, the engine or the broker ever compares `observedAt` to now. The field is persisted; the rule is not enforced anywhere. See `06-economia.md`.
- **The gas floor is derived in the type and frozen in the runtime.** `main.ts` composes `{ ...DEFAULT_SIZING_POLICY, maxOpenEntries }` and never recomputes `minFillUsd` from `config.gasUsdPerSwap`. Set `OPERADOR_GAS_USD=0.20` and the engine keeps a $5 floor where the derived answer is $20 — the exact failure `gasFloorUsd` was written to prevent. This is Shape 2 in a live state.
- **`depthSource: 'measured'` is not always literally true.** When `scan.ts` has no sell quote it derives `slippagePct` from `estimatePriceImpactPct(referenceUsd, liquidityUsd)`, and that value inverts algebraically back to exactly `liquidityUsd` — so `effectiveDepth` returns the reported number while labelling it measured. The number is right; the provenance label is wrong. `TokenSnapshot.measuredImpactPct` is the honest field.
- **`spreadPct` is a configured constant, not a measurement** (0.3 in `main.ts`). It is the term subtracted *first* from both cost budgets, and it is the one nobody verifies per venue.
- **`shouldEngage` has no production caller.** The automatic kill-switch limits documented in `CLAUDE.md` — drawdown past 35%, three death exits in 24 hours — do not fire. Noted in `13-telefono-alertas.md`.
- **A position with no candles is skipped without stopping the cycle**, and also without advancing. A persistently failing candle provider therefore looks like a quiet, healthy engine from the tick count alone. Shape 1's cousin: the silent no-op.
- **All of the return figures in the capital-floor tables are survivorship-shaped.** The tokens were a trending list, measured over a window in which they trended. The **floor** and the **scaling shape** are the findings; the returns are not. See `06-economia.md`.

---

## 17. Cross-references

| Chapter | For |
|---|---|
| `01-vision-general.md` | The two subsystems, the mission, and the one-shot process model that §3 is a consequence of |
| `03-estrategia-cascade-dca.md` | `confirmBars` and the five rebound locks that §7 disabled; `stepCascade`'s reset condition, which §8 relies on |
| `04-escaner.md` | The gate set in full, the impersonation gate of §9, the security budget of `2d99bee`, the tiering of `9e2f6a3` |
| `05-riesgo.md` | The death exit that §8 exempts; the portfolio allocator of §10 and §12; `releasableSlots`; the kill switch |
| `06-economia.md` | `sizeLadder` and `scaledParams` from §4; the derived gas floor and `slotFloorUsd` from §10; the capital-floor experiment |
| `08-motor.md` | `tickPosition` and `runCycle` step by step — the mechanics every incident here modified |
| `09-persistencia.md` | Idempotency keys from §2; `fills` having no foreign key to `positions`, which §11 depends on; `planRecovery`'s three verdicts |
| `10-adaptadores.md` | The sell probes, `Erc20Decimals`, the caches and the throttles behind `8418e75` and the scan-performance work |
| `11-vistas.md` | The operations view of §11, the universe tiers of `9e2f6a3`, and the dashboard that surfaced most of this log |
| `12-runtime-despliegue.md` | `runLoop`, the watch/full split, GitHub Actions and `d9f416e`'s cron finding |
| `13-telefono-alertas.md` | The alert log, throttling policy, and the standing list of known gaps |
| `CLAUDE.md` | The charter, which carries the measurements verbatim and now records where it claimed something the code did not do |
