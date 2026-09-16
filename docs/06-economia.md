# Economics: sizing, costs and the capital floor

This chapter documents the layer where the strategy's nominal USD meets the pool's reality: `src/domain/market/market-quality.ts` (the four measurements the scanner hands the executor), `src/domain/economics/sizing.ts` (the three budgets, the derived gas floor, and the refusal rule), `src/application/production-ladder.ts` (the two numbers that make production differ from the reference, kept where nothing can disagree about them), the capital arithmetic in `src/application/paper-run.ts` (`deployableCapital`, `ladderCapitalUsd`, `slotFloorUsd`, `scaledParams`) together with `paperRun`, the offline run that composes them into one token's whole life, and `src/application/portfolio-run.ts`, the offline harness that runs all of it across many tokens at once. It covers why effective depth comes from a measured quote and never from reported TVL, why the exit budget bounds the whole position rather than each rung, why the gas floor is computed instead of picked, why production composes its ladder on top of `DEFAULT_PARAMS` instead of editing it, and what the capital-floor experiment actually measured — including the tables, the four findings, and the U-shaped cost curve that is the strongest argument in the repository for many small positions over one large one. It also names, plainly, the places where the implementation is narrower than the documentation around it.

---

## 1. The files, and what each one owns

| File | Owns | Purity |
|---|---|---|
| `src/domain/market/market-quality.ts` | the `MarketQuality` contract, its validator, the first-order impact estimate, `expectedFillCostPct` | pure, **zero imports** |
| `src/domain/economics/sizing.ts` | `effectiveDepth`, `gasFloorUsd`, `DEFAULT_SIZING_POLICY`, `sizeLadder` | pure; imports only `usdForLevel`, `CascadeParams`/`PYRAMIDING`, and the `MarketQuality` type |
| `src/domain/strategy/ladder.ts` | `usdForLevel`, `dropPct`, `triggerPrice`, `ladderCapital` — the ladder arithmetic from `DCA.pine` | pure |
| `src/application/production-ladder.ts` | `DEFAULT_MAX_USD_PER_LEVEL = 15`, `DEFAULT_MAX_DCA_PER_TOKEN = 5`, `productionLadder(env)` | no clock, no network, no database (so the web app can import it) |
| `src/application/paper-run.ts` | `PRICE_HEADROOM_PCT`, `deployableCapital`, `ladderCapitalUsd`, `scaledParams`, `slotFloorUsd`, and `paperRun` with `PaperRunConfig` / `PaperRunResult` / `PaperSummary` — one token, end to end, offline (§6.5) | application layer |
| `src/application/portfolio-run.ts` | `portfolioRun` — the same wallet split across tokens, one independent `paperRun` each, and the `PortfolioSummary` that accounts for all of it | application layer; offline harness, §8.6 |
| `src/infrastructure/brokers/paper-broker.ts` | charging what sizing predicted: spread + own impact + gas | infrastructure; §7 below |
| `src/domain/risk/portfolio.ts` | splitting a wallet across slots using the same `sizeLadder` | pure; see `05-riesgo.md` |

Tests: `src/domain/market/market-quality.test.ts`, `src/domain/economics/sizing.test.ts`, `src/application/paper-run.test.ts`, `src/application/portfolio-run.test.ts`, `src/application/capital-floor.test.ts`.

---

## 2. `MarketQuality` — the contract between scanner and executor

The scanner does not hand the executor a verdict. It hands it four measurements, and keeps handing them over while the position is open.

```ts
export interface MarketQuality {
  readonly liquidityUsd: number   // total pool liquidity, both sides
  readonly spreadPct: number      // round-trip cost at negligible size
  readonly slippagePct: number    // measured impact for referenceUsd
  readonly referenceUsd: number
  readonly observedAt: number     // "Stale quality is no quality."
}
```

| Field | Meaning | Consumed by |
|---|---|---|
| `liquidityUsd` | reported pool depth | the death exit's liquidity-collapse baseline; the fallback when nothing was measured |
| `spreadPct` | the AMM fee plus any gap — "what you pay for merely being there" | subtracted from **both** budgets before any impact is allowed; charged by `PaperBroker` on every fill |
| `slippagePct` @ `referenceUsd` | the quoted impact of a real reference order | inverted into **effective depth**, which is what every live cost model actually uses |
| `observedAt` | when the numbers were taken | **nothing** — see §11.3 |

### 2.1 Where it is built

Three sites in `src/application/scan.ts` (≈ lines 140, 249, 380) construct it:

```ts
{
  liquidityUsd: market.liquidityUsd,                       // DexScreener
  spreadPct: config.spreadPct,                             // a CONFIG CONSTANT (0.3 in main.ts)
  slippagePct: slippagePct                                 // the sell probe's priceImpactPct…
    ?? (market.liquidityUsd > 0
        ? estimatePriceImpactPct(config.referenceUsd, market.liquidityUsd)  // …or the model
        : 100),
  referenceUsd: config.referenceUsd,                       // 100
  observedAt: scannedAt,
}
```

It then rides on `Candidate.marketQuality` through ranking (`domain/scanner/ranking.ts`), is persisted as JSONB on the position row (`quality`, `postgres-store.ts`), and is refreshed for open positions by `main.ts`'s `healthFor`, which probes a sell of `Math.max(position.capitalUsd, 50)` — the **whole position**, not a token nibble, because "whether $100 can be sold says nothing about whether the position can leave".

### 2.2 The two rules the contract implies

1. **The executor validates, it does not trust.** A token the scanner ranked first still has to prove its pool can carry a ladder; `sizeLadder` is called again inside `planPortfolio` (`domain/risk/portfolio.ts:202`) and again per tick in `engine.ts:114`. Defense in depth, and the comment says so: *"The executor validates, it does not trust: a token the scanner ranked highly still has to prove its pool can carry a ladder."*
2. **Nominal USD is not fill size.** `usdForLevel(params, n)` is what the strategy *wants*. What is deployed is bounded by three budgets and by the wallet.

### 2.3 The validator

```ts
if (!(q.liquidityUsd > 0)) throw new MarketQualityError('liquidityUsd must be positive')
```

Written as `!(x > 0)` rather than `x <= 0` so that **`NaN` fails too**. `spreadPct` and `slippagePct` must be `>= 0`; `referenceUsd` must be `> 0`.

`assertMarketQuality` has **no production caller** — only `expectedFillCostPct` and the tests. See §11.2.

---

## 3. Effective depth: a measured quote beats reported TVL

### 3.1 The inversion

`estimatePriceImpactPct` is a deliberately first-order constant-product model: with quote reserve `Q = liquidity / 2`, a swap of Δ moves the average execution price by `Δ / Q`.

```ts
return (usd / (liquidityUsd / 2)) * 100
```

The comment states its scope exactly: *"exact enough for the 'is this level too big for this pool' question, and deliberately simpler than reproducing every AMM curve. Real fills come from real quotes; this is the planning estimate."* It **throws** on an empty pool rather than returning `Infinity`.

`effectiveDepth` runs that model backwards. If the pool moved `slippagePct` on an order of `referenceUsd`, then the depth that would explain it is:

```
depth = 200 × referenceUsd / slippagePct
```

```ts
export function effectiveDepth(quality: MarketQuality): { usd: number; source: 'measured' | 'reported' } {
  if (quality.slippagePct > 0 && quality.referenceUsd > 0) {
    return { usd: (200 * quality.referenceUsd) / quality.slippagePct, source: 'measured' }
  }
  return { usd: quality.liquidityUsd, source: 'reported' }
}
```

It falls back to reported liquidity rather than throwing when `slippagePct` is 0, "when a measurement of exactly zero impact makes the inversion meaningless".

### 3.2 Why — HEV

The reason this exists is one token in the first live Solana scan. From the test that records it:

```ts
// HEV in the first live scan: $186k reported, 5.2% impact on $100.
const hev = effectiveDepth(quality({ liquidityUsd: 186_000, slippagePct: 5.2 }))
expect(hev.usd).toBeCloseTo(3_846, 0)
```

**$186,000 reported. $3,846 real.** A 48× overstatement, because on a concentrated venue almost none of the reported liquidity sits at the current price. Reported depth would have sized a ladder that the pool could not fill at any price the strategy would accept.

The rule the test states: *"reported liquidity never rescues a pool the quote says is thin."* A token reporting $5,000,000 with 8% impact on $100 has $2,500 of usable depth and gets a ladder under $50.

### 3.3 Reported vs real, across the live Solana candidates

Recorded in `CLAUDE.md` from the first live scan, when sizing was run against the pool alone (no capital ceiling):

| Token | Reported | Real depth | Ladder |
|---|---|---|---|
| EMBER | $517k | $1.0M | $13,750 over 5 levels |
| DREGG | $171k | $67k | $909 over 4 levels |
| SQUIRE | $125k | $14k | $183 over 4 levels |
| HEV | $186k | **$3.8k** | **refused** |

Against a nominal ladder of $41,200. Note that HEV's "refused" belongs to that run: it was refused by the **$20 hardcoded floor** that `gasFloorUsd` later replaced. Under today's derived $5 floor the same pool is *shrunk*, not refused — see §4.5 and §11.1.

---

## 4. The three budgets

The file header of `sizing.ts` is the specification:

> `usd(n)` from DCA.pine is what the strategy WANTS. What the executor may actually deploy is bounded by three things:
> 1. Per-fill cost. Every buy pays spread + price impact.
> 2. Exit cost. `close_all` sells the ENTIRE position in one order, so the total position — not each level — determines what leaving costs. **This is the constraint people forget, and on a thin pool it binds first.**
> 3. A gas floor. A fill so small that fixed costs dominate is not worth placing at all.

```ts
export interface SizingPolicy {
  readonly maxFillCostPct: number   // per BUY, spread + impact
  readonly maxExitCostPct: number   // for the single sell that closes everything
  readonly minFillUsd: number       // below this, gas and rounding dominate
  readonly maxOpenEntries?: number  // omitted = PYRAMIDING
}

export const DEFAULT_SIZING_POLICY: SizingPolicy = {
  maxFillCostPct: 1.0,
  maxExitCostPct: 3.0,
  minFillUsd: gasFloorUsd(0.05, 1),   // $5
}
```

**1% per buy and 3% for the exit are the user's numbers.** The exit budget is looser *on purpose*, and the code says why: *"it happens once, and by the strategy's own rules only in profit (or on a death exit, where getting out at all beats getting out cheaply)."*

### 4.1 The spread comes out first, of both budgets

```ts
const fillImpactBudget = policy.maxFillCostPct - quality.spreadPct
const exitImpactBudget = policy.maxExitCostPct - quality.spreadPct
```

Both budgets are **total** cost, so the venue's fee is subtracted before anything is left for impact. The comment names the bug this prevents:

> Forgetting this on the exit side silently lets the position grow past its own budget by exactly one spread.

With a 0.25% pool, a 1% fill budget leaves 0.75% for impact. With production's configured 0.3% spread it leaves 0.7%.

The largest order that fits a given impact budget is the inversion again:

```ts
const maxOrderUsd = (budgetPct: number, depth: number): number => (budgetPct <= 0 ? 0 : (budgetPct * depth) / 200)
```

### 4.2 The exit budget bounds the TOTAL, not each rung

```ts
const perFillCap  = maxOrderUsd(fillImpactBudget, depth.usd)
const positionCap = Math.min(maxOrderUsd(exitImpactBudget, depth.usd), availableCapitalUsd)
```

`closeAll` sells everything in one order. `PaperBroker.execute` charges exactly that — one `costPct` computed against the **summed** notional, one gas charge split by share — so `maxExitCostPct` is the budget for the thing the broker will actually do, not a hypothetical.

Levels are then sized **in order**, and the exit budget is consumed cumulatively:

```ts
const roomInPosition = positionCap - deployed
const sizedUsd = Math.min(nominalUsd, perFillCap, roomInPosition)
```

An early level may take its full nominal size while a later one is cut or dropped — *"which is exactly the shape a DCA ladder needs — the scouting entry matters less than being able to leave."*

### 4.3 The gas floor is derived, not guessed

```ts
export const gasFloorUsd = (gasUsdPerSwap: number, maxGasSharePct = 1): number =>
  maxGasSharePct > 0 ? (gasUsdPerSwap * 100) / maxGasSharePct : Infinity
```

It replaced a hardcoded `$20` minimum fill in commit `000b4df`. The reasoning, verbatim:

> A fixed floor is a guess that stops being true the moment gas moves: $20 is generous on Solana at $0.01 a swap and reckless on a congested chain at $0.20. The honest floor is whatever size keeps gas under the share of it you are willing to lose.

| Gas per swap | Tolerance | Floor |
|---|---|---|
| $0.01 | 1% | $1 |
| $0.05 | 1% | **$5** (the default) |
| $0.05 | 0.5% | $10 |
| $0.20 | 1% | $20 |
| any | 0% | `Infinity` — admits no fill at all |

The 20× gas ratio produces a 20× floor exactly; that identity is pinned by a test. And the whole point of deriving it is visible in one pair of tests:

```ts
it('a $15 ladder clears the derived floor at Solana gas', …)   // minFillUsd = gasFloorUsd(0.05, 1) = 5  → tradeable
it('…and is refused at congested gas, which is the right answer', …) // minFillUsd = gasFloorUsd(0.20, 1) = 20 → refused
```

The old $20 floor refused the production $15 ladder outright. The derived floor accepts it on Solana and still refuses it if gas climbs to $0.20 — the right answer in both cases.

### 4.4 Capital is a second ceiling on the total

`availableCapitalUsd` defaults to `Infinity` and is `min`'d into `positionCap`. The comment is the bug report:

> A ladder sized past the capital does not fail gracefully — every level beyond it is simply rejected for funds, which reads as a strategy that does not trade rather than a position that was sized wrong.

Omitting it sizes against the pool alone — *"useful for asking 'what could this token carry', not for placing orders."*

### 4.5 Refusal vs truncation — three gates and one loop break

`sizeLadder` refuses the token entirely in four places, and truncates the ladder in one. The distinction is worth memorising, because two of these comparisons are three lines apart and produce opposite outcomes.

| Condition | Outcome | Message shape |
|---|---|---|
| `fillImpactBudget <= 0` | **refuse** | `venue spread 1.5% already exceeds the 1% fill budget` |
| `perFillCap < minFillUsd` | **refuse** | `a 1% fill allows only $2, below the $5 floor` |
| `positionCap < minFillUsd` | **refuse** | `capital allows a position of only $0, below the $5 floor` (or `a 3% exit allows…`) |
| `sizedUsd < minFillUsd` at **level 0** | **refuse** | `level 0 can only be funded with $3, below the $5 floor` |
| `sizedUsd < minFillUsd` at any later level | **truncate** — `break`, the ladder is exhausted | no message; `tradeable` stays true |

A thin pool is therefore **shrunk, not refused**. The test states the rule and its justification together:

> The budgets, not the floor, are what protect the position: a $14 fill on this pool costs the same 1% as a $750 fill on a deep one. Refusing would be a different rule from the one the budgets already enforce.

### 4.6 The output record

```ts
export interface LadderSizing {
  readonly tradeable: boolean
  readonly reason: string | null
  readonly levels: readonly LevelSizing[]   // { level, nominalUsd, sizedUsd, limitedBy, fillCostPct }
  readonly totalUsd: number
  readonly nominalTotalUsd: number
  readonly exitCostPct: number
  readonly effectiveDepthUsd: number
  readonly depthSource: 'measured' | 'reported'
}
```

`SizingLimit` is `'none' | 'fillCost' | 'exitCost' | 'capital'`.

**A refusal still reports `nominalTotalUsd`, `effectiveDepthUsd` and `depthSource`** — only `levels` and `totalUsd` are emptied. The audit log needs to know what was asked for and what the pool answered, not only that the answer was no. Pinned by *'still reports the nominal ladder when refusing, for the audit log'*.

`nominalTotalUsd` is summed over the **fillable** rungs only:

```ts
const fillable = Math.min(params.maxLevels + 1, policy.maxOpenEntries ?? PYRAMIDING)
```

> The nominal total is what the ladder WANTS before any cap applies, and a shorter ladder wants less. Sizing that against the old count would hold back capital for rungs that can never fill.

### 4.7 A worked example, end to end

Take the test fixture: `liquidityUsd: 1_000_000`, `spreadPct: 0.25`, `slippagePct: 0.1 @ referenceUsd: 100`, `DEFAULT_PARAMS`, no capital ceiling.

```
effectiveDepth  = 200 × 100 / 0.1                 = $200,000   (measured)
fillImpactBudget = 1.00 − 0.25                     = 0.75%
exitImpactBudget = 3.00 − 0.25                     = 2.75%
perFillCap       = 0.75 × 200,000 / 200            = $750
positionCap      = 2.75 × 200,000 / 200            = $2,750
```

| Level | Nominal `usd(n)` | Room left | Sized | `limitedBy` | `fillCostPct` |
|---|---|---|---|---|---|
| 0 | $1,000 | $2,750 | **$750** | `fillCost` | 1.00% |
| 1 | $2,200 | $2,000 | **$750** | `fillCost` | 1.00% |
| 2 | $3,400 | $1,250 | **$750** | `fillCost` | 1.00% |
| 3 | $4,600 | $500 | **$500** | `exitCost` | 0.75% |
| 4 | $5,800 → $5,000 | $0 | — | — | loop breaks |

Total **$2,750** against a nominal $41,200 — a factor of fifteen. `exitCostPct = 0.25 + 2,750/100,000 × 100 = 3.00%`, exactly the budget.

The same machinery on HEV's measured depth of $3,846:

```
perFillCap  = 0.75 × 3,846 / 200 = $14.42
positionCap = 2.75 × 3,846 / 200 = $52.88
```

giving four rungs of $14.42, $14.42, $14.42, $9.62 — **$52.88 total**, which is why the test asserts `totalUsd < 100` against a $41,200 nominal ladder. Under the old $20 floor, `perFillCap = $14.42 < $20` refused the token outright.

### 4.8 The nominal ladder, for reference

`usdForLevel(params, n) = min(baseUsd × (1 + amountIncrement × n), maxUsdPerLevel)`. With `DEFAULT_PARAMS` (`baseUsd: 1000`, `amountIncrement: 1.2`, `maxUsdPerLevel: 5000`):

| Level | 0 | 1 | 2 | 3 | 4..9 |
|---|---|---|---|---|---|
| USD | 1,000 | 2,200 | 3,400 | 4,600 | 5,000 (capped) |

Ten fillable rungs sum to **$41,200**, asserted in both `sizing.test.ts` and `paper-run.test.ts`. Against a $100k pool at 0.3% spread, level 4 alone costs **10.3% per fill** — *"the number that makes small pools untradeable at nominal size"*. Against a $1M pool every one of the ten stays under 1.5%.

---

## 5. The production ladder — composed, never edited

### 5.1 Why composition

`DEFAULT_PARAMS` and `PYRAMIDING = 10` are what TradingView ran, and the parity harness (`14-pruebas.md`) asserts they are exactly the backtest's inputs. The rule, stated in `production-ladder.ts`:

> Neither number may be expressed by editing `DEFAULT_PARAMS` or `PYRAMIDING`. Those are what TradingView ran and the parity harness asserts them: they are EVIDENCE, and **evidence that can be edited to express a preference stops being evidence**. Production composes its own values on top.

A test enforces it directly:

```ts
it('leaves the reference untouched, because the harness asserts it', () => {
  expect(PYRAMIDING).toBe(10)
  expect(P.maxOpenEntries).toBeUndefined()
})
```

and `config.test.ts` re-asserts `DEFAULT_PARAMS.maxUsdPerLevel === 5_000` in the same breath as checking the production override is 15.

So the runtime spreads:

```ts
params:  { ...DEFAULT_PARAMS,          maxUsdPerLevel: config.maxUsdPerLevel },        // main.ts:320
sizing:  { ...DEFAULT_SIZING_POLICY,   maxOpenEntries: config.maxDcaPerToken + 1 },    // main.ts:328
```

### 5.2 Why the numbers live alone in one file

`production-ladder.ts` exists because **two** consumers need these values and neither may own them: the engine, which sizes and fills the ladder, and the dashboard, which draws it.

> The dashboard drew `DEFAULT_PARAMS` instead and showed a $1,000 rung beside a $15 order for days — a screen disagreeing with the engine about the size of a trade, which is the exact failure `buildDashboard` exists to prevent.

The module has no database, clock or network import, so the Next.js app can import it without dragging the runtime into its build.

### 5.3 The two numbers

```ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15
export const DEFAULT_MAX_DCA_PER_TOKEN = 5

export function productionLadder(env): ProductionLadder {
  return {
    maxUsdPerLevel: positive(env.OPERADOR_MAX_USD_PER_LEVEL, DEFAULT_MAX_USD_PER_LEVEL),
    maxOpenEntries: positive(env.OPERADOR_MAX_DCA, DEFAULT_MAX_DCA_PER_TOKEN) + 1,
  }
}
```

**`maxUsdPerLevel = 15` changes the ladder's shape, not only its size.** `min(1000 × (1 + 1.2n), 15)` is $15 at *every* level, so the production ladder is **flat** rather than growing. Ten fills come to $150, where gas at $0.05 a swap is **0.33%** of each — which is what makes a ladder this small viable at all. `config.ts` adds: *"Raise it as the capital grows. That was always the plan."*

**`maxDcaPerToken = 5` means six open entries**, not the reference's ten. The user's reasoning is the ladder's own geometry, and it appears verbatim in three files (`sizing.ts`, `production-ladder.ts`, `config.ts`):

> With `linInc` at 3, DCA-5 already needs a 13% fall and DCA-10 needs 28%. A token down 28% is rarely an opportunity, and the capital those deep rungs reserve buys more by going to another token — which is finding 2 of the capital floor, arriving by a different road.

`main.ts` passes that same 6 to the sizing policy as well as to the broker, because *"sizing for ten while the venue holds six would reserve capital for four rungs that are never coming."*

### 5.4 What a $15 flat ladder demands of a pool

With production's configured `spreadPct = 0.3`:

| Requirement | Threshold |
|---|---|
| any fill at all (`perFillCap ≥ $5`) | effective depth ≥ **$1,429** |
| a full $15 rung (`perFillCap ≥ $15`) | effective depth ≥ **$4,286** |
| all six rungs (`positionCap ≥ $90`) | effective depth ≥ **$6,667** |

Below those the ladder is shrunk, then truncated, then refused — in that order.

---

## 6. The capital arithmetic: four functions, two of them inverses — and the run they serve

### 6.1 `deployableCapital` — the forward question

```ts
const PRICE_HEADROOM_PCT = 5

export function deployableCapital(config): number {
  const swaps = Math.min(config.params.maxLevels + 1, config.maxOpenEntries) + 1 // entries + one exit
  const gasReserve = config.gasUsdPerSwap * swaps
  return Math.max(0, (config.initialCapital - gasReserve) * (1 - PRICE_HEADROOM_PCT / 100))
}
```

Two reserves, each for a measured failure:

- **Gas for every swap of a full cycle**, buys and the one sell that closes them all.
- **5% of price headroom**, because *"the state machine sizes an order at the signal bar's CLOSE, and it fills at the next bar's OPEN plus slippage. Sizing to the last cent therefore makes every order a coin flip on affordability: a gap up of half a percent and the broker rejects it for funds. A position that silently fails to open is the worst failure mode there is — it looks exactly like a strategy with no signals."*

This matters because `PaperBroker` ignores `order.usd` entirely and prices `notional = order.qty × open`, where `qty` was computed at the signal bar's close. The whole close-to-open gap lands on the affordability check; `PRICE_HEADROOM_PCT` is what absorbs it.

Adding these two reserves is what dropped the measured floor where the system trades at all **from ~$200 to under $50**.

### 6.2 `ladderCapitalUsd` — the inverse, and the $950 bug

```ts
export function ladderCapitalUsd(params, maxOpenEntries, gasUsdPerSwap): number {
  const rungs = Math.min(params.maxLevels + 1, maxOpenEntries)
  const nominal = Array.from({ length: rungs }, (_, level) => usdForLevel(params, level)).reduce((a, b) => a + b, 0)
  const swaps = rungs + 1
  return nominal / (1 - PRICE_HEADROOM_PCT / 100) + gasUsdPerSwap * swaps
}
```

Allocation used to ask only the forward question and then hand each slot whatever the portfolio had spare. Measured live:

> Five positions holding **$285 each** while a flat $15 ladder of six rungs can only ever deploy about **$95**. Nine hundred and fifty dollars reserved against rungs that do not exist — capital the engine counted as committed, so it could neither spend it nor open anything with it.

It is an **exact inverse, not an estimate**, and the test proves the round trip:

```
ladderCapitalUsd(flat-$15, 6 rungs, $0.05) = 6 × 15 / 0.95 + 7 × 0.05 = 94.7368 + 0.35 = $95.09
deployableCapital($95.09, $0.05, 6, …)      = (95.0868 − 0.35) × 0.95   = $90.00   ← exactly six rungs of $15
```

`orchestrator.ts:269` uses it twice: to **trim** every kept position down to what its ladder actually needs — *"never below what is already deployed: that money is in the token, and pretending otherwise would let the same dollars be handed out twice"* — and as `PortfolioPolicy.targetPositionUsd`, so the width of the book is the division rather than the size of each slot.

### 6.3 `slotFloorUsd` — the derived floor, and the stale one it replaced

```ts
export function slotFloorUsd(params, maxOpenEntries, gasUsdPerSwap, minFillUsd): number {
  return ladderCapitalUsd({ ...params, maxUsdPerLevel: minFillUsd, baseUsd: minFillUsd, amountIncrement: 0 },
                          maxOpenEntries, gasUsdPerSwap)
}
```

It is **the same ladder priced entirely at the gas floor**: every rung at `minFillUsd`, flat, grossed up for headroom, plus gas for a full cycle.

Deliberately *not* the nominal ladder, because `scaledParams` shrinks the ladder to what the wallet allows: *"A slot with less does not fail; it trades smaller rungs. What it cannot do is trade rungs below the GAS FLOOR, where the chain's fixed cost eats the fill."*

```
slotFloorUsd(any 6-rung ladder, $0.05 gas, $5 floor) = 6 × 5 / 0.95 + 7 × 0.05 = 31.58 + 0.35 = $31.93
```

Under $50, matching what the capital-floor experiment measured after the sizing fixes. A test pins that the floor does **not** depend on the ladder being flat — `slotFloorUsd(DEFAULT_PARAMS, …)` equals `slotFloorUsd(flat15, …)` to six decimals — because *"the floor is a property of the gas, not of the ambition."*

**What it replaced.** `PortfolioPolicy.minPositionUsd: 200` was a *real* measurement — the first capital-floor run placed no orders below it — taken **before** sizing reserved gas and headroom. That change dropped the true floor to under $50, and the constant never moved, so for weeks it capped the book at four slots however much capital was free. The 200 survives in `DEFAULT_PORTFOLIO_POLICY` only as a conservative default for offline experiments; `orchestrator.ts:349` overrides it with `slotFloorUsd`. The lesson in the comment: *"A floor that is derived cannot go stale that way."*

### 6.4 `scaledParams` — shrink the ladder, never drop a rung

```ts
export function scaledParams(params: CascadeParams, sizing: LadderSizing): CascadeParams {
  const first = sizing.levels[0]
  if (!first || first.nominalUsd <= 0) return params
  const scale = first.sizedUsd / first.nominalUsd
  const cappedNominal = sizing.levels.reduce((max, level) => Math.max(max, level.sizedUsd), 0)
  return {
    ...params,
    baseUsd: params.baseUsd * scale,
    maxUsdPerLevel: Math.min(params.maxUsdPerLevel * scale, Math.max(cappedNominal, usdForLevel(params, 0) * scale)),
  }
}
```

The ladder's **shape** — growing size as price falls — is preserved; only its scale changes. A level the pool cannot fund is clamped to the last fundable size rather than removed, *"because dropping a level would change the state machine's own transitions and break parity with the validated behaviour"*. `dcaBasePct`, `amountIncrement`, `maxLevels` and every drop parameter are untouched; tests assert exactly that.

### 6.5 `paperRun` — the four functions composed into one token's whole life

The four above are arithmetic. `paperRun` is what they were written for: paper-trades **one** token end to end, the executor's strategy over real candles, through the honest broker, with the ladder sized to the pool. Its header says what it is for, and what it is not:

> This is where the project's open question gets answered. Not *"is the strategy good"* — parity already settled that it reproduces the backtest — but *"does it survive spread, impact and gas at THIS size, on THIS pool"*.

```ts
export function paperRun(
  snapshot: TokenSnapshot,
  quality: MarketQuality,
  candles: Candles,
  config: PaperRunConfig,
): PaperRunResult
```

Four steps, in this order:

1. `sizeLadder(config.params, quality, config.sizing ?? DEFAULT_SIZING_POLICY, deployableCapital(config))` — the three budgets of §4 and the wallet ceiling of §6.1, in one call.
2. **If the sizing refuses, the run stops there.** `{ tradeable: false, reason: sizing.reason, sizing, replay: null, broker: null, summary: null }` — no broker is even constructed. Tested as *"refuses before placing a single order, with the reason"*; it is the same refusal that prints `POOL REFUSED` in §8.3's table.
3. Otherwise one `PaperBroker` is built with `gasUsdPerSwap`, `initialCapital`, `maxOpenEntries` and `quality` as a **thunk** (§7), and `replay(candles, scaledParams(config.params, sizing), broker)` walks every bar.
4. The broker's numbers are folded into a `PaperSummary`.

**`PaperRunConfig`** — five fields, and four of them are read by more than one layer:

| Field | Type | Read by |
|---|---|---|
| `params` | `CascadeParams` | the ladder the machine signals — `DEFAULT_PARAMS` in the capital-floor run, `productionLadder(env)` elsewhere (§5) |
| `sizing?` | `SizingPolicy` | optional; falls back to `DEFAULT_SIZING_POLICY` |
| `gasUsdPerSwap` | `number` | reserved by `deployableCapital`, then charged per swap by the broker |
| `initialCapital` | `number` | the sizing ceiling, the broker's starting cash, and the denominator of `returnPct` |
| `maxOpenEntries` | `number` | the broker's pyramiding cap, and the rung count both capital functions count swaps over |

**`PaperRunResult`** — everything the caller might want to inspect, including on a refusal:

| Field | Meaning |
|---|---|
| `token` | `snapshot.symbol`, the only thing read off the snapshot |
| `tradeable` / `reason` | sizing's verdict, and its message when the answer is no |
| `sizing` | the full `LadderSizing` record (§4.6) — returned in **both** branches, which is why a test can read `nominalTotalUsd === 41_200` off a run that never placed an order |
| `replay` | `ReplayResult` (signals, per-bar states, per-bar orders, fills), or `null` |
| `broker` | the `PaperBroker` itself, or `null` — callers read `fills`, `totalCosts` and `rejections` off it |
| `summary` | `PaperSummary`, or `null` |

**`PaperSummary`** — the run in twelve numbers:

| Field | How it is computed |
|---|---|
| `bars` | `candles.time.length` |
| `cycles` | bars whose emitted order set contained a `closeAll` — **round trips**, not rungs |
| `closedTrades` / `wins` | closed trades and those with `profit > 0`. A `closeAll` closes every open rung separately, so this counts **rungs**, which is why §8.3 reads 25/29 trades against 14 cycles |
| `grossPnlUsd` | `broker.realisedGrossUsd` — mid-to-mid: *"what the price move was worth before the chain took its cut"* |
| `costsUsd` | spread + impact + gas over the whole run, **open position included** |
| `closedCostsUsd` | the share of those costs belonging to CLOSED trades: entry + exit commission, summed |
| `netPnlUsd` | the summed `profit` of the closed trades |
| `endingCashUsd` | `broker.equityCash` — cash only, the open position is not marked into it |
| `openPositionUsd` | open trades marked at the **last** close of the candle series |
| `equityUsd` | `endingCashUsd + openPositionUsd` |
| `returnPct` | `(equityUsd − initialCapital) / initialCapital × 100` |

Two cost numbers, not one, and the comment says why:

> Costs on trades still open are real money already spent, but they have no realised P&L to net against — keeping the two apart is what makes the accounting identity below exact instead of approximately right.

Three identities the tests pin, and one floor:

```
netPnlUsd  = grossPnlUsd − closedCostsUsd     (to 6 decimals)
costsUsd  >= closedCostsUsd                   (the open position's costs are real)
equityUsd  = endingCashUsd + openPositionUsd  (to 9 decimals)
costsUsd   > 0                                "costs are never zero — this is the honest simulator"
```

**Who reads it.** `capital-floor.test.ts` runs it once per token per capital and builds §8.3's table straight off the summary — `closedCostsUsd / |grossPnlUsd|` is the cost share that §9's U is measured on, `netPnlUsd > 0` is what "viable at this capital" means, and `reason` is what prints when a capital is refused. `portfolio-run.ts` (§8.6) declares `PositionResult extends PaperRunResult` and runs one `paperRun` per allocated slot, summing `closedCostsUsd` into its own `costsUsd` and counting the capital of a slot that never traded as still the wallet's.

**What it is not.** `replay` is the strategy and the broker, nothing else: no death watch, no persistence, no recovery, no scanner, and a broker that starts flat every time (`07-paper-mode.md`). It is the **offline** path — the live engine calls `deployableCapital` and `scaledParams` directly, per tick, and never calls `paperRun`. That asymmetry is exactly what `14-pruebas.md` §11.1 records as the shape of the recurring bug: the fix lands here first, and *"anything the experiment does and the engine does not is not a fix; it is a rehearsal of one"* (§8.5).

### 6.6 Where the live engine calls all of this

`engine.ts:114`, once per tick, **before** the catch-up walk:

```ts
const sizing = sizeLadder(config.params, input.position.quality,
                          config.sizing ?? DEFAULT_SIZING_POLICY,
                          deployableCapital({ initialCapital: input.position.capitalUsd, … }))
const params = sizing.tradeable ? scaledParams(config.params, sizing) : config.params
```

Sized **once, not per bar**: *"Neither the wallet's capital nor the pool's quality moves within a catch-up, so this is constant across the walk."*

And `sizing.tradeable` is carried into every replayed bar, where it gates entries only:

```ts
const orders = walk.tradeable ? afterDeath : afterDeath.filter((o) => o.kind !== 'entry')
```

> A pool too thin to size against must not trap the money already in it: entries stop, exits never do.

---

## 7. What the broker charges — the other half of the contract

The fill model is this section. `PaperBroker` is constructed per position by the composition root (`12-runtime-despliegue.md`) and seeded from recorded fills on every restart (`08-motor.md`, `09-persistencia.md`); what belongs here is that it **independently re-derives the same depth** rather than trusting the sizing result:

```ts
private impactPctFor(usd: number): number {
  const depth = effectiveDepth(this.config.quality()).usd
  return depth > 0 ? (usd / (depth / 2)) * 100 : Infinity
}
```

- A buy fills at `open × (1 + (spreadPct + impact)/100)` and pays one gas charge.
- `closeAll` computes `notional = totalQty × open`, **one** `costPct` against the summed notional, sells at `open × (1 − costPct/100)`, and splits **one** gas charge by qty share.

That exit behaviour is precisely what `maxExitCostPct` is a budget for. `quality` is passed as a **thunk** (`() => MarketQuality`) rather than a value, because market quality is refreshed while a position is open and the broker must read it at fill time.

Cost attribution is split by cause, which is what made the U-shaped finding visible at all:

```ts
const spreadUsd = (notional * spreadPct) / 100
impactUsd: this.costs.impactUsd + Math.max(0, totalSlipUsd - spreadUsd)
```

---

## 8. The capital floor experiment

`src/application/capital-floor.test.ts`. Its header states the purpose without overclaiming:

> It does not promise returns; it says below what capital the strategy cannot work at all, because the chain takes more than the edge produces.

### 8.1 Method

| | |
|---|---|
| Dataset | `tools/golden/solana-dataset.json`, written by `collect-dataset.smoke.test.ts`; the suite **skips** when it is absent, so nothing depends on the network |
| Capitals | `[1, 50, 200, 1_000, 5_000, 20_000]` |
| Gas | `$0.05` per swap |
| Params | `DEFAULT_PARAMS` (the $5,000-capped reference ladder), `maxOpenEntries: 10` — **not** the production $15 / 6-rung ladder |
| Token filter | `candles.time.length >= 250` |
| Costs | spread + own impact + gas, charged by `PaperBroker` on every swap |

The dataset currently on disk was collected **2026-09-14**, scanned 56 tokens and kept 5. Of those, three clear the 250-bar filter:

| Token | Bars | Reported liquidity | Measured slippage @ $100 | Effective depth | In the run? |
|---|---|---|---|---|---|
| DREGG | 1000 | $201,864 | 0.176% | $113,691 | yes |
| TROLL | 1000 | $3,130,235 | 0.496% | $40,295 | yes |
| Leafy | 370 | $111,261 | 1.288% | $15,527 | yes |
| EMBER | 105 | $521,740 | 0.497% | $40,221 | **no — history** |
| HEV | 38 | $207,947 | 5.509% | $3,631 | **no — history** |

TROLL is the clearest live case for measured depth: **$3.1M reported, $40k real** — a 78× overstatement.

### 8.2 The first run, as recorded in `CLAUDE.md`

Net P&L per token, ~41 days of 1H candles:

| Token | $1 | $50 | $200 | $1,000 | $5,000 | $20,000 |
|---|---|---|---|---|---|---|
| DREGG | — | — | — | +$1,044 | +$5,534 | +$5,534 |
| TROLL | — | — | +$53 | +$34 | +$34 | +$34 |
| Leafy | — | — | +$159 | +$159 | +$159 | +$159 |

A dash is **no trades at all**, not a loss.

### 8.3 The same experiment re-run today

Reproduced while writing this chapter (`npx vitest run src/application/capital-floor.test.ts`), same dataset, same grid:

| Token | Capital | Verdict | Cycles | Wins/trades | Gross | Costs | Costs/gross | Net | Return |
|---|---|---|---|---|---|---|---|---|---|
| DREGG | $1 | **POOL REFUSED** — `capital allows a position of only $0, below the $5 floor` | | | | | | | |
| DREGG | $50 | | 8 | 8/8 | $93.18 | $4.14 | 4% | **+$89.04** | +177.6% |
| DREGG | $200 | | 8 | 8/8 | $375.84 | $24.12 | 6% | **+$351.73** | +175.2% |
| DREGG | $1,000 | | 8 | 9/9 | $1,157.91 | $114.04 | 10% | **+$1,043.87** | +104.0% |
| DREGG | $5,000 | | 14 | 25/29 | $7,629.05 | $2,095.11 | 27% | **+$5,533.94** | +110.6% |
| DREGG | $20,000 | | 14 | 25/29 | $7,629.05 | $2,095.11 | 27% | **+$5,533.94** | +27.7% |
| TROLL | $1 | **POOL REFUSED** | | | | | | | |
| TROLL | $50 | | 6 | 6/6 | $20.42 | $3.77 | 18% | **+$16.65** | −1.4% |
| TROLL | $200 | | 6 | 6/6 | $71.63 | $18.81 | 26% | **+$52.83** | +0.1% |
| TROLL | $1,000 | | 7 | 11/15 | $122.14 | $87.82 | 72% | **+$34.31** | −8.1% |
| TROLL | $5,000 | | 7 | 11/15 | $122.14 | $87.82 | 72% | **+$34.31** | −1.6% |
| TROLL | $20,000 | | 7 | 11/15 | $122.14 | $87.82 | 72% | **+$34.31** | −0.4% |
| Leafy | $1 | **POOL REFUSED** | | | | | | | |
| Leafy | $50 | | 10 | 10/10 | $129.81 | $12.04 | 9% | **+$117.78** | +235.6% |
| Leafy | $200 | | 12 | 13/14 | $181.63 | $22.37 | 12% | **+$159.26** | +79.6% |
| Leafy | $1,000 | | 12 | 13/14 | $181.63 | $22.37 | 12% | **+$159.26** | +15.9% |
| Leafy | $5,000 | | 12 | 13/14 | $181.63 | $22.37 | 12% | **+$159.26** | +3.2% |
| Leafy | $20,000 | | 12 | 13/14 | $181.63 | $22.37 | 12% | **+$159.26** | +0.8% |

**The $200-and-up columns are identical to the first run.** What changed is the left edge: the $50 row now trades, and trades profitably on all three tokens, while $1 is refused by name rather than silently producing nothing. That is exactly the effect §6.1 claims — reserving gas and 5% of headroom moved the floor from ~$200 to under $50 — measured rather than asserted.

Note also the difference in **why** each row is a dash. At $1 the refusal is `capital`, not the pool: `deployableCapital($1, …) = (1 − 11 × 0.05) × 0.95 = $0.43`, below the $5 gas floor. The message names the binder.

Two caveats that belong with any reading of these numbers, stated in `CLAUDE.md` and worth repeating:

> **These numbers are not a forecast.** The tokens are today's trending list, over a window in which they trended — survivorship pointing the same way as the result. The floor and the scaling shape are the findings; the returns are not.

And the run uses the **reference** ladder with ten open entries, not production's flat $15 / six rungs. It answers "where is the floor", not "what will the engine make".

### 8.4 The four findings

**Finding 1 — below ~$200 the system did not trade at all.** Not "lost money": placed **zero orders**. The pool-sized ladder had its own minimum, and under it the broker rejected every entry for want of funds. The $1 experiment was not unprofitable; it was mechanically impossible. *Status: fixed.* Sizing now reserves gas and headroom, and the floor is derived per-slot by `slotFloorUsd` ($31.93 at Solana gas). $1 is still impossible, and now says so.

**Finding 2 — above the pool's capacity, more capital does nothing.** Leafy returns the same $159 at $200 and at $20,000, because the ladder is capped by depth, not by the wallet. Return per dollar therefore **falls** as capital grows: 80% at $200, 0.8% at $20,000. *Status: fixed* — `domain/risk/portfolio.ts` splits capital across slots instead of into one position, and `targetPositionUsd = ladderCapitalUsd` stops a slot from being handed more than its ladder can spend. **Scale comes from more tokens, not more size per token.** This is the scanner's real justification.

The sizing layer shows the same wall directly. Re-running `sizeLadder(DEFAULT_PARAMS, quality, DEFAULT_SIZING_POLICY, deployableCapital(…))` over the recorded dataset:

| Token | Effective depth | $50 | $200 | $1,000 | $5,000 | $20,000 |
|---|---|---|---|---|---|---|
| DREGG | $113,691 | $46.98 (1 rung) | $189.48 (1) | $949.48 (3) | **$1,534.83 (4)** | **$1,534.83 (4)** |
| TROLL | $40,295 | $46.98 (1) | $189.48 (2) | **$543.98 (4)** | **$543.98 (4)** | **$543.98 (4)** |
| EMBER | $40,221 | $46.98 (1) | $189.48 (2) | **$542.99 (4)** | **$542.99 (4)** | **$542.99 (4)** |
| Leafy | $15,527 | $46.98 (1) | $189.48 (4) | **$209.62 (4)** | **$209.62 (4)** | **$209.62 (4)** |
| HEV | $3,631 | $46.98 (4) | **$49.01 (4)** | **$49.01 (4)** | **$49.01 (4)** | **$49.01 (4)** |

Bold is where the **pool**, not the wallet, has become the binding constraint — every one of those rows has `exitCostPct` sitting at exactly 3.00%, the exit budget, and adding capital changes nothing. Note also that at $50 the reference ladder collapses to a **single rung** on four of the five tokens: the cascade cannot cascade when the capital cap binds at level 0. That is the production ladder's argument in one line — a flat $15 ladder gets six rungs out of the same wallet.

**Finding 3 — the chain's cut varies enormously per token**: 4% of gross on DREGG, 72% on TROLL at the same capital. Cost share is a property of the token's pool, not of the strategy. *Status: fixed* — `costEfficiency` is a weighted component of the opportunity score (weight 0.2, scoring zero at a 6% round trip); see §10 and `04-escaner.md`.

**Finding 4 — most small caps lack the history the strategy needs.** Two of five candidates had 38 and 105 bars; EMA-200 cannot exist there. *Status: fixed* — a `history` gate rejects under 250 1H bars, fed by the candle adapter, and an unmeasured count stays silent: the gate fires on evidence, not on absence. See `04-escaner.md`.

### 8.5 Two sizing bugs the experiment exposed

- **The ladder was sized against the pool but not against the wallet** (commit `a9c3480`). A $200 position was handed $1,000 levels and the broker rejected each one for funds — which looks exactly like a strategy that produces no signals. `sizeLadder` gained `availableCapitalUsd` as a second ceiling.
- **Orders were sized to the last cent.** Fixed by `PRICE_HEADROOM_PCT` and the full-cycle gas reserve (§6.1).

And the bug that sits on top of both, which this chapter's rules exist to prevent: **the sizing layer existed, was tested, and was documented as the fix while `tickPosition` did not call it.** Only the offline `paper-run.ts` did. Production ran a $285 position emitting $1,000 nominal entries, rejected for funds in silence, for hours. From `CLAUDE.md`:

> Anything the experiment does and the engine does not is not a fix; it is a rehearsal of one.

When changing anything in this chapter, check **both** paths: `paper-run.ts` (offline) and `engine.ts` (live).

### 8.6 `portfolio-run.ts` — finding 2, measured on the other axis

`paperRun` answers *what does this token do with this capital*. Finding 2 is a claim about the other axis — what the same wallet does when it is **split across tokens** — and `src/application/portfolio-run.ts` is the harness that measures it. It is the offline analogue of one allocation pass of `runCycle` (`08-motor.md` §8.10): `planPortfolio` decides who gets capital, then every allocation runs its own `paperRun` over its own candles.

```ts
export type CandleLookup = (candidate: AllocationCandidate) => Candles | null

export function portfolioRun(
  candidates: readonly AllocationCandidate[],
  candlesFor: CandleLookup,
  config: PortfolioRunConfig,
): PortfolioRunResult
```

- **History is injected.** `CandleLookup` is the only way candles enter, so the harness has no network, no clock and no dataset of its own — the same rule the domain lives under, applied one layer up.
- `PortfolioRunConfig` carries `params`, `portfolio` (a `PortfolioPolicy`), an optional `sizing`, `gasUsdPerSwap` and `maxOpenEntriesPerPosition`. Nothing about *who gets what*: that is `planPortfolio`'s job (`05-riesgo.md`), and this file does not second-guess it.
- `PositionResult extends PaperRunResult` with the two things the plan knew and the run does not: `capitalUsd` and `score`.
- `PortfolioRunResult` returns all three layers — `plan`, the per-position `positions`, and the aggregate `summary` — so a reading that looks wrong can be traced back to the allocation that caused it.

**Isolation is structural here, not a discipline.** From the file's header:

> Positions are INDEPENDENT by construction — one token dying cannot touch another's state, cash or ladder. That isolation is not an optimisation; it is the reason a portfolio of small caps is survivable at all.

Each allocation gets its own `PaperBroker` inside its own `paperRun`, seeded with its own `capitalUsd`, and the loop shares nothing between iterations. This is the code behind `01-vision-general.md` §7 constraint 8, and the test that pins it is an inequality per position:

```ts
expect(position.summary.endingCashUsd).toBeLessThanOrEqual(position.capitalUsd + 1e-9)
```

**`PortfolioSummary` accounts for the wallet, not for the trades.** Fifteen fields, and the distinction matters in three of them:

| Field | What it is |
|---|---|
| `positions` | positions that actually **traded** — allocations whose `paperRun` returned a summary |
| `capitalUsd` | `policy.totalCapitalUsd`: the whole wallet |
| `deployedUsd` / `idleUsd` / `reserveUsd` | straight from the plan; `deployed + idle = capital − reserve` |
| `grossPnlUsd` | realised, mid-to-mid, before the chain's cut |
| `costsUsd` | the sum of each position's **`closedCostsUsd`** — costs belonging to closed trades only, so `gross − costs = net` is exact |
| `netPnlUsd` | realised P&L after those costs |
| `openPositionUsd` | open inventory marked at the last close |
| `equityUsd` | traded equity + capital of allocations that ran and were refused + `idleUsd` + `reserveUsd` |
| `returnPct` | *"Return on the WHOLE wallet, reserve and idle capital included."* |
| `winners` / `losers` | positions with net P&L above and below zero — **positions, not trades**, and an exactly-flat one is neither, which is why the test asserts `winners + losers <= positions` |
| `bestUsd` / `worstUsd` | *"Net P&L of the best and worst position — how much breadth actually mattered."* A `bestUsd` that is most of `netPnlUsd` says the portfolio was one token wearing four slots |

Two naming traps live in that table. `PortfolioSummary.costsUsd` is **not** `PaperSummary.costsUsd`: the per-position field includes costs already paid on trades still open, the portfolio one deliberately excludes them so the accounting identity holds. And `returnPct` is measured against the whole wallet, so a portfolio that leaves half its money in the drawer does not get to report the traded half's return.

**What the tests measure** (`src/application/portfolio-run.test.ts`) is finding 2 restated as an assertion instead of a table. Six identical candidates, `maxPositions: 10`, the same candles, and only the wallet changes:

```ts
expect(wide.summary.positions).toBeGreaterThan(narrow.summary.positions)   // $3,000 vs $500
expect(wide.summary.netPnlUsd).toBeGreaterThan(narrow.summary.netPnlUsd)
```

More capital buys more **positions**, and P&L grows with them. The complement is the same claim from the other side: one candidate, $50,000 and a 30% concentration cap leaves `idleUsd > deployedUsd` — capital with nowhere to go idles, it does not become a bigger position. Between them they are the mechanism behind *scale comes from more tokens, not more size per token*; §8.4's sizing table shows the wall each individual pool puts up, and this shows what the wallet does when it stops hitting it.

Three isolation tests carry the rest:

- a candidate whose `candlesFor` returns `null` is skipped and the others run untouched;
- a pool-refused candidate never reaches an allocation at all — an HEV-shaped token ($186k reported, 50% slippage at the reference size) appears in `plan.skipped` with `reason: 'pool-refused'` and the detail `a 1% fill allows only $2, below the $5 floor`, so it costs **its slot, not the portfolio**;
- with nothing funded, `equityUsd` equals the wallet and `returnPct` is exactly `0` — a run that could not trade reports no loss.

**One trap, measured.** Those last two cases are not symmetric. A position that ran and was refused keeps its capital in the wallet (`untradedCapital`), but an allocation whose candles are **missing** is `continue`d out of the loop before it becomes a `PositionResult` at all — so its money sits in `plan.allocatedUsd` and in nothing else, `equityUsd` included. Reproduced on the test's own four $475 slots at $2,000 capital, dropping one token's candles:

| | all four candles | one token's candles missing |
|---|---|---|
| `positions` | 4 | 3 |
| `deployedUsd` | $1,900 | $1,900 |
| `equityUsd` | $1,969.55 | **$1,502.17** |
| `returnPct` | −1.52% | **−24.89%** |

Nothing lost that money; it left the accounting. Read `returnPct` only when `summary.positions` plus the refused positions equals `plan.allocations.length`, and treat a gap there as a missing-history report, not a result.

Finally, `portfolioRun` is **offline only** — nothing in `orchestrator.ts` or `engine.ts` calls it, and it is referenced nowhere but its own test. That is deliberate rather than the §8.5 gap repeating itself: the live path does the same two steps with the same functions (`planPortfolio`, then one `tickPosition` per position, `08-motor.md` §8.10), and this file exists to measure across a whole recorded market in one pass. It is a harness, not a second engine — which is also why a change to allocation or sizing has to be checked in **both**, exactly as §8.5 says.

---

## 9. Cost is a U, not a slope

Two costs pull in opposite directions as a position grows:

- **gas is FIXED**, so its share falls with size
- **impact is SUPERLINEAR**, so its share rises with size

Cost as a share of gross, same recorded market, reproduced today — identical to the figures in `CLAUDE.md`:

| Token | $50 | $200 | $1,000 | $5,000 | $20,000 | cheapest at |
|---|---|---|---|---|---|---|
| DREGG | **4%** | 6% | 10% | 27% | 27% | $50 |
| TROLL | **18%** | 26% | 72% | 72% | 72% | $50 |
| Leafy | **9%** | 12% | 12% | 12% | 12% | $50 |

The test asserts the shape rather than any particular number: past the cheapest point, every larger capital must cost at least as much per dollar earned.

```ts
for (const p of after) expect(p.share).toBeGreaterThanOrEqual(best.share - 1e-9)
```

**On these pools the minimum sits at the small end of the tested grid.** The gas-dominated left arm of the U is below it, where the grid stops being tradeable at all — at $1 every token is refused. It is visible instead in `paper-broker.test.ts`, where a $1 position at $0.20 gas loses more than $0.30 over a round trip: *"the capital-floor argument, in a test."*

The conclusion is the same as finding 2 arriving by a different road: **many small positions beat one large one, and not only for diversification — they are cheaper to run.**

Two related measurements worth keeping near this table:

- **A round trip at a flat price must lose money.** Spread on the way in and again on the way out, impact both ways, gas per swap. `PaperBroker` is built so that it does, because on a real chain it would.
- **The average fill price of a deep ladder is not the average of its trigger prices.** Six rungs at 1, .95, .90, .85, .80, .75 have a nominal mid of 0.875 and come out at **0.8792 (+0.48%)**, because every rung paid the venue on the way in. The exit compares against *that* number, so a +2% profit target on a six-deep ladder needs the price to travel nearly 2.5%.

---

## 10. Where economics feeds the scanner

`domain/scanner/opportunity.ts` reads the same `MarketQuality` as a scoring component:

```ts
const costEfficiency = quality === null
  ? 0.5
  : clamp01(1 - (2 * (quality.spreadPct + quality.slippagePct)) / policy.worstRoundTripPct)
```

- The `2 ×` is the round trip: pay to get in, pay to get out.
- `worstRoundTripPct = 6` — past a 6% round trip the toll plausibly exceeds what a DCA cycle can produce, and the component scores zero.
- Weight **0.2** of the six-component score (`DEFAULT_OPPORTUNITY_POLICY.weights`).
- Unmeasured scores **0.5, not 1** — *"so a token is never rewarded for a toll nobody checked."*

The weight's justification is finding 3, quoted in the type itself: *"The first capital-floor run measured 10% of gross on one token and 72% on another, same strategy and same budget — so the venue's toll is a property OF THE TOKEN, and a ranking that ignores it ranks a trap alongside a bargain."*

Quality is therefore measured **before** scoring. Full treatment of the score in `04-escaner.md`.

The effect on the live ranking, recorded in `CLAUDE.md`:

| Token | bars | round trip | cost eff. | score before | after | verdict |
|---|---|---|---|---|---|---|
| DREGG | 1000 | 0.95% | 0.84 | 61.9 | **68.7** | PASS |
| TROLL | 1000 | 1.59% | 0.73 | 43.2 | **47.9** | PASS |
| HEV | 38 | **11.62%** | 0.00 | 54.0 | 44.0 | **history** |
| EMBER | 105 | 1.59% | 0.73 | 34.2 | 38.8 | **history** |
| Leafy | 370 | 3.18% | 0.47 | 34.1 | 33.5 | PASS |

---

## 11. Known gaps, traps and things that are narrower than they look

Everything in this section is a statement about the code as it stands, not a proposal.

### 11.1 `depthSource: 'measured'` is not always literally true

`scan.ts` sets `slippagePct` from the sell probe when it has one, **and from `estimatePriceImpactPct(referenceUsd, liquidityUsd)` when it does not**. That derived value inverts algebraically straight back to `liquidityUsd`:

```
slippage = 200 × ref / liq   ⇒   depth = 200 × ref / slippage = liq
```

So `effectiveDepth` returns the reported number while labelling it `'measured'`. The *number* is right; the *provenance label* is wrong. The honest field is `TokenSnapshot.measuredImpactPct`, which is nullable. **Anything that trusts `depthSource` to mean "a real sell was quoted" will be misled.**

Related: when `liquidityUsd` is 0, `scan.ts` substitutes `slippagePct: 100` rather than calling `estimatePriceImpactPct` (which throws). That inverts to an effective depth of exactly **$200** — a plausible-looking small number for a pool with no liquidity at all.

### 11.2 Two cost models coexist, and only one ships

| | Uses | Callers |
|---|---|---|
| `expectedFillCostPct(usd, quality)` | **reported** `liquidityUsd` | tests only |
| `sizeLadder`'s private `impactPct`, `PaperBroker.impactPctFor` | **effective depth** | everything on the live path |

`expectedFillCostPct` and `assertMarketQuality` have no production callers. Calling `expectedFillCostPct` from new code would silently reintroduce the HEV-shaped error — $186k reported against $3.8k real.

`estimatePriceImpactPct` *does* have production callers, but only for display and for the provisional pre-measurement score: `universe-view.ts:130`, `recall.ts:82`, `scan.ts` (three sites). None of them size an order.

### 11.3 `observedAt` is carried, never checked

The field is documented "Stale quality is no quality", and `CLAUDE.md` lists staleness as one of the contract's two rules. **No code in `market-quality.ts`, `sizing.ts`, `engine.ts`, `portfolio.ts` or `paper-broker.ts` ever compares it to a clock.** It is constructed, persisted and read back; the rule is not enforced anywhere. (`dashboard.ts` has a staleness warning, but it measures the *position's* `updatedAt`, not the quality's `observedAt`.)

### 11.4 The gas floor is derived in the type and frozen in the runtime

`main.ts` composes:

```ts
sizing: { ...DEFAULT_SIZING_POLICY, maxOpenEntries: config.maxDcaPerToken + 1 }
```

and never recomputes `minFillUsd` from `config.gasUsdPerSwap`. Set `OPERADOR_GAS_USD=0.20` and the engine keeps a **$5** floor where the derived answer is **$20** — it will place fills whose gas is 4% of the order, which is the exact failure `gasFloorUsd` was written to prevent. The comment in `sizing.ts` says *"Recompute this whenever gas changes"*; nothing does.

Note that `gasUsdPerSwap` *is* wired correctly everywhere else: `deployableCapital`, `ladderCapitalUsd`, `slotFloorUsd` and the broker all take it from config. Only `minFillUsd` is stranded.

### 11.5 `spreadPct` is a configured constant, not a measurement

`0.3` in `main.ts`, `0.25` in test fixtures. Only slippage is measured. So the term subtracted **first** from both budgets is the one nobody verifies per venue, and a venue whose real fee is higher silently eats into the impact budget.

### 11.6 Smaller traps

- **`limitedBy` distinguishes `'capital'` from `'exitCost'` by float equality** (`positionCap === availableCapitalUsd`). It is only a label — nothing branches on it — but it will misreport when the two ceilings happen to coincide.
- **Level 0 failing the floor refuses the entire token; any later level merely truncates the ladder.** Two very different outcomes from the same comparison, three lines apart.
- **`sizeLadder` returns `tradeable: false` with a human-readable `reason` rather than throwing.** A caller that ignores `tradeable` sees an empty `levels` array and `totalUsd: 0` — a ladder that looks merely small rather than refused.
- **A `maxOpenEntries` of 0 produces `tradeable: false` with `reason: null`** — the loop never runs, so no refusal message is ever produced. Unreachable from the runtime config (`config.ts`'s `number()` rejects values ≤ 0, so `maxDcaPerToken + 1 ≥ 2`), but reachable from a hand-built `SizingPolicy`.
- **`scaledParams` returns `params` unchanged when `sizing.levels[0]` is missing** — a silent no-op, not an error. A caller that skips the `sizing.tradeable` check can therefore run the full nominal ladder against a pool that cannot carry it.
- **`ladderCapitalUsd`'s rung count is `min(params.maxLevels + 1, maxOpenEntries)`.** Passing the reference `PYRAMIDING` of 10 when production only fills 6 asks for a wallet that reserves four rungs that will never fire — the $950 bug in miniature. `orchestrator.ts` passes `config.maxOpenEntries ?? PYRAMIDING`.
- **Refusal messages round with `toFixed(0)`**, so a `$1.50` per-fill cap prints as `$2`. Cosmetic, but do not read the printed number as the exact value.

---

## 12. Cross-references

| Chapter | For |
|---|---|
| `01-vision-general.md` | how the scanner and executor fit together; the $0/month topology |
| `03-estrategia-cascade-dca.md` | `usdForLevel`, the trigger arithmetic, the five rebound locks, the 50-signalled/10-fillable split |
| `04-escaner.md` | where `MarketQuality` is measured, the gates, the opportunity score and its `costEfficiency` component |
| `05-riesgo.md` | `liquidityUsd` at entry as the liquidity-collapse baseline; why price may never be a death signal; the portfolio allocator that spends `sizeLadder` |
| `08-motor.md` | `tickPosition`, the catch-up walk, portfolio allocation, the common fund and slot trimming; `PaperBroker.seed` inside the tick |
| `09-persistencia.md` | `quality` as JSONB on the position row; idempotent fills; what a restart rebuilds the broker from |
| `12-runtime-despliegue.md` | where the per-position `PaperBroker` is constructed, position isolation, and `OPERADOR_GAS_USD` |
| `14-pruebas.md` | why `DEFAULT_PARAMS` and `PYRAMIDING` are evidence that must not be edited; the parity harness; `paper-broker.test.ts` |
