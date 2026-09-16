# Indicators and Pine parity

This chapter documents `src/domain/indicators/` — the pure TypeScript transcription of every `ta.*` function CASCADE DCA uses, plus the strategy's own VWM. It covers each indicator's Pine counterpart and the exact semantics that make parity hold (seeding, `na` handling, biased estimators, direction encodings, the two faces of `ta.tr`), the golden-file methodology that proves parity against TradingView's own numbers, the rule that golden values are never regenerated from our own output, and the `ta.bb` tuple finding that makes the reference strategy's BBW filter effectively inert — with its measured impact over 4001 bars. Parity breaks here first, which is why the indicator layer was milestone 1 and nothing downstream proceeded until it matched.

---

## 1. Why this layer exists, and why it is first

`DCA.pine` is the reference specification. The acceptance test for the executor is not "does it look sensible" but "does it reproduce TradingView's Strategy Tester trade for trade" (see the parity chapter). That test is worthless if the indicators feeding the state machine differ from TradingView's, because a state machine fed slightly wrong booleans produces plausible, wrong, unfalsifiable trades.

The failure mode that motivates every rule below is specific and was hit for real: **a wrong EMA seed does not look wrong.** It converges toward the right values. A mis-seeded EMA-200 measured **0.36% off** — invisible on a chart, and enough to move the EMA-200 trend gate, which is one of the strategy's two entry doors.

```
// src/domain/indicators/ema.ts
 * Seeded with the SMA of the first full window. That seed was the single
 * highest-risk assumption in the indicator layer — a wrong one does not look
 * wrong, it converges toward the right values and quietly shifts everything
 * downstream (VWM, Supertrend, the trend re-entry EMA-200 gate).
```

Only an external oracle catches that class of bug. Section 6 is that oracle.

### Domain purity

Every file here is pure and deterministic: no clock, no randomness, no network, zero imports from `infrastructure/`. Inputs are number arrays and integers; outputs are number arrays. The whole suite runs with no network, no sleeps and no wall-clock dependency.

There is **no barrel/index file**. The two consumers import each module directly:

| Consumer | Imports |
|---|---|
| `src/domain/strategy/signals.ts` | `dmi`, `ema`, `highest`, `sma`, `stdev`, `supertrend`, `vwm`, `type DenseSeries` |
| `src/application/replay.ts` | `type DenseSeries` only |

The state machine (`stepCascade`) never sees an indicator. It sees booleans and prices, assembled by `computeSignals` — see section 5.

---

## 2. The map: Pine function → port

Every row is pinned by a golden test against TradingView's exported values unless the "Parity evidence" column says otherwise.

| Pine | Port | File | Parity evidence |
|---|---|---|---|
| `ta.sma(source, length)` | `sma(source, length)` | `sma.ts` | Two independent golden columns: `bb_basis` = `ta.sma(close, 50)`, `vol_ma` = `ta.sma(volume, 10)` |
| `ta.ema(source, length)` | `ema(source, length)` | `ema.ts` | Seed probe at lengths 3 and 5 over the first 12 bars of history; full recursion at length 200 over 4001 bars |
| `ta.rma(source, length)` | `rma(source, length)` | `rma.ts` | Indirect — pinned through `atr` and `dmi`, which are RMA-only compositions |
| `ta.stdev(source, length)` | `stdev(source, length)` | `stdev.ts` | Compared against the Bollinger half-width (`bb_upper - bb_basis`, mult = 1) from bar 49 |
| `ta.roc(source, length)` | `roc(source, length)` | `roc.ts` | Golden column `roc`, from bar 10 |
| `ta.highest(source, length)` | `highest(source, length)` | `highest.ts` | Golden column `swing_high`, from bar 19 |
| `ta.tr(handle_na = true)` | `trueRange(high, low, close)` | `tr.ts` | Indirect, through `atr` |
| `ta.atr(length)` | `atr(high, low, close, length)` | `atr.ts` | Golden column `atr`, from bar 1000 (converged) |
| `ta.dmi(diLength, adxSmoothing)` | `dmi(high, low, close, diLength, adxLength)` | `dmi.ts` | Golden columns `dip`, `dim`, `adx`, from bar 1000 |
| `ta.supertrend(factor, atrPeriod)` | `supertrend(high, low, close, factor, atrLength)` | `supertrend.ts` | Golden columns `st_line` (value) and `st_dir` (exact integer), from bar 1000 |
| `ta.bb(source, length, mult)` | *not a function* — composed by the caller from `sma` + `stdev` | `strategy/signals.ts` | Tuple order proven three ways; see section 7 |
| VWM (strategy's own, not a `ta.*`) | `vwm(close, volume, params)` | `vwm.ts` | Golden column `vwm`, from bar 200 |

Two Pine constructs the strategy uses are reproduced **outside** this directory, in `src/domain/strategy/signals.ts`, because they are one-line compositions over the primitives:

- `bbw` (both the as-written and the textbook formula) — section 7.
- `ta.crossover(st_dir, 0)` — `prevDir <= 0 && dir > 0`.

---

## 3. Shared vocabulary: `na`, `Series`, and the guards

`src/domain/indicators/series.ts` is 27 lines and carries three decisions.

### `null` is `na`, never `NaN`

```ts
export type Series = readonly (number | null)[]
```

```
 * `null` is this codebase's representation of Pine's `na`. We deliberately do
 * NOT use `NaN`: `NaN !== NaN` makes accidental equality bugs silent, and in
 * code that moves money a silent comparison failure is unacceptable.
```

Every indicator returns `(number | null)[]`. A `NaN`-based representation would let `value === expected` fail silently and `if (value)` misbehave; `null` forces the check to be written.

### `DenseSeries` is the type for inputs that must have no gaps

```ts
export type DenseSeries = readonly number[]
```

`highest`, `trueRange`, `atr`, `dmi` and `supertrend` take `DenseSeries`. This is not decoration: it means "if this has a hole, the OHLCV pipeline is broken, and the type system should say so at the call site rather than the indicator inventing a gap rule".

### Guards

| Guard | Where | Rejects |
|---|---|---|
| `assertLength(length, label = 'length')` | `series.ts` | any non-integer or `< 1` length — called by `sma`, `ema`, `rma`, `stdev`, `roc`, `highest`, `dmi` (both lengths) and `vwm` (all three) |
| `assertAligned(high, low, close)` | `tr.ts` | mismatched series lengths — called by `trueRange`, `dmi`, `supertrend` |

Both throw `IndicatorError`.

---

## 4. Indicator by indicator

### 4.1 `sma` — `ta.sma`

```ts
export function sma(source: Series, length: number): (number | null)[]
```

Semantics reproduced from Pine:

- The window is **trailing**: bar `i` averages bars `[i - length + 1 .. i]`. A test pins this explicitly, because a centred window is the classic misreading: `sma([1,2,3,10,20,30], 3)` ends at **20**, not 3.
- Bars before the window is full are `na`.
- **`na` poisons its window.** Pine does not skip gaps: `sma([1, null, 3, 4, 5], 3)` is `[null, null, null, null, 4]`.
- `length = 1` is the identity mapping.

One deliberate non-optimisation:

```
 * Precision note: the window is summed directly on every bar rather than kept
 * as a rolling add/subtract accumulator. The rolling form is O(n) instead of
 * O(n·length), but it accumulates floating-point drift across long series —
 * and TradingView parity is this project's acceptance test, so correctness
 * wins over a micro-optimisation on an input we measure in thousands of bars.
```

The cost is visible and accepted: `sma.golden.test.ts` is one of the two slowest files in the layer (~374 ms) because it re-sums a 50-bar window over 4001 bars twice.

### 4.2 The seeded recursion — `recursive.ts`, shared by `ema` and `rma`

```ts
export function smaSeededRecursion(
  source: Series, length: number, alpha: number, name: string,
): (number | null)[]
```

```
out[i] = alpha * source[i] + (1 - alpha) * out[i - 1]
```

seeded, once the first full window exists, with **the SMA of that window**. Only alpha differs: `2 / (length + 1)` for EMA, `1 / length` for RMA. The recursion exists exactly once because the seeding rule is the riskiest single fact in the layer, and a fact that matters that much should not be duplicated.

**Seeding is settled, not assumed.** TradingView emits `na` until the window fills, and the first emitted value equals the SMA of that window. It does **not** start at bar 0 from the source value — which is how several public descriptions read it. The proof is `ema.golden.test.ts` against TradingView's own first twelve bars (section 6.5).

`na` handling has two distinct cases, and the asymmetry is the point:

| Case | Behaviour | Why |
|---|---|---|
| gap **before** the seed | simply delays the seed — the SMA window is poisoned until the gap falls out | this is exactly Pine's behaviour |
| gap **after** the seed | throws `IndicatorError` | *"We own the OHLCV pipeline, so a post-seed gap means the data is broken, and inventing a recursion rule for a case we cannot verify would be guessing in code that moves money."* |

The thrown message names both bars: `ema: gap at bar 3, after the series was seeded at bar 2.`

### 4.3 `ema` — `ta.ema`

```ts
export function ema(source: Series, length: number): (number | null)[]
// alpha = 2 / (length + 1), over smaSeededRecursion
```

Two unit tests are kept together deliberately, and neither may be deleted:

- *"reacts faster than an SMA to a change in direction"* — tested on a **step**, `[10,10,10,10,10,20,20,20]`.
- *"has the same lag as an SMA on a constant ramp"* — the flip side, pinned so nobody "fixes" it.

```
 * NOT tested with a constant ramp: alpha = 2/(length+1) is chosen precisely
 * so the EMA's lag, (1-alpha)/alpha, equals the SMA's lag, (length-1)/2.
 * On a straight line the two are identical BY CONSTRUCTION — that is the
 * whole reason for that alpha. Responsiveness only shows on a step.
```

Downstream, `ema` is the trend gate (`ema(close, 200)`) and the final smoothing inside VWM.

### 4.4 `rma` — `ta.rma` (Wilder)

```ts
export function rma(source: Series, length: number): (number | null)[]
// alpha = 1 / length, over the same smaSeededRecursion
```

Worked arithmetic is pinned in the unit test: seed 2 on `[1,2,3,4,5]` at length 3, then `(1/3)*4 + (2/3)*2 = 8/3`, then `(1/3)*5 + (2/3)*(8/3) = 31/9`. Because `1/n < 2/(n+1)` for every `n > 1`, RMA must trail an EMA of the same length; the test asserts `rma(5) < 17` on the step where `ema(5) = 17.04`.

RMA is the smoothing under `ta.atr` and `ta.dmi`, so it inherits the proven seed and is verified through them.

### 4.5 `stdev` — `ta.stdev(source, length, biased = true)`

```ts
export function stdev(source: Series, length: number): (number | null)[]
```

**Population (biased) standard deviation — divide by `length`, not `length - 1`.**

```
 * Pine's default is the biased estimator, and the golden data leaves no doubt:
 * population matches the Bollinger half-width to the export grid, sample is
 * off by a full 1%.
```

Measured: population matched to **9e-5%**; sample was off by **1.02%**. That is a difference large enough to move the Bollinger bands and therefore `is_lateral`, and small enough to look like rounding if it is only eyeballed.

The unit test uses the classic set `[2,4,4,4,5,5,7,9]`: mean 5, squared deviations 32, `32/8 = 4`, stdev **2**. Sample would give `sqrt(32/7) = 2.138`.

Pine's zero-snap is reproduced for completeness, not because it fires:

```ts
const PINE_ZERO_EPSILON = 1e-10
const snapped = Math.abs(deviation) <= PINE_ZERO_EPSILON ? 0 : deviation
```

The file says plainly: *"on real prices it never triggers"*.

### 4.6 `roc` — `ta.roc`

```ts
export function roc(source: Series, length: number): (number | null)[]
// roc[i] = 100 * (source[i] - source[i - length]) / source[i - length]
```

`na` when either end of the comparison is `na`, **and when the reference is exactly zero** — Pine's behaviour for `x / 0`. This is not a theoretical nicety on this system's universe: a token that printed a zero would make a naive implementation emit `Infinity`, which then poisons the entire VWM exit chain.

### 4.7 `highest` — `ta.highest`

```ts
export function highest(source: DenseSeries, length: number): (number | null)[]
```

Trailing maximum, current bar included. It takes `DenseSeries` only, and the scope restriction is explicit:

```
 * Takes a dense series: the strategy only ever applies this to `high`, which
 * has no gaps, so the question of how Pine treats `na` inside the window never
 * arises in practice and is deliberately not answered here.
```

An unanswered question that cannot arise is cheaper than a guessed answer that can.

### 4.8 `trueRange` / `atr` — and the two faces of `ta.tr`

```ts
export function trueRange(high: DenseSeries, low: DenseSeries, close: DenseSeries): number[]
export function atr(high, low, close, length): (number | null)[]  // = rma(trueRange(...), length)
```

`trueRange` implements `ta.tr(handle_na = true)`, which is what `ta.atr` uses internally: bar 0, having no previous close, falls back to `high - low`.

**`ta.tr` is not one function.** `ta.dmi` calls it *without* `handle_na`, so its bar 0 is `na`. `dmi.ts` therefore nulls it immediately after calling the shared helper:

```ts
// ta.tr without handle_na: first bar has no previous close → na.
const tr: (number | null)[] = trueRange(high, low, close)
tr[0] = null
```

Combined with `change()` being `na` on bar 0, **every RMA inside DMI seeds one bar later than ATR's.** Delete that one line and the unit tests still pass while the golden ADX drifts — this is the single most deletable-looking line in the layer.

### 4.9 `dmi` — `ta.dmi`

```ts
export function dmi(high, low, close, diLength: number, adxLength: number): Dmi
export interface Dmi { plus, minus, adx }   // +DI, -DI, ADX, each 0..100
```

Transcribed from the reference implementation in the Pine documentation:

```
up   = change(high)          down = -change(low)
+DM  = up > down and up > 0 ? up : 0
-DM  = down > up and down > 0 ? down : 0
+DI  = 100 * rma(+DM, diLength) / rma(tr, diLength)
-DI  = 100 * rma(-DM, diLength) / rma(tr, diLength)
DX   = |+DI - -DI| / (+DI + -DI)        (denominator 1 when the sum is 0)
ADX  = 100 * rma(DX, adxSmoothing)
```

Two Pine details that matter for parity:

1. The no-`handle_na` true range (above).
2. **`fixnan()` is reproduced.** `fixnan()` wraps +DI and -DI: if the smoothed true range is ever zero the division yields `na`, and Pine carries the previous value forward. Implemented as `lastPlus` / `lastMinus` loop state — the loop only recomputes them when all three smoothed inputs exist and `trValue !== 0`, and otherwise re-emits the carried value.

A property worth knowing before writing a test against synthetic data: **on a pure one-directional trend ADX is pinned at exactly 100 from its seed.** With `-DI = 0`, `DX = |+DI - 0| / +DI = 1` on every bar, so the RMA of DX is 1 from its seed onward. A test asserting "ADX rises" on monotone data would be asserting a false property; `dmi.test.ts` documents this explicitly.

### 4.10 `supertrend` — `ta.supertrend`

```ts
export type SupertrendDirection = -1 | 1
export interface Supertrend { line, direction }
export function supertrend(high, low, close, factor: number, atrLength: number): Supertrend
```

**Pine's direction encoding is inverted and is kept verbatim:**

| Value | Means |
|---|---|
| `-1` | **UPTREND** — price above the line, line is the lower band |
| `+1` | **DOWNTREND** — price below the line, line is the upper band |

```
 * It reads backwards. It is also what the strategy's own code assumes:
 * `st_dir < 0` means bullish, and `ta.crossover(st_dir, 0)` is the bearish
 * flip that triggers the safety exit. Renaming it would be friendlier and
 * would break parity — so it stays, loudly documented.
```

`DCA.pine:454` reads `trend_bullish = (st_dir < 0) and ...` and `DCA.pine:449` reads `st_bear_flip = ta.crossover(st_dir, 0)`. Reading the direction as the intuitive `+1 = up` inverts every entry and exit gate in the strategy.

Three transcription details that are easy to get wrong:

- **`upperBand[1]` in Pine is the REASSIGNED variable**, not that bar's raw `src + factor * atr`. The port carries `previousUpper` / `previousLower` / `previousLine` as the **final, post-ratchet** values. Recomputing the prior band from scratch breaks the ratchet, and the direction flips break with it.
- **`nz(band[1]) → 0`** before the first computed bar (`const priorUpper = previousUpper ?? 0`).
- **`close[1]` is `na` on bar 0**, and in Pine a comparison against `na` is false. Reproduced as `const previousClose = i > 0 ? close[i - 1]! : null`, with the null explicitly excluded from each comparison.

The bands ratchet: the lower band may only rise unless price closed below it; the upper may only fall unless price closed above it.

Golden result: over 3001 converged bars the line matches to the export grid and the direction has **zero disagreements** — an exact integer comparison, not a tolerance.

### 4.11 `vwm` — the strategy's own exit indicator

```ts
export interface VwmParams { rocLength, smooth, volumeLength }
export function vwm(close: Series, volume: Series, params: VwmParams): (number | null)[]
```

From `DCA.pine:434-437`:

```
roc_raw = ta.roc(close, roc_len)
vol_ma  = ta.sma(volume, vol_sm_len)
rel_vol = volume / math.max(vol_ma, 1)
vwm     = ta.ema(roc_raw * rel_vol, roc_sm)
```

Price velocity scaled by how active the bar was relative to recent volume, then smoothed. The `math.max(vol_ma, 1)` floor is reproduced exactly (`Math.max(average, 1)`).

This is the exit engine: `decay_count` increments while `vwm < vwm[1]`, and `impulse_dead = decay_count >= decay_req and vwm[decay_req] > 0.3` (`DCA.pine:439-442`). The `0.3` is ported as the named parameter `impulseThreshold` — deviation #2 in CLAUDE.md's table — so it is configurable and, above all, visible.

Its unit tests check composition rather than values: it reduces to `ema(roc(close, 10), 5)` when volume is constant, and with `smooth = 1` a doubled-volume bar scales by exactly `2000 / mean(10 bars)`.

---

## 5. Composition: what the strategy actually consumes

`src/domain/strategy/signals.ts::computeSignals(ohlcv, params)` is the only place the strategy's indicator formulas live. It returns two things:

- `contexts: BarContext[]` — the per-bar booleans and prices the state machine consumes (`isLateral`, `swingHigh`, `trendBullish`, `stBearFlip`, `vwm`, `vwmPrev`, `vwmLagged`).
- `series: SignalSeries` — every intermediate series: `bbBasis`, `bbUpper`, `bbLower`, `bbwAsWritten`, `bbwTextbook`, `adx`, `dip`, `dim`, `swingHigh`, `vwm`, `stLine`, `stDir`, `emaTrend`.

The source calls that second field "kept for the audit log and the dashboard". **Neither reads it, and no indicator value is persisted anywhere.** `application/engine.ts` and `application/replay.ts` both take `signals.contexts` and drop `series`; grepping the repo for `series` or `bbwTextbook` finds `signals.ts` and `signals.test.ts` and nothing else. `PersistedPosition` has no field for an indicator value and `schema.sql` has no column, so the whole structure is recomputed from scratch on every tick and discarded when the tick ends — its only real consumer is the golden test in §6, which is a genuine use but not the documented one. The audit trail the dashboard and the alert log actually run on is orders, fills and the death watch's evidence chain; see `01-vision-general.md` §7 constraint 6 for what that costs.

Pine `na` semantics apply throughout: any comparison involving `na` is false, so every boolean is false until all of its inputs exist. Two compositions are worth reading closely:

```ts
// ta.crossover(st_dir, 0): above zero now, at or below zero on the previous bar.
const stBearFlip = prevDir !== null && dir !== null && prevDir <= 0 && dir > 0
```

```ts
const trendBullish =
  dir !== null && dir < 0 &&                 // Supertrend bullish (-1!)
  a !== null && a >= params.trendAdxMin &&
  p !== null && m !== null && p > m &&       // +DI > -DI
  e !== null && close[i]! > e &&             // close > EMA(200)
  slopeRef !== null && close[i]! > slopeRef &&
  !isLateral[i]!
```

Bollinger bands are assembled here rather than in the indicator layer, because Pine's `ta.bb` is itself just `sma` ± `mult * stdev` — and because the tuple order is the subject of section 7.

The parameters driving all of this are `DEFAULT_PARAMS` in `src/domain/strategy/params.ts`, which are the Pine defaults and therefore the production configuration:

| Parameter | Value | Feeds |
|---|---|---|
| `bbLength` | 50 | `sma(close, 50)`, `stdev(close, 50)` |
| `bbStdev` | 1.0 | band half-width |
| `bbwMax` | 14 | `is_lateral` |
| `adxLength` | 15 | `dmi(15, 15)` — both DI length and ADX smoothing |
| `adxMax` | 40 | `is_lateral` |
| `requireBoth` | `false` | `is_lateral` is an **OR** |
| `swingLookback` | 20 | `highest(high, 20)` |
| `rocLength` / `rocSmooth` / `volumeLength` | 10 / 5 / 10 | VWM |
| `decayBarsRequired` | 2 | `vwmLagged` |
| `supertrendFactor` / `supertrendAtrLength` | 3.0 / 10 | Supertrend, ATR |
| `trendEmaLength` | 200 | `ema(close, 200)` |
| `trendAdxMin` / `trendSlopeBars` | 30 / 1 | trend re-entry |
| `impulseThreshold` | 0.3 | `impulse_dead` |

These are **evidence, not preference**. `src/domain/indicators/__golden__/bless-1h.trades.json` carries an `inputs` block captured from the TradingView run itself (`base_usd: 1000`, `max_usd_cap: 5000`, `max_levels: 50`, `bbw_max: 14`, `adx_len: 15`, …), and the parity harness asserts `DEFAULT_PARAMS` equals it. Editing these constants to express a runtime preference breaks the proof; the runtime instead composes `{ ...DEFAULT_PARAMS, maxUsdPerLevel }` (see `06-economia.md` for why the live ladder cap is 15 and not 5,000).

---

## 6. The golden-file methodology

### 6.1 The rule

> Golden values are an **external oracle**. They are never regenerated from this codebase's output.

```
// src/domain/indicators/__golden__/harness.ts
 * Golden values are an EXTERNAL ORACLE. They are never regenerated from this
 * codebase's output — doing so would turn every test here into a mirror that
 * confirms whatever we already compute.
```

`ema.golden.test.ts` states the corollary, which is the sharpest sentence in the layer:

```
 * These are the only tests in the indicator layer that prove parity. Every
 * other test proves internal consistency, which is a different and much weaker
 * claim.
```

Regenerating the fixture from the port's own output would silently convert the entire parity suite into a tautology — and, crucially, it would still be green. The fixture may only ever come from `tools/golden-exporter.pine` run on a live TradingView chart.

### 6.2 The capture pipeline

```
TradingView chart (BLESSUSDT.P, 1H)
  → tools/golden-exporter.pine            Pine v6 indicator, free plan; emits SEED= / CSV= lines
  → Pine Logs pane                        copy (seed mode) or Download (full mode)
  → tools/golden/<SYMBOL>-1H.raw.csv      raw `Date,Message` rows
  → tools/parse-golden.mjs                na→null, bb column remap, dedupe by timestamp
  → src/domain/indicators/__golden__/bless-1h.json
  → __golden__/harness.ts                 bars, seed, column, cell, dense, expectGolden
  → *.golden.test.ts
```

A parallel path (`tools/parse-trades.mjs`, from `DCA-logged.pine`) produces `bless-1h.trades.json` for the parity harness in `src/application/parity.test.ts`. That file lives in `__golden__/` for locality but **is not read by any indicator test**.

The exporter has two modes, and the ordering is deliberate:

| Mode | Output | Purpose |
|---|---|---|
| `Seed probe only` (default) | ~13 `SEED=` lines, copy-pasteable | Settles the EMA seeding question alone. *"Public sources disagree, and every EMA-derived indicator depends on the answer."* |
| `Full export` | one `CSV=` row per bar, downloaded from the Pine Logs pane | Everything else. `export_bars` maxes at **9500** because Pine Logs retains only the last **10,000** messages. |

Formatting is `str.tostring(x, "#.###############")` — 15 decimals, with `na` preserved as the literal string `na`. At 15 dp, prices near 0.008 keep ~13 significant digits.

The exporter's own parameter block is a mirror of `DCA.pine`'s defaults (`bb_len 50`, `bb_dev 1.0`, `adx_len 15`, `swing_lb 20`, `roc_len 10`, `roc_sm 5`, `vol_sm_len 10`, `st_atr_len 10`, `st_factor 3.0`, `tr_ema_len 200`), so the exported columns are the same numbers the strategy would see.

The parser handles two things the raw log needs:

- **`V1_BB_REMAP`** — the v1 exporter copied `DCA.pine`'s destructuring `[bb_up, bb_mid, bb_lo]`. The numbers were always right; only the labels were shifted, so the parser renames `bb_up → bb_basis`, `bb_mid → bb_upper`, `bb_lo → bb_lower`.
- **`dedupeByTime(rows)`** — a still-forming realtime bar is logged on **every tick**, so the final timestamp can appear many times with different values. The parser keeps the last sample per timestamp. This was a real bug (commit `4d9e2fb`): *"duplicates silently corrupt every windowed indicator"*.

### 6.3 The fixture

`src/domain/indicators/__golden__/bless-1h.json` — 2.9 MB.

| | |
|---|---|
| Source | `tools/golden/BLESS-1H_v2.raw.csv`, TradingView Pine Logs |
| Symbol | `BLESSUSDT.P`, timeframe 60 (1H), mintick 0.000001 |
| `seed` | **12 rows**, 6 columns: `bar_index, close, ema3, sma3, ema5, sma5` |
| `bars` | **4001 rows**, 23 columns |

The 23 bar columns: `time, open, high, low, close, volume, bb_basis, bb_upper, bb_lower, bbw_as_written, bbw_textbook, dip, dim, adx, swing_high, roc, vol_ma, rel_vol, vwm, st_line, st_dir, ema_trend, atr`.

> The raw CSV that produced this fixture is **not** in the repository — `tools/golden/` currently holds only `BLESS-1H.trades.raw.csv`, `README.md` and `solana-dataset.json`. Regenerating the bar fixture therefore means re-running the exporter on a live chart, which is exactly the constraint the external-oracle rule wants.

### 6.4 The tolerance model

```ts
export const GOLDEN_DECIMALS = 15
const GRID = 10 ** -GOLDEN_DECIMALS          // 1e-15
const FLOAT_NOISE_RELATIVE = 1e-9
const tolerance = (expected: number) =>
  Math.max(1.5 * GRID, Math.abs(expected) * FLOAT_NOISE_RELATIVE)
```

Parity is asserted **against the export grid**, not against a fuzzy percentage: a correct implementation lands on the same grid point, and a wrong one misses by orders of magnitude.

The `1e-9` relative floor is not arbitrary. At 15 decimals the grid is finer than the arithmetic — two IEEE-754 implementations summing the same window in a different order, or carrying an EMA-200 through two thousand recursions, land ~1e-11 apart:

| Observation | Relative magnitude |
|---|---|
| Float noise, EMA-200 | 5e-12 |
| Float noise, BBW | 1.4e-12 |
| Float noise, a tiny stdev | 2e-11 |
| **The tolerance floor** | **1e-9** |
| A **mis-seeded** EMA-200 | 4e-3 — seven orders above the line |

The history here matters: the first capture used **10** decimal places, and the residual against `ema_trend` (~6e-7%) was the exporter's own string rounding, not a disagreement — snapped to the grid, 1001 of 1001 bars were identical. Commit `9052de1` moved to 15 dp so the tolerance could describe arithmetic rather than formatting.

`expectGolden` also treats `na` as a first-class expectation: if the golden cell is `null`, the port must be `null` too, and vice versa. `column` / `cell` normalise an absent column and an explicit `na` to the same `null` (`noUncheckedIndexedAccess` is on, so indexed reads widen to `undefined`). `dense` throws at fixture load if an OHLCV column has a hole, because *"a hole there is a broken pipeline, not a legitimate `na`"*.

### 6.5 Where each comparison starts, and why

TradingView computed the export window with history that **precedes** it. Bars before a window is full cannot be reproduced at all, and recursive indicators arrive already converged while ours seed fresh. Comparing from bar 0 produces false failures, so every golden test names an explicit start index.

| Test | Series | Start | Reason |
|---|---|---|---|
| `sma.golden.test.ts` | `sma(close, 50)` vs `bb_basis` | 49 | first full window |
| `sma.golden.test.ts` | `sma(volume, 10)` vs `vol_ma` | 9 | first full window |
| `indicators.golden.test.ts` | `roc(close, 10)` | 10 | first full lookback |
| `indicators.golden.test.ts` | `highest(high, 20)` vs `swing_high` | 19 | first full window |
| `indicators.golden.test.ts` | `stdev(close, 50)` vs `bb_upper - bb_basis` | 49 | first full window |
| `indicators.golden.test.ts` | `atr(10)` | **1000** (`CONVERGED`) | recursive |
| `indicators.golden.test.ts` | `supertrend(3, 10)` line **and** direction | **1000** | recursive (ATR-derived) |
| `indicators.golden.test.ts` | `dmi(15, 15)` +DI / -DI / ADX | **1000** | recursive (three nested RMAs) |
| `indicators.golden.test.ts` | `vwm` | 200 | ROC 10 + volume SMA 10 + EMA 5, with margin |
| `ema200.golden.test.ts` | `ema(close, 200)` vs `ema_trend` | **2200** (`WARMUP_BARS`) | seed at bar 199, then ~2000 bars for `alpha = 2/201` to decay |

Convergence is not a weakening of the test — it **is** a test:

```
 * The two therefore start apart and converge — which is itself the proof that
 * the recursion is identical, since a different recursion would converge to a
 * different place, or not at all.
```

`ema200.golden.test.ts` asserts that directly: `relErr(300) > relErr(1000) > relErr(2200)`. *"A wrong recursion can still look close. It cannot look close AND shrink its error by orders of magnitude as history accumulates."* It also re-checks the final bar, so "converged" cannot quietly mean "drifted back apart".

### 6.6 The seed probe, in detail

`ema.golden.test.ts` compares at `PRECISION = 9` over the 12 seed rows and asserts the shape of the seed, not just the values:

- first non-null `ema5` is at index **4**, and equals `sma5` at that index;
- first non-null `ema3` is at index **2**, and equals `sma3` at that index;
- `seed[0].ema5` is `null`.

The test is named `SETTLED: ta.ema seeds from the SMA of the first full window`, and commit `4d9e2fb` records the outcome: *"The port's implementation was correct; it is now pinned by golden tests instead of assumption."*

### 6.7 Relative vs absolute comparison for `ta.sma`

`sma.golden.test.ts` uses its own relative comparator (`rel < 1e-9`) rather than the shared `expectGolden`:

```
 * Volume is in the tens of millions and price in the thousandths, so these are
 * compared RELATIVELY. An absolute tolerance that is strict for 0.008 is
 * meaningless for 47,286,856, and one that fits volume would let a price error
 * through untouched.
```

> Note: that file's header docstring still describes a *"301-bar 1H window"*, which is stale — the fixture now has 4001 bars and the loops run to `bars.length`. The comment is wrong; the test is not.

---

## 7. The `ta.bb` tuple finding, and the inert BBW filter

### 7.1 The bug

`DCA.pine:415-416`:

```pine
[bb_up, bb_mid, bb_lo] = ta.bb(close, bb_len, bb_dev)
bbw = (bb_up - bb_lo) / bb_mid * 100   // Ancho normalizado como % del precio
```

**Pine's `ta.bb` returns `[basis, upper, lower]` — the basis comes FIRST.** So all three names are shifted:

| Pine name in `DCA.pine` | What it actually holds |
|---|---|
| `bb_up` | the **basis** (`ta.sma(close, 50)`) |
| `bb_mid` | the **upper** band |
| `bb_lo` | the **lower** band |

and the BBW line computes

```
(basis - lower) / upper * 100        instead of        (upper - lower) / basis * 100
```

— a half-width normalised by the upper band, rather than a full width normalised by the basis.

### 7.2 Three independent proofs

Proven against TradingView's own exported values, not by reading documentation:

1. **Element 0 equals `ta.sma(close, 50)` to 0.0000000000%.** `sma.golden.test.ts` compares our `sma(close, 50)` to the `bb_basis` column across the whole fixture at `rel < 1e-9`.
2. **The other two sit exactly symmetrically around it**: `|(upper - basis) - (basis - lower)| / (basis - lower) < 1e-9`.
3. **As labelled, `bb_up < bb_mid`** — an upper band below its own basis is impossible.

The test carrying these is literally named:

```ts
it('PROVES ta.bb returns [basis, upper, lower], not [upper, mid, lower]', () => {
```

### 7.3 Measured impact

Both formulas are exported from Pine side by side (`bbw_as_written`, `bbw_textbook`), so the comparison is TradingView's arithmetic against TradingView's arithmetic. Over the full 4001-bar fixture, with `bbw_max = 14`, `adx_max = 40`, `require_both = false`:

| | As written | Textbook |
|---|---|---|
| Mean BBW | **5.821** | **13.165** (2.26×) |
| `bbw < bbw_max(14)` holds on | **92.5%** of bars | 74.3% of bars |
| `is_lateral` differs | — | on **4.45%** of bars |

*(Recomputed directly from `bless-1h.json` while writing this chapter; the figures match CLAUDE.md exactly.)*

The consequence is the finding's real content: the BBW half of `is_lateral` passes on 92.5% of bars, so it filters almost nothing — and because `is_lateral` is an **OR** with `adx_val < 40` (`require_both = false` in the production config), the lateral gate is close to a constant `true`. That is the hard evidence for the permissiveness of the classic entry door.

**A superseded measurement, kept because it is instructive.** The first capture was 301 bars and reported *2.12× low, `bbw < 14` on 100% of bars* (commit `4d9e2fb`). That window was an unusually quiet stretch. The small sample was not merely imprecise — **it pointed at a stronger conclusion than the data supports**, which is the more dangerous kind of wrong. The 4001-bar figures supersede it everywhere.

### 7.4 The decision

**Port the behaviour exactly as written.** The strategy's parameters — the Pine defaults, which are the production configuration, and which the trade fixture proves were the backtest's actual inputs — were tuned against this behaviour, and parity with the validated backtest is the acceptance test. Silently "fixing" it changes `is_lateral` on 4.45% of bars against a baseline that was never tested.

The corrected formula ships alongside, unread by the strategy:

```ts
/** BBW exactly as DCA.pine computes it — see the note below. The strategy uses THIS. */
readonly bbwAsWritten: readonly (number | null)[]
/** Textbook BBW. Exported for a future A/B; the strategy does not read it. */
readonly bbwTextbook: readonly (number | null)[]
```

So the fix can later be evaluated as an explicit A/B with a retuned `bbw_max` — not smuggled in as a bugfix. This is deviation #6 in CLAUDE.md's "Known deviations from the Pine reference" table.

Note also that **the indicator layer does not compute BBW at all.** Both formulas live in `src/domain/strategy/signals.ts`, because BBW is a strategy formula over `ta.bb`, not a `ta.*` function.

---

## 8. Failure modes — the things that look right and are not

Each row is a real trap, most of them paid for once already.

| Trap | What it looks like | What catches it |
|---|---|---|
| Seeding `ta.ema` at bar 0 from the source value | An EMA that converges toward the right values; a chart you cannot tell apart. Mis-seeded EMA-200 measured 0.36% off, enough to move the EMA-200 entry gate. | Only golden data — `ema.golden.test.ts` seed probe |
| Using the `handle_na` true range inside DMI (or the raw one inside ATR) | Every subsequent RMA seeds one bar off; ADX/±DI drift | Golden `dip`/`dim`/`adx`. Local unit tests still pass — this is why `tr[0] = null` carries a comment |
| Sample (N-1) instead of population stdev | Off by 1.02% on a 50-bar window — moves the Bollinger bands and therefore `is_lateral`, but looks like rounding | Golden stdev vs the Bollinger half-width (population matched to 9e-5%) |
| Reading Supertrend direction as `+1 = up` | Inverts every entry and exit gate in the strategy | `supertrend.test.ts` pins the encoding; golden `st_dir` is an exact integer match |
| Recomputing Supertrend's prior band from `src ± factor*atr` | Breaks the ratchet, and the direction flips with it | Golden `st_line` + `st_dir` |
| `ta.roc` on a zero reference | `Infinity` poisons the whole VWM exit chain | `roc.test.ts`: `roc([0, 5], 1)` is `[null, null]` |
| Duplicated realtime bars in the raw export | Silently corrupts every windowed indicator | `dedupeByTime` in `parse-golden.mjs` (fixed in `4d9e2fb`) |
| Comparing golden values from bar 0 | False failures on warmup and pre-window history | Explicit start index per test (section 6.5) |
| Regenerating the fixture from our own output | The entire parity suite becomes a tautology — and stays green | Nothing automated. This is a discipline rule, stated in `harness.ts` and here |
| Asserting "ADX rises" on synthetic monotone data | Asserting a false property — ADX is pinned at 100 from its seed | `dmi.test.ts` documents it |
| "Fixing" the EMA to beat the SMA on a ramp | Undoes the property `alpha = 2/(length+1)` exists for | Both the step test and the ramp test are kept |
| Optimising `sma` into a rolling accumulator | Float drift across thousands of bars, against a grid-level tolerance | The comment in `sma.ts`; the golden tolerance would eventually catch it |

---

## 9. Test inventory and measurements

Run on 2026-09-15, `npx vitest run src/domain/indicators`: **14 files, 72 tests, all passing.** Duration 3.77 s total, 2.19 s in tests.

| File | Tests | Time | What it proves |
|---|---|---|---|
| `sma.test.ts` | 9 | 9 ms | trailing window, length-1 identity, `na` poisoning, no input mutation, length validation |
| `ema.test.ts` | 12 | 8 ms | SMA seed, alpha arithmetic, step vs ramp, post-seed gap throws |
| `rma.test.ts` | 5 | 8 ms | same seed, `alpha = 1/length` (8/3, 31/9), slower than EMA on a step |
| `stdev.test.ts` | 5 | 6 ms | population vs sample, constant series, `na` poisoning |
| `roc.test.ts` | 4 | 7 ms | percent change, `na` on zero reference, `na` propagation |
| `highest.test.ts` | 4 | 5 ms | trailing max incl. current bar, identity at length 1 |
| `tr.test.ts` | 4 | 7 ms | worked TR arithmetic; `atr` at length 1 is TR itself |
| `dmi.test.ts` | 4 | 12 ms | +DI/-DI on a pure trend, ADX pinned at 100, ADX drops on a zig-zag |
| `supertrend.test.ts` | 3 | 7 ms | `-1/+1` encoding, no flip-back on a monotone rise, `na` until ATR exists |
| `vwm.test.ts` | 2 | 9 ms | reduces to `ema(roc)` at constant volume; relative-volume scaling |
| `sma.golden.test.ts` | 4 | 374 ms | **parity**: `ta.sma` on price and volume; the `ta.bb` tuple proof |
| `ema.golden.test.ts` | 5 | 9 ms | **parity**: the EMA seed, settled |
| `ema200.golden.test.ts` | 4 | 110 ms | **parity**: `ema(close, 200)` from bar 2200; monotone convergence |
| `indicators.golden.test.ts` | 7 | 1621 ms (dmi alone 504 ms) | **parity**: roc, highest, stdev, atr, supertrend (line + direction), dmi, vwm |

Consolidated parity results:

| Indicator | Result |
|---|---|
| `ta.sma` | exact on both price and volume scales (rel < 1e-9) |
| `ta.ema` | seed settled; length-200 recursion matches to the export grid from bar 2200 |
| `ta.rma` | verified indirectly through ATR and DMI |
| `ta.stdev` | population matched the Bollinger half-width to 9e-5%; sample off by 1.02% |
| `ta.roc`, `ta.highest` | exact from their first valid bar |
| `ta.atr` | matches to the grid once converged |
| `ta.supertrend` | line to the grid; **zero direction disagreements over 3001 converged bars** |
| `ta.dmi` | +DI, -DI and ADX all match to ~1e-9 once converged |
| VWM | composition pinned from bar 200 |

The same harness is imported beyond this directory — by `src/domain/strategy/signals.test.ts`, `src/application/parity.test.ts` and `src/application/replay.test.ts` — so the OHLCV that drives the state-machine and parity tests is the *same* real market data the indicators were pinned on.

---

## 10. What this chapter does not claim

Stated plainly, because an honest boundary is worth more than a tidy one:

- **`ta.rma` has no direct golden column.** It is pinned only through `atr` and `dmi`. Both are RMA-only compositions, so a wrong RMA cannot pass them, but there is no standalone `rma` oracle column in the fixture.
- **Pine's `na`-inside-window behaviour for `ta.highest` is deliberately unanswered.** `highest` accepts `DenseSeries` only. If the strategy ever applies it to a gap-bearing series, that question has to be answered against real Pine behaviour first.
- **Parity is proven on one symbol and one timeframe** — BLESSUSDT.P, 1H, 4001 bars. That is sufficient for arithmetic (an indicator has no symbol-specific branch), but the fixture is not a sample of market regimes, and the 301-bar episode in section 7.3 is the standing warning about reading conclusions out of a narrow window.
- **The raw CSV behind the bar fixture is not in the repository.** Re-deriving it means re-running `tools/golden-exporter.pine` on a live chart.
- **Production runs 15-minute bars, not the 1H the golden data was captured on.** The parity harness proves the *port* is faithful to `DCA.pine`; bar size is a separate decision, and every parameter counted in bars changes meaning with it (see CLAUDE.md, "Bar size — 15m in production", and the strategy chapter).
- **The `sma.golden.test.ts` header comment is stale** — it says "301-bar 1H window" while the fixture has 4001 bars. Comment only; the assertions iterate the full fixture.

---

## Files

| Path | Role |
|---|---|
| `src/domain/indicators/series.ts` | `Series`, `DenseSeries`, `IndicatorError`, `assertLength` |
| `src/domain/indicators/sma.ts` | `ta.sma` |
| `src/domain/indicators/recursive.ts` | the shared SMA-seeded recursion |
| `src/domain/indicators/ema.ts` | `ta.ema` |
| `src/domain/indicators/rma.ts` | `ta.rma` |
| `src/domain/indicators/stdev.ts` | `ta.stdev` (population) |
| `src/domain/indicators/roc.ts` | `ta.roc` |
| `src/domain/indicators/highest.ts` | `ta.highest` |
| `src/domain/indicators/tr.ts` | `ta.tr(handle_na = true)`, `assertAligned` |
| `src/domain/indicators/atr.ts` | `ta.atr` |
| `src/domain/indicators/dmi.ts` | `ta.dmi` (+DI, -DI, ADX) |
| `src/domain/indicators/supertrend.ts` | `ta.supertrend` |
| `src/domain/indicators/vwm.ts` | VWM — the strategy's own exit indicator |
| `src/domain/indicators/__golden__/harness.ts` | fixture loader, tolerance model, accessors |
| `src/domain/indicators/__golden__/bless-1h.json` | the external oracle: 12 seed rows + 4001 bars × 23 columns |
| `src/domain/indicators/__golden__/bless-1h.trades.json` | TradingView trade list + inputs — consumed by the parity harness, not by any indicator test |
| `src/domain/strategy/signals.ts` | composes the indicators into `BarContext[]`; where BBW lives |
| `src/domain/strategy/params.ts` | `DEFAULT_PARAMS` — the Pine defaults, and the production configuration |
| `tools/golden-exporter.pine` | the capture tool (Pine v6, free plan, Pine Logs) |
| `tools/parse-golden.mjs` | raw CSV → fixture; `na`→`null`, bb remap, dedupe |
