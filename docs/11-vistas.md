# Read models, the dashboard and the universe view

This chapter documents the **read side** of Operador by Open Doors: the four functions in `src/application/` that compute every number a human ever sees — `buildDashboard`, `buildUniverse`, `buildOperations`, `buildPhoneStatus` — plus `src/application/ledger.ts` (the one implementation of *what does this position hold and what did it make*), `src/application/production-ladder.ts` (the two numbers where production differs from the reference), `src/application/control-api.ts` (authorisation for the single write path in the whole system), and the Next.js app in `dashboard/` that renders them. It covers why the numbers live in the application layer and never in the web app; every read model and the exact shape it returns; the universe canvas mark by mark, with the formula behind each one; the four performance decisions that let it run on a phone; zoom, pan and the mixed sky; the operations view — ladder, rebound locks, fills, realised profit; why the screen shows warnings instead of a green badge; and why there is no write path except one endpoint that can only ever make the system safer. It ends with the sharp edges the source actually contains, including one gate misclassification that is live-reachable today.

---

## 1. The rule: the numbers live in the application layer

The header of `src/application/dashboard.ts` states it, and it is the constraint the whole subsystem is built around:

> the dashboard must never become a second place where the system's numbers are computed. Two implementations of "how much are we up" will disagree, and the one on the screen is the one you will believe.

Mechanically this means: `dashboard/app/page.tsx` and `dashboard/app/api/view/route.ts` **import** `buildDashboard`, `buildUniverse` and `buildOperations` from `src/application/` and write no SQL of their own. `dashboard/next.config.mjs` lifts `outputFileTracingRoot` to the repo root precisely so that import is legal, and teaches webpack `extensionAlias { '.js': ['.ts', '.tsx', '.js'] }` because the engine is NodeNext ESM whose import specifiers end in `.js` while the files on disk are `.ts`.

The rule was learned twice, in two different ways, and both scars are still in the code.

**First scar — `production-ladder.ts`.** The engine sizes rungs at `OPERADOR_MAX_USD_PER_LEVEL` (default $15); the dashboard drew `DEFAULT_PARAMS`, whose `maxUsdPerLevel` is 5,000 because that is what TradingView ran. From the file's own header:

> The dashboard drew `DEFAULT_PARAMS` instead and showed a $1,000 rung beside a $15 order for days — a screen disagreeing with the engine about the size of a trade, which is the exact failure `buildDashboard` exists to prevent.

The fix is not to edit `DEFAULT_PARAMS`. Those values are what the parity harness asserts (see `03-estrategia-cascade-dca.md`): *"they are EVIDENCE, and evidence that can be edited to express a preference stops being evidence."* So `production-ladder.ts` holds the two production numbers, has no database, clock or network so the web app can import it cheaply, and both callers compose on top:

```ts
params: { ...DEFAULT_PARAMS, maxUsdPerLevel: ladder.maxUsdPerLevel },
maxOpenEntries: ladder.maxOpenEntries,
```

| Constant | Value | Env override | Meaning |
|---|---|---|---|
| `DEFAULT_MAX_USD_PER_LEVEL` | `15` | `OPERADOR_MAX_USD_PER_LEVEL` | USD cap per rung. Flat at this size: `min(1000 × (1 + 1.2n), 15)` is 15 at every level. |
| `DEFAULT_MAX_DCA_PER_TOKEN` | `5` | `OPERADOR_MAX_DCA` | DCA rungs production will fill per token. The entry is not one of them, so `maxOpenEntries = 6`. |

`productionLadder(env)` coerces both through a `positive()` helper — a non-finite or non-positive value falls back to the constant rather than producing a zero-size ladder.

**Second scar — `ledger.ts`.** Three things need to know what a position holds: the screen, the capital allocator, and the common fund. From its header:

> ONE implementation, because three things need the answer and any two of them disagreeing is how a trading dashboard starts lying.

`buildOperations` used to read `fillsFor(positionId)` and therefore lost the realised profit of every position that had closed; the allocator read `commonFund(allFills)` and kept it. The screen and the allocator gave different answers to "how much have we made". Both now walk the same `positionLedger`.

**The consequence for anyone extending this code:** a new number on the screen belongs in a read model under `src/application/`, with a test under the same name. It does not belong in a React component.

---

## 2. The four read models, at a glance

| Function | File | Store methods read | Consumers |
|---|---|---|---|
| `buildDashboard` | `src/application/dashboard.ts` (134 lines) | `loadPositions`, `loadCheckpoint`, `blacklisted`, `latestScan` | `page.tsx`, `/api/view`, `/api/state` |
| `buildUniverse` | `src/application/universe-view.ts` (265 lines) | `latestScansByChain`, `loadPositions`, `blacklisted` | `page.tsx`, `/api/view` |
| `buildOperations` | `src/application/operations-view.ts` (302 lines) | `loadPositions`, `allFills` | `page.tsx`, `/api/view`, `/demo` |
| `buildPhoneStatus` | `src/application/phone-status.ts` (70 lines) | `loadPositions`, `loadCheckpoint`, `latestAlertSeq` | `/api/phone`, `src/runtime/demo-server.ts` |

All four take an injected `now: () => number` and touch nothing else — no network, no wall clock, no engine memory. Postgres, through `PostgresStore` implementing the `StatePort` contract (`09-persistencia.md`), is the only input. None of them can write: the type they are handed is `StatePort`, but every call site in the read path uses only its read half, and no read model calls `savePosition`, `recordFill`, or `saveCheckpoint`.

---

## 3. `buildDashboard` — is the engine alive, and what should a human do about it

```ts
export async function buildDashboard(store: StatePort, options: DashboardOptions): Promise<DashboardView>

export interface DashboardOptions {
  readonly now: () => number
  /** A position untouched for longer than this is reported as stale. */
  readonly staleAfterMs?: number     // default 2 * 60 * 60 * 1000
}
```

The four store reads happen in one `Promise.all`.

### 3.1 Output shape

`PositionView`, one per open position:

| Field | Type | Notes |
|---|---|---|
| `id`, `symbol`, `chain`, `tokenAddress` | `string` | identity |
| `capitalUsd` | `number` | capital the slot was allocated |
| `filledDcas` | `number` | `cascade.level > 0 ? cascade.level - 1 : 0` — **signalled** levels minus the entry, not fills |
| `deathStage` | `'healthy' \| 'frozen' \| 'dead'` | read straight through from `deathWatch.stage`; nothing here re-derives health |
| `deathSignals` | `readonly string[]` | newest first, at most three |
| `lastPriceUsd` | `number \| null` | |
| `updatedAt` | `number` | drives both staleness checks |
| `hasPendingOrders` | `boolean` | `pendingOrders.length > 0` |

`DashboardView` adds `generatedAt`, `killSwitchEngaged`, `lastCompletedBar`, `totals { positions, committedUsd, frozen, pending }`, `blacklistedCount`, `lastScan { at, tokensSeen } | null`, and `warnings`.

### 3.2 Zero is not a bar, it is the absence of one

```ts
lastCompletedBar: checkpoint?.lastCompletedBar || null,
```

That is `||`, not `??`, and it is deliberate. A cycle that opened positions without ticking any of them checkpoints `lastCompletedBar: 0`, and rendering that literally puts **1 Jan 1970** on a money screen. The comment:

> On a money screen an epoch date reads as a dead engine, which is a worse lie than showing nothing at all. No market ever traded a bar at zero.

Pinned by `dashboard.test.ts`: *"reports 'no bar yet' as nothing, not as 1970"*.

### 3.3 The four warnings

Warnings are the only thing the page renders from this model that a human is expected to act on. There is no green badge: an **empty list** is the good case, and `dashboard.test.ts` pins *"a healthy system warns about nothing"*.

| # | Condition | Text |
|---|---|---|
| 1 | `checkpoint?.killSwitchEngaged` | `Kill switch is engaged — no new positions will open.` |
| 2 | `hasPendingOrders && now - updatedAt > staleAfterMs` | `N posición(es) con una orden sin ejecutar hace horas: …` |
| 3 | `deathStage === 'frozen'` | `N position(s) frozen: …` |
| 4 | `now - updatedAt > staleAfterMs` | `N position(s) not updated in over Xh — is the engine running?` |
| 5 | `positions.length === 0 && !checkpoint` | `No positions and no checkpoint: the engine has never completed a cycle.` |

The hours figure is `Math.round(staleAfterMs / 3_600_000)`.

**Why #2 is not "warn on any pending order".** An order decided at a close fills at the *next* bar's open (`08-motor.md`), so every position that just decided something carries one. The comment:

> Warning on that fired constantly during healthy operation, and a warning that cries wolf costs you the one that matters.

Two tests pin the distinction: *"says nothing about an order decided on the last bar"* and *"warns when an order has been pending far longer than a bar"*.

**Why #4 exists at all.** *"A position nobody has touched in hours is the shape of a silently dead engine — the failure that looks exactly like 'nothing is happening'."*

### 3.4 Death signals: newest first, at most three

```ts
deathSignals: [...p.deathWatch.evidence]
  .reverse()
  .flatMap((record) => record.signals.map((signal) => signal.detail))
  .slice(0, 3),
```

The copy before `.reverse()` matters — `evidence` is readonly and reversing in place would mutate the loaded state. Note that the cap counts **signals, not evidence records**: one record carrying four signals fills the list on its own and hides the records behind it. See `05-riesgo.md` for what an evidence record contains.

---

## 4. `buildUniverse` — the scanned universe as something you can look at

```ts
export async function buildUniverse(store: StatePort, options: UniverseOptions): Promise<UniverseView>

export interface UniverseOptions {
  readonly now: () => number
  readonly gates?: GatePolicy            // default DEFAULT_GATE_POLICY
  readonly opportunity?: OpportunityPolicy // default DEFAULT_OPPORTUNITY_POLICY
  readonly spreadPct?: number            // default 0.3
}
```

### 4.1 It recomputes; it does not store a second verdict

`buildUniverse` runs the same `evaluateGates` and `scoreOpportunity` the scanner runs (`04-escaner.md`), over the `TokenSnapshot`s persisted with the scan. From the header:

> The scanner already decides everything this needs; storing a second, prettier version of those decisions would be a second place for them to be wrong. So this recomputes from the stored snapshots using the SAME gate and score functions the engine runs, and adds only what a picture needs: a tier, a magnitude, and a reason.

### 4.2 Every chain at once, reported at its stalest

```ts
const snapshots = scans.flatMap((scan) => scan.snapshots)
...
scannedAt: scans.length === 0 ? null : Math.min(...scans.map((s) => s.scannedAt)),
```

`latestScansByChain()` exists because `latestScan()` returns a single newest row, so scanning BSC made every Solana token vanish from the screen — which looks exactly like the scanner having stopped finding them. And the reported freshness is the **oldest** scan, not the newest:

> A universe is only as fresh as its stalest half, and reporting the newest would let a healthy Solana scan hide a BSC scanner that died three hours ago.

Three tests pin this: *"shows Solana AND BSC together, not whichever scanned last"*, *"keeps only the LATEST scan of each chain"*, *"reports the OLDEST chain as the scan time"*.

### 4.3 The tier cascade

Seven tiers, in render and sort order:

```ts
const TIERS: TokenTier[] = ['held', 'prime', 'eligible', 'pending', 'filtered', 'unsafe', 'dead']
```

Assignment, in exact precedence order:

| Order | Condition | Tier | Meaning |
|---|---|---|---|
| 1 | `blacklisted.has(key)` | `dead` | The death exit condemned it. Never again. |
| 2 | a position holds it | `held` | Money is in it. |
| 3 | `securityChecked === false` **and** a market gate failed | `filtered` | Rejected on market grounds; it will never be examined. |
| 4 | `securityChecked === false` **and** no market gate failed | `pending` | Cleared the free gates; the cycle's security budget did not reach it. |
| 5 | any `SAFETY_GATES` failure | `unsafe` | A bullet dodged, not a missed chance. |
| 6 | `!gateResult.passed` | `filtered` | Too thin, too young, too quiet, too big. |
| 7 | `score >= PRIME_SCORE` (45) | `prime` | Passed everything and scored well. |
| 8 | otherwise | `eligible` | Passed everything, quieter score. |

`dead` outranking `held` is load-bearing: a condemned token you still hold must never render as a healthy position. Pinned by *"a blacklisted token is dead, and dead outranks everything"*.

Sorting is `TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.score - a.score` — **brightest first, so a truncated render keeps the interesting ones.** The canvas relies on this when it applies its body cap.

### 4.4 Unexamined is not dangerous

The gates fail closed (`04-escaner.md`), so a token with an all-null `SecurityReport` naively reads as six safety failures. `securityChecked === false` is what separates *"nobody has looked at this yet"* from *"we looked and it is dangerous"*. The comment carries the measurement:

> This mattered in production: the screen read "insegura 219, filtrada 6" when almost all 219 were simply too thin to bother with. Calling a thin pool a bullet dodged devalues the label for the tokens that earned it.

The same flag suppresses the noise in the blocker list:

```ts
const blockers = gateResult.failures
  .filter((f) => snapshot.securityChecked !== false || !SAFETY_GATES.has(f.gate))
  .map((f) => f.detail)
```

> Measured live: 180 of 185 filtered tokens led with them. True, and useless. The real reason is the market gate it hit.

The ten names treated as safety gates:

```ts
const SAFETY_GATES = new Set(['honeypot', 'mintAuthority', 'freezeAuthority', 'blacklist',
  'transferTax', 'lpLocked', 'topHolders', 'creatorShare', 'proxy', 'impersonation'])
```

Two of these classifications are wrong or arguable — see §11.1 and §11.2.

### 4.5 A position is never invisible

After building from the scan, `buildUniverse` walks the open positions and appends any held token the scan did not include:

```ts
const drawn = new Set(tokens.map((t) => `${t.chain}:${t.address}`))
for (const position of positions) {
  const key = `${position.chain}:${position.tokenAddress}`
  if (drawn.has(key)) continue
  tokens.push(fromPositionAlone(position))
}
```

The evidence in the comment:

> found live with five open positions and four bodies drawn, and the missing one was holding money. […] A token that drops off every discovery list may be a token that is dying — so the screen went blank at the exact moment it had something to say.

`fromPositionAlone` **admits what it does not know**, and that is the interesting part:

| Field | Value | Why |
|---|---|---|
| `score` | `0` | not a stale one |
| `components` | `{}` | no bars to draw |
| `volume24hUsd` | `0` | the scan said nothing |
| `change24hPct`, `ageHours` | `null` | render as `—` |
| `liquidityUsd`, `frictionPct` | from `position.quality` | a real measurement, taken when the position opened |
| `priceUsd` | `position.lastPriceUsd ?? 0` | the last close the engine acted on |
| `blockers` | `['el escáner no la encontró en este ciclo — los datos son los de la posición']` | never empty |

The blocker is not decoration. From the function's docstring: *"an empty blockers list reads as 'checked and fine', which is the single thing nobody checked."*

Four tests cover this: drawing a position the scan missed, carrying what the position knows, saying the scanner did not see it, and not drawing a held token twice when the scan *did* find it.

### 4.6 Friction is a display estimate, and the fallback is the optimistic half

```ts
slippagePct: snapshot.measuredImpactPct
  ?? (snapshot.liquidityUsd > 0 ? estimatePriceImpactPct(100, snapshot.liquidityUsd) : 100),
...
frictionPct: 2 * (quality.spreadPct + quality.slippagePct),
```

`estimatePriceImpactPct(usd, liq) = (usd / (liq / 2)) * 100` reads **reported** liquidity, and the comment names exactly why that is the optimistic half of the pair:

> it reads reported liquidity, which said $718,000 about a pool that moved 98% on a $285 sell.

(That is CREPE; the same evidence sets `maxReferenceImpactPct: 10` in `DEFAULT_GATE_POLICY`. See `06-economia.md`.) Two consequences worth stating plainly:

- The `ida y vuelta` figure in the detail sheet is a **model** where no measurement exists, not a quote. The executor re-measures before it trades (`06-economia.md`).
- The same estimate is fed into `scoreOpportunity` as the quality argument, and `costEfficiency` carries weight `0.2` of six components — so an unmeasured token's displayed score is also computed on the optimistic number.

### 4.7 `UniverseToken` and `UniverseView`

| Field | Type | Source |
|---|---|---|
| `id` | `string` | `` `${chain}:${address}` `` |
| `symbol`, `chain`, `address`, `pairAddress` | `string` | snapshot |
| `tier` | `TokenTier` | §4.3 |
| `score` | `number` (0..100) | `scoreOpportunity` |
| `components` | `Record<string, number>` | the six weighted components |
| `liquidityUsd`, `volume24hUsd`, `priceUsd` | `number` | snapshot (`volumeUsd.h24`) |
| `change24hPct`, `ageHours` | `number \| null` | `priceChangePct.h24`; `(observedAt - pairCreatedAt) / 3_600_000` |
| `frictionPct` | `number` | §4.6 |
| `blockers` | `readonly string[]` | filtered gate failures |
| `position` | `{ capitalUsd, filledDcas, deathStage } \| null` | present only when held |

`UniverseView` adds `generatedAt`, `scannedAt`, `tokens`, `counts` (every tier, including zeros) and `chains` (sorted, deduplicated).

---

## 5. `buildOperations` — what the broker is actually doing

```ts
export async function buildOperations(store: StatePort, options: OperationsOptions): Promise<OperationsView>

export interface OperationsOptions {
  readonly now: () => number
  readonly params?: CascadeParams   // default DEFAULT_PARAMS
  readonly tapeLength?: number      // default 40
  readonly maxOpenEntries?: number  // default PYRAMIDING = 10
}
```

From the header: *"The universe view answers 'what is out there'. This answers 'what happened, what is open, and what is it worth'. They are different questions and a screen that only answers the first looks busy while telling you nothing."*

### 5.1 The books come from the fills

Every money figure is derived from `positionLedger(fills)` — never from a running total.

> A counter that drifts from its own transactions is the classic way a trading dashboard starts lying: the fills are the facts, everything else is derived from them on demand.

`positionLedger` is a **forward walk**, not a set of sums, and that is its whole correctness argument. Sorted by `time`, buys add to `qty` and `basisUsd`; a sell realises `sold × (fill.price − avg)` against the basis *at that moment* and leaves the remaining basis per unit unchanged. From its header:

> Totalling every buy ever made counts entries that were already sold, so a position that closed once and re-entered reports twice the capital it holds — and dividing that blend by every unit ever bought produces a cost basis the position never paid, which then feeds the unrealised number.

Pinned by *"counts only what is still held as deployed, not everything ever bought"* — $10 in, out at $12, $11 in again gives `deployedUsd` 11 (not 21), `avgCostUsd` 0.011 (not 0.0105), and therefore `unrealisedUsd` +1 (not +1.50).

Two smaller guards in the same walk:
- `const sold = Math.min(fill.qty, qty)` — selling more than the record says is held cannot come from our own orders, *"but a sale is the moment to be careful rather than clever: cap it, so a bad fill cannot invent profit out of a negative position."*
- After a full exit, `qty <= 0` returns `deployedUsd: 0, avgCostUsd: null` — *"a basis of 1e-17 on zero units is not a cost, it is noise."*

### 5.2 Profit does not leave when the position does

```ts
const allFills = await store.allFills()
```

Not `fillsFor(id)`. The comment records the bug:

> a token that had made the most money ceded its slot and its gain simply vanished, as if it had never won. […] `fills` has no foreign key to `positions` precisely so they survive that, and nothing was reading them.

Five tests in *"a closed position keeps its profit on the screen"* cover it: the gain, the costs, the execution count, the tape row, and *"adds up open and closed together, and never twice"*.

### 5.3 The ladder: planned against actual

`LadderRung`:

| Field | Meaning |
|---|---|
| `level` | 0 = the entry, 1..N = DCA rungs |
| `triggerPrice` | `triggerPrice(params, cascade.ep1, level)`, `null` at level 0 or when `ep1` is null |
| `nominalUsd` | `usdForLevel(params, level)` = `min(baseUsd × (1 + amountIncrement × level), maxUsdPerLevel)` |
| `filled`, `fillPrice`, `fillUsd` | from the matching fill; `fillUsd = price × qty` |
| `pending` | `level === waitingOn && !fill` |
| `beyondPyramiding` | `level >= (options.maxOpenEntries ?? PYRAMIDING)` |

**The rung the view points at is the order in flight, not the machine's level:**

```ts
const inFlight = position.pendingOrders.find((order) => order.kind === 'entry')
const waitingOn = inFlight?.level ?? position.cascade.level
```

> The machine advances to level N the moment it SIGNALS that level, but the order does not fill until the next bar's open. Pointing at the machine's level during that window says "waiting for DCA-1" while the Entry — the order actually in flight — sits unmarked, and a reader would conclude the entry had already happened.

**The cap drawn is production's, not the reference's.** With `maxOpenEntries = 6`, rungs 6..11 are struck through. Falling back to `PYRAMIDING = 10` would draw four rungs as reachable that the broker is going to refuse, *"overstating how much dry powder is left"*. Two tests: *"marks everything past the production cap, not past the reference"* and *"falls back to the reference when production says nothing"*.

**The ladder is always exactly 12 rungs**: `Array.from({ length: Math.min(params.maxLevels + 1, 12) })`. With `maxLevels = 50` the view draws levels 0..11 and stops. The state machine genuinely signals to 50 (`03-estrategia-cascade-dca.md`); the screen does not follow it there.

### 5.4 The four rebound locks

`ladderLocks(cascade, params, close)` returns `null` when `cascade.level < 1 || cascade.ep1 === null`. Otherwise four `LadderLock`s, each `{ name, held, detail }`. The `detail` is written in the numbers it is waiting on, in Spanish.

| Lock | `held` when | Example detail (waiting) |
|---|---|---|
| `trigger` | `cycleLow <= triggerPrice(params, ep1, level)` | `falta que caiga a 0.009900; el mínimo va en 0.010500` |
| `separation` | `cycleLow <= lastFill × (1 − minGapPct/100)` | `hace falta 5% bajo la compra anterior (0.009500)` |
| `confirmation` | `barsSinceLow >= confirmBars` | `3 de 20 barras sin un mínimo nuevo — cada mínimo nuevo reinicia la cuenta` |
| `rebound` | `close >= cycleLow × (1 + reboundPct/100)` | `hace falta un rebote de 2.5% sobre 0.009400; va +0.8%` |

With `DEFAULT_PARAMS`: `minGapPct = 5`, `confirmBars = 20`, `reboundPct = 2.5`, `dcaBasePct = 1.0`, `linearIncrementPct = 3` — so DCA-1 arms at `ep1 × 0.99`, DCA-2 at `ep1 × 0.96`, DCA-5 needs a 13% fall and DCA-10 a 28% one.

This exists because of a specific production question that could not be answered from the screen. From the `LadderLock` docstring:

> a token fell 28% below its entry, no rung fired, and the screen could not say why: answering took reading the cascade state out of the database by hand. A ladder that is correctly waiting and a ladder that is broken looked exactly alike, which makes the correct one impossible to trust.

(The answer in that case was the `confirmation` lock: every new low resets `barsSinceLow`, so a token making new lows every bar never confirms a bottom. The test *"a new low resets the window, which is why a falling token never confirms"* pins it.)

**The fifth Pine lock is deliberately absent.** `DCA.pine`'s `close > open` (`require_green`) is a property of the bar being evaluated, and nothing durable records the open. From the `locks` field comment: *"Four locks that are certain beat five where one is invented."* The UI says so out loud — `cerrojos del próximo peldaño — los cuatro tienen que ceder`.

Two boundary behaviours: `trigger` is `null`-safe (`cascade.level <= params.maxLevels ? triggerPrice(...) : null`), and any lock whose inputs are missing reports `todavía no hay un mínimo de ciclo que medir` rather than claiming to hold.

### 5.5 `PositionOperations` and the totals

| Field | Derivation |
|---|---|
| `deployedUsd`, `qty`, `avgCostUsd`, `realisedUsd` | `positionLedger(fills)` |
| `costsUsd` | `fills.reduce((s, f) => s + f.costUsd, 0)` — spread, impact and gas |
| `marketValueUsd` | `qty × lastPriceUsd`, or `null` when price is unknown or `qty === 0` |
| `unrealisedUsd` | `(price − avgCostUsd) × qty` |
| `unrealisedPct` | `(unrealisedUsd / deployedUsd) × 100` — **the basis still held, not the capital allocated** |
| `ladder`, `locks` | §5.3, §5.4 |
| `fills` | this position's fills, **reversed** (newest first) |
| `capitalUsd`, `openedAt`, `updatedAt`, `hasPendingOrders`, `deathStage` | straight through |

Totals:

```ts
netUsd: fund.netUsd + built.reduce((s, p) => s + (p.unrealisedUsd ?? 0), 0)
```

where `commonFund(allFills)` groups by position, runs `positionLedger` per group, and returns `{ realisedUsd, costsUsd, netUsd: realisedUsd - costsUsd }`. Grouping per position matters: *"realised profit is defined against a cost basis and a basis only means anything within one position's own history."*

Costs are subtracted **and** reported on their own:

> netting them silently would hide the single largest reason a small-cap strategy fails, which is that the chain takes more than the edge.

`recentFills` is the tape: every fill, tagged with a symbol, sorted newest first, sliced to `tapeLength`. A departed position has no symbol in `symbolOf`, so the fallback is `fill.positionId.split(':')[1]?.slice(0, 6) ?? '—'` — the position id is shaped `chain:address:at`, and six characters of address beat a blank.

---

## 6. `buildPhoneStatus` — the cheap poll

```ts
export const STALE_AFTER_MS = 45 * 60 * 1000
export async function buildPhoneStatus(store: StatePort, options: PhoneStatusOptions): Promise<PhoneStatus>
```

| Field | Meaning |
|---|---|
| `generatedAt` | `now()` |
| `killSwitchEngaged` | `checkpoint?.killSwitchEngaged ?? false` |
| `lastEngineUpdate` | `checkpoint?.savedAt ?? null` |
| `engineStale` | `lastEngineUpdate === null \|\| now - lastEngineUpdate > staleAfter` |
| `positions`, `frozen` | counts |
| `cursor` | `store.latestAlertSeq()` — the newest alert sequence |

Three things, and only three. From the header:

> This runs every minute, forever, on a free-tier database — and the moment it stops being cheap it stops being something you can leave running. […] P&L is not here on purpose. It is a number you go and LOOK at; the phone poll answers a different question: is the engine alive, is it stopped, and has anything happened that I have not seen.

The cheapness is **a tested property, not a comment**: `phone-status.test.ts` wraps the store in a `Proxy` that counts `fillsFor` accesses and asserts zero (*"reads no fills — this is polled every minute on a free database"*).

**Never having run is not healthy.** `engineStale` is true when `lastEngineUpdate === null`: *"never having run and running fine are not the same state, and defaulting the unknown one to green is how a dead engine goes unnoticed."*

**45 minutes is three missed 15-minute cycles** (`01-vision-general.md` for the bar size): *"Long enough that a slow scan or a restart does not cry wolf, short enough that a dead engine is noticed within the hour."* Note this is independent of the dashboard's 2h default — the phone will call the engine stale roughly an hour and a quarter before the web page says anything (§11.6).

**`latestAlertSeq()` is its own port method** for a reason the store contract states: reading the first page of alerts to find the last sequence stalls at the page size and the app silently stops noticing new alerts. Pinned by *"reports the newest sequence even past one page — the cursor must not stall at 100"*, seeded with 130 alerts. The cursor is a **sequence, not a timestamp**: two alerts can share a millisecond, and a timestamp cursor must then either skip one or replay it forever (`09-persistencia.md`).

---

## 7. The Next.js app

`dashboard/` is a Next.js App Router app targeting Vercel's Hobby tier.

### 7.1 Route map

| Route | Method | What it does |
|---|---|---|
| `/` (`app/page.tsx`) | server render | `buildDashboard` + `buildUniverse` + `buildOperations` in one `Promise.all`, into `<Console initial={…}>` |
| `/demo` (`app/demo/page.tsx`) | `force-static` | synthetic universe, **real** `buildOperations` over a `MemoryStore` |
| `/api/view` | GET | the same three builders, one `Promise.all`, `cache-control: no-store` |
| `/api/phone` | GET | `buildPhoneStatus` only |
| `/api/alerts?since=&limit=` | GET | `store.alertsSince`, cursor-paged |
| `/api/control` | **POST** (token) / GET (open) | the only write path |
| `/api/state` | GET | **orphaned** — see §11.4 |

Every route and the page carry `export const dynamic = 'force-dynamic'` (the page also `revalidate = 0`), and every JSON response sets `cache-control: no-store`. From `page.tsx`:

> A cached view of a trading system is worse than no view: a stale "all healthy" reads exactly like a live one.

### 7.2 One endpoint for the whole screen

`/api/view` returns all three models together, and the reason is in its header:

> One request rather than three: three would arrive at three different moments and the screen would show a position that exists in one panel and not the other. A single read is a single instant.

### 7.3 Refresh by fetch, never by reload

`Console` (`dashboard/app/console.tsx`, `'use client'`) polls `/api/view` every `REFRESH_MS = 20_000`:

```ts
if (inFlight.current || document.hidden) return
```

Three decisions in three lines:

- **Never reload.** *"Reloading the page wiped the canvas, snapped every orbit back to its starting angle and dropped whatever the viewer had selected — a flinch once a minute that communicated nothing. Swapping the data underneath leaves the sky turning and the panel open."*
- **Defend the database.** A slow response must not stack requests on a free tier, and a hidden tab polls nothing.
- **Coming back shows the present.** A `visibilitychange` listener calls `pull` directly, *"so returning to the tab shows the present, not what was on screen when it was hidden."*

`dashboard/app/layout.tsx` still carries `<meta httpEquiv="refresh" content="60" />` as a no-JavaScript backstop: *"The page refreshes itself; a trading view nobody reloads is a lie."*

### 7.4 A failed refresh is said out loud

```ts
catch (error) { setStaleReason(String(error).slice(0, 120)) }
```

rendered as a red banner, `⚠️ Datos congelados — no se pudo actualizar: …`.

> A dashboard that silently keeps showing the last good data is a dashboard that reads "all healthy" during an outage.

### 7.5 One pool, and never a stack trace

`dashboard/lib/store.ts`:

```ts
pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
```

> Next.js reuses the module across requests, and a pool created per request is how a free-tier database runs out of connections at the worst possible moment.

Errors go through `failed(error, status = 500)`, which returns `String(error).slice(0, 200)`:

> The message, never the stack: a stack from a database client carries connection details, and these endpoints are one paste away from public.

`page.tsx` does the same inline, rendering `No se puede leer el estado: {error}` instead of a broken page.

### 7.6 Build configuration worth knowing

`dashboard/next.config.mjs`:

- `outputFileTracingRoot` lifted to the repo root, so `src/` can be imported.
- `webpack.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }`, because the engine is NodeNext ESM.
- `distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'`. The comment explains the choice of signal: *"Next renders in CHILD processes whose argv no longer says `dev`, so an argv check makes the router resolve `.next-dev` while the worker looks in `.next` — which fails as a missing chunk ('Cannot find module ./873.js') rather than as a config mistake. The environment is inherited; the command line is not."*
- `typescript: { ignoreBuildErrors: false }` — type errors fail the build. `eslint.ignoreDuringBuilds: true`.

### 7.7 The demo

`/demo` is `force-static`, labelled `DEMO — datos sintéticos` in amber (`#ffb454`), and passes `live={false}` so it never polls. The universe is 80 synthetic tokens from a deterministic `sin`/`fract` hash. The operations half is **not** synthetic arithmetic:

> Rather than hand-writing a P&L that looks plausible, this seeds fake fills into a real store and runs the real read model over them. If the maths on this page is wrong, the maths in production is wrong too — which is the only kind of demo worth looking at.

Three synthetic positions are built with entries at `×0.82`, `×1.03` and `×1.19` of the token price — *"one winner, one grinder, one underwater — a demo where every position shows the same P&L teaches nothing about reading the screen."* `src/runtime/demo-server.ts` does the equivalent for the phone API: real `buildPhoneStatus`, real `authoriseControl`, real kill switch, `MemoryStore` instead of SQL.

Two caveats about the demo are in §11.7.

---

## 8. The universe canvas

`dashboard/app/universe.tsx` (823 lines, `'use client'`). Every mark is a measurement.

### 8.1 The encoding

| Mark | Encodes | Formula |
|---|---|---|
| **Colour** | tier | `TIER_STYLE[tier].core` |
| **Size** | liquidity, log scale | `radius = (compact ? 3 : 4) + (log10(max(liquidityUsd, 1000)) − 3) × (compact ? 2.4 : 3.4)` |
| **Shape** | chain | `● ` circle for Solana, `◆` diamond for BSC |
| **Glow** | money is in it | held only; blitted sprite, `reach = drawn × (5 + pulse × 2.5)` |
| **Glow colour** | frozen by the death watch | `rgb(120,200,255)` blue instead of the held green |
| **Ripples** | opportunity score | `count = floor(strength × (compact ? 2.2 : 3.4))`, zero for `dead` and `unsafe`; `strength = tier === 'held' ? 1 : score / 100` |
| **Orbit speed** | 24h volatility | `(tier === 'held' ? 0.04 : 0.11) × (0.35 + min(\|change24h\|, 40) / 40) × ±1`, advanced `speed × 0.004` per frame |
| **Label** | identity of anything actionable | `held`, `prime`, `eligible`, plus hover/selection |
| **Alpha** | how much it deserves attention | `dead` 0.5, `filtered` 0.65, everything else 1 |

Liquidity is log-scaled because *"a memecoin and a bluechip cannot share a screen"* otherwise — six orders of magnitude with a linear radius makes a $40k pool an invisible dot beside a $5M one.

Held tokens orbit at `0.04` against `0.11` for everything else: *"Lively tokens orbit faster; held ones barely drift, so they anchor."*

### 8.2 The palette

| Tier | Core | Label | Chip short |
|---|---|---|---|
| `held` | `#63e6a5` | `EN POSICIÓN` | `operando` |
| `prime` | `#ffd166` | `ÓPTIMA` | `óptima` |
| `eligible` | `#5aa9e6` | `ELEGIBLE` | `elegible` |
| `pending` | `#9d7cd8` | `SIN REVISAR` | `pendiente` |
| `filtered` | `#5c6773` | `FILTRADA` | `filtrada` |
| `unsafe` | `#ff6b6b` | `INSEGURA` | `insegura` |
| `dead` | `#3a2030` | `MUERTA` | `muerta` |

`pending` is violet, *"between eligible and filtered: it is queued, not judged."*

**`short` is a separate field, not the first word of `label`.** The comment records why:

> Truncating at the space turned "SIN REVISAR" into "sin" and "EN POSICIÓN" into "en" — chips that read as nothing at all. A shorter name is a different name, not a prefix of the longer one.

### 8.3 The sky is mixed on purpose

```ts
orbit: Math.sqrt(hash(`${token.id}:r`)) * 0.94 + 0.06,
```

Orbit radius comes from the **token**, not its tier, *"so a position sits among the candidates instead of on a lane of its own"*. `sqrt` because area grows with r²: a uniform radius clumps everything near the centre.

Angles are spaced evenly **by index**, with jitter:

```ts
const spread = (index / max(visible.length, 1)) * 2π + (seed - 0.5) * (π / max(visible.length, 1))
```

> Random angles clump: three tokens landing within a few degrees become one unreadable blob. […] with a little jitter so it does not read as a clock face.

The disc is tilted by multiplying `y` by `0.82`. The unit radius is `(min(w, h) / 2 − (compact ? 18 : 30)) × zoom`.

The tier ring guides were **deleted** along with the tier lanes: *"a guide under a disc nobody is sorted into would be a line pretending to mean something."*

The sun at the centre is the engine itself, drawn first, underneath everything, *"so it never hides a position"* — the `prime` glow sprite at `reach = (compact ? 30 : 40) + corePulse × 8`.

### 8.4 Clusters: collapsed, not hidden

```ts
const COLLAPSED_TIERS: readonly TokenTier[] = ['pending', 'unsafe', 'filtered']
```

One body per `(tier, chain)` pair, sized `(compact ? 9 : 12) + log10(count) × (compact ? 4 : 6)`, kept to the outside (`orbit = 0.82 + hash(key) × 0.14`), drawn with its count and a `SOL/BSC <short>` caption beneath.

> A cycle turns up a hundred tokens nobody has examined and a few dozen that failed a safety gate. Drawing each of them spends the canvas — and a fingertip's worth of screen — on the two groups you will never act on, while the handful that matter get the same dot each.

and

> A cluster is ONLY useful with its number. A shape that stands for ninety tokens and says nothing is just a bigger dot.

Tapping a cluster sets **both** filters (`setChainFilter`, `setTierFilter`) so exactly those tokens expand — which is why the reset chip clears both:

> Tapping a cluster sets BOTH filters, so a "todas" that cleared only one left the view filtered while claiming to show everything — and the word, unqualified, promises everything. The escape hatch has to mean what it says or people stop trusting the other controls too.

### 8.5 Labels

```ts
const NAMED: readonly TokenTier[] = ['held', 'prime', 'eligible']
const labelled = isHovered || isSelected || NAMED.includes(tier)
```

> The label used to be reserved for held tokens and, on a wide screen, for prime — so an ÓPTIMA and an ELEGIBLE were anonymous dots, and "which one is that" needed a tap. They are the shortlist; a shortlist whose members have no names is a picture of a shortlist.
>
> The clutter that argument was protecting against is now navigable: the sky zooms, and the tiers that come in dozens are collapsed into clusters.

Held keeps the brightest label — `rgba(235,235,235,0.92)` against `rgba(210,214,222,0.62)` — *"it is the only tier with money in it, and at a glance that distinction has to survive the crowd."* Symbols are truncated to 12 characters; font size is `(compact ? 10 : 11) × min(sqrt(zoom), 1.6)`.

### 8.6 The four performance decisions

The file header names them, and each one has a measurement behind it.

| # | Decision | Implementation | Why |
|---|---|---|---|
| 1 | **Glows are pre-rendered sprites** | `makeGlowSprite(rgb, 80)`, one per tier plus one frozen-blue; blitted with `drawImage` | *"A radial gradient per body per frame is the single most expensive thing a canvas can do, and it is pure waste when the image never changes."* Stops: `0 → 0.55`, `0.45 → 0.16`, `1 → 0`. |
| 2 | **Body count capped by screen size** | `BODY_CAP = 400`, `BODY_CAP_COMPACT = 120`, boundary `window.innerWidth < 700` | *"Two hundred nodes on a 380px phone is an unreadable smear that costs battery to draw."* Tokens arrive brightest-first, so the cap drops noise, not signal. |
| 3 | **Rendering stops when the tab is hidden** | `visibilitychange` sets `running = false`; the RAF loop exits | *"A background tab painting 60fps is a battery leak nobody ever sees."* |
| 4 | **`prefers-reduced-motion` renders one still frame** | `if (still) draw()` and no `requestAnimationFrame` | *"Motion is the point, but not at the cost of somebody's vestibular system."* |

A fifth, unnamed but equally deliberate: **device pixel ratio is capped** at `1.5` compact / `2` desktop — *"a 3x phone screen triples the fill cost for a difference nobody can see on a glow."*

What the cap dropped is counted and shown as `+N sin dibujar`:

> a screen that silently renders a third of the universe is telling you the scanner found a third of the universe.

`hidden = matching − visible.length − clustered`. Clustered tokens are subtracted because they are **represented**, not hidden.

### 8.7 Zoom, pan and the gestures

| Property | Value |
|---|---|
| Clamp | `MIN_ZOOM = 1`, `MAX_ZOOM = 6` |
| Wheel step | `×1.15` per notch, about the pointer |
| Button step | `×1.5` (`＋` / `－` chips) |
| Body scale | `sqrt(zoom)` — slower than the distances |
| Reset | a `{zoom}× ✕` chip appears whenever `zoomLabel > 1` |
| Canvas height | `62vh` compact, `min(72vh, 700px)` otherwise |

Three decisions worth stating:

- **Zoom and pan live in a ref, not in state.** *"The draw loop reads them sixty times a second; putting them in state would tear down and rebuild the whole animation effect on every pinch frame, and the sky would stutter exactly while being looked at closely."* Only `zoomLabel` — used for the chip — is mirrored into state.
- **Zoom is about a point**, so what is under the finger stays under the finger: `panX = aboutX − (aboutX − panX) × ratio`. At `MIN_ZOOM` the pan resets to zero, because *"a pan that survives a zoom-out strands it."*
- **Bodies grow more slowly than the distances.** *"Magnifying a dot to the size of a coin is not what zoom is for."*
- **Buttons exist alongside the pinch.** *"A pinch is not discoverable, and on a trackpad it is not available at all."*

**Tap versus drag is decided at the end, by distance:**

```ts
if (!drag || drag.moved > 8) return
tap(pickAt(drag.x, drag.y, ...))
```

> Eight pixels of slack: a finger never holds perfectly still, and a tap that needs stillness is a tap that keeps missing.

Hit radius is `body.radius × sqrt(zoom) + (compact ? 22 : 10)` — *"fingers are not mice."* The canvas sets `touchAction: 'none'` so the browser does not scroll the page instead of panning the sky. Chips have `minHeight: 32`.

### 8.8 Selection survives the poll; orbits survive it too

Two refs and one rule keep the canvas stable across the 20-second refresh:

- **Selection is an ID, not an object.** `selectedId` / `hoveredId` are strings resolved against the *current* `view.tokens` on every render: *"the view is replaced wholesale every time fresh data arrives, and a selection holding the OLD object would either vanish or quietly keep showing stale numbers."* It also closes itself when the token leaves the universe.
- **`anglesRef: Map<key, angle>`**, keyed by a stable token id, records each body's orbital position every frame: *"Without this every poll snaps the whole sky back to its starting angles — which reads as the screen flinching once a minute for no reason a viewer can connect to anything."*

### 8.9 The detail sheet

Tapping a body opens a full-screen sheet (`position: fixed; inset: 0; zIndex: 40`, background `#0b0e16`) showing, in order: symbol with its chain glyph, tier label, position line when held (`$N · M DCA`, plus `❄️ congelada` / `☠️ muerta`), then six rows —

`puntaje`, `liquidez`, `volumen 24h`, `cambio 24h`, `antigüedad` (in days), `ida y vuelta` (the friction estimate of §4.6)

— then **the score components as bars**, labelled in Spanish via `COMPONENT_LABEL` (`expansión de volumen`, `presión compradora`, `crecimiento de liquidez`, `actividad`, `volatilidad`, `eficiencia de costo`), then the blockers in red under `bloqueada por`. This is what makes *"why is this ranked here"* answerable without reading code.

It became a full-screen sheet for a measured reason:

> It used to be a panel under the canvas with a 34vh cap on a phone, so the thing you had just tapped to read about was the thing you had to scroll inside a letterbox to read. Full screen costs nothing here — the sky is not being watched while a token is being read.

Dismissal is a downward drag, and three details make the gesture correct:

- The grab handle (44×5px) **is** the instruction: *"Nobody reads 'swipe down to close'."*
- The drag only starts when `scrollRef.current.scrollTop === 0` — *"a drag that started halfway down a scrolled list is someone scrolling, not someone leaving."*
- It fires past `window.innerHeight * 0.25`: *"Less and a scroll that overshoots the top throws the sheet away; more and the gesture stops feeling like one."*

The `✕` button stays for pointers, at 44×44 minimum.

On desktop, hovering shows a compact `Hint` instead (symbol, tier label, score, liquidity). Hovering is disabled on compact (`!compact && setHoveredId(...)`), so the hint and the cluster hint are desktop-only by design.

---

## 9. The operations screen

`dashboard/app/operations.tsx` (`'use client'`), and deliberately the opposite of the canvas:

> A screen about money should be legible at a glance on a phone at 3am, which is not the moment for an animation.
>
> One rule runs through it: every number is shown WITH what it cost. A P&L that hides its fees is the friendliest possible lie.

### 9.1 Layout

A summary card (`desplegado`, `valor de mercado`, `pagado a la cadena`, `ejecuciones`), then one card per position, then the tape.

The position header is **two fixed rows that never wrap** — identity above, money below: *"A P&L that reflows onto its own line is a P&L that gets misread on a phone."* Row 1 carries the chain glyph, symbol, `❄️`/`☠️` stage, `⏳` when an order is in flight, and the filled-DCA count (`max(0, filled rungs − 1)`). Row 2 carries `$N dentro`, the banked figure, and the unrealised P&L with its percentage.

**Banked money keeps its own slot**, rendered whenever `realisedUsd !== 0`:

> A position that closed flat shows "—" for the open mark, and without this its realised gain would have nowhere to appear.

### 9.2 The ladder, always visible

Rungs are flex children, 22px tall. Filled is solid green (`#63e6a5` border, `rgba(99,230,165,0.35)` fill); the pending one is amber (`#ffd166`, `rgba(255,209,102,0.18)`); the rest are outlines. Rungs past the production cap get `opacity: 0.25` and `text-decoration: line-through`, *"because the strategy keeps signalling levels the venue will never fill and pretending otherwise would overstate how much dry powder is left."*

Each rung's `title` says what it is waiting for or what it cost: `N3 se arma en 0.0094500 · $15 nominal`, or `N3 ejecutado a 0.0093100 · $14.87`.

### 9.3 The blocking lock is always on screen

```tsx
{position.locks && position.locks.some((l) => !l.held) && (
  <div>⏸ {position.locks.find((l) => !l.held)!.detail}</div>
)}
```

Not behind a tap. The expanded view lists all four with `✅` / `⏸`, under `cerrojos del próximo peldaño — los cuatro tienen que ceder`, alongside `costo promedio`, `último precio`, `valor de mercado`, `ganancia cobrada`, `pagado a la cadena`, `capital asignado`, `abierta hace`, and the position's own fill list.

### 9.4 The tape

Newest first, keyed by `fill.idempotencyKey`: age, `COMPRA`/`VENTA`, symbol, `orderId`, price at 5 significant figures, notional, and the chain's cut with an explicit minus at three decimals.

### 9.5 The empty state explains the strategy

> Sin posiciones abiertas. El motor está escaneando; abre una cuando un token pasa todos los filtros Y se disparan las condiciones de entrada de la estrategia: una caída del 10% desde el máximo reciente dentro de una zona lateral.

It names the entry gate (`03-estrategia-cascade-dca.md`) rather than only reporting an absence — so "nothing is happening" is distinguishable from "something is broken".

### 9.6 The profit moved out of this tab

The `netUsd` block lives in `Console`, above the tabs, at 34px:

> It used to live inside Operaciones, which meant the one number the system exists to produce was two taps away — and while the Universe tab was open, invisible.

Operations no longer repeats it; it shows the detail behind it. Two formatting decisions in `console.tsx`:

- `money()` rounds to whole dollars (right for committed capital); `exact()` keeps two decimals. *"On a $15 ladder a gain of $6.02 rounds to '$6' and $0.83 of chain costs round to '$0', which is the difference between a cost being visible and being invisible."*
- The costs term is rendered `−$0.83 a la cadena`, with the minus written in: *"Without it this term sat in a row of signed figures wearing no sign at all, so the row read as three things being added and the total looked wrong by exactly the cost."*

---

## 10. Warnings, not a green badge — and no write path

### 10.1 Warnings

The screen tells you what is wrong and says nothing when nothing is. Four sources, in order of how they appear:

1. The engine state chip — `🛑 DETENIDO` / `▶️ Funcionando`.
2. The red **`⚠️ Datos congelados`** banner, when the poll itself failed (§7.4).
3. The amber warning list from `buildDashboard` (§3.3), rendered only when non-empty.
4. `⏸` lock lines and `⏳` badges on individual positions.

`DashboardView.warnings` being empty is itself the signal. The field's own doc comment: *"Empty is the good case, and an empty list is a stronger signal than a green badge nobody reads."*

### 10.2 Why there is no write path

`dashboard/README.md` states the principle (and is otherwise stale — §11.5):

> It shares a database with the engine and nothing else. […] A dashboard that could trade would be a second attack surface on the money, guarded by a URL people paste into chats.

Verified against the source: the HTTP handlers exported anywhere under `dashboard/` are five `GET`s and one `POST`, and the only `savePosition` / `recordFill` calls are in `demo/page.tsx`, against an in-memory store.

### 10.3 The one exception: `POST /api/control`

It earns the exception by being **one-way safe**: it can stop the engine from opening new positions and release that stop, and it cannot place an order, size one, close one, or touch a wallet. It calls `engageKillSwitch` / `disengageKillSwitch` (`src/application/kill-switch.ts`), which write an `EngineCheckpoint` and nothing else. See `05-riesgo.md` for the switch itself and its automatic triggers (`DEFAULT_LOSS_LIMITS`: 35% drawdown, or 3 death exits in 24h).

Authorisation is `src/application/control-api.ts`, 54 lines, and every rule fails closed:

| Rule | Behaviour | Why |
|---|---|---|
| Token undefined, empty, or `< MIN_TOKEN_LENGTH` (24) | **503**, before the credential is even read | *"'we forgot to set it' and 'anyone may stop the engine' must not be the same state."* |
| No credential presented | 401 | |
| Header is not `Bearer <token>` | 401 | *"`Authorization: Bearer <token>` — anything else is not a credential."* A raw token in the header is refused. |
| Lengths differ | 401, without comparing bytes | |
| Bytes differ | 401, **constant time** | *"a plain `===` on a secret returns as soon as it finds a differing byte, which over enough requests tells an attacker how much of the prefix is right."* |

```ts
const secretsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

24 characters is *"short enough to type once into a phone, long enough not to be guessed."* Six tests cover it, including *"a wrong token of a different length is still just wrong — length must not leak"*.

Body validation is equally narrow: `action` must be exactly `'kill'` or `'resume'`, anything else is a 400, and `detail` is sliced to 200 characters.

Two further properties:

- **The action is written to the alert log**, through the same `StoredAlertSink` the engine uses, *"so the phone sees its own action arrive the same way it sees a death exit — and so the audit trail records that a human stopped this, not a loss limit."* (That sink spools failed criticals, bounded at 50, and drains oldest-first — see `09-persistencia.md`.)
- **Reading the switch needs no token.** `GET /api/control` returns `killSwitchStatus(store)` openly: *"it is already on the dashboard."* Only throwing it is gated.

### 10.4 The alert feed is a log, not a pipe

`GET /api/alerts?since=&limit=` reads forward from an exclusive sequence cursor. `MAX_PAGE = 200`, default limit 50, and non-finite or non-positive inputs are coerced to safe values.

> An app that was asleep for six hours catches up instead of finding an empty pipe, which is exactly what Telegram gave us when the phone was off.

The response echoes `cursor` — `alerts.at(-1)?.seq ?? (since > 0 ? since : 0)` — rather than making every client re-derive it: *"a client that derives it wrong silently replays or skips alerts."* The Android client (`android/app/src/main/java/com/opendoors/operador/Api.kt`) reads `/api/phone`, `/api/alerts?since=&limit=`, and posts to `/api/control` with an `Authorization: Bearer` header; see `android/README.md`.

---

## 11. Sharp edges

Everything below is in the source today. None of it is speculative.

### 11.1 `impersonation` is classified as a safety gate but fires as a free market gate

`universe-view.ts:93` lists `impersonation` in `SAFETY_GATES`. `gates.ts:190` fires it inside `evaluateMarketGates` — before any security call — and `scan.ts:218` stores every token that fails the free gates with `securityChecked: false`.

The consequence, following the tier cascade exactly: a token whose **only** failure is impersonation is stored unexamined, so `marketFailure` is computed as `failures.some(f => !SAFETY_GATES.has(f.gate))` = `false`, giving tier **`pending`** ("SIN REVISAR"); and its one blocker is stripped by the same `SAFETY_GATES` filter, giving an **empty** blocker list.

A fake USDC therefore renders as *"nobody has looked at this yet"*, in violet, with no reason given — rather than as a rejection. This is reachable in production: the scanner stores exactly such snapshots.

### 11.2 `impact` is not classified as a safety gate

`impact` is absent from `SAFETY_GATES`, so a token rejected because a **measured** sell moved the price catastrophically renders as `filtered` — grey, alpha 0.65, "uninteresting" — indistinguishable from a $500 pool. That is the CREPE case: $718,000 of reported liquidity, 98% impact on a $285 sell, which is the very evidence `maxReferenceImpactPct: 10` exists for.

`denylist`, `history`, `freefall` and `marketCap` are also outside the set, which is defensible — they are genuinely "not a trade" rather than "this could hurt you". `impact` is the one worth revisiting.

### 11.3 `buildDashboard` still reads `latestScan()`

`buildUniverse` uses `latestScansByChain()`; `buildDashboard` still calls `latestScan()`, which returns a single newest row. Its `lastScan.tokensSeen` is therefore **one chain's** figure while the canvas shows the merged universe.

Mitigating, today: neither `lastScan` nor `lastCompletedBar` is rendered by `console.tsx` (searched; the only references under `dashboard/` are in `demo/page.tsx`'s hand-written payload). They are computed, serialised into `/api/view` and `/api/state`, and unused. The bug is latent rather than visible — but any new consumer of `DashboardView.lastScan` inherits it.

### 11.4 `GET /api/state` is orphaned and opens a second pool

Nothing in the repository fetches it (verified by search, excluding build artefacts). It duplicates `buildDashboard` and creates its own `new Pool({ max: 2 })` instead of using `lib/store.ts`'s memoised one — so if anything ever does hit it, the app's connection budget on a free-tier database is 4, not 2. Its own header still claims *"The only endpoint"*. Either delete it or route it through `openStore()`.

### 11.5 `dashboard/README.md` is stale

It states *"The kill switch lives in Telegram precisely because that channel is authenticated to one chat id"* — Telegram was removed entirely — and *"There is no write path in this app at all"*, which is now one endpoint wrong. The principle it explains is still right; the two factual sentences are not.

### 11.6 Two staleness windows that do not know about each other

| Where | Window | Derivation |
|---|---|---|
| `buildPhoneStatus` | 45 min | three missed 15-minute cycles, stated |
| `buildDashboard` | 2 h | not derived from the bar size at all |

The phone calls the engine stale an hour and a quarter before the web page says anything. Separately, `buildDashboard` uses `staleAfterMs` for **two different failures** — an order that should have filled, and an engine that stopped — and the comment says this is deliberate (*"it uses the same window"*). The consequence is real: you cannot tighten the stuck-order alarm without also making the engine-liveness alarm noisier.

### 11.7 The demo is half real

- Its `DashboardView` is hand-written: `committedUsd: 600`, `frozen: 1`, `blacklistedCount: 2`, `positions: []`. Its `OperationsView` is genuinely derived. So the header stats are decorative while the P&L is real — the opposite of what a reader would assume.
- `demoOperations()` calls `buildOperations(store, { now, params: DEFAULT_PARAMS })` with **no** `maxUsdPerLevel` override and **no** `maxOpenEntries`. `/demo` therefore draws the $1,000-rung ladder that the live page was fixed to stop drawing, and strikes through rungs 10–11 instead of 6–11.

### 11.8 Rendering and data-flow edges

- **The canvas effect depends on `[bodies, selectedId, hoveredId, paused, compact]`.** Every desktop hover tears down and rebuilds the whole animation effect, re-creating all eight glow sprites. Survivable at 400 bodies; not free, and `hoveredId` is set on every `mousemove`.
- **`prefers-reduced-motion` draws exactly one frame.** When `still` is true, `draw()` runs once and no `requestAnimationFrame` is ever scheduled. The canvas repaints on fresh data only because `bodies` usually changes identity through its `useMemo`; a poll returning the same tokens in the same order leaves the picture frozen. `onVisibility` has the same shape — it restarts the loop only `if (running && !still)`.
- **`compact` is decided in an effect**, so the first client render is always desktop-sized before it corrects: `BODY_CAP` 400 → 120 and the DPR cap 2 → 1.5 at `window.innerWidth < 700`.
- **`Console` never re-seeds from `initial`.** `useState(initial)` ignores later prop changes — correct for the poll, but a server re-render that changes `initial` (a soft navigation, say) is not reflected until the next 20-second tick.
- **Dead code in the `bodies` memo**: `const style = TIER_STYLE[...]` is assigned and unused in both the token and cluster branches, and the `seen` map is written and never read.

### 11.9 Operations-view edges

- **The filled map is parsed out of `fill.orderId`**: `orderId === 'Entry' ? 0 : parseInt(orderId.replace('DCA-', ''), 10)`, guarded by `Number.isFinite`. Any id that is not literally `Entry` or `DCA-<n>` silently fails to mark its rung. Sells are excluded upstream (`buys` only), which is correct, but the coupling to the string format is invisible.
- **`hasPendingOrders` is any pending order; `waitingOn` only looks at `kind === 'entry'`.** A position carrying only an exit order shows the `⏳` badge while the ladder points at `cascade.level` as if nothing were in flight.
- **`unrealisedPct` divides by `deployedUsd`, not `capitalUsd`.** It is the return on the basis still held, so a position that has cycled reports against a smaller denominator than the capital allocated to its slot. `capital asignado` is the separate line.
- **The totals mix two scopes.** `deployedUsd`, `marketValueUsd` and `unrealisedUsd` sum **open** positions only; `realisedUsd` and `costsUsd` come from `commonFund(allFills)` over **every** fill ever; `buys` and `sells` count the **full** tape, not the `tapeLength` slice. Deliberate, and easy to misread as one consistent scope.
- **The tape's symbol fallback assumes an id shaped `chain:address:at`.** A differently shaped position id yields `—`.
- **React keys in the tape are `fill.idempotencyKey`.** Unique per intended order by construction — but the demo page hand-writes `${position.id}:${orderId}`, so anything that reuses a key duplicates a React key and drops a row.
- **`buildOperations` filters `allFills` per position inside the position loop** — O(positions × fills). Fine at today's scale; it is a full read of the fill history on every server render and every 20-second poll, on a free-tier database.

### 11.10 Language

The interface is Spanish (warnings, tier labels, lock explanations, blocker text, chips); code, identifiers, types and comments are English — the project convention. `dashboard.ts` is mid-migration: warning #2 is Spanish while #1, #3, #4 and #5 are still English, so the warning list can render in two languages at once.

---

## See also

- `01-vision-general.md` — the cycle, the 15-minute bar, the free-tier topology
- `03-estrategia-cascade-dca.md` — the state machine, the ladder arithmetic, `DEFAULT_PARAMS` as evidence
- `04-escaner.md` — gates, the opportunity score, free-before-paid and the security budget
- `05-riesgo.md` — the death watch, the kill switch, `shouldEngage`
- `06-economia.md` — `MarketQuality`, the impact model, what a fill really costs
- `08-motor.md` — why an order decided at a close fills at the next open
- `09-persistencia.md` — `StatePort`, the alert log and its sequence cursor, why `fills` has no foreign key
- `android/README.md` — building the phone app and pointing it at an engine
