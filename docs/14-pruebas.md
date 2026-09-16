# Testing discipline

This chapter documents how Operador is tested and why the suite is shaped the way it is: strict TDD as it is actually practised in this repository, the measured pyramid (68 files, 753 tests, 13 seconds), golden files as an **external oracle** that is never regenerated from our own output, the parity harness that reproduces TradingView's Strategy Tester trade for trade and the three execution facts that had to be learned from the real trade list, what "fixtures from real rugs" means here in practice (and what it does not yet mean), the smoke tests that hit live APIs behind `OPERADOR_SMOKE=1`, the dataset-as-fixture pattern that turns a rate-limited experiment into a millisecond test, the recurring and expensive lesson about functions the engine never called, and every command needed to run the whole thing.

---

## 1. The rule, and where it actually binds

`CLAUDE.md` states it in four words:

> Test first. Always. Non-negotiable for anything that can move money.

That last clause is the operative one. It is not a productivity claim about TDD in general; it is a statement about a system that runs unattended, decides on its own, and whose failures are denominated in dollars rather than in bug reports. Three properties of this project make the discipline load-bearing rather than aspirational:

1. **There is no user to notice.** The engine wakes on a schedule, decides, writes, and exits (see `12-runtime-despliegue.md`). Nobody watches a cycle. A wrong answer is not reported — it is *executed*, and the only trace is a fill.
2. **Wrong is often indistinguishable from right.** A mis-seeded EMA-200 converges toward the correct values and measures 0.36% off — invisible on a chart, enough to move one of the strategy's two entry doors. A silently rejected order looks exactly like a strategy with no signals. These are the failure modes this suite exists for.
3. **There is an external oracle for half the system.** The executor has a known correct answer — TradingView's own numbers — so it can be *proven*, not merely reviewed. The scanner has none, which is why the build order was executor first (`01-vision-general.md`).

### 1.1 What "test first" looks like in the commit log

The evidence is in the shape of the commits, not in a ceremony. Implementation and its tests land together as one reviewable work unit; there is no commit that adds behaviour and a later one that adds its tests:

```
8fd4216 feat(gates): refuse a token in freefall
        CLAUDE.md
        src/domain/scanner/gates.test.ts
        src/domain/scanner/gates.ts

74c1407 perf(scan): cache discovery, so the engine stops re-finding the same universe
        src/domain/persistence/store.ts
        src/infrastructure/adapters/geckoterminal/cached-discovery.test.ts
        src/infrastructure/adapters/geckoterminal/cached-discovery.ts
        ...

2ade823 fix(engine): a restart does not owe a scan it already has
        src/application/orchestrator.test.ts
        src/application/orchestrator.ts
        src/runtime/loop.test.ts
        src/runtime/loop.ts
```

Commits that are *only* tests exist too, and they are the interesting ones, because they are written against a path that already shipped. `89445d8` (`test: prove the ladder at depth through the path production uses`) is the clearest example, and its message is the best short statement of this repository's testing philosophy:

> The deepest thing production has ever reached is DCA-1. The parity harness already proves the ladder to DCA-4 against TradingView's own trade list — entry by entry, price and size to nine decimals — so the STRATEGY at depth is pinned against an external oracle.
>
> What nothing covered was the live loop at depth. Every seed test stopped at two open entries, and in production each cycle is a new process: decide, persist, die, rebuild from fills, decide again. Six rungs exercises that rebuild in a way two do not.

That commit ends with a line worth framing:

> One assertion was wrong and the broker was right.

The expected average of a six-rung ladder was assumed to be the average of the trigger prices. It is not: every rung pays the venue on the way in, so the real basis came out 0.48% higher, which means a +2% exit target on a six-deep ladder needs the price to travel nearly 2.5%. The test was corrected to the measurement, not the code to the test.

### 1.2 Test names are the specification

Almost every `it(...)` in this repository is a sentence stating a rule, not a description of a mechanism. This is deliberate and it is the main reason the suite doubles as documentation:

| Test name | File |
|---|---|
| `'an unknown honeypot result is a failure, not a pass'` | `src/domain/scanner/gates.test.ts` |
| `'an unknown halts, it never guesses'` (describe) | `src/application/recovery.test.ts` |
| `'never exits at a loss on price alone'` | `src/domain/strategy/cascade.test.ts` |
| `'stage-1 evidence never accumulates into an exit, however long it persists'` | `src/domain/risk/death-exit.test.ts` |
| `'keys a fill so recovery recognises it, instead of halting a position it just traded'` | `src/application/engine.test.ts` |
| `'a round trip at a flat price LOSES money'` (describe) | `src/infrastructure/brokers/paper-broker.test.ts` |
| `'PROVES ta.bb returns [basis, upper, lower], not [upper, mid, lower]'` | `src/domain/indicators/sma.golden.test.ts` |
| `'refuses to start without a database, a bot token or a chat id'` | `src/runtime/config.test.ts` |
| `'a wrong token of a different length is still just wrong — length must not leak'` | `src/application/control-api.test.ts` |

Reading the names of `orchestrator.test.ts` end to end is a faithful description of the cycle's safety properties, in order. That is the intent.

---

## 2. The pyramid, measured

Run on 2026-09-15, Node 24, Windows, `npx vitest run`:

```
 Test Files  66 passed | 2 skipped (68)
      Tests  751 passed | 2 skipped (753)
   Duration  13.26s (transform 1.96s, collect 5.29s, tests 5.59s, prepare 10.34s)
```

`npx tsc --noEmit` takes a further ~6 seconds. The two skipped files are the smoke tests (§9); nothing else is ever skipped.

### 2.1 By layer

| Layer | Files | Tests | Time (vitest, per-file) |
|---|---:|---:|---:|
| `src/application/` | 21 | 279 | 653 ms |
| `src/domain/indicators/` | 14 | 72 | 2 017 ms |
| `src/domain/scanner/` | 5 | 64 | 170 ms |
| `src/domain/strategy/` | 3 | 61 | 1 049 ms |
| `src/domain/risk/` | 3 | 60 | 60 ms |
| `src/domain/economics/` | 1 | 22 | 12 ms |
| `src/domain/market/` | 1 | 8 | 7 ms |
| `src/domain/notifications/` | 1 | 4 | 5 ms |
| `src/infrastructure/adapters/` | 10 | 98 | 1 572 ms |
| `src/infrastructure/brokers/` | 3 | 29 | 28 ms |
| `src/infrastructure/persistence/` | 2 | 16 | 17 ms |
| `src/infrastructure/notifications/` | 1 | 5 | 9 ms |
| `src/infrastructure/http.test.ts` | 1 | 2 | 4 ms |
| `src/runtime/` | 2 | 33 | 36 ms |
| **Total** | **68** | **753** | — |

The distribution is not a classic pyramid and should not be read as one. The heaviest single file is the application layer's orchestrator (48 tests) and the second is the engine (35), because in this system the *order of operations* is the safety property and it lives in the application layer. The domain is smaller per file because each domain module is small and total.

### 2.2 The largest files, and why they are large

| File | Tests | What it pins |
|---|---:|---|
| `src/application/orchestrator.test.ts` | 48 | recovery-before-allocation ordering, halted capital, kill switch, slot reclamation, watch passes |
| `src/domain/scanner/gates.test.ts` | 40 | every blocker, every fail-closed path, impersonation, freefall |
| `src/domain/strategy/cascade.test.ts` | 39 | one scenario per `DCA.pine` transition, all five rebound locks, one-fill-per-bar |
| `src/application/engine.test.ts` | 35 | execution model, idempotency keys, the death watch's veto, the no-loss guard at execution time |
| `src/application/operations-view.test.ts` | 33 | the read model behind the screen |
| `src/domain/risk/portfolio.test.ts` | 23 | slot width from capital, concentration cap, the `$1` experiment at portfolio level |
| `src/domain/risk/death-exit.test.ts` | 22 | two stages, the price guardrail, evidence chains |
| `src/domain/economics/sizing.test.ts` | 22 | measured depth, fill/exit budgets, gas floor |

### 2.3 The slowest files

Wall time is dominated by the golden fixtures, which is exactly where it should be:

| File | Time |
|---|---:|
| `src/infrastructure/adapters/geckoterminal/geckoterminal.test.ts` | 1 484 ms |
| `src/domain/indicators/indicators.golden.test.ts` | 1 382 ms (DMI alone is the bulk) |
| `src/domain/strategy/signals.test.ts` | 1 021 ms |
| `src/domain/indicators/sma.golden.test.ts` | 427 ms |
| `src/domain/indicators/ema200.golden.test.ts` | 144 ms |
| `src/application/capital-floor.test.ts` | 144 ms |

Nothing here is slow because it waits. There is no sleep and no network in the suite (§8); these files are slow because they walk 4001 bars several times, or parse a 2.9 MB fixture.

### 2.4 What is NOT tested

Stated plainly, because a reader should not have to infer it from silence:

- **`dashboard/`** has no test suite. `vitest.config.ts` includes only `src/**/*.test.ts`. The dashboard is covered indirectly — its numbers come from `src/application/dashboard.ts`, `operations-view.ts`, `universe-view.ts` and `phone-status.ts`, which have 13, 33, 24 and 8 tests respectively — and directly by a CI job that builds it the way Vercel does (§10.3).
- **`android/`** has no tests. The Kotlin app is unit-tested nowhere; `13-telefono-alertas.md` covers what it does.
- **No adapter is tested against a live testnet/devnet.** `CLAUDE.md` lists "Adapters: integration tests against testnet/devnet" as a requirement; what exists today is fixture-based mapping tests plus opt-in smoke tests against the real public APIs. This is a real gap and is listed in §12.

---

## 3. The kinds of test in this repository

There are nine recognisable species. Knowing which one you are writing determines what counts as a passing assertion.

| Kind | Proves | Oracle | Example |
|---|---|---|---|
| **Unit** | internal consistency of a pure function | arithmetic worked out by hand in the test | `stdev.test.ts` — `[2,4,4,4,5,5,7,9]` → 2, not 2.138 |
| **Golden / parity oracle** | our output equals TradingView's | **external**: Pine Logs export | `indicators.golden.test.ts` |
| **Parity harness** | the whole executor reproduces a real backtest | **external**: the Strategy Tester trade list | `application/parity.test.ts` |
| **Scenario / state machine** | one transition of `DCA.pine` per test | the reference script | `cascade.test.ts`, 39 scenarios |
| **Contract** | the SQL clause that *is* the guarantee | the literal statement text | `postgres-store.test.ts` |
| **Reference implementation** | `MemoryStore` behaves as the port demands | the port's documented rules | `recovery.test.ts` |
| **Adapter mapping** | a live response shape maps to a domain type | a trimmed real response | `goplus.test.ts` (BONK, CAKE) |
| **Type-level** | an illegal state cannot be expressed | `tsc` itself, via `@ts-expect-error` | `death-exit.test.ts` |
| **Experiment** | a measured claim about the real market | a recorded dataset | `capital-floor.test.ts` |
| **Smoke** | the live APIs still answer the way we think | reality, behind a flag | `scan.smoke.test.ts` |

---

## 4. Golden files: an external oracle, never a mirror

### 4.1 The rule

From `src/domain/indicators/__golden__/harness.ts`:

> Golden values are an EXTERNAL ORACLE. They are never regenerated from this codebase's output — doing so would turn every test here into a mirror that confirms whatever we already compute.

And from `ema.golden.test.ts`, the sharper version of the same point: these are **the only tests in the indicator layer that prove parity**. Every other indicator test proves internal consistency, which is a different and much weaker claim. A unit test can confirm that `ema` is self-consistent forever while `ema` is seeded wrongly.

The corollary is operational: **the fixture may only ever come from `tools/golden-exporter.pine` run on a live TradingView chart.** There is no script that writes `bless-1h.json` from our own indicators, and adding one would silently convert the whole parity suite into a tautology.

### 4.2 The capture pipeline

```
TradingView chart (BLESSUSDT.P, 1H)
  └─ tools/golden-exporter.pine          Pine v6 indicator, works on the FREE plan.
     │                                    Mode 1 "Seed probe only"  → ~13 SEED= lines
     │                                    Mode 2 "Full export"      → one CSV= row per bar
     │                                    Formats at 15 decimals (#.###############)
     └─ Pine Logs pane → Download
        └─ tools/golden/<SYMBOL>-1H.raw.csv
           └─ node tools/parse-golden.mjs <raw-csv> bless-1h
              │   'na' → null, dedupe realtime bars by timestamp
              └─ src/domain/indicators/__golden__/bless-1h.json

TradingView Strategy Tester (tools/DCA-logged.pine)
  └─ Pine Logs → tools/golden/BLESS-1H.trades.raw.csv
     └─ node tools/parse-trades.mjs <raw-csv> bless-1h
        └─ src/domain/indicators/__golden__/bless-1h.trades.json
```

Two details in `parse-golden.mjs` are not cosmetic. It maps `'na'` to `null` (never `NaN` — see `02-indicadores.md`), and it **dedupes by timestamp**, because TradingView logs the realtime bar once per tick, so the last timestamp appears many times with different values. Without the dedupe, duplicate rows silently corrupt every windowed indicator.

Pine Logs retains only the last 10 000 messages, which is why the exporter's `export_bars` input maxes at 9 500.

### 4.3 What the fixtures contain

| Fixture | Size | Contents |
|---|---:|---|
| `__golden__/bless-1h.json` | ≈2.9 MB | `seed`: 12 rows (`bar_index, close, ema3, sma3, ema5, sma5`). `bars`: **4001 rows**, 23 columns — `time, open, high, low, close, volume, bb_basis, bb_upper, bb_lower, bbw_as_written, bbw_textbook, dip, dim, adx, swing_high, roc, vol_ma, rel_vol, vwm, st_line, st_dir, ema_trend, atr` |
| `__golden__/bless-1h.trades.json` | ≈38 KB | `inputs` (every strategy input as TradingView ran it), `syminfo` (`mintick 0.000001`, `BLESSUSDT.P`, `timeframe 60`, `initial_capital 10000`), `states` (94), `entries` (60), `closed` (55), `open` |

Both live under `src/domain/indicators/__golden__/` for locality, but the trade list is consumed only by `src/application/parity.test.ts` — no indicator test reads it.

### 4.4 The tolerance model

```ts
// src/domain/indicators/__golden__/harness.ts
export const GOLDEN_DECIMALS = 15
const GRID = 10 ** -GOLDEN_DECIMALS
const FLOAT_NOISE_RELATIVE = 1e-9
const tolerance = (expected: number) =>
  Math.max(1.5 * GRID, Math.abs(expected) * FLOAT_NOISE_RELATIVE)
```

Parity is asserted against the **export grid**, not against a fuzzy percentage. The reasoning, from the harness itself: a correct implementation lands on the same grid point, and a wrong one misses by orders of magnitude.

| Quantity | Magnitude |
|---|---|
| Export grid at 15 dp | 1e-15 |
| Observed float noise — EMA-200 over ~2000 recursions | 5e-12 |
| Observed float noise — BBW | 1.4e-12 |
| Observed float noise — a tiny stdev | 2e-11 |
| **The relative floor the tests use** | **1e-9** |
| A **mis-seeded** EMA-200 | 4e-3 — seven orders above the line |

The exporter was widened from 10 to 15 decimals after the residual at 10 dp turned out to be the exporter's own string rounding rather than a disagreement; snapped to the grid, 1001 of 1001 bars were identical.

`sma.golden.test.ts` is the one place that uses a **relative** comparison of its own (`rel < 1e-9`) rather than the shared harness, and the comment says why: it compares price (≈0.008) and volume (≈4.7e7) in the same file, and *"an absolute tolerance that is strict for 0.008 is meaningless for 47,286,856."*

### 4.5 Where each golden comparison starts, and why

TradingView warmed every indicator on history that precedes the export window, so bars before an indicator's window cannot be reproduced at all. Every golden test therefore names an explicit start index; comparing from bar 0 produces false failures.

| Indicator | Golden column | Compared from | Reason |
|---|---|---:|---|
| `sma(volume, 10)` | `vol_ma` | 9 | window fills |
| `sma(close, 50)` | `bb_basis` | 49 | window fills |
| `roc(close, 10)` | `roc` | 10 | window fills |
| `highest(high, 20)` | `swing_high` | 19 | window fills |
| `stdev(close, 50)` | `bb_upper − bb_basis` | 49 | window fills |
| `atr(10)` | `atr` | **1000** | recursive (RMA) |
| `supertrend(3, 10)` line + direction | `st_line`, `st_dir` | **1000** | recursive |
| `dmi(15, 15)` +DI/−DI/ADX | `dip`, `dim`, `adx` | **1000** | recursive |
| `vwm` | `vwm` | 200 | composed, needs volume MA + EMA |
| `ema(close, 200)` | `ema_trend` | **2200** | seeds at 199, then ~2000 bars for α = 2/201 to decay |
| composed booleans (`isLateral`, `stBearFlip`, …) | several | **1000** | inherit the recursive ones |

The convergence argument is itself a proof, and `ema200.golden.test.ts` states it:

> The two therefore start apart and converge — which is itself the proof that the recursion is identical, since a different recursion would converge to a different place, or not at all.

It is asserted, not merely asserted about: the test checks that relative error *shrinks monotonically*, `relErr(300) > relErr(1000) > relErr(2200)`. A wrong recursion can look close; it cannot look close **and** shrink its error by orders of magnitude as history accumulates.

### 4.6 The seed probe

The single highest-risk assumption in the indicator layer was how `ta.ema` seeds — at bar 0 from the source value, or at bar `length - 1` from the SMA of that window. Public sources disagree and every EMA-derived indicator depends on the answer. So the exporter has a separate, tiny **Mode 1** that emits ~13 lines, copy-pasteable, and `ema.golden.test.ts` compares them at 9 decimals over the 12 seed rows. Verdict, recorded in the test name: *"SETTLED: `ta.ema` seeds from the SMA of the first full window."*

### 4.7 The `ta.bb` proof

`sma.golden.test.ts` contains the test that settles the BBW finding documented in `02-indicadores.md` and `03-estrategia-cascade-dca.md`:

```ts
it('PROVES ta.bb returns [basis, upper, lower], not [upper, mid, lower]', () => {
  // ...
  expect(lower).toBeLessThan(basis)
  expect(basis).toBeLessThan(upper)
  const below = basis - lower
  const above = upper - basis
  expect(Math.abs(above - below) / below).toBeLessThan(1e-9)
})
```

Three independent lines of evidence, all from TradingView's own columns: element 0 equals `ta.sma(close, 50)` exactly; the bands sit symmetrically around it; and as `DCA.pine` labels them, `bb_up < bb_mid`, which is impossible for an upper band. The decision that follows — port the bug as written, ship `bbwTextbook` alongside it unused — is pinned by `signals.test.ts`, which asserts both formulas against their own golden columns and additionally asserts `lateralShare > 0.9` over the converged window, so a future retune that accidentally makes the lateral gate bite fails a test instead of silently changing behaviour.

> **Accuracy note.** The header comment of `sma.golden.test.ts` still says *"over a 301-bar 1H window"*. The fixture it reads has 4001 bars; the comment predates the recapture and the code does not depend on it. The measured BBW figures in `CLAUDE.md` (2.26×, 92.5%, 4.45%) are the 4001-bar ones and supersede the 301-bar sample, which came from an unusually quiet stretch.

---

## 5. The parity harness

`src/application/parity.test.ts` is **the** acceptance test of the executor. Four tests; everything else in the executor exists to make them pass.

### 5.1 What it does

```
bless-1h.json (4001 bars of OHLCV)
        │
        ├─ pass 1 ──▶ replay(candles, DEFAULT_PARAMS, new TradingViewSim(...))
        │             find the RESYNC point: the first TradingView 'Entry'
        │             inside the window, at bar ≥ 2200 (EMA-200 converged),
        │             on a bar where the port also opens an 'Entry'
        │
        └─ pass 2 ──▶ replay(..., { beforeBar })   at the resync bar:
                        assert the port is FLAT
                        sim.seedCash(initialCapital + Σ profits TV had realised)
                      then walk in lockstep to the end of history
```

`src/application/replay.ts` is the bar loop, and it is the TradingView execution model made explicit:

```
for each bar i:
  1. the broker executes the orders emitted at bar i-1, at bar i's OPEN
  2. the strategy sees the resulting position, marked at bar i's CLOSE
  3. the strategy evaluates bar i and emits orders for bar i+1
```

Nothing in that loop is backtest-specific. The live engine runs the same three steps per closed bar with a different broker — which is precisely why `08-motor.md` can claim the engine's step 0 is "parity semantics".

### 5.2 The window, measured

Computed from the fixtures as they stand:

| Quantity | Value |
|---|---:|
| Bars in the fixture | 4 001 |
| TradingView closed trades in the whole list | 55 |
| Closed trades whose entry falls inside the window | 48 |
| Resync bar index | **2 260** (2026-07-03T12:00Z) |
| Closed trades actually compared | **22** |
| Entry ids among them | `Entry`, `DCA-1`, `DCA-2`, `DCA-3` |
| Still open at the end of history | **5** — `Entry`, `DCA-1`, `DCA-2`, `DCA-3`, `DCA-4` |
| Capital rejections recorded by the simulator in the replay pass | **19** |

Each compared trade is checked on exit time, entry price (9 dp), exit price (9 dp), size (6 dp), profit (6 dp) and exit comment, and the *sequence* of `entryTime + id` keys must match exactly — with a failure message that names the first divergence and prints the surrounding six trades from both sides.

The fourth test covers the tail: the five-entry position still open at the end, matched entry by entry on id, price and size. That is the only place `DCA-4` appears, and it is what "the harness proves the ladder to DCA-4" means.

### 5.3 The first test is not about behaviour at all

```ts
it('the inputs TradingView ran with are exactly DEFAULT_PARAMS', () => {
  const inputs = trades.inputs as Record<string, unknown>
  expect(inputs.max_levels).toBe(DEFAULT_PARAMS.maxLevels)
  expect(inputs.confirm_bars).toBe(DEFAULT_PARAMS.confirmBars)
  expect(inputs.min_gap_pct).toBe(DEFAULT_PARAMS.minGapPct)
  expect(inputs.bbw_max).toBe(DEFAULT_PARAMS.bbwMax)
  expect(inputs.rescue_levels).toBe(DEFAULT_PARAMS.rescueLevels)
})
```

This is the guard that makes `DEFAULT_PARAMS` **evidence rather than preference**. The exported `inputs` block records what the backtest actually ran with; if anyone edits `DEFAULT_PARAMS` to express an opinion, this test fails before the trade comparison even starts. Production expresses its own choices by composition instead — `{ ...DEFAULT_PARAMS, maxUsdPerLevel: 15 }` via `src/application/production-ladder.ts`, itself covered by 5 tests. See `03-estrategia-cascade-dca.md` and `06-economia.md`.

### 5.4 The three execution facts

None of these are derivable from `DCA.pine`. All three were learned from the real trade list and are encoded in `src/infrastructure/brokers/tradingview-sim.ts`, whose own comments carry the evidence.

What *is* derivable — the `strategy()` header — sits beside them in one exported constant rather than as literals in each harness:

```ts
export const DCA_PINE_SIM_CONFIG: Omit<TradingViewSimConfig, 'mintick' | 'qtyStep'> = {
  slippageTicks: 1,        // `slippage = 1`
  commissionPct: 0.1,      // `commission_value = 0.1`, `commission.percent`
  pyramiding: 10,          // max open entries in one direction
  initialCapital: 10_000,  // `initial_capital = 10000`
  capitalRule: 'margin',   // Fact 1
}
```

Four of the five are `DCA.pine`'s header transcribed once; the fifth, `capitalRule`, is Fact 1 — the one field that had to be *inferred*, kept in the same place as the four that did not. `parity.test.ts`, `replay.test.ts` and `tradingview-sim.test.ts` all spread it, so no test file gets to hold its own private opinion of what the backtest ran with — the same argument as 5.3, applied to the broker instead of the strategy.

The `Omit` is the deliberate part. `mintick` and `qtyStep` are properties of the **symbol**, not of the strategy, so the constant *cannot* supply them and every caller is forced to say which instrument it is simulating. The parity harness takes `mintick` — and `initialCapital`, overriding the constant — from the export's own `syminfo` block; `qtyStep` it infers (Fact 2). A default tick size baked into the constant would let a harness run against the wrong symbol and report green.

**Fact 1 — the capital rule is MARGIN, not cash.**

```ts
/**
 *  - 'none'   — never rejects for funds.
 *  - 'cash'   — rejects when notional + commission exceeds free cash.
 *  - 'margin' — Pine v5+ default `margin_long = 100`: an entry is rejected
 *               when its notional exceeds AVAILABLE FUNDS, i.e. equity
 *               (cash + open position marked at the fill bar's open) minus
 *               the margin already used by open trades (their cost).
 *
 * The BLESS trade list settles it: DCA-4 ($5,000) filled with $11,200
 * already deployed against $10,000 initial capital — so not 'cash' — and
 * DCA-5..8 were signalled but never filled once price fell and equity no
 * longer covered them — so not 'none'. That is exactly 'margin'.
 */
```

The reasoning is a two-sided elimination from observed fills, and it matters because the nominal ten-entry ladder is $41,200 against $10,000 of initial capital: with the wrong rule, either everything fills or almost nothing does, and in both cases the trade list diverges within a handful of bars. `tradingview-sim.test.ts` pins all three rules side by side, including the case where a doubled price makes a $900 entry affordable on ~$500 of free cash.

The rule is not a boolean buried inside a branch. The arithmetic it runs on is an exported shape:

```ts
export interface MarginState {
  readonly cash: number
  readonly openQty: number
  readonly usedMargin: number
  readonly equity: number
  readonly available: number
}
```

`marginState(markPrice)` computes all five; `affordable` reads exactly one of them (`available >= cost`). Separating the two is what makes a rejection **explainable rather than merely observed** — a capital rejection in the parity replay can be opened up and read:

| Field | Is | Note |
|---|---|---|
| `cash` | the balance | may go **negative** under `'margin'` — the state a `'cash'` rule cannot even represent |
| `openQty` | units held | |
| `usedMargin` | `Σ(entryPrice · qty)` | what the open trades **cost**, not what they are now worth |
| `equity` | `cash + openQty · markPrice` | marked at the **fill bar's open**, the price the entry would fill at |
| `available` | `equity − usedMargin` | the number the entry is tested against |

The margin test walks that arithmetic rather than asserting the verdict alone: buy 5 @ ~100 (cash ~500, used ~500) → price doubles, equity 1 500, available 1 000, and a $900 entry fills on ~$500 of free cash → price crashes to 50, equity 75 against 1 400 used, available negative, rejected. Same rule, both directions. The parity replay records **19** of those rejections (5.2), and each one is a trade TradingView also did not take.

**Fact 2 — quantities are TRUNCATED to the contract step, not rounded.**

```ts
/**
 * Quantity step of the contract. TradingView TRUNCATES `strategy.entry`
 * quantities to it: 1000 / 0.01374 = 72780.2038… filled as 72780.203.
 * Not in `syminfo` for Pine to log; read it off the trade list.
 */
readonly qtyStep: number
```

The step is not exposed to Pine, so it had to be *inferred from the data*: every size in the trade list has at most three decimals, hence `QTY_STEP = 0.001` in the parity test. `truncateToStep` floors with a `1e-9` guard against `0.1 + 0.2` drift.

**Fact 3 — equity carries history that precedes the export window.**

The margin rule depends on realised P&L since the chart began, in January; the fixture window starts in April. So the harness seeds the simulator with TradingView's own cash at the resync bar:

```ts
const tvCashAt = (time: number) =>
  initialCapital + trades.closed.filter((t) => t.exitTime <= time).reduce((s, t) => s + t.profit, 0)
```

`seedCash` refuses to run with open trades (*"with trades open the balance and the position would disagree about what equity is"*), and the hook asserts the port is flat at that bar before seeding. Without this, the two sides agree on signals and disagree on which ones fill.

**And one definition underneath all three: what the broker's numbers MEAN.**

`03-estrategia-cascade-dca.md` §2 says the exit and rescue rules read the **broker's** `PositionSnapshot` rather than the state machine's own arithmetic. That is half a specification; the other half is what TradingView means by those fields, and the class docstring states it because a quiet disagreement here is exactly where a parity divergence surfaces first — the signals stay identical and the exits drift by a bar:

```
 * `position_avg_price` is the qty-weighted average of open entry fill prices
 * (slippage included, commission excluded). `openprofit` is marked at the
 * bar's close and excludes commission.
```

Four choices in two sentences, each of them a way to be wrong:

| Choice | What the alternative would do |
|---|---|
| **qty-weighted**, not a mean over rungs | a flat mean counts a $5,000 level the same as a $1,000 one, so the basis of a deep ladder lands far too high |
| over **open** entries only | including closed trades keeps a basis for coins no longer held |
| slippage **included** | the basis would sit a tick under every actual fill, and `min_profit` would fire early on every cycle |
| commission **excluded** | 0.1% in and 0.1% out is a tenth of the whole `+2%` target; folding it in pushes every exit later |

`openprofit` being marked at the **close** is what makes the rescue breakeven a close-time rule: `openProfit <= 0` is asked of the bar being evaluated, not of the next open where the sale would actually fill. Both sides do it that way, so it is parity rather than approximation — but note which side proves it. Every exit in the 55-trade list is `🏁 Exit` (5.5), so the oracle never exercises breakeven; these semantics are pinned by `tradingview-sim.test.ts` instead — *"reports size, qty-weighted average fill price and open profit at the close"*, which asserts `avgPrice` to 12 decimals against the hand-computed weighted average of the two fill prices and `openProfit` against the close-marked sum, commission left out of both.

`PaperBroker.snapshot` computes the identical expression over its own open trades (`07-paper-mode.md` §11). That is what lets `08-motor.md` claim the live engine runs parity semantics past the fill and not only up to it: the strategy is reading the same three numbers, defined the same way, whichever broker is underneath it.

### 5.5 What the parity harness does NOT prove

Stated because it is easy to over-read a green harness:

- **The rescue breakeven exit is never exercised.** Every exit comment in the entire 55-trade list is `🏁 Exit`. The `⚖️ BE Exit` path is covered only by `cascade.test.ts` scenarios, against the reference script rather than against an external oracle.
- **The death exit is not in it at all.** It does not exist in `DCA.pine`; it is this project's own addition (`05-riesgo.md`).
- **Depth beyond DCA-4 is untested against TradingView**, because the backtest never went deeper on this symbol.
- **It says nothing about the 15-minute timeframe.** The harness runs 1H because that is what the backtest ran. Bar size is a separate decision (`03-estrategia-cascade-dca.md`), and `config.test.ts` records the split explicitly: `'defaults to 15m — the user trades these tokens on that bar'` and `'still accepts 1h, which is what the parity harness proved'`.

---

## 6. Fixtures from real rugs — what that means here

`CLAUDE.md` states the requirement: *"Safety gates: fixtures from real honeypots and real rugs. The gate must catch known-bad tokens, not just pass known-good ones."* Here is what the repository actually contains, in three tiers, ordered by how close each is to a recording of a real event.

### 6.1 Tier 1 — adapter fixtures trimmed from live responses

The closest thing to recorded reality. Adapter tests are built from real API payloads, trimmed and pasted in with provenance in the comment:

```ts
/** Trimmed from the live BONK response (Sept 2026). */
const bonk: GoPlusSolanaToken = { ... }
/** Trimmed from the live CAKE response (Sept 2026). */
const cake: GoPlusEvmToken = { ... }
```

The same pattern appears in `dexscreener.test.ts` (*"Trimmed from a live response for BONK on Solana (Sept 2026)"*), `jupiter.test.ts` (*"a live lite-api quote: 1,000,000 BONK → USDC"*), `jupiter-tokens.test.ts` and `geckoterminal.test.ts` (*"Newest first, seconds — exactly as the live API returns it"*). These prove the mapping layer: that a real provider's shape becomes the right `TokenSnapshot` / `SecurityReport` / `MarketQuality`. They include the awkward real cases — a burn address holding 92.63% of the LP, a `null` tax field, percent-as-string.

### 6.2 Tier 2 — the SHAPES of real rugs, as domain literals

`src/domain/scanner/gates.test.ts` is organised around one describe block literally named `'gates — the shapes of real rugs'`. Each test starts from a `clean()` token that sails through every gate and mutates exactly one field, so the failure is attributable:

| Test | Mutation | Expected failure |
|---|---|---|
| `'honeypot: sell simulation failed'` | `honeypot: true` | `honeypot:failed` |
| `'infinite mint: mint authority still active'` | `mintAuthorityActive: true` | `mintAuthority:failed` |
| `'freeze: the dev can lock your tokens'` | `freezeAuthorityActive: true` | `freezeAuthority:failed` |
| `'blacklist function present'` | `hasBlacklist: true` | `blacklist:failed` |
| `'tax trap: 30% sell tax'` | `transferTaxPct: 30` | `transferTax:failed` |
| `'unlocked LP: the dev can pull liquidity'` | `lpLockedPct: 10` | `lpLocked:failed` |
| `'whale-heavy: top holders own 70%'` | `topHoldersPct: 70` | `topHolders:failed` |
| `'creator still holds a quarter of supply'` | `creatorPct: 25` | `creatorShare:failed` |
| `'upgradeable proxy on BSC'` | `isProxy: true` | proxy failure |
| `'a rug can fail several gates at once — all are reported'` | several | all of them, not the first |

That last row is the design statement: the gate returns **every** failure, because a one-line rejection teaches nothing about a token that was bad in four ways.

The fail-closed block is the other half, and it is what makes the gates trustworthy on bad data rather than only on bad tokens:

- `'an unknown honeypot result is a failure, not a pass'`
- `'unknown authorities, blacklist, tax, LP lock and concentration all fail closed'`
- `'unknown pair age fails closed'`
- `'the LP lock gate is skipped, not passed, on concentrated venues'` — skipped and marked, which is not the same as passing
- `'unknown creator share is tolerated — concentration covers the dangerous case'` — a deliberate, argued exception
- `'unmeasured history is not a failure — the scanner may not have fetched candles yet'` and `'stays silent when nothing was measured — it fires on evidence, never on absence'`

The last two are the counterweight: failing closed on *everything* unknown would reject the entire universe on a provider outage. The line drawn is between facts that are safety-critical (fail closed) and facts that are merely absent measurements (stay silent). See `04-escaner.md`.

### 6.3 Tier 3 — death-exit scenarios as observation sequences

`src/domain/risk/death-exit.test.ts` feeds sequences of `AssetHealthObservation` into `assessAssetHealth` and asserts the verdict at each step:

```ts
const run = (observations: AssetHealthObservation[], start = startDeathWatch(ENTRY_LIQ, 0)) => {
  const verdicts: string[] = []
  let state: DeathWatchState = start
  observations.forEach((obs, i) => {
    const out = assessAssetHealth(state, P, { ...obs, observedAt: i })
    verdicts.push(out.verdict)
    state = out.state
  })
  return { verdicts, state }
}
```

Against `DEFAULT_DEATH_EXIT_POLICY` — `liquidityFreezeRatio 0.5`, `liquidityExitRatio 0.2`, `liquidityFloorUsd 5 000`, `holderDumpFreezePct 10`, `abandonmentFreezeHours 6`, `abandonmentExitHours 24`, `exitConfirmations 3`, `clearObservations 6` — the 22 tests cover both directions:

- Freeze fires on **one** observation (`'freezes on a single observation when liquidity halves'`).
- Exit requires **three consecutive** (`'a broken sell path on 3 consecutive observations kills the watch'`), and `'a single broken quote freezes but does not kill — one RPC is not proof'`.
- `'a positive sell quote between failures resets the exit evidence'`.
- `'stage-1 evidence never accumulates into an exit, however long it persists'` — the two stages do not blend.
- `'an unknown sell quote is inconclusive: it neither confirms nor clears'`.
- `'dead is terminal: clean observations never resurrect it'`.
- `'records source, signals, resulting stage and verdict for every consequential observation'` — the evidence chain `CLAUDE.md` requires.
- A policy-sanity block asserting `'exit thresholds are strictly worse than freeze thresholds'`, so a future edit cannot invert the two stages.

**These are synthetic sequences, not replays of named rugs.** There is no recorded LP-pull or honeypot-flip fixture in the repository; the only JSON fixtures under `src/` are the two golden files. `CLAUDE.md` lists *"replay fixtures of real rugs (LP pulls, honeypot flips, abandonment) proving both stages fire"* as the requirement, and that is the gap: the *logic* is thoroughly tested, the *recordings* do not exist yet. See §12.

### 6.4 The guardrail that is enforced by the compiler

The strongest test in the death-exit suite does not run any code:

```ts
it('an observation cannot carry a price, even by accident', () => {
  // @ts-expect-error price is not a health signal — this must not compile
  const smuggled: AssetHealthObservation = { ...healthy(), price: 0.001 }
  // @ts-expect-error nor can drawdown
  const smuggled2: AssetHealthObservation = { ...healthy(), drawdownPct: -80 }
  ...
})
```

It works because `src/domain/risk/death-exit.ts` declares the illegal fields as `never`:

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
  ...
}
```

`@ts-expect-error` inverts the assertion: the test fails if the line *compiles*. So the guardrail is checked by `npx tsc --noEmit` in CI as well as by vitest, and "price is never a death signal" is a compile error rather than a code-review convention. This is the only file in the repository that uses `@ts-expect-error`, and the two uses are both here.

The behavioural counterparts sit alongside it — most importantly that a deep drawdown at any DCA level never triggers either stage, which is what stops the death exit from silently degrading into the stop loss the strategy must not have.

---

## 7. Test doubles: four, and each is argued for

There is no mocking library. `vi.mock` and `vi.fn` do not appear anywhere in the suite. What exists instead are four hand-written doubles, each small enough to read in one screen.

| Double | Where | Used by | What it is |
|---|---|---:|---|
| `MemoryStore` | `src/infrastructure/persistence/memory-store.ts` | 14 test files | the **reference implementation** of `StatePort` |
| `stubHttp(table)` | `src/infrastructure/http.ts` | 6 test files | a prefix-matched URL → response table that records `calls` |
| `fakeSql(responses)` | inline in `postgres-store.test.ts` | 1 | records every statement, answers with queued rows |
| `RecordingAlerts` | `src/infrastructure/notifications/recording.ts` | 6 test files | collects alerts instead of delivering them |

Plus two *simulators*, which are production code rather than doubles: `TradingViewSim` (parity) and `PaperBroker` (paper mode, `06-economia.md`).

**`MemoryStore` is not a stub.** Its header calls it the reference *"that defines what 'correct' means for the Postgres implementation"*, and it is deliberately stricter than it needs to be — idempotent by key, and every read returns a `structuredClone`, so *"a store that is loose in memory hides the bugs the real one will have."* Its contract tests live in `recovery.test.ts` (a describe block literally named `'MemoryStore — the reference implementation'`) and `alert-store.test.ts`. There is no `memory-store.test.ts`, which is worth knowing before concluding it is untested.

**`fakeSql` asserts on the SQL text, and that is the point.** `postgres-store.test.ts` does not test behaviour for the idempotency rules; it tests the literal clause, because the clause **is** the guarantee:

```ts
expect(calls[0]!.sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING')
expect(calls[0]!.sql).toContain('ON CONFLICT (chain, token_address) DO NOTHING')
expect(calls[0]!.sql).not.toContain('DO UPDATE')        // the blacklist keeps its FIRST verdict
expect(calls[0]!.sql).toContain('ON CONFLICT (id) DO UPDATE')       // a position is meant to move
expect(calls[0]!.sql).toContain('ON CONFLICT (singleton) DO UPDATE') // the checkpoint is a singleton
```

The second describe block catches the trap that no behavioural test would: Postgres returns `NUMERIC` and `BIGINT` as **strings**. The fixture feeds `capital_usd: '500.00'`, `last_bar_time: '1800000000000'`, `last_price_usd: '0.0123'` and asserts numbers come back — *"a classic way to end up comparing `\"1800000000000\"` to `1800000000000` and getting false."* See `09-persistencia.md`.

**`RecordingAlerts` has its own lesson**, recorded in its header: it used to live beside the Telegram adapter, and when Telegram was removed the whole suite would have gone with it — *"the tell that a test double was sharing a file with a delivery mechanism it never depended on."*

---

## 8. Determinism: no network, no sleeps, no wall clock

`CLAUDE.md`: *"No network, no sleeps, no wall-clock dependencies in domain tests."* In practice the rule holds across the whole suite, not only the domain, and it is enforced structurally rather than by a lint rule.

- **No network.** Nothing patches `globalThis.fetch`. Adapters take an `HttpGet` function as a constructor argument, so tests pass `stubHttp({...})` and the real implementation is simply never constructed. The only files that can reach a network are the two smoke tests, and both are skipped by default (§9).
- **No sleeps.** Both throttling and backoff take an injected `sleep`. `http.test.ts` passes its own clock and sleep and asserts on the *recorded durations*:

  ```ts
  const throttle = makeThrottle(1_000, async (ms) => { sleeps.push(ms); t += ms }, () => t)
  await throttle.wait(); await throttle.wait(); t += 400; await throttle.wait()
  expect(sleeps).toEqual([1_000, 600])
  ```

  `geckoterminal.test.ts` does the same for the 429 retry: `expect(sleeps).toEqual([4_000, 8_000])` — doubling backoff proven in under a millisecond. The single `setTimeout` anywhere in the suite is one `resolve, 0` in `loop.test.ts`, used to yield, not to wait.
- **No wall clock.** `Date.now()` appears in **no** domain test. Times are integers chosen by the test (`NOW = 1_800_000_000_000`, or bar indices used as timestamps). The domain never calls a clock at all — it is injected — so there is nothing to freeze.

The consequence worth naming: the suite is reproducible on any machine at any time, and a failure is always a real disagreement rather than a flake. There is no retry configuration in `vitest.config.ts` because nothing needs one.

```ts
// vitest.config.ts — the whole file
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
```

---

## 9. Smoke tests, and the dataset-as-fixture pattern

### 9.1 Two smoke tests, both behind a flag

```ts
const SMOKE = process.env.OPERADOR_SMOKE === '1'
describe.skipIf(!SMOKE)('scan — live smoke on Solana', () => { ... })
```

| File | What it does | Timeout |
|---|---|---:|
| `src/application/scan.smoke.test.ts` | one real scan on Solana through DexScreener + GoPlus + Jupiter; prints candidates, the rejection tally by `gate:reason`, and errors | 300 s |
| `src/application/collect-dataset.smoke.test.ts` | a full scan **plus** GeckoTerminal candles for every candidate, written to `tools/golden/solana-dataset.json` | 1 500 s |

The header of the first is honest about what it is: *"It prints what a real scan sees today. Not a parity check — a look."* They exist because the universe is not stable — Jupiter's lists fell from ~220 to 99 tokens while GeckoTerminal's pools rose from 20 to 171 between two runs (`04-escaner.md`) — and a test that asserts on today's market would be a test that fails tomorrow for the right reasons, which is the worst kind.

Run them on purpose:

```bash
OPERADOR_SMOKE=1 npx vitest run src/application/scan.smoke.test.ts
OPERADOR_SMOKE=1 npx vitest run src/application/collect-dataset.smoke.test.ts
```

### 9.2 Why collection and analysis are separate files

From `collect-dataset.smoke.test.ts`:

> Separated from the analysis on purpose. Provider throttles make a full pass take minutes, and an experiment you can only run by waiting on rate limits is an experiment you will not re-run. The dataset is a fixture: the capital floor analysis then runs in milliseconds, in the normal suite, over the same recorded market — which also makes its conclusions reproducible.

This is the most reusable idea in the chapter. The expensive, non-deterministic part runs once, by hand, and its output is **committed** (`tools/golden/solana-dataset.json`, ≈396 KB, tracked in git). Everything downstream is a fast, deterministic test over a recording.

### 9.3 The experiment that lives in the suite

`src/application/capital-floor.test.ts` is the result: four tests, 144 ms, answering the question the project exists to answer.

```ts
const DATASET = 'tools/golden/solana-dataset.json'
const CAPITALS = [1, 50, 200, 1_000, 5_000, 20_000]
const GAS_USD_PER_SWAP = 0.05
const dataset = existsSync(DATASET) ? JSON.parse(readFileSync(DATASET, 'utf8')) : null
describe.skipIf(!dataset)('capital floor — recorded Solana market', () => {
  const tokens = (dataset?.tokens ?? []).filter((t) => t.candles.time.length >= 250)
```

`skipIf(!dataset)` means the suite never depends on the file being present — a fresh clone without it still goes green — but the file *is* committed, so the four tests run in CI today. The 250-bar filter is the history gate applied to the experiment itself (`04-escaner.md`).

Two of the four tests assert, rather than merely report:

- `'at $1 the chain takes more than the strategy can produce'` — for every token, net P&L at $1 of capital is `<= 0`. *"Not an opinion: with gas at $0.05 a swap, a dollar cannot fund a cycle."*
- `'cost share is a U: gas dominates when small, impact when large'` — for each token it finds the capital at which cost/gross is minimised, then asserts that **every larger capital costs at least as much per dollar earned**. Gas is fixed so its share falls with size; impact is superlinear so its share rises. Measured on the recorded market, the cheapest point is $50 for all three tokens (4%, 18%, 9% for DREGG, TROLL and Leafy), rising to 27%, 72% and 12% at $20 000.

The other two print tables via `console.table` and assert only that rows exist. That is deliberate: the *numbers* are a measurement of one recorded window with survivorship pointing the same way as the result, and pinning them would be pinning a forecast. The **shape** — the floor, and the U — is the finding, and the shape is what is asserted. See `06-economia.md`.

---

## 10. How to run everything

### 10.1 Commands

| Command | What it does |
|---|---|
| `npm test` | `vitest run` — the whole suite once (~13 s) |
| `npm run test:watch` | `vitest` in watch mode |
| `npm run typecheck` | `tsc --noEmit` (~6 s) — also the only thing that checks the `@ts-expect-error` guardrail |
| `npx vitest run src/domain/indicators` | one directory |
| `npx vitest run src/application/parity.test.ts` | one file — the executor's acceptance test |
| `npx vitest run -t 'never exits at a loss'` | filter by test name |
| `npx vitest run --reporter=dot` | compact output, as CI and the Docker build use |
| `OPERADOR_SMOKE=1 npx vitest run src/application/scan.smoke.test.ts` | one live scan against the real APIs |
| `OPERADOR_SMOKE=1 npx vitest run src/application/collect-dataset.smoke.test.ts` | re-record `tools/golden/solana-dataset.json` |

Regenerating the golden fixtures is a manual, deliberate act (§4.2) and is **not** a script anyone should run casually:

```bash
node tools/parse-golden.mjs tools/golden/BLESS-1H.raw.csv bless-1h
node tools/parse-trades.mjs tools/golden/BLESS-1H.trades.raw.csv bless-1h
```

> The raw indicator CSV is not committed — only `tools/golden/BLESS-1H.trades.raw.csv` is, alongside a `README.md` that says *"Paste exported Pine Logs CSV files here."* Re-running `parse-golden.mjs` therefore requires re-capturing from TradingView first, which is the correct friction: the fixture is an oracle, and an oracle you can regenerate locally is one you will eventually regenerate from the wrong source.

### 10.2 Nothing runs the suite implicitly

There is no pre-commit hook, no husky, no lint-staged. The gates are explicit and there are three of them.

### 10.3 CI — `.github/workflows/tests.yml`

Two jobs, on every push to `main`/`master`, every pull request, and on demand:

| Job | Timeout | Steps |
|---|---:|---|
| `verify` | 15 min | `npm ci` → `npx tsc --noEmit` → `npx vitest run` |
| `dashboard` | 10 min | `npm ci` and `npm run build` **inside `dashboard/`** |

The second job's comment explains why it is not redundant with a local build:

> A local `next build` resolves modules through the REPOSITORY's node_modules, so a file under `src/` importing a dev-only package (vitest, say) compiles happily here and fails on Vercel, which installs only dashboard's own dependencies. That exact mistake shipped a broken deploy once.

The workflow header states what the suite is for in one sentence: *"indicator parity against TradingView's own exported values, the gates that refuse a rug, and the recovery path that halts rather than guessing. It runs before anything gets deployed anywhere."*

### 10.4 The Docker build is a gate too

```dockerfile
COPY tsconfig.json vitest.config.ts ./
COPY src ./src

# The suite is the gate. An image that cannot pass its own tests never ships.
RUN npx tsc --noEmit && npx vitest run --reporter=dot
```

The image targets `linux/arm64`, so this also means a native module without an ARM build fails at image build time rather than at 3am on the VPS (`12-runtime-despliegue.md`).

### 10.5 The engine workflow does not run tests

`.github/workflows/engine.yml` runs the engine on a schedule and does **not** run the suite — `tests.yml` already gated the commit, and a run there costs up to six hours of wall time. What it does instead is fail fast on configuration: `loadConfig` throws at boot on a bad secret, so *"a broken secret fails here rather than halfway through a ladder."* That behaviour is itself tested by the 14 tests in `src/runtime/config.test.ts`, including `'refuses live mode while no wallet adapter exists'` and `'the refusal says what to do instead'`.

---

## 11. The recurring lesson: functions the engine never called

This is the most expensive category of bug this project has hit, it has hit it at least three times, and every instance had the same shape: **a function that was written, tested, documented as the fix — and reached only by the offline path.** The suite was green throughout. Production was busy and completely still.

### 11.1 The three instances

| # | The function | Called from | NOT called from | What production did |
|---|---|---|---|---|
| 1 | `broker.execute` / `store.recordFill` | `replay.ts` (and the stores' own tests) | `tickPosition` | five positions ran showing `0 compra / 0 venta`; the engine decided orders, wrote them as `pendingOrders`, alerted, and never sent them anywhere |
| 2 | `sizeLadder` / `deployableCapital` / `scaledParams` | `paper-run.ts` | `tickPosition` | a $285 position emitted $1 000 entries; the broker rejected each for funds, in silence, for hours |
| 3 | `PaperBroker.seed` | (did not exist) | the engine tick | the engine is a one-shot process, so the broker woke flat every cycle and the strategy never saw what it opened fifteen minutes earlier |

`CLAUDE.md` names the pattern in one sentence, and it is the rule this section exists to preserve:

> Anything the experiment does and the engine does not is not a fix; it is a rehearsal of one.

Instance 2 is the cruellest of the three, because the failure is *indistinguishable from correctness*. `engine.ts` now says so in the comment above the fix:

```ts
// The strategy speaks in Pine's nominal sizes — level 0 is $1,000 — and a
// position holds whatever the portfolio allotted it. Unsized, a $285
// position emits a $1,000 entry, the broker refuses it for funds, and
// nothing is recorded anywhere: a silent rejection is indistinguishable
// from a strategy with no signals. It ran that way in production.
```

A unit test of `sizeLadder` passes. A unit test of the broker's rejection passes. The system is broken, and nothing in the suite is red.

### 11.2 What the suite does about it now

The countermeasure is a set of tests written **through the live path**, not around it. In `engine.test.ts`:

| Describe block | Tests | Closes |
|---|---:|---|
| `'tickPosition — the orders actually execute'` | 3 | instance 1 — a fill is recorded, at the next bar's open, once per replay |
| `'tickPosition — the fill recovery will look for'` | 1 | the key must be the one recovery asks about |
| `'tickPosition — the ladder is sized to the wallet, not to Pine'` | 2 | instance 2 — the emitted entry must be affordable |
| `'tickPosition — the broker is the truth about what is held'` | 2 | instance 3 — a machine that believes it holds what the broker never bought is resynced |
| `'tickPosition — a ladder six rungs deep'` | 4 | the rebuild-from-fills loop at depth (commit `89445d8`) |

Two of those tests are worth quoting because they encode reasoning that a shallower test cannot reach.

**The idempotency key must be the DECIDED bar, not the FILLED bar:**

```ts
it('keys a fill so recovery recognises it, instead of halting a position it just traded', async () => {
  ...
  // Recovery asks by the bar the order was DECIDED on, not the one it filled
  // at. These two used to disagree, which would have halted every position
  // the engine had just traded — the exact opposite of what recovery is for.
  const key = idempotencyKeyFor('pos-1', decidedAt, orderKeyPart(order))
  expect(await r.store.hasFill(key)).toBe(true)
})
```

**One `closeAll` on six rungs produces six fills, each keyed apart:**

`'records one fill per rung, each keyed apart so none collides'` — six sells, six *distinct* keys. Asserting six fills would pass while a collision silently ate one, because the store's `ON CONFLICT DO NOTHING` would discard the duplicate without error. The assertion is on the keys.

And from the same commit, the no-loss guard tested on both sides of a six-deep average cost:

- `'lets a deep ladder out at 0.92 — under the 1.00 entry, over the 0.875 average'`
- `'still refuses below the AVERAGE, not below the last rung'` — 0.80 is refused even though it is above the last rung at 0.75

A guard that read the most recent fill instead of the average would behave backwards exactly here, and nowhere shallower. That is the argument for depth: not more coverage, but coverage of the place where two plausible implementations first disagree.

### 11.3 The rule, generalised

Three questions to ask of any test that is meant to prevent a money bug:

1. **Which caller reaches this in production?** If the answer is "the replay runner" or "the paper script", the test proves the function, not the system.
2. **Would the failure be silent?** A rejected order, a stale cache, a skipped bar and an unsized ladder all look like "nothing is happening". Silent failures need a test at the boundary that *asserts something was written*, not merely that nothing threw.
3. **Is the shallowest case the one where two designs agree?** Two open entries cannot distinguish "average cost" from "last fill". Six can.

---

## 12. Known gaps

Listed as gaps, not as future work, because the difference matters when reading a green suite.

| Gap | Status |
|---|---|
| **Recorded rug replays** | `CLAUDE.md` requires replay fixtures of real rugs (LP pulls, honeypot flips, abandonment). None exist. Death-exit coverage is 22 synthetic observation sequences plus the compile-time price guardrail (§6.3). |
| **Adapter integration tests against testnet/devnet** | Required by `CLAUDE.md`; not present. What exists is fixture mapping tests plus two opt-in smoke tests against live public APIs. |
| **Slippage model validated against executed swaps** | `CLAUDE.md` requires it. The impact model is tested for internal consistency (`sizing.test.ts`, `paper-broker.test.ts`) and calibrated from measured quotes, but no test compares it to a *realised* on-chain swap, because no swap has ever been executed — the system is paper-only. |
| **The rescue breakeven exit has no external oracle** | Every exit in the TradingView trade list is `🏁 Exit`. `⚖️ BE Exit` is covered only against the reference script. |
| **Parity is 1H only** | Production runs 15m. The port is proven; the *bar size* is a separate decision with no oracle behind it. |
| **`dashboard/` and `android/` have no tests** | The dashboard's numbers are tested in the application layer and its build is gated in CI; the Android app is not tested at all. |
| **No coverage measurement** | Nothing in the repo produces a coverage report, and no threshold is enforced. The suite's adequacy is argued per-rule, not by a percentage. |
| **`capital-floor.test.ts` silently vanishes without its dataset** | `skipIf(!dataset)` is correct for a fresh clone, but it also means deleting the file turns four assertions into zero with no warning. The file is committed; nothing enforces that it stays. |
| **Stale comment in `sma.golden.test.ts`** | Its header says "301-bar 1H window"; the fixture has 4001 bars. Cosmetic, but it is the kind of drift that makes a reader distrust the numbers next to it. |

---

## 13. Summary of the rules

1. **Test first for anything that can move money.** Implementation and its tests land in the same commit.
2. **Test names are the specification.** Write the rule, not the mechanism.
3. **Golden values are an external oracle and are never regenerated from our own output.** The moment they are, the suite becomes a mirror.
4. **Compare against the export grid, not a fuzzy percentage** — `max(1.5e-15, |expected| × 1e-9)`. Real errors are orders of magnitude above float noise.
5. **Recursive indicators are compared once converged**, and convergence itself is asserted, because a wrong recursion cannot converge onto the right one.
6. **`DEFAULT_PARAMS` are evidence.** A test pins them to the backtest's exported inputs; preferences are expressed by composition.
7. **Fail closed on unknown safety facts; stay silent on unmeasured ones.** Both directions are tested.
8. **Illegal states are compile errors where the type system allows it**, and `@ts-expect-error` is how that gets tested.
9. **No network, no sleeps, no wall clock.** Ports are injected; the two files that can reach the internet are skipped unless `OPERADOR_SMOKE=1`.
10. **Expensive, non-deterministic collection runs once and is committed as a fixture.** Analysis runs in milliseconds, in the normal suite, reproducibly.
11. **Assert the shape, not the forecast.** The floor and the U are findings; the returns are not.
12. **Test through the path production uses.** A function the engine never calls is a rehearsal, not a fix.

---

**See also:** `02-indicadores.md` (the indicator semantics the golden tests pin), `03-estrategia-cascade-dca.md` (the state machine the 39 scenarios cover), `04-escaner.md` (the gates), `05-riesgo.md` (the death exit and its guardrail), `06-economia.md` (sizing, the honest simulator, the capital floor), `08-motor.md` (the engine tick the execution tests drive), `09-persistencia.md` (the store contract and recovery), `10-adaptadores.md` (the adapters whose fixtures are trimmed live responses), `12-runtime-despliegue.md` (CI, the Docker gate, the schedule).
