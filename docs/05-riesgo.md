# Risk: the death exit, the portfolio, the slots, the kill switch

This chapter documents `src/domain/risk/` and `src/application/kill-switch.ts` — the layer that answers four separate questions with four independent modules: *is this asset still an asset* (`death-exit.ts`), *how does capital split across tokens* (`portfolio.ts`), *which slots are being wasted* (`idle-slots.ts`), and *when does the whole engine stop taking new risk* (`kill-switch.ts`). It covers the death exit in full — the distinction between a stop loss and a death exit, the two stages, every invalidation signal with its exact condition and threshold, the five guardrails, and the type-level construction that makes it impossible to compile a price into the path; then the portfolio allocator and the arithmetic of a slot, idle-slot release and the commitment/reservation distinction it rests on, and the kill switch with its deliberate asymmetry. It also documents, plainly, the three places where the code does less than the design says: the live monitor can only ever produce one of the seven signals, `shouldEngage` has no caller, and `killSwitchStatus().since` reports the wrong instant.

Sizing, the gas floor and the capital-floor experiment live in `06-economia.md`; the strategy whose orders this layer vetoes in `03-estrategia-cascade-dca.md`; the scanner's safety gates — a different mechanism with an opposite failure bias — in the scanner chapter; `planRecovery` and the durable schema in the persistence chapter; alert levels, throttling and the phone in the alerts chapter.

---

## 1. Where the code is

| File | What it is | Pure? |
|---|---|---|
| `src/domain/risk/death-exit.ts` | Two-stage asset invalidation: the price-free observation type, the signal table, the fold, the order filter. 279 lines. | yes |
| `src/domain/risk/death-exit.test.ts` | 22 scenarios in seven `describe` blocks. Two `@ts-expect-error` assertions are part of the guardrail. | — |
| `src/domain/risk/portfolio.ts` | `planPortfolio` — capital across candidates: slot count, slot size, concentration cap, per-pool re-validation. 215 lines. | yes |
| `src/domain/risk/portfolio.test.ts` | Six `describe` blocks, including the two that document measured production bugs. | — |
| `src/domain/risk/idle-slots.ts` | `releasableSlots` — which slots holding *nothing* should change hands. 132 lines. Reason strings are Spanish, because they are alert copy. | yes |
| `src/domain/risk/idle-slots.test.ts` | Four `describe` blocks; the last states the anti-churn rule three ways. | — |
| `src/application/kill-switch.ts` | `engageKillSwitch` / `disengageKillSwitch` / `killSwitchStatus` (store I/O) plus `shouldEngage` (pure). 118 lines. | mixed |
| `src/application/kill-switch.test.ts` | Restart survival, checkpoint preservation, and the automatic limits. | — |
| `src/application/control-api.ts` | `authoriseControl` — the authorisation for the one write path. Constant-time, fails closed. | yes |
| `src/application/retire.ts` | `retireToken` — the *human* counterpart to a death exit, deliberately not one. | no |

Consumers, none of which own the rules:

| File | What it consumes |
|---|---|
| `src/application/engine.ts` | `assessAssetHealth` in step 1 of `advanceOneBar`, `applyDeathVerdict` in step 3, `DEATH_EXIT_COMMENT` in the execution guard and the alert loop. |
| `src/application/orchestrator.ts` | `recovery.killSwitchEngaged` (gates the whole open-new-positions block), `releasableSlots`, `planPortfolio`, `startDeathWatch`. |
| `src/runtime/main.ts` | Produces the `AssetHealthObservation` (`healthFor`), composes the portfolio and idle-slot policies. |
| `dashboard/app/api/control/route.ts` | The only write path in the system: `POST /api/control` → engage/disengage. |
| `src/application/dashboard.ts` | Reads `deathWatch.stage` and the evidence chain into the read model. |

---

## 2. The death exit

### 2.1 Two different questions

The whole strategy rests on *never exit at a loss*: the ladder's argument is that a drop is an opportunity to average down, so selling into one destroys the edge the system exists to harvest. That premise assumes the asset mean-reverts. New small caps frequently do not — they rug, get abandoned, liquidity is pulled — and the DCA ladder deploys its **largest** orders at the **lowest** prices, so on a dying token the system commits maximum capital right before the token becomes unsellable.

The resolution is a distinction, stated at the top of `death-exit.ts`:

```
A stop loss exits because the PRICE fell.
A death exit exits because the ASSET stopped being an asset.
```

The no-loss rule stays fully intact for price movement. It does not apply to an instrument that no longer functions. Everything below exists to keep those two things from ever being confused — in the type system, in the thresholds, in the audit log, and in the execution guard.

### 2.2 The guardrail: a price cannot be typed into this path

Guardrail 1 in `CLAUDE.md` says price is never a death signal and asks for it to be enforced in the type system "if the language allows it". It does:

```ts
type PriceFree = {
  readonly price?: never
  readonly close?: never
  readonly drawdown?: never
  readonly drawdownPct?: never
  readonly pnl?: never
  readonly openProfit?: never
  readonly roi?: never
  readonly level?: never
}

export interface AssetHealthObservation extends PriceFree { … }
```

`?: never` means the property may be absent and can never be present with a value. Any object literal carrying `price`, `drawdownPct`, `openProfit`, `roi` — or `level`, because the DCA level is a price-derived quantity wearing an integer's clothes — fails to typecheck as an observation.

The test that protects it is inverted, and that inversion is the point:

```ts
// @ts-expect-error price is not a health signal — this must not compile
const smuggled: AssetHealthObservation = { ...healthy(), price: 0.001 }
// @ts-expect-error nor can drawdown
const smuggled2: AssetHealthObservation = { ...healthy(), drawdownPct: -80 }
```

`@ts-expect-error` **fails the build when the line compiles cleanly**. So weakening `PriceFree` — adding an index signature, loosening the interface, replacing it with `Record<string, unknown>` — does not silently pass; it breaks the suite, because the smuggling would then have succeeded. The guardrail is a test that only passes while the compiler refuses.

The comment states the stake: *"If price ever leaks into this path the death exit silently degrades into a stop loss and the strategy's premise dies with it."*

### 2.3 What a monitor may say

```ts
export interface AssetHealthObservation extends PriceFree {
  readonly observedAt: number
  readonly source: string                       // which monitor / RPC produced it
  readonly sellQuote: SellQuoteResult           // 'ok' | 'failed' | 'implausible' | 'unknown'
  readonly liquidityUsd: number | null
  readonly lpStatus: LpStatus                   // 'locked'|'burned'|'unlocked'|'removed'|'unknown'
  readonly mintAuthorityActive: boolean | null
  readonly freezeAuthorityActive: boolean | null
  readonly transfersBlocked: boolean | null
  readonly topHolderMovedPct: number | null
  readonly hoursSinceLastTrade: number | null
}
```

Two things to notice. `source` is a field, not a convenience: it is recorded in the evidence chain, which is how multi-source agreement becomes visible after the fact. And every uncertain reading has an explicit *unknown* spelling — `null` for the numbers and booleans, `'unknown'` for the two enumerations — so "the RPC is down" can never be written the same way as "the token cannot be sold".

`SellQuoteResult` is four-valued for exactly that reason. `'failed'` and `'implausible'` are death evidence; `'unknown'` is nothing at all; `'ok'` is the only value that counts as clean.

### 2.4 The signal table

`evaluateSignals(obs, state, policy)` is pure and stateless apart from reading `state.entryLiquidityUsd` as the liquidity baseline. Every condition, in the order the function evaluates them:

| Signal | Stage | Exact condition | Detail string |
|---|---|---|---|
| `sellPathBroken` | **2** | `sellQuote === 'failed' \|\| sellQuote === 'implausible'` | `sell quote failed` |
| `lpRemoved` | **2** | `lpStatus === 'removed' \|\| lpStatus === 'unlocked'` | `LP removed` |
| `liquidityCollapse` | **2** | `liquidityUsd !== null` and (`liquidityUsd < liquidityFloorUsd` **or** `ratio < liquidityExitRatio`) | `liquidity $4900 = 4.9% of entry` |
| `liquidityCollapse` | 1 | else if `ratio < liquidityFreezeRatio` | same shape |
| `authorityReinstated` | **2** | `mintAuthorityActive === true \|\| freezeAuthorityActive === true` | `mint=true freeze=false` |
| `transfersBlocked` | **2** | `transfersBlocked === true` | `transfers paused or wallet blacklisted` |
| `holderDump` | 1 | `topHolderMovedPct !== null && ≥ holderDumpFreezePct` | `top holders moved 15% of supply` |
| `abandonment` | **2** | `hoursSinceLastTrade !== null && ≥ abandonmentExitHours` | `30h without a trade` |
| `abandonment` | 1 | else if `≥ abandonmentFreezeHours` | same shape |

where `ratio = obs.liquidityUsd / state.entryLiquidityUsd`.

Three structural points:

- **`holderDump` is stage 1 and only stage 1.** A dev or top-holder dump, however large, can never kill a position by itself. The test *"stage-1 evidence never accumulates into an exit, however long it persists"* feeds twenty consecutive observations of top holders moving 50% of supply and asserts the stage stays `frozen`. A suspicion repeated forever is still a suspicion.
- **Liquidity has both a relative and an absolute test.** Relative catches a pool that has been drained of what it had at entry; absolute (`$5,000`) catches a pool that was never deep enough to leave, whatever the baseline said. Either one alone is escapable.
- **Nothing in this table reads a price.** It could not: the type forbids it. The closest thing is `liquidityUsd`, which is pool *depth* — a property of the venue, not of the mark.

### 2.5 Null is not a signal — and this fails *open*

Every nullable field is guarded with an explicit `!== null` before it can produce anything, `lpStatus: 'unknown'` is not in the `removed | unlocked` set, and `mintAuthorityActive === true` is a strict comparison so `null` cannot pass. The test *"null readings are not signals"* passes a fully blind observation and expects `[]`.

This is the **opposite** bias from the scanner's safety gates, which fail *closed* — an unknown honeypot result there is a failure, not a pass (see the scanner chapter). Both biases are correct, and the reason they differ is the cost of being wrong:

| | Unknown reading means | Because being wrong costs |
|---|---|---|
| Scanner gate | reject the token | a missed opportunity |
| Death watch | nothing happened | a healthy position liquidated at market |

A blind monitor that liquidated would be a monitor whose worst failure mode is an outage. Guardrail 2 — *confirmation required* — is this rule plus the consecutive-observation counter in §2.6.

### 2.6 The fold: `assessAssetHealth`

```ts
export function assessAssetHealth(
  state: DeathWatchState,
  policy: DeathExitPolicy,
  obs: AssetHealthObservation,
): Assessment                         // { state, verdict, signals }
```

State is small, serialisable, and stored as JSONB on the position row:

```ts
export interface DeathWatchState {
  readonly stage: DeathStage          // 'healthy' | 'frozen' | 'dead'
  readonly entryLiquidityUsd: number  // the baseline, captured at birth
  readonly startedAt: number
  readonly exitEvidence: number       // consecutive observations carrying stage-2 evidence
  readonly cleanStreak: number        // consecutive clean observations
  readonly evidence: readonly EvidenceRecord[]
}
```

The fold, branch by branch, in evaluation order:

| Input | What happens | Verdict | Evidence appended |
|---|---|---|---|
| `stage === 'dead'` | returns immediately; the observation is **not even evaluated** | `none` | no |
| no signals, `sellQuote !== 'ok'` | **state returned untouched** — inconclusive | `none` | no |
| no signals, `sellQuote === 'ok'`, frozen, `cleanStreak + 1 >= clearObservations` | `stage → healthy`, counters zeroed | `resume` | yes |
| no signals, `sellQuote === 'ok'`, otherwise | `exitEvidence → 0`, `cleanStreak + 1` | `none` | no |
| signals, `exitEvidence >= exitConfirmations` | `stage → dead` | `exit` | yes |
| signals, healthy | `stage → frozen` | `freeze` | yes |
| signals, already frozen | stays frozen, counters updated | `none` | yes |

with the counter update that decides the whole thing:

```ts
const hasExitEvidence = signals.some((s) => s.stage === 2)
const exitEvidence = hasExitEvidence ? state.exitEvidence + 1 : 0
```

**Freeze is cheap, exit is not**, and the asymmetry is in the arithmetic rather than in the prose: a *single* observation carrying *any* signal freezes a healthy watch, while death requires `exitConfirmations` consecutive observations each carrying at least one stage-2 signal. The test *"a single broken quote freezes but does not kill — one RPC is not proof"* pins the first half; *"a broken sell path on 3 consecutive observations kills the watch"* pins the second.

Stage-2 signals do not have to be the *same* signal. *"mixed stage-2 signals still count as consecutive evidence"* feeds `implausible` quote → LP removed → transfers blocked and gets `exit`. What matters is that every observation in the run carried *some* proof.

**Dead is terminal.** The early return is not merely a shortcut: fifty perfectly healthy observations after death produce nothing but `none`, and the stage never leaves `dead`. Combined with `applyDeathVerdict('dead', inPosition = false) → []`, a dead token can never be re-entered even after its position closes.

**A freeze is lifted, not aged out.** `clearObservations: 6` clean-and-sellable looks in a row produce `resume` and return the stage to `healthy`. Six is deliberately larger than the three needed to die: it is harder to earn trust back than to lose it.

### 2.7 The policy and its sanity constraints

```ts
export const DEFAULT_DEATH_EXIT_POLICY: DeathExitPolicy = {
  liquidityFreezeRatio: 0.5,
  liquidityExitRatio: 0.2,
  liquidityFloorUsd: 5_000,
  holderDumpFreezePct: 10,
  abandonmentFreezeHours: 6,
  abandonmentExitHours: 24,
  exitConfirmations: 3,
  clearObservations: 6,
}
```

| Field | Default | Meaning |
|---|---|---|
| `liquidityFreezeRatio` | `0.5` | freeze under half the entry baseline |
| `liquidityExitRatio` | `0.2` | exit evidence under a fifth of it |
| `liquidityFloorUsd` | `5_000` | exit evidence below this absolutely, whatever the baseline |
| `holderDumpFreezePct` | `10` | top holders moving ≥ 10% of supply is a suspicion |
| `abandonmentFreezeHours` | `6` | quiet this long is a suspicion |
| `abandonmentExitHours` | `24` | quiet this long is evidence |
| `exitConfirmations` | `3` | consecutive stage-2 observations required to die |
| `clearObservations` | `6` | consecutive clean observations required to resume |

Two tests in the `policy sanity` block make the two stages non-reorderable by a config edit: *"freeze fires on one look; exit needs at least two"* pins `exitConfirmations >= 2`, and *"exit thresholds are strictly worse than freeze thresholds"* pins `liquidityExitRatio < liquidityFreezeRatio` and `abandonmentExitHours > abandonmentFreezeHours`. A policy that inverted either would make stage 2 fire before stage 1 — a death exit with no freeze in front of it, which is the failure the two-stage design exists to prevent.

`CycleConfig.deathPolicy` is optional and **the runtime never sets it** (`src/runtime/main.ts:314-338` builds a `cycleConfig` without it), so production runs on exactly the defaults above via `config.deathPolicy ?? DEFAULT_DEATH_EXIT_POLICY` in the engine. There is no environment variable for any of these numbers.

### 2.8 The evidence chain

Guardrail 5 — *every death exit is logged with its full evidence chain* — is `EvidenceRecord`:

```ts
export interface EvidenceRecord {
  readonly observedAt: number
  readonly source: string
  readonly signals: readonly InvalidationSignal[]
  readonly stageAfter: DeathStage
  readonly verdict: DeathVerdict
}
```

Appended on freeze, on resume, on exit, and on any signalling observation while already frozen. A clean non-resuming observation appends nothing, so the chain is signal rather than noise, and a healthy position that has run for months carries an empty array.

The test asserts the exact triple, source rotation included:

```
['helius',  'sellPathBroken', 'frozen', 'freeze']
['jupiter', 'sellPathBroken', 'frozen', 'none'  ]
['helius',  'sellPathBroken', 'dead',   'exit'  ]
```

Recording *which monitor said it* is what turns "three observations" into evidence of multi-source agreement rather than three readings of the same broken endpoint.

Downstream, `buildDashboard` (`src/application/dashboard.ts:77-81`) exposes `deathStage` plus the three newest signal details per position:

```ts
deathSignals: [...p.deathWatch.evidence].reverse()
  .flatMap((record) => record.signals.map((signal) => signal.detail))
  .slice(0, 3),
```

and raises a warning listing every frozen position by symbol.

### 2.9 What the executor does with the orders

```ts
export function applyDeathVerdict(
  orders: readonly Order[],
  stage: DeathStage,
  inPosition: boolean,
): readonly Order[] {
  switch (stage) {
    case 'healthy': return orders
    case 'frozen':  return orders.filter((o) => o.kind !== 'entry')
    case 'dead':    return inPosition ? [{ kind: 'closeAll', comment: DEATH_EXIT_COMMENT }] : []
  }
}
```

| Stage | Entries | Strategy exits | Emitted |
|---|---|---|---|
| `healthy` | pass | pass | untouched |
| `frozen` | **dropped** | **pass** | everything that is not an entry |
| `dead`, in position | dropped | **replaced** | exactly `[{ kind: 'closeAll', comment: '☠️ Death Exit' }]` |
| `dead`, flat | dropped forever | — | `[]` |

Three consequences worth stating explicitly:

**Frozen never traps the money.** Stage 1 means *no new capital enters*, never *the position cannot leave*. The strategy's own take-profit and rescue-breakeven exits pass through a freeze untouched. The engine reinforces the same rule independently for a different reason one line later:

```ts
const orders = walk.tradeable ? afterDeath : afterDeath.filter((o) => o.kind !== 'entry')
```

— *"A pool too thin to size against must not trap the money already in it: entries stop, exits never do."*

**The death exit replaces the strategy's exit rather than coexisting with it.** The `dead` branch returns its single order regardless of input, *including an empty input array*: the strategy does not have to want to sell. The comment gives the reason — *"it replaces any strategy exit, so the audit log names the true reason"*. A `🏁 Exit` in the log beside a rug would misattribute the sale, and these logs become test fixtures.

**The sale comment is the mechanism, not just a label.** The execution guard that enforces never-exit-at-a-loss carves out exactly one exception, by string:

```ts
function refusesToSellAtALoss(order: Order, avgPrice: number | null, fillPrice: number): boolean {
  if (order.kind !== 'closeAll') return false
  if (order.comment === DEATH_EXIT_COMMENT) return false
  if (avgPrice === null) return false
  return fillPrice < avgPrice
}
```

A non-death `closeAll` whose fill price at the next bar's open is below average cost is **refused** — the sale does not happen, the broker keeps holding, and because `stepCascade` resets on the *broker* going flat rather than on an exit being *signalled*, the ladder survives with nothing rolled back. A death exit is exempt, because holding out for a better price on something unsellable is how you hold it forever. See `03-estrategia-cascade-dca.md` for the -13.1% `🏁 Exit` that produced this guard.

### 2.10 The five guardrails, mapped to code

| # | Guardrail (`CLAUDE.md`) | Where it lives |
|---|---|---|
| 1 | Price is never a death signal | `PriceFree` + two `@ts-expect-error` tests (§2.2). No condition in `evaluateSignals` reads a mark. |
| 2 | Confirmation required | `exitConfirmations: 3` consecutive stage-2 observations; `null`/`'unknown'` produce nothing (§2.5); `source` recorded per observation. |
| 3 | Freeze is cheap, exit is not | one signal freezes; three consecutive prove death; the policy-sanity tests forbid inverting the thresholds. |
| 4 | A death exit may fail | detection runs every pass, not only at entry; the canonical probe is a real full-size sell quote (§2.11); `'failed'` and `'unknown'` are different values. |
| 5 | Full evidence chain | `EvidenceRecord`, persisted as JSONB and surfaced on the dashboard (§2.8). |

### 2.11 What the live monitor actually observes today

**This is the largest gap between the design and the running system, and reading `death-exit.ts` alone will overestimate it.**

`src/runtime/main.ts:175-207` is the only producer of `AssetHealthObservation` in production:

```ts
const referenceUsd = Math.max(position.capitalUsd, 50)
const amountRaw = BigInt(Math.floor((referenceUsd / position.lastPriceUsd) * 10 ** decimals))
const assessment = await sellProbeFor(position.chain).assessSell(position.tokenAddress, amountRaw, decimals, referenceUsd)
return {
  observedAt: Date.now(),
  source: 'jupiter',
  sellQuote: assessment.sellQuote,
  liquidityUsd: null,
  lpStatus: 'unknown',
  mintAuthorityActive: null,
  freezeAuthorityActive: null,
  transfersBlocked: null,
  topHolderMovedPct: null,
  hoursSinceLastTrade: null,
}
```

Only `sellQuote` ever carries data. Because null is never a signal (§2.5), **liquidity collapse, LP removal, authority reinstatement, holder dump and abandonment are structurally unreachable in production.** The domain implements seven signals; the live monitor can fire one. What is live, therefore, is:

- **freeze** on one failed or implausible full-size sell quote
- **death** on three consecutive ones
- **resume** on six consecutive clean ones

Three further facts about the live probe:

- **It probes the full position.** `max(position.capitalUsd, 50)` USD, sized in raw token units from the last measured price — *"whether $100 can be sold says nothing about whether the position can leave."* This is the canonical honeypot test and it is a *fact*, not a vendor's `is_honeypot` opinion. On Solana it goes through Jupiter; on BSC through PancakeSwap's `getAmountsOut` via `eth_call` (see the adapters chapter).
- **It refuses to answer when it cannot size the question.** No decimals, or no positive `lastPriceUsd`, returns `null` and the engine skips the observation entirely — *"Reporting nothing is honest; reporting an unfounded 'ok' is not."* This is also why a newly opened position stores `lastPriceUsd: snapshot.priceUsd > 0 ? snapshot.priceUsd : null` rather than a placeholder: a stand-in price would make the very first probe ask an absurd question and freeze the position before it had done anything.
- **`source` is hardcoded `'jupiter'` on both chains.** The evidence chain therefore records agreement between three *readings*, not three *providers*, and on BSC it records the wrong provider name. Multi-source agreement is available in the data model and is not yet available in fact.

One more configuration gap in the same area: `OPERADOR_HEALTH_MS` (default 10 minutes) is read into `RuntimeConfig.healthIntervalMs` by `src/runtime/config.ts:206` and **never used anywhere**. `runCycle` calls `deps.healthFor(position)` once per position per pass, so the probe cadence is the pass cadence (`OPERADOR_CYCLE_MS`, default 5 minutes), not the configured health interval.

### 2.12 Where the watch is born, and the one way it throws

The death watch is created with the position, in the allocation loop of `runCycle` (`orchestrator.ts:385`):

```ts
deathWatch: startDeathWatch(allocation.quality.liquidityUsd, at),
```

— *"The liquidity at entry is the baseline every future collapse is measured against — so the watch is born with the position."* The baseline comes from the `MarketQuality` the scanner measured and the allocator just re-validated, never from a later reading.

```ts
export function startDeathWatch(entryLiquidityUsd: number, startedAt: number): DeathWatchState {
  if (!(entryLiquidityUsd > 0)) throw new Error('startDeathWatch: entry liquidity must be positive')
  …
}
```

The negated comparison catches `NaN` as well as `0` and negatives, which is deliberate — a baseline of `NaN` would make every future ratio `NaN` and silently disable the liquidity signals. **Gotcha:** it *throws*, and it is called mid-loop while building a `PersistedPosition`, so a quality reading of zero or `NaN` aborts the allocation loop with an exception rather than skipping that one candidate. That failure mode is untested and is not the same shape as the `skipped` entries the allocator produces for every other refusal.

### 2.13 How the engine wires it, step by step

In `advanceOneBar` (`src/application/engine.ts`), per bar, in this order:

0. **Execute what the previous bar decided**, at this bar's open — including the never-sell-at-a-loss refusal of §2.9.
1. **The death watch speaks first.** `assessAssetHealth` runs *before* the strategy, so a freeze or a death is already in force when orders are decided.
   - `verdict === 'exit'` → `store.blacklist(chain, token, signals.map(s => s.detail).join('; '), barTime)` and an unthrottled **critical** `death-exit` alert carrying every signal detail. The blacklist reason *is* the evidence.
   - `verdict === 'freeze'` → a `ladder-frozen` alert at level `warn`, throttled per position.
2. **`stepCascade` evaluates the closed bar**, unchanged and unaware any of this exists.
3. **The death watch gets the last word.** `applyDeathVerdict(stepped.orders, deathWatch.stage, inPosition)`, then the tradeability filter. Vetoed orders are *returned* as `vetoed`, not silently dropped.
4. **Write before sending.** The surviving orders are persisted as `pendingOrders` on the position, together with the new `deathWatch` state, *before* anything is submitted.

**Gotcha — the death alert is sent in step 1 and deliberately skipped in step 4:**

```ts
if (order.kind === 'closeAll' && order.comment === DEATH_EXIT_COMMENT) continue // already alerted
```

`DEATH_EXIT_COMMENT` is therefore load-bearing in three places: the order filter that creates it, the execution guard that exempts it, and this alert loop that suppresses the duplicate. A rename that misses one site produces either a duplicate critical alert or — worse — a death exit that goes out as a routine `position-closed` and gets throttled.

### 2.14 Retiring a token is not a death exit

`src/application/retire.ts` exists because an operator sometimes needs to remove a token for a reason the system cannot compute. The first real case: a fifteen-day-old memecoin was scanned, ranked and allocated capital under the symbol **BTC**, because the impersonation gate knew `WBTC` and not `BTC`.

It is kept architecturally distinct, and the reason is epistemic:

> A death exit is a **verdict** — the asset stopped being an asset, and the evidence chain is part of the record. Retiring is a **decision**, made by a person for a reason the system could not compute, and calling it a death would put a diagnosis in the log that nothing diagnosed.

`retireToken` sells with the ordinary `🏁 Exit` comment, records the fills under a retirement-instant idempotency key (`retire:<positionId>:<at>:<index>`, never a bar key, so it cannot collide with a real order), **then** closes, **then** blacklists. That order is not arbitrary:

> Blacklisting alone would be worse than doing nothing. `planRecovery` **skips** a blacklisted position, so the position stops being ticked while its tokens stay bought — and it drops out of the committed total, which is how the portfolio quietly hands the same dollars to somebody else.

It also refuses rather than inventing: a position holding tokens with `lastPriceUsd === null` is left whole and the operator is told why, because a fabricated price would enter the ledger every other number in the system is derived from.

---

## 3. The portfolio allocator

### 3.1 Why it exists: scale comes from more tokens

Finding 2 of the capital-floor experiment (`06-economia.md`): above a pool's capacity, extra capital does nothing. Leafy returned the same **$159 at $200 and at $20,000**, because the ladder is capped by depth, not by the wallet. Return per dollar therefore *falls* as capital grows. Scale cannot come from bigger positions; it has to come from more of them — and that turns allocation into a real problem with real limits:

- every slot needs enough capital to clear the floor, or it trades nothing at all
- no single token may hold so much that its death takes the portfolio
- the number of slots is bounded by capital, not by how many the scanner happens to like

### 3.2 Equal weight, on purpose

Slots are equal-weight. The reasoning is in the header and it is an argument about epistemics, not about diversification theory:

> A score-weighted split would concentrate capital in whatever the heuristic likes most today — and that heuristic is an untuned v1 whose own documentation says it is not a claim of alpha. Equal weight makes the portfolio's survival depend on breadth rather than on the score being right.

The score decides **order of service**, never **size**. A 99 and a 51 that both get funded get identical capital.

### 3.3 The policy

```ts
export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  totalCapitalUsd: 1_000,
  maxPositions: 5,
  maxPositionPct: 30,
  minPositionUsd: 200,
  reservePct: 5,
}
```

| Field | Default | Meaning |
|---|---|---|
| `totalCapitalUsd` | `1_000` | capital the portfolio may deploy in total. The orchestrator overrides this with what is genuinely *free*. |
| `maxPositions` | `5` (production: `0`) | hard ceiling on simultaneous positions. **Zero means no ceiling** — the capital decides. |
| `maxPositionPct` | `30` | largest share of deployable capital one token may hold. *"The death exit bounds how a position dies; this bounds how much dies with it."* |
| `minPositionUsd` | `200` | capital below which a slot places no orders at all. **Stale by design; the live engine derives it** (§3.6). |
| `targetPositionUsd` | *(optional)* | what a slot *should* get: the wallet a full ladder needs, and not a dollar more (§3.5). |
| `reservePct` | `5` | held back for gas and rebalancing. |

### 3.4 The algorithm

```ts
export function planPortfolio(
  candidates: readonly AllocationCandidate[],
  params: CascadeParams,
  policy: PortfolioPolicy,
  sizingPolicy?: SizingPolicy,
): PortfolioPlan
```

1. **Reserve.** `reserveUsd = totalCapitalUsd × reservePct / 100`; `deployableUsd = totalCapitalUsd − reserveUsd`.
2. **Concentration cap.** `concentrationCapUsd = deployableUsd × maxPositionPct / 100`.
3. **How many slots the capital funds**, at the size a ladder wants:
   ```ts
   const slotSize = Math.max(Math.min(policy.targetPositionUsd ?? policy.minPositionUsd, concentrationCapUsd), policy.minPositionUsd)
   const affordableSlots = Math.floor(deployableUsd / slotSize)
   ```
   Clamping the target to the cap here is what keeps an unscaled reference ladder — nominally tens of thousands of dollars — from making the whole book look unaffordable, when in practice `scaledParams` shrinks it to fit.
4. **Bail out if nothing is affordable.** `affordableSlots < 1` returns an empty plan with *every* candidate skipped as `'no-capital'` and `idleUsd = deployableUsd`.
5. **Rank.** `b.score - a.score || a.snapshot.address.localeCompare(b.snapshot.address)` — ties break deterministically by address, so the same shortlist always allocates in the same order.
6. **Slot count.** `slots = min(affordableSlots, ceiling, ranked.length)` with
   ```ts
   const ceiling = policy.maxPositions > 0 ? policy.maxPositions : Number.POSITIVE_INFINITY
   ```
7. **Slot size:**
   ```ts
   const evenUsd = deployableUsd / slots
   const wanted  = Math.min(evenUsd, policy.targetPositionUsd ?? evenUsd)
   const perSlotUsd = Math.max(Math.min(wanted, capUsd), policy.minPositionUsd)
   const floorOverrodeCap = perSlotUsd > capUsd
   ```
8. **Serve in rank order.** For each candidate: stop when the slots are full or the next slot would overspend (`allocatedUsd + perSlotUsd > deployableUsd + 1e-9`) → `'no-slots'`; otherwise re-validate the pool with `sizeLadder(params, quality, sizingPolicy, perSlotUsd)` → `'pool-refused'` on failure; otherwise allocate.
9. **Weights.** `weightPct = capitalUsd / deployableUsd × 100`, computed after the loop.

**The executor validates, it does not trust.** A 99-scoring candidate whose pool cannot carry a ladder at `perSlotUsd` is refused and its slot goes to the next candidate — the test *"a refused token frees its slot for the next candidate"* drops HEV at score 99 with 50% slippage and fills four slots with the tokens behind it. Defence in depth: the scanner's opinion does not survive contact with the sizing model.

### 3.5 The `evenUsd` bug, and what `targetPositionUsd` fixed

Before `targetPositionUsd` existed the split was simply `deployable / slots`. Measured in production:

| | |
|---|---|
| Deployable | $1,425 across ten slots |
| Handed to each slot | $142 |
| What a flat six-rung $15 ladder can ever spend | ~$95 |
| Result | five positions holding $285 each; **roughly $950 doing nothing** |

The surplus was counted as *committed*, so the engine could neither spend it nor open anything with it, and *"why only five tokens"* had a number nobody had recomputed as its answer. With a target, a slot gets what its ladder wants and the **width** of the book becomes the division — which is finding 2 arriving by a different road.

Pinned by the `sized to the ladder, counted by the capital` block: $1,500 capital, 5% reserve, a $95.10 target → **14 positions**, every one at $95.10, idle under one ladder's worth.

The orchestrator also **trims existing positions** to the same number each full pass (step 3c): `needs = max(ladderNeeds, deployedUsd)`, never below what is already in the token, because pretending otherwise would let the same dollars be handed out twice.

### 3.6 The floor is derived, never remembered

`minPositionUsd: 200` was a real measurement — the first capital-floor run placed **zero orders** below it — taken *before* sizing began reserving gas plus 5% of price headroom. That change dropped the real floor to under $50, and the constant never moved, so it spent weeks capping the book at four slots however much capital was free.

The live engine therefore overrides it (`orchestrator.ts:335-341`) with:

```ts
minPositionUsd: slotFloorUsd(params, maxOpenEntries, gasUsdPerSwap, sizing.minFillUsd)
targetPositionUsd: ladderCapitalUsd(params, maxOpenEntries, gasUsdPerSwap)
```

Both live in `src/application/paper-run.ts`:

```ts
export function ladderCapitalUsd(params, maxOpenEntries, gasUsdPerSwap) {
  const rungs = Math.min(params.maxLevels + 1, maxOpenEntries)
  const nominal = Array.from({ length: rungs }, (_, level) => usdForLevel(params, level)).reduce((a, b) => a + b, 0)
  const swaps = rungs + 1 // the entries, and the one sell that closes them all
  return nominal / (1 - PRICE_HEADROOM_PCT / 100) + gasUsdPerSwap * swaps
}

export const slotFloorUsd = (params, maxOpenEntries, gasUsdPerSwap, minFillUsd) =>
  ladderCapitalUsd({ ...params, maxUsdPerLevel: minFillUsd, baseUsd: minFillUsd, amountIncrement: 0 }, maxOpenEntries, gasUsdPerSwap)
```

`ladderCapitalUsd` is the exact inverse of `deployableCapital`, not an estimate. `slotFloorUsd` is **the gas floor, not the nominal ladder**: `scaledParams` shrinks a ladder to what the wallet allows, so a smaller slot does not fail — it trades smaller rungs. What it cannot do is trade rungs the chain's fixed cost would eat. `PRICE_HEADROOM_PCT = 5`.

Worked with production's own constants (`OPERADOR_MAX_USD_PER_LEVEL = 15`, `OPERADOR_MAX_DCA = 5` → six open entries, `OPERADOR_GAS_USD = 0.05`, `minFillUsd = gasFloorUsd(0.05, 1) = $5`):

| | Rungs | Nominal | + headroom | + gas (7 swaps) | Total |
|---|---|---|---|---|---|
| `ladderCapitalUsd` (target) | 6 × $15 | $90 | $94.74 | $0.35 | **≈ $95.09** |
| `slotFloorUsd` (floor) | 6 × $5 | $30 | $31.58 | $0.35 | **≈ $31.93** |

At $1,000 of free capital that is $950 deployable, a 30% cap of $285, nine slots of $95.09 and about $94 idle — under one ladder, which is as close to fully deployed as an integer number of slots allows. *(Arithmetic derived from the code, not a live measurement; the orchestrator feeds `free` capital, which includes the common fund and excludes committed and halted positions.)*

### 3.7 When the floor and the cap conflict, the floor wins — loudly

The two constraints genuinely collide at small capital:

| Capital | Deployable | 30% cap | Floor ($200) | Outcome |
|---|---|---|---|---|
| $1,000 | $950 | $285 | $200 | cap holds |
| $500 | $475 | **$142** | $200 | **floor overrides**, 2 slots at $200, `weightPct` 42.1% |

```ts
const floorOverrodeCap = perSlotUsd > capUsd
```

> The floor wins, and loudly. A position below it is a **guaranteed zero**, while concentration is a **probabilistic loss**; refusing to trade in order to stay diversified is diversifying into nothing.

Loudly, because the orchestrator turns the flag into a `provider-degraded` alert (*"El capital solo alcanza para N ranuras, así que cada una supera el límite del 30%"*) rather than letting the book drift over its target in silence. A test also pins that overspend is impossible even when the floor wins: `allocatedUsd <= deployableUsd + 1e-9`.

### 3.8 `maxPositions: 0` means *no ceiling*, in both files

The sentinel is handled twice, and the orchestrator comment says why that matters:

```ts
// portfolio.ts
const ceiling = policy.maxPositions > 0 ? policy.maxPositions : Number.POSITIVE_INFINITY

// orchestrator.ts
const uncapped = config.portfolio.maxPositions <= 0
const slotsLeft = uncapped ? Number.POSITIVE_INFINITY : config.portfolio.maxPositions - keeping.length - recovery.halted.length
```

Subtracting open positions from the sentinel gave **minus five** with five open, which failed the `slotsLeft > 0` guard: the book froze while $950 of freed capital and thirty-eight candidates sat waiting. With an empty book it gave zero, which fails the same guard, so nothing would ever have opened at all. *"A sentinel that means one thing in one file and another next door is not a sentinel, it is a trap."* Production runs `OPERADOR_MAX_POSITIONS = 0`.

### 3.9 The plan, and how the orchestrator uses it

```ts
export interface PortfolioPlan {
  readonly allocations: readonly Allocation[]   // snapshot, quality, score, capitalUsd, sizing, weightPct
  readonly skipped: readonly Skipped[]          // snapshot, reason, detail
  readonly deployableUsd: number
  readonly allocatedUsd: number
  readonly reserveUsd: number
  readonly idleUsd: number
  readonly floorOverrodeCap: boolean
}
```

Every surviving allocation becomes a `PersistedPosition` with `capitalUsd: allocation.capitalUsd`, a fresh `initialState()` cascade, `lastBarTime: -1`, and its own death watch. One last veto sits between the plan and the save: `deps.confirmSellable(snapshot)` re-probes the sell path *right now*, because the scanner's security verdict can be hours old by design and the honeypot answer is the one that ages worst. `'unknown'` is not a yes there.

### 3.10 Gotchas in `planPortfolio`

- **`slotSize` and `perSlotUsd` are computed by similar but different expressions.** `slotSize` (used only to count affordable slots) omits the `evenUsd` clamp that `perSlotUsd` applies. They can disagree, and only `perSlotUsd` reaches `sizeLadder`. Changing one without the other changes the slot count without changing the money, or the reverse.
- **`Skipped.reason` declares `'below-floor'` and nothing ever produces it.** The three emitted reasons are `'no-capital'`, `'no-slots'` and `'pool-refused'`. Downstream code matching on `'below-floor'` will never fire.
- **The overspend guard uses an epsilon** (`+ 1e-9`) and the corresponding test asserts the same tolerance. Tighten neither without the other.
- **The `'no-slots'` branch `continue`s rather than breaking**, so once the slots are full every remaining candidate gets its own skip record. That is intentional for reporting; it is not a per-candidate judgement.

---

## 4. Idle slots: commitment versus reservation

### 4.1 The two cases, and the one rule

The portfolio hands a slot and its capital to a token **before** the strategy enters it: the scanner says "worth running the machine on", and CASCADE DCA then waits for its own gates. Two ways that stops being a good deal:

1. **The gates never line up** and the position sits at level 0 indefinitely. Measured live at **five hours and twenty minutes, holding $285 and one of five slots, while candidates scoring 76 and 72 waited outside.**
2. **It takes its profit and goes flat**, and the token is no longer what it was when it was chosen — or something better has appeared since.

Both are the same situation wearing different clothes, and the rule that covers both is about what the position **holds**, not what it has done:

> A position holding tokens is a **commitment**. The slot cannot come back without selling, and selling is the strategy's decision, never the allocator's.
>
> A position holding **nothing** is a **reservation**. Handing it on costs nothing, because nothing is in it.

### 4.2 The function

```ts
export function releasableSlots(
  holders: readonly SlotHolder[],
  waiting: readonly number[],          // scores of candidates not currently held
  now: number,
  policy: IdleSlotPolicy = DEFAULT_IDLE_SLOT_POLICY,
): readonly SlotDecision[]
```

```ts
export const DEFAULT_IDLE_SLOT_POLICY: IdleSlotPolicy = { idleAfterMs: 3 * 3_600_000, minScoreEdge: 10 }
```

`idleAfterMs` is justified in **bars**, not clock time: *"Three hours: twelve bars at 15m, most of the 20-bar swing-high window."* `minScoreEdge: 10` is deliberately non-zero — *"the opportunity score is a heuristic that moves bar to bar, so swapping on any difference at all would trade the book against its own noise and pay gas for the privilege."* Both are configurable (`OPERADOR_IDLE_HOURS`, `OPERADOR_MIN_SCORE_EDGE`).

The body, in order:

```ts
if (waiting.length === 0) return []
const best = Math.max(...waiting)

for (const holder of holders) {
  if (holder.openQty > 0) continue                      // holding something ends the conversation
  const proven = holder.hasFills
  const waited = now - holder.openedAt >= policy.idleAfterMs
  if (!proven && !waited) continue                      // a fresh reservation gets its window
  if (holder.score === null) { release: 'el escáner ya no lo tiene entre sus candidatos' }
  else if (best >= holder.score + policy.minScoreEdge) { release: `hay un candidato N puntos mejor esperando` }
  else if (!proven && waited) { release: `reservó una ranura y Nh después no compró nada` }
}

return decisions
  .sort((a, b) => (a.holder.score ?? -1) - (b.holder.score ?? -1))
  .slice(0, waiting.length)
```

| Holder | Released? | Why |
|---|---|---|
| `openQty > 0`, 90 hours open, score 1, a 99 waiting | **no** | commitment; selling is the strategy's call |
| never traded, 1 hour old | no | inside the idle window |
| never traded, 6 hours old, a 40 waiting | yes | reserved a slot and bought nothing |
| traded, now flat, 30 minutes old, dropped by the scanner (`score === null`) | yes | judged immediately — it proved what it could do |
| traded, now flat, score 45, best waiting 50 | no | 5 points is inside the noise band |
| nobody waiting | no | releasing into an empty queue is pure loss |

### 4.3 `openQty` comes from the fills, never from the cascade level

> A machine can sit at level 1 believing it holds something the broker refused, and a reservation dressed as a position is the case this must not misread.

The orchestrator satisfies this from a **single shared walk** over the fills (step 3a), one `PositionLedger` per position, reused by three decisions — slot release, capital trimming, and the committed total — explicitly because *"any two of them disagreeing is how a book starts double-spending."*

### 4.4 Anti-churn, in four separate places

1. **The idle window** applies only to a reservation that never traded. One that *has* traded is re-examined the moment it goes flat, with no waiting period — *"it was chosen by this same ranking minutes ago, and judging it against a ranking that moves bar to bar would open a position and close it on the next scan."*
2. **`minScoreEdge: 10`** — a slot changes hands for a clear difference, not for noise.
3. **Only on full passes.** `kind !== 'full' ? [] : releasableSlots(…)`. *"Taking a slot off one token and giving it to another is a judgement about which is better right now, and it deserves data gathered right now. Filling a slot that is already empty does not."*
4. **`justReleased`.** A token that gave up its slot cannot win it back in the same cycle: *"that is not a reallocation, it is a round trip through the database."* It is eligible again next cycle.

### 4.5 Releasing is not blacklisting

`store.closePosition(holder.id)` and a `token-retired` alert; no blacklist row. *"The token did not fail a safety gate, it merely stopped being the best use of a slot, and it is welcome back."* The freed capital drops out of `committed` and reappears as `free` for `planPortfolio` **in the same cycle** — the reason slot release runs before allocation rather than after it.

### 4.6 Gotchas in `releasableSlots`

- **`best` is a single maximum compared against every holder, and the cap is on count, not on pairwise quality.** With `waiting = [90, 20]` and two flat holders scoring 50 and 55, both clear `best >= score + 10` and both are released — though only one waiting candidate is genuinely better than either. The book can shed more slots than it has good replacements for.
- **`score === null` is deliberately ambiguous, and the Spanish copy must stay ambiguous with it.** Null means *either* "stopped clearing the gates" *or* "ranked below the watch-slot cut", and the comment states that the reason text must not claim which. Editing `el escáner ya no lo tiene entre sus candidatos` into something like `falló los filtros de seguridad` would put a false statement in the audit log.
- **Reason strings are user-facing Spanish** while the rest of the codebase is English. That is the project's language split (interface Spanish, code English), not an inconsistency.

---

## 5. The kill switch

### 5.1 It lives in the store, not in the process

> A switch held in memory can only be thrown by a healthy engine, and a healthy engine is exactly the case where you least need one.

It is a column on the checkpoint row (`EngineCheckpoint.killSwitchEngaged`), so a phone can stop a machine it cannot reach, and a crash-looping process comes back **already stopped**. The test treats a second reader of the same `MemoryStore` as a new process to prove restart survival.

### 5.2 The asymmetry

| | |
|---|---|
| **Stops** | opening any new position |
| **Keeps** | the death watch running on everything already open |

Enforced by *where the flag is read* in `runCycle`: the entire step-3 block — scan/recall, slot release, capital trimming, the common fund, `planPortfolio`, saving new positions — sits inside `if (!recovery.killSwitchEngaged) { … }`, while step 2's tick loop, which runs `assessAssetHealth` and can still emit a death exit, sits outside it.

> A switch that froze the death watch too would mean "stop the engine" also meant "stop protecting the money", and the moment you most want to stop taking new risk is often the moment an open position most needs watching.

The flag round-trips through `saveCheckpoint` at the end of every cycle, so a cycle never clears it by accident, and an engaged switch also raises a throttled `kill-switch` alert each pass.

### 5.3 The API

```ts
engageKillSwitch(store, alerts, reason: KillSwitchReason, detail: string, at: number): Promise<void>
disengageKillSwitch(store, alerts, at: number): Promise<void>
killSwitchStatus(store): Promise<{ engaged: boolean; since: number | null }>
```

`KillSwitchReason = 'manual' | 'loss-limit' | 'provider-failure' | 'reconciliation'`. Only `'manual'` is ever passed in production today.

Both writers preserve progress:

```ts
lastCompletedBar: previous?.lastCompletedBar ?? 0,
```

pinned by *"preserves the checkpoint bar, so stopping does not lose progress"* — stopping must never cost the engine its place in the bar walk.

Engaging always alerts, at level `critical`, which the `AlertThrottle` never suppresses (`if (alert.level === 'critical') return true`): *"the one message that must always land."* Releasing is a separate, explicit act; nothing re-enables the engine by itself.

**Gotcha — `since` is not when it was engaged.** `EngineCheckpoint` carries only `{ savedAt, lastCompletedBar, killSwitchEngaged }`; there is no `engagedAt`. `killSwitchStatus` returns `checkpoint.savedAt`, and `runCycle` rewrites the checkpoint every pass with `savedAt: at` while carrying the flag forward. The reported "since" therefore **marches forward every pass** while the switch is engaged: a phone shows "stopped 3 minutes ago" after two days of being stopped. The test only ever reads `since` immediately after engaging, so the drift is invisible to the suite.

**Gotcha — a fresh store.** With no prior checkpoint, engaging writes `lastCompletedBar: 0`. Benign on an engine that has never run; a trap for any path that clears checkpoints without clearing positions.

### 5.4 The automatic limits — implemented, tested, and never called

```ts
export const DEFAULT_LOSS_LIMITS: LossLimitPolicy = {
  maxDrawdownPct: 35,
  maxDeathsPerWindow: 3,
  windowMs: 24 * 60 * 60 * 1000,
}

export function shouldEngage(snapshot: RiskSnapshot, policy: LossLimitPolicy, at: number):
  { engage: boolean; reason: KillSwitchReason; detail: string }
```

Two triggers:

| Trigger | Condition | Rationale |
|---|---|---|
| Drawdown | `(starting − equity) / starting × 100 >= 35` | equity is that far below starting capital |
| Death cluster | `deathTimes.filter(t => at − t <= 24h).length >= 3` | *"Several tokens dying at once is rarely a coincidence. It is either a bad market or a bad scanner, and neither is a reason to keep buying."* |

Pure on purpose — *"the decision and the act are separate"* — so the rule is testable without a store. `startingCapitalUsd === 0` yields a drawdown of 0 rather than a division by zero, and a profitable portfolio never trips the limit.

**It has no caller.** `rg` over the repository finds `shouldEngage` only in `kill-switch.ts`, its own test, and documentation. Nothing computes a `RiskSnapshot`; `runCycle` *reads* `killSwitchEngaged` but never *writes* it. **The automatic limits described in `CLAUDE.md` do not currently fire — the kill switch is manual-only in practice.** This is the same shape as the missing-execution-layer bug the repository already documents: a function written, tested, documented as the fix, and never reached.

### 5.5 The one write path

The dashboard is read-only by design. `POST /api/control` is the single exception and it earns it by being **one-way safe**: it can stop the engine from opening new positions and release that stop, and it cannot place an order, size one, close one, or touch a wallet.

```ts
export const MIN_TOKEN_LENGTH = 24

export function authoriseControl(configured, presented, options): ControlVerdict {
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return { ok: false, status: 503, reason: 'control token is not configured' }
  if (presented === null) return DENIED                    // 401
  const offered = options.fromHeader ? bearer(presented) : presented
  if (offered === null) return DENIED
  return secretsMatch(configured, offered) ? { ok: true } : DENIED
}
```

- **Fails closed with 503** when `OPERADOR_CONTROL_TOKEN` is missing or shorter than 24 characters, because *"we forgot to set it"* and *"anyone may stop the engine"* must not be the same state. 503 rather than 401 is honest: the server is not configured to answer, which is a different fact from the credential being wrong.
- **Constant-time comparison, with length checked separately.** A plain `===` on a secret returns as soon as it finds a differing byte, *"which over enough requests tells an attacker how much of the prefix is right."*
- **Only `Bearer <token>`** counts as a credential; any other `Authorization` shape is denied.
- `action` must be exactly `'kill'` or `'resume'`; `detail` is truncated to 200 characters.
- The route writes through `StoredAlertSink`, the same alert log the engine uses, *"so the phone sees its own action arrive the same way it sees a death exit — and so the audit trail records that a human stopped this, not a loss limit."*
- **`GET` needs no token:** the switch state is already on the dashboard.

---

## 6. Configuration

| Env | Default | Reaches |
|---|---|---|
| `OPERADOR_CAPITAL_USD` | `1000` | `PortfolioPolicy.totalCapitalUsd` (before the common fund and committed capital are applied) |
| `OPERADOR_MAX_POSITIONS` | `0` | `PortfolioPolicy.maxPositions` — zero means no ceiling |
| `OPERADOR_GAS_USD` | `0.05` | `ladderCapitalUsd`, `slotFloorUsd`, the broker |
| `OPERADOR_MAX_USD_PER_LEVEL` | `15` | `params.maxUsdPerLevel` → the flat $15 ladder |
| `OPERADOR_MAX_DCA` | `5` | `maxOpenEntries = 5 + 1 = 6` rungs |
| `OPERADOR_IDLE_HOURS` | `3` | `IdleSlotPolicy.idleAfterMs` |
| `OPERADOR_MIN_SCORE_EDGE` | `10` | `IdleSlotPolicy.minScoreEdge` |
| `OPERADOR_CONTROL_TOKEN` | *(none)* | the control endpoint; under 24 characters refuses everything |
| `OPERADOR_HEALTH_MS` | `600000` | **nothing — parsed and never read** (§2.11) |

`maxPositionPct` (30), `reservePct` (5) and every field of `DEFAULT_DEATH_EXIT_POLICY` have **no environment variable**: production runs the code defaults. `minPositionUsd` is configured at 200 and always overridden by the derived floor in the live path.

---

## 7. What the tests pin

| Suite | Tests | The ones that are specifications rather than checks |
|---|---|---|
| `death-exit.test.ts` | 22 | `an observation cannot carry a price, even by accident` (compiler-enforced); `stage-1 evidence never accumulates into an exit, however long it persists`; `dead is terminal: clean observations never resurrect it`; `an unknown sell quote is inconclusive: it neither confirms nor clears`; `exit thresholds are strictly worse than freeze thresholds` |
| `portfolio.test.ts` | 6 blocks | `more capital buys more POSITIONS, not bigger ones — the whole point`; `the floor wins, and the plan says so`; `a refused token frees its slot for the next candidate`; the whole `sized to the ladder` block, which is the `evenUsd` bug written down |
| `idle-slots.test.ts` | 4 blocks | `never touches a position that is HOLDING something`; `a fresh reservation is not judged by the ranking that just chose it` (three ways); `lets go of the weakest first when slots are scarce` |
| `kill-switch.test.ts` | 2 blocks | `survives a restart: a new engine reads it as engaged`; `preserves the checkpoint bar`; `engaging always alerts, and always as critical`; `only counts deaths inside the window` |

No network, no sleeps, no wall-clock dependency anywhere in these suites: every module in `domain/risk/` is pure, and `kill-switch.ts` takes its clock as a parameter.

---

## 8. Known gaps

Stated plainly, because each one is a place where this document's subject does less than its design:

1. **The live death watch is a one-signal system.** Five of the seven invalidation signals are structurally unreachable in production because `runtime/main.ts` never populates their fields (§2.11). Closing this needs adapters for pool depth, LP status, on-chain authorities and trade recency — the scanner already fetches some of these for its gates, so the data exists in the codebase; it does not reach the observation.
2. **`source` is hardcoded `'jupiter'`**, including on BSC where the probe is PancakeSwap. The evidence chain records repeated readings, not independent agreement, and on one chain it records the wrong name.
3. **`shouldEngage` has no caller** (§5.4). The automatic drawdown and death-cluster limits documented in `CLAUDE.md` do not fire.
4. **`killSwitchStatus().since` drifts forward** every pass while engaged (§5.3).
5. **`OPERADOR_HEALTH_MS` is dead configuration.** The probe cadence is the pass cadence.
6. **A stage-1 signal resets the stage-2 counter.** `exitEvidence = hasExitEvidence ? state.exitEvidence + 1 : 0` means an observation carrying *only* a stage-1 signal — a 15% holder dump, a 7-hour quiet spell — zeroes a death chain that was two-thirds complete. Two failed sell quotes with one holder-dump-only observation between them leaves `exitEvidence` at 1, not 3. No test covers this; the tested reset case is a *clean* observation. Bad news breaks the chain of worse news, which is arguably the safe direction but is not documented anywhere in the source. *(Unreachable today for the separate reason above: production never produces a stage-1 signal at all.)*
7. **"Consecutive clean observations" is not literally consecutive.** An inconclusive observation returns the state untouched, so `cleanStreak` survives it: a frozen watch can resume on clean-clean-**unknown**-clean-clean-clean-clean. Whether that is intended is undocumented; the header comment says "consecutive".
8. **`startDeathWatch` throws inside the allocation loop** when `quality.liquidityUsd` is zero or `NaN`, rather than skipping the candidate (§2.12).
9. **`Skipped.reason: 'below-floor'` is declared and never produced** (§3.10).
10. **`releasableSlots` caps releases by count, not by pairwise quality** (§4.6).
