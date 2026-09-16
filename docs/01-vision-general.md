# Overview and architecture

This chapter is the map of the whole system: what Operador by Open Doors is for, the two subsystems it is made of and why they are kept apart, the `MarketQuality` contract that is the only thing passing between them, the hexagonal layering and the rules that keep the domain pure, what is in and out of scope, the core constraints every other chapter inherits, and a directory map of the entire repository. It also carries the two diagrams the rest of the documentation refers back to: the layer diagram, and one full cycle from recovery to heartbeat. Everything here is checked against source at `E:/Operador`; where documentation and code disagree, the disagreement is named rather than smoothed over.

---

## 1. Mission

A self-hosted trading system that **watches thousands of small-cap crypto tokens at once**, detects when one starts moving, and deploys the **CASCADE DCA** strategy into it — spot only, on low-fee chains, from a dedicated wallet.

Not TradingView. Not forex. Not futures. Not leverage. Spot, on-chain, harvesting volatility on assets that are volatile by nature.

The reference strategy is [`DCA.pine`](../DCA.pine) — CASCADE DCA v1.5, Pine Script v6, spot long, bar-close driven, MPL-2.0. It is the **specification**, not an inspiration: the port's acceptance test is reproducing TradingView's own trade list (see `03-estrategia-cascade-dca.md` and `14-pruebas.md`).

### Naming

"Operador" is the repo, the npm package (`package.json` → `"name": "operador"`) and the engine. "Open Doors" is the brand it ships under. The full name appears in user-facing surfaces — the heartbeat alert title is literally `'💓 Operador by Open Doors'` (`src/application/orchestrator.ts`) — and the short name in code.

### What is real today

Paper mode, and only paper mode. `loadConfig` throws before a connection is opened:

```ts
if (config.mode === 'live') {
  throw new ConfigError(
    'live mode is not available: no wallet adapter has been built or audited. ' +
      'Run OPERADOR_MODE=paper until one exists and has been reviewed.',
  )
}
```

`src/runtime/config.ts`. Live is not a flag anyone can drift into, because nothing in the repository can sign a transaction. Everything that **decides** is real — discovery, gates, the honeypot sell quote, candles, the strategy, the death watch's sell probes. Only the **fill** is simulated, and pessimistically: it pays the venue spread, the impact its own size causes against measured depth, and gas per swap, so a round trip at a flat price loses money. See `06-economia.md`.

---

## 2. The system is two subsystems

Keep these separate. They fail for different reasons and are tested differently.

```
        ┌──────────────────────────────────────────────┐
        │                  SCANNER                     │
        │  "which token is worth touching at all"      │
        │                                              │
        │  universe → safety gates → opportunity score │
        │           → ranking → watch slots            │
        └───────────────────┬──────────────────────────┘
                            │  Candidate
                            │  { snapshot, opportunity, marketQuality }
                            ▼
        ┌──────────────────────────────────────────────┐
        │                  EXECUTOR                    │
        │  "CASCADE DCA on a chosen token"             │
        │                                              │
        │  one independent state machine per position  │
        │  + one death watch per position              │
        └──────────────────────────────────────────────┘
```

**The scanner produces a WATCHLIST, not entry signals.** It decides which tokens are worth running the strategy on; CASCADE DCA's own gates — drop from the swing high, lateral zone — decide *when* to enter.

### 2.1 Scanner — "which token is worth touching at all"

Watches the universe continuously, ranks and gates candidates. This is where most of the risk lives, and most of the work.

**Safety gates are hard blockers, evaluated before anything else, and they fail closed.** An unknown honeypot result, authority, blacklist, tax, LP lock or holder concentration is a *failure*, not a pass. The doc comment in `src/domain/scanner/gates.ts` states the reason: "The cost of a false negative here is a wallet full of something unsellable."

`DEFAULT_GATE_POLICY` (`src/domain/scanner/gates.ts`), verbatim:

| Field | Value | What it blocks |
|---|---|---|
| `minLiquidityUsd` | 20 000 | pools too thin to trade |
| `minAgeHours` | 24 | pairs born minutes ago |
| `minVolume24hUsd` | 10 000 | dead tokens |
| `maxFallPct` | 50 | freefall — half gone in 1h or 6h (24h is deliberately ignored) |
| `maxTransferTaxPct` | 5 | tax traps |
| `minLpLockedPct` | 80 | unlocked / unburned LP |
| `maxTopHoldersPct` | 40 | holder concentration |
| `maxCreatorPct` | 10 | creator still holding the supply |
| `maxFdvUsd` | 50 000 000 | not a small cap any more |
| `denylist` | `SOLANA_DENYLIST` | USDC, USDT, wSOL, mSOL, jitoSOL, stSOL, USD1 — money, not trades |
| `canonicalSymbols` | `SOLANA_CANONICAL_SYMBOLS` | impersonation |
| `minHistoryBars` | 250 | EMA-200 and the 50-bar Bollinger basis cannot exist below this |
| `maxReferenceImpactPct` | 10 | a pool no sizing can shrink out of |

Two of these exist because a real token got through. `BTC` and `ETH` were added to `SOLANA_CANONICAL_SYMBOLS` after "a fifteen-day-old memecoin was scanned, ranked and ALLOCATED under the name 'BTC' with a $267k pool and not one blocker against it" — the map knew `WBTC` and not `BTC`. And `maxReferenceImpactPct: 10` carries its evidence in the source: "CREPE measured 98% on a $285 sell while reporting $718k of liquidity."

Note the asymmetry between the two "unknown" cases, which is stated in the policy's own comments:

- **Safety facts fail closed.** Unknown danger *is* evidence.
- **Cost and history fail open.** `maxReferenceImpactPct` "Fires only on a MEASURED value"; the history gate fires "only on a count that was actually measured and came up short." Unknown cost is not evidence of a bad pool.

The `evaluateMarketGates` / `evaluateGates` split matters for budget, not for strictness: the free gates (liquidity, age, volume, FDV, denylist, impersonation, freefall) need no network call, so they decide first and only the survivors cost a throttled security request and a sell quote. A token that clears the free gates still faces the full set.

**Opportunity score** — the token "breathing", 0..100, six explainable components. `DEFAULT_OPPORTUNITY_POLICY` (`src/domain/scanner/opportunity.ts`):

```ts
weights: { volumeExpansion: 0.3, buyPressure: 0.15, liquidityGrowth: 0.1,
           activity: 0.1, volatility: 0.15, costEfficiency: 0.2 },
fullExpansionRatio: 3, fullActivityTxnsPerHour: 60,
fullVolatilityPct: 20, worstRoundTripPct: 6,
```

`costEfficiency` at weight 0.2 exists because of finding 3 of the capital floor: the chain's cut varies enormously per token (10% of gross on DREGG, 72% on TROLL), so what the chain will take is part of how good an opportunity is. It scores zero at a 6% round trip. This is a v1 heuristic with policy weights, to be tuned against recorded outcomes — not a claim of alpha. See `04-escaner.md`.

**Ranking** — `rankUniverse(universe, previous, quality, policy)` in `src/domain/scanner/ranking.ts` is the whole pipeline in fifteen lines: gates → quality → score → `minScore` cut → sort by score (address as the tie-break, so the order is deterministic) → `slice(0, watchSlots)`. One comment there is load-bearing for the contract in §3:

> Quality is measured before scoring, because what the chain will take is part of how good the opportunity is — not a detail settled afterwards.

**The sell probe — one port, two chains.** "Can this position actually be sold?" is answered two ways: quote a real sell (a fact), or read a vendor's `is_honeypot` flag (an opinion). Solana had the fact from the start via Jupiter; BSC had the opinion until `PancakeSwap.assessSell` closed the gap by calling the V2 router's `getAmountsOut` through `eth_call`. Both implement the same `SellProbePort` (declared in `src/application/scan.ts`), so the domain never learns which chain it is on:

```ts
export interface SellProbePort {
  assessSell(token: string, amountRaw: bigint, decimals: number, expectedUsd: number): Promise<SellAssessment>
}
```

An RPC failure is never read as "no route" — one is inconclusive, the other is a death signal, and confusing them would either liquidate a healthy position or hold a dead one. See `10-adaptadores.md`.

**Status: the scanner domain is complete** (`src/domain/scanner/`, chain-agnostic, pure): `snapshot.ts`, `gates.ts`, `opportunity.ts`, `ranking.ts`, plus `lp-model.ts` and `security-merge.ts`.

### 2.2 Executor — CASCADE DCA on a chosen token

Runs the reference strategy, one independent state machine per open position, plus one death watch per position.

- `src/domain/strategy/cascade.ts` — `stepCascade(state, params, bar, ctx, position)`, a transcription of `DCA.pine`'s per-bar logic **in the same evaluation order**. Its header states why order is not a style choice: "In a state machine the order is the semantics… Reordering any of these changes which bar a fill lands on, and parity dies quietly."
- `src/domain/risk/death-exit.ts` — two-stage asset invalidation, with the price guardrail enforced by the type system (§6, constraint 9).
- `src/domain/economics/sizing.ts` — what the pool and the wallet will actually allow.

The step function takes two inputs the Pine reference conflates: `BarContext` (indicator-derived facts) and `PositionSnapshot` (what the **broker** reports — size, average fill price, open P&L). Exit and rescue logic read the broker's numbers, not the machine's, exactly as the reference does. Details in `03-estrategia-cascade-dca.md`, `05-riesgo.md`, `06-economia.md`.

### 2.3 Why the separation is not cosmetic

The build order was decided from it, and the reasoning is worth repeating because it is the project's main methodological commitment:

> The executor has a **known correct answer** — port CASCADE DCA, replay the same OHLCV TradingView used, compare trade for trade. Parity is an objective, binary acceptance test.
> The scanner has **no ground truth**. Building it first means building blind, with no way to tell a working scanner from a broken one.
>
> Build what can be verified. Then build what must be discovered.

---

## 3. The contract between them: `MarketQuality`

When the scanner selects a token it hands the executor **liquidity, spread and slippage** — and keeps refreshing them while the position is open. `src/domain/market/market-quality.ts`:

```ts
export interface MarketQuality {
  readonly liquidityUsd: number   // total pool depth, both sides
  readonly spreadPct: number      // round-trip cost at negligible size
  readonly slippagePct: number    // measured impact for referenceUsd
  readonly referenceUsd: number
  readonly observedAt: number     // "Stale quality is no quality."
}
```

| Field | Meaning | Used for |
|---|---|---|
| `liquidityUsd` | total pool depth, both sides | sizing each ladder level; the **entry baseline** the death exit's "liquidity collapse" signal compares against (`startDeathWatch(quality.liquidityUsd, at)`) |
| `spreadPct` | round-trip cost at negligible size (AMM fee + any gap) | paper fills; the floor every trade pays |
| `slippagePct` @ `referenceUsd` | measured price impact for a reference quote | extrapolating impact to actual level sizes |
| `observedAt` | when it was measured | staleness |

Two functions travel with it, and they are the whole planning model:

```ts
estimatePriceImpactPct(usd, liquidityUsd) = (usd / (liquidityUsd / 2)) * 100
expectedFillCostPct(usd, quality)        = quality.spreadPct + estimatePriceImpactPct(usd, quality.liquidityUsd)
```

A first-order constant-product model, described in its own comment as "exact enough for the 'is this level too big for this pool' question, and deliberately simpler than reproducing every AMM curve. Real fills come from real quotes; this is the planning estimate."

Two rules follow from the contract, and both are enforced in code rather than by convention:

1. **The executor validates, it does not trust.** A selected token whose fillable levels would cost more than the configured impact ceiling is refused or sized down, regardless of the scanner's verdict. Defense in depth. `sizeLadder` returns `tradeable: false` with a `reason`, and the tick then strips entries — but never exits (§5.3).
2. **Nominal USD is not fill size.** `usd(n)` from the ladder is what the strategy *wants*; the executor caps it so `spread + impact` stays bounded, against `DEFAULT_SIZING_POLICY` — `maxFillCostPct: 1.0`, `maxExitCostPct: 3.0`, `minFillUsd: gasFloorUsd(0.05, 1)` = **$5**.

And one refinement the live market forced: **effective depth comes from a measured quote, never reported TVL.** `effectiveDepth(quality)` inverts the impact model — `depth = 200 × usd / impact%` — because "on concentrated venues the pool can hold $186k and still move 5% on a $100 order, because almost none of it sits at the current price." HEV reported $186k of liquidity and had $3.8k of real depth. Full treatment in `06-economia.md`.

The type that crosses the boundary is `Candidate` (`src/domain/scanner/ranking.ts`):

```ts
export interface Candidate {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
  readonly marketQuality: MarketQuality
}
```

`TokenSnapshot` (`src/domain/scanner/snapshot.ts`) is the only shape the scanner domain ever sees; adapters translate API responses into it. `null` means "the source could not tell us", and for security fields that is not neutral.

---

## 4. Hexagonal layering

Ports and adapters. The domain is pure, deterministic and network-free; everything that can fail for an external reason lives outside it.

```
                    ┌─────────────────────────────────────────────┐
                    │                 runtime/                    │
                    │  config · loop · main (composition root)    │
                    │  index (the only file that opens sockets)   │
                    │  retire · demo-server                       │
                    └───────────────────┬─────────────────────────┘
                                        │ wires adapters to ports
        ┌───────────────────────────────▼─────────────────────────────────┐
        │                        infrastructure/                          │
        │  adapters/  dexscreener · geckoterminal · goplus · jupiter      │
        │             pancakeswap · solana                                │
        │  brokers/   paper-broker · tradingview-sim                      │
        │  persistence/  postgres-store · memory-store · schema.sql       │
        │  notifications/ store-alerts · recording                        │
        │  http.ts    GET with timeout + per-provider throttles           │
        └───────────────────────────────┬─────────────────────────────────┘
                                        │ implements the ports below
        ┌───────────────────────────────▼─────────────────────────────────┐
        │                         application/                            │
        │  orchestrator (one cycle) · engine (one tick) · recovery        │
        │  scan · recall · ledger · production-ladder · retire            │
        │  kill-switch · dashboard · operations-view · universe-view      │
        │  phone-status · control-api · replay · paper-run · portfolio-run│
        └───────────────────────────────┬─────────────────────────────────┘
                                        │ calls only pure functions
        ┌───────────────────────────────▼─────────────────────────────────┐
        │                            domain/                              │
        │  indicators/  BB, ADX/DMI, Supertrend, ROC, EMA/SMA, RMA, VWM   │
        │  strategy/    cascade state machine · ladder · signals · params │
        │  scanner/     gates · opportunity · ranking · snapshot          │
        │  risk/        death-exit · portfolio · idle-slots               │
        │  economics/   sizing (fee, gas, depth-based impact)             │
        │  market/      market-quality — the scanner↔executor contract    │
        │  execution/   BrokerPort                                        │
        │  persistence/ StatePort + idempotencyKeyFor                     │
        │  notifications/ Alert, AlertPort, AlertThrottle                 │
        └─────────────────────────────────────────────────────────────────┘

        Dependencies point INWARD only.  Nothing in domain/ imports
        anything from application/, infrastructure/ or runtime/.
```

### 4.1 The rules

| Rule | Status |
|---|---|
| New chain or DEX = new adapter. It never changes the domain. | Holds — `sellProbeFor(chain)` in `src/runtime/main.ts` picks PancakeSwap for `'bsc'` and Jupiter otherwise; `SellProbePort` is unchanged by either. |
| Domain has zero imports from `infrastructure/`. | Holds in production code. One **test** file breaks it: `src/domain/notifications/alerts.test.ts` imports `RecordingAlerts` from `infrastructure/notifications/recording.js` — a test double, not a runtime dependency. Verified by grep; there are no domain → application or domain → runtime imports at all. |
| Clock, randomness and network are injected — never called in domain code. | Holds. `now()` is a `CycleDeps` field; `runtime/main.ts` is described in its own header as "the one file allowed to touch the environment, the filesystem and the clock." |
| Domain state is serializable; any position must be fully reconstructable from persisted state after a crash. | Holds. `CascadeState`, `DeathWatchState`, `MarketQuality` and `Order[]` are plain data; `store.ts`'s header: "Everything here is plain data. No classes, no closures, nothing that only exists while a process does." |
| Indicators must match Pine Script semantics exactly. | Pinned by golden-file tests against TradingView exports at 10 decimal places (`src/domain/indicators/__golden__/harness.ts`). See `02-indicadores.md`. |

### 4.2 The ports

| Port | Declared in | Implemented by |
|---|---|---|
| `StatePort` | `src/domain/persistence/store.ts` | `PostgresStore`, `MemoryStore` |
| `BrokerPort` | `src/domain/execution/broker.ts` | `PaperBroker`, `TradingViewSim` (parity harness) |
| `AlertPort` | `src/domain/notifications/alerts.ts` | `StoredAlertSink`, `RecordingAlerts` (tests) |
| `SellProbePort` | `src/application/scan.ts` | `Jupiter` (Solana), `PancakeSwap` (BSC) |
| `DecimalsPort` | `src/application/scan.ts` | `JupiterTokens` (Solana), `Erc20Decimals` (BSC) |
| `HistoryPort` | `src/application/scan.ts` | `GeckoTerminal` behind `CachedHistory` + `CachedDiscovery` |
| `SecurityCachePort` | `src/application/scan.ts` | `PostgresStore` (same object as `StatePort`) |
| `OrderProbe` | `src/application/recovery.ts` | `runtime/main.ts` — `'not-filled'` in paper, `'unknown'` in live |
| `SqlClient`, `postJson` | `src/runtime/main.ts` | `src/runtime/index.ts`, over `pg` and `fetch` |

Three of those ports (`SellProbePort`, `DecimalsPort`, `HistoryPort`) are declared in the **application** layer rather than the domain, because the scanner's domain functions never call them — `scanOnce` does, and hands the domain finished `TokenSnapshot`s. That is a deliberate placement, not a leak.

**The broker port, in full.** The directory map in §8 names `src/domain/execution/broker.ts` and the table above names its interface; the file is 54 lines, and everything in it crosses the seam between the strategy and whatever fills its orders, so it is worth stating once:

```ts
export interface BrokerPort {
  /** Execute pending orders at this bar's open. Returns what actually filled. */
  execute(orders: readonly Order[], open: number, time: number): readonly Fill[]
  /** The position as the strategy must see it on this bar, marked at `close`. */
  snapshot(close: number): PositionSnapshot
  readonly openTrades: readonly OpenTrade[]
  readonly closedTrades: readonly ClosedTrade[]
  readonly rejections: readonly Rejection[]
}
```

Two methods and three read-only ledgers. `execute` takes the bar's **open** and `snapshot` the bar's **close**, because an order decided at a close fills at the *next* bar's open — the execution model the parity harness pinned (`08-motor.md` §3). `Order` and `PositionSnapshot` are the strategy's own types (`src/domain/strategy/state.ts`), which is the whole reason the state machine never learns which broker it is talking to.

| Shape | Fields | Read by |
|---|---|---|
| `Fill` | `time`, `id`, `side: 'buy' \| 'sell'`, `price`, `qty`, `commission`, `comment` | `tickPosition`, which writes each one through `store.recordFill`: `fill.id` becomes `orderId` and **`fill.commission` becomes `PersistedFill.costUsd`** — the chain's cut, as the ledger and every screen report it afterwards |
| `OpenTrade` | `id`, `entryTime`, `entryPrice`, `qty`, `entryCommission`, `comment` | `paper-run.ts` (what is still held, marked at the last close) and the parity harness (the position still open at the end of history) |
| `ClosedTrade` | everything in `OpenTrade`, plus `exitTime`, `exitPrice`, `exitCommission`, `profit`, `exitComment` | the parity harness, trade for trade; `paper-run.ts`, for realised P&L and the closed-trade count |
| `Rejection` | `time`, `order`, `reason: 'pyramiding' \| 'capital' \| 'flat'` | nothing in production — only tests |

`profit` carries its own definition in the source — *"net of both commissions — matches TradingView's trade list Profit"* — and that is not a convenience field. It is exactly what `src/application/parity.test.ts` compares against the exported trade list, beside `exitComment`: a trade shape that could not state profit the way TradingView states it would leave the parity harness with nothing to assert. Both simulators reach that number by different roads — `PaperBroker` through the fill price, `TradingViewSim` through the commission — and the identity that proves they agree is in `07-paper-mode.md` §7.1.

The three rejection reasons are worth reading as the three ways an order dies without moving: `'pyramiding'` (the ladder is at its ceiling of open entries), `'capital'` (cash cannot cover the fill *plus* gas), `'flat'` (a `closeAll` against nothing). **Nothing in production reads `rejections`**, which is how a $285 position emitting the reference ladder's $1 000 rungs came to look, from outside, exactly like a strategy with no signals. The cause was removed by sizing the ladder to the wallet; the silence was not (`07-paper-mode.md` §6, `15-decisiones.md`).

### 4.3 Where the numbers live

One rule generates several decisions across the codebase: **a number that is evidence may never be edited to express a preference.**

`DEFAULT_PARAMS.maxUsdPerLevel` is 5 000 and `PYRAMIDING` is 10 because that is what TradingView ran, and the parity harness asserts them. Production composes its own on top, in a module with no clock, no database and no network so the Next.js dashboard can import it without dragging the runtime into its build:

```ts
// src/application/production-ladder.ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15
export const DEFAULT_MAX_DCA_PER_TOKEN = 5
```

`src/runtime/main.ts` then builds `params: { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel }` and `maxOpenEntries: config.maxDcaPerToken + 1` (the entry is not a DCA rung, so five DCAs means six open entries). The dashboard once imported `DEFAULT_PARAMS` directly and drew a $1 000 rung beside a $15 order for days — a screen disagreeing with the engine about the size of a trade, which is exactly the failure `buildDashboard` exists to prevent. That is why `production-ladder.ts` is its own module.

---

## 5. One full cycle

`src/application/orchestrator.ts` runs one pass of the whole system, and **the order of its steps is the safety property**.

```
   runLoop (src/runtime/loop.ts) decides the kind of this pass
   ───────────────────────────────────────────────────────────────────────
   full   when scanIntervalMs is unset, lastScanAt is null,
          or now - lastScanAt >= scanIntervalMs
   watch  otherwise    (a strict PREFIX of full — not a shortcut)

┌─ runCycle(deps, config, throttle, kind) ─────────────────────────────────┐
│                                                                          │
│  1. RECOVER          planRecovery(store, probe)                          │
│     ├── per pending order: recorded fill → continue                      │
│     │                      venue says never arrived → resubmit           │
│     │                      unknown → HALT the position                   │
│     ├── critical 'position-halted' alert per halted position             │
│     └── throttled 'kill-switch' alert if the switch is engaged           │
│                                                                          │
│  2. TICK             for each recoverable position:                      │
│     ├── candlesFor(position)   → null means skip, silently               │
│     ├── healthFor(position)    → one sell probe sized to the position    │
│     ├── brokerFor(position)    → PaperBroker seeded from its OWN fills   │
│     └── tickPosition(...)      → see §5.3                                │
│                                                                          │
│  ── steps 3a–3f run only when the kill switch is OFF ───────────────────  │
│                                                                          │
│  3a. CANDIDATES      full  → deps.scan()     (network, ~30 min)          │
│                      watch → deps.recall()   (the shelf, no network)     │
│                      minus everything blacklisted; empty → 'scan-empty'  │
│                                                                          │
│  3b. LEDGERS         positionLedger(fillsFor(id)) once per position,     │
│                      shared by 3c, 3d and 3e                             │
│                                                                          │
│  3c. RELEASE SLOTS   full passes only. A position HOLDING tokens is a    │
│                      commitment and is never touched; one holding        │
│                      nothing is a reservation and can be handed on.      │
│                                                                          │
│  3d. TRIM CAPITAL    down only, never below what is already deployed     │
│                                                                          │
│  3e. WHAT IS FREE    committed = kept capital + HALTED capital           │
│                      fund      = commonFund(allFills())  (net of costs)  │
│                      free      = max(0, total + fund.netUsd - committed) │
│                      slotsLeft = ∞ when maxPositions <= 0                │
│                                                                          │
│  3f. ALLOCATE        planPortfolio(...) → confirmSellable(...) →         │
│                      savePosition({ cascade: initialState(),             │
│                                      deathWatch: startDeathWatch(...),   │
│                                      lastBarTime: -1 })                  │
│                                                                          │
│  4. CHECKPOINT       saveCheckpoint({ savedAt, lastCompletedBar,         │
│                                       killSwitchEngaged })               │
│                                                                          │
│  5. HEARTBEAT        throttled 'heartbeat' naming the counts             │
│                                                                          │
│  returns CycleResult — submitting orders and moving money is the         │
│  CALLER's job, because a function that both decides and acts cannot be   │
│  tested without a chain.                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Why that order

- **Recovery runs first.** An engine that scans and allocates before reconciling its own past is building on state it has not verified.
- **New positions come last**, because capital that might belong to an unresolved position is not capital to spend.
- **A halted position keeps BOTH its capital and its slot.** `committed` adds `recovery.halted` capital and `slotsLeft` subtracts `recovery.halted.length`. Treating either as free is how an engine quietly doubles its own exposure after a bad restart.
- **A token already held or already blacklisted is never reopened**, however highly the scanner ranks it.
- **The kill switch stops new risk only.** Open positions are still ticked and their death watches still run. If the switch froze the death watch too, "stop the engine" would also mean "stop protecting the money" — and the moment you most want to stop taking new risk is often the moment an open position most needs watching. Releasing it is a separate, explicit act.

### 5.2 `watch` vs `full`

The two halves cost wildly different amounts: a scan is hundreds of throttled calls and about half an hour; advancing five open positions is one candle request and one sell probe each, under a minute. Fused on one clock, a held token got attention every ~35 minutes on 15-minute bars.

> The asymmetry is the whole argument: a token you **hold** can rug in ten minutes, while an opportunity missed by an hour is only a missed opportunity.

`watch` still recovers, still halts, still ticks, still checkpoints — only discovery and reallocation are skipped. It may **fill** an empty slot from the recalled shelf, but never **swaps** one token for another (`release = kind !== 'full' ? [] : releasableSlots(...)`): taking a slot off one token and giving it to another is a judgement about which is better right now, and deserves data gathered right now.

### 5.3 One tick, one position

`tickPosition` (`src/application/engine.ts`) advances one position from its last processed bar to the newest closed bar, walking every bar it missed, bounded at `MAX_CATCH_UP_BARS = 96` (a day at 15m).

```
  sizeLadder(...)  ONCE per tick    ─ neither wallet nor pool moves in a catch-up
  computeSignals(candles, params)   ─ every indicator is causal, so context at
                                       bar i is the same however far the series runs
                                       (this turns the catch-up from quadratic
                                        into a linear walk)

  for barIndex = first .. last:
    0.  execute the PREVIOUS bar's pendingOrders at THIS bar's OPEN
        · skip if store.hasFill(key)            (a second execute() would still
                                                 move the broker's cash)
        · skip if refusesToSellAtALoss(...)     (non-death closeAll below avg cost)
        · broker.execute → store.recordFill, keyed by the DECIDING bar
    0b. announce a refused exit           ('🛡️ … no se vendió a pérdida')
    1.  the DEATH WATCH speaks first      (freeze/exit in force before orders exist)
    1a. desync guard                      flat + nothing pending + level > 0
                                          → cascade reset to initialState(), alert
    2.  stepCascade(...)                  the same function that reproduces the backtest
    3.  the DEATH WATCH gets the LAST word — applyDeathVerdict filters the orders;
        a pool too thin to size against loses ENTRIES but never EXITS
    4.  WRITE BEFORE SENDING              savePosition({ pendingOrders }) then alert
```

Two invariants from this loop are worth carrying into every other chapter:

**Bar-close semantics with next-open execution.** An order decided at bar *N*'s close fills at bar *N+1*'s **open**. This is the execution model the parity harness pinned; it is also what makes a crash between "decided" and "filled" survivable.

**Idempotency keys use the bar the order was DECIDED on:**

```ts
// src/domain/persistence/store.ts
export const idempotencyKeyFor = (positionId: string, barTime: number, orderId: string): string =>
  `${positionId}:${barTime}:${orderId}`
```

Recovery looks a fill up by exactly that key. Writing the *filling* bar instead leaves recovery unable to find its own fills, and it then halts every position the engine had just successfully traded — the exact opposite of what recovery is for. One `closeAll` produces several fills (one per open rung); the first carries the canonical key and the rest are suffixed `${key}#${index}`, because without the suffix the store's `ON CONFLICT DO NOTHING` would silently swallow five of six sell fills.

Full treatment of the tick and the cycle in `08-motor.md`; recovery in `09-persistencia.md`.

### 5.4 The failure shapes this design was bought with

These are not hypotheticals. Each is a measured production incident, and each one is why a rule above exists.

| What happened | Measured | The rule it bought |
|---|---|---|
| The engine decided orders, wrote them as `pendingOrders`, alerted — and never sent them anywhere. `broker.execute` was reachable only from `replay.ts`. | Five positions showing `0 compra / 0 venta` | Step 0 of `advanceOneBar` |
| `PaperBroker` kept its position in memory while the engine wakes as a one-shot process, so every cycle started flat. | ladder rebuilt from level zero, forever | `broker.seed(await store.fillsFor(id))` in `brokerFor` |
| `sizeLadder` was written, tested and documented as the fix for oversized orders — and never called from `tickPosition`. | a $285 position emitting $1 000 entries, silently rejected for hours | ladder sized once per tick. A silent broker rejection is **indistinguishable from a strategy with no signals** — the most dangerous failure shape in the system |
| The engine advanced one bar per cycle while a cycle took ~37 minutes against 15-minute bars. Every parameter counted in bars silently changed meaning: `confirmBars: 20` became eleven hours. | ten entries, six exits, **zero DCA fills** | walk every missed bar, bounded at 96 |
| "Never exit at a loss" was enforced at decision time, where price is above average cost by construction, and leaked at execution time. | BinanceTown sold at **-13.1%** under the comment `🏁 Exit`; the close→open gap was -14.8%, against a +2% target | `refusesToSellAtALoss(order, avgPrice, fillPrice)`, comparing against the **average** cost of everything held |
| `maxPositions: 0` meant "no ceiling" inside `planPortfolio` while the orchestrator computed `maxPositions - open`. | `slotsLeft = -5`; the book froze with $950 free and thirty-eight candidates waiting | `uncapped` translated to `Infinity` and back. "A sentinel that means one thing in one file and another next door is not a sentinel, it is a trap." |
| A slot is handed to a token *before* the strategy enters it. | one token held $285 and a slot for 5h20m at level 0, zero fills, while candidates scoring 76 and 72 waited | `releasableSlots`, `OPERADOR_IDLE_HOURS=3` |

---

## 6. Scope

| In scope | Out of scope |
|---|---|
| Scanner over thousands of tokens, multi-chain | Strategy research / new alpha |
| Continuous asset-invalidation monitoring (death exit) | Price-based stop losses |
| Safety gates: honeypot, LP lock, holder concentration | Futures, leverage, shorts, margin |
| CASCADE DCA executor | Forex, TradingView dependency |
| Solana + BSC first; other low-fee chains after | Custody of third-party funds |
| Dedicated wallet, isolated and capped | Tax/accounting reporting |
| Honest fee/slippage simulator (paper mode) | Manual/discretionary trading UI |

---

## 7. Core constraints

Nine rules the rest of the system is built to satisfy. The first eight are the project's stated constraints; the ninth is the guardrail that makes the death exit coherent and is enforced by the compiler.

1. **Paper first, and paper must be honest.** A simulator that ignores gas, swap fees and depth-based slippage produces results that do not transfer. Modeling those three is a correctness requirement, not a refinement.
2. **Safety gates are blocking.** No trade on a token that fails honeypot, liquidity or authority checks. Ever.
3. **Dedicated wallet only.** The operator never touches a wallet it does not exclusively control. Funds isolated and capped.
4. **Green path to live**: strategy parity → honest paper sim → small live size.
5. **Kill switch is mandatory** and reachable independently of the main process. It lives in the **store**, not in the process: a switch held in memory can only be thrown by a healthy engine, and a healthy engine is exactly the case where you least need one. Two of the three limits named alongside it are enforced in code: the **per-position cap** by `maxOpenEntries` — `PaperBroker.execute` rejects the entry past it with `reason: 'pyramiding'`, and `SizingPolicy.maxOpenEntries` stops the ladder earlier when production wants fewer than the reference's `PYRAMIDING` — and the **total exposure cap** by `planPortfolio`, which deploys `totalCapitalUsd` minus the reserve, split into slots, each clipped by `maxPositionPct`. The third, **max order rate, does not exist** — see §10.
6. **Every decision is auditable** — stated as "persist inputs, indicator values, signal, order, fill, gas paid, realized slippage and timestamps", and **this is the constraint the system meets least**. What is persisted is the decision and its consequence: `pendingOrders` written *before* submission, the `fills` row that confirms it, the order `comment` naming which door fired (`🟢 Entry`, `DCA-n`, `🏁 Exit`, `☠️ Death Exit`), the death watch's full `evidence` chain, the scanner snapshot that selected the token, and timestamps throughout. What is **not** persisted is most of what the decision was computed *from*:

   - **No indicator value reaches the database.** `computeSignals` returns a `SignalSeries` beside the per-bar contexts (`src/domain/strategy/signals.ts:20`), but it is recomputed from scratch on every tick and **read by nothing in production** — the engine and the replay harness both take `signals.contexts` and drop the rest. `PersistedPosition` has no field for an indicator value and `schema.sql` has no column; the candles they were computed from are not stored either.
   - **"Gas paid" and "realized slippage" are not separately auditable.** `PersistedFill.costUsd` is a single blended number — `engine.ts` writes `costUsd: fill.commission`, which is spread plus impact plus gas summed by `PaperBroker.chargeCosts`. The broker *does* keep the three split by cause in `totalCosts`, and only the offline `application/paper-run.ts` ever reads that split; the production path throws it away at the store boundary.

   **In practice the audit trail is orders, fills and one cost number per fill**, plus the death watch's evidence. Enough to reconstruct exactly what was done and when; not enough to reconstruct why, or to attribute a cost to its cause after the fact.
7. **Bar-close semantics are sacred.** Signals evaluate on **closed** bars only.
8. **Position isolation.** One token dying must not affect any other position. In paper mode this is structural: every position gets its own `PaperBroker`, "so one position's cash can never be spent by another — the same isolation the live wallets will need to enforce for real."
9. **Price is never a death signal**, and the type system says so. `AssetHealthObservation extends PriceFree`, where:

   ```ts
   type PriceFree = {
     readonly price?: never;   readonly close?: never
     readonly drawdown?: never; readonly drawdownPct?: never
     readonly pnl?: never;      readonly openProfit?: never
     readonly roi?: never;      readonly level?: never
   }
   ```

   A leak fails `tsc`. The reason is stated in the source: "If price ever leaks into this path the death exit silently degrades into a stop loss and the strategy's premise dies with it."

### 7.1 Running unattended — operational requirements

Running 24/7 with no human in the loop changes what "correct" means. The free tier makes crash recovery mandatory, not optional: an instance that can be stopped for idleness, reclaimed for a terms change, or restarted by the provider *will* go down without warning.

| # | Requirement | Where it lives |
|---|---|---|
| 1 | All state persisted, always; in-memory state is a cache | `StatePort`, `schema.sql` |
| 2 | Crash recovery reconstructs from the database, never from memory | `application/recovery.ts` |
| 3 | Process supervision with restart-loop detection | `runtime/loop.ts` backoff + GitHub Actions concurrency group |
| 4 | Idempotent order submission | `idempotencyKeyFor` + `fills ON CONFLICT DO NOTHING` |
| 5 | Reconcile on startup; disagreement halts and alerts, never guesses | `planRecovery` |
| 6 | Kill switch reachable from a phone, independent of the engine | `application/kill-switch.ts` + `POST /api/control` |
| 7 | Heartbeat + alerting | `heartbeatMs` = 1 hour, `StoredAlertSink` |
| 8 | Dead-man behavior on feed loss — freeze ladders rather than act on stale prices | `applyDeathVerdict`, `candlesFor → null` skip |

Recovery's three verdicts are the design in miniature:

| Verdict | Action | Why |
|---|---|---|
| a fill is already recorded | continue | the store is the truth; the venue is not even asked |
| the venue confirms it never arrived | resubmit | retrying is safe |
| **unknown** | **halt the position** | both guesses are wrong half the time |

"Assume filled" loses a position; "assume not filled" buys twice; a silent divergence is worse than either, because it keeps trading on a lie. **An unattended system is allowed to stop; it is not allowed to guess.**

### 7.2 Alerting levels

`src/domain/notifications/alerts.ts` assigns a level per kind, deliberately conservatively — "an alert channel where everything screams is a channel nobody reads, and the one night it matters the message will be lost in the noise."

| Level | Kinds | Throttling |
|---|---|---|
| `critical` | `death-exit`, `position-halted`, `kill-switch`, `token-retired` | never throttled |
| `warn` | `ladder-frozen`, `provider-degraded`, `scan-empty` | throttled, keyed per position (`no-loss:${id}`, `ladder-frozen:${id}`, `unsellable:${address}`); `scan-empty` keeps the default key, its own kind |
| `info` | `position-opened`, `position-closed`, `dca-filled`, `engine-started`, `heartbeat` | throttled; `info` is the only level that never becomes a phone notification |

`AlertThrottle` window: 30 minutes (`runtime/main.ts`). See `13-telefono-alertas.md`.

Two things the level column alone hides:

- **`warn` does reach the phone.** `WatchService.drainAlerts` raises a
  notification for every alert whose level is not `info` (`alert.n != "info"`),
  so a `warn` lands on the `Actividad` channel. `scan-empty` is graded `warn`
  in `LEVELS`, which means a cycle that finds nothing buzzes — once per
  throttle window, but it buzzes. Silence is `info`'s property, not
  "everything below critical".
- **`released:${id}` is an inert key.** The idle-slot handback
  (`orchestrator.ts:252`) passes it, but the alert it guards is a
  `token-retired`, and `shouldSend` returns `true` for every `critical` before
  it ever reads the key. The scoping is written down and has no effect. See
  `13-telefono-alertas.md` §4.2.

---

## 8. Directory map

```
E:/Operador/
├── CLAUDE.md                     design notes, measurements, decision log (the long one)
├── README.md                     short intro — ⚠ stale, see §10
├── DEPLOY.md                     Spanish operator guide: Neon → secrets → Vercel → phone
├── DCA.pine                      the reference specification (CASCADE DCA v1.5)
├── Dockerfile                    two-stage, linux/arm64, gated on tsc + vitest
├── docker-compose.yml            local run only — ⚠ stale, see §10
├── .env.example                  the documented env surface
├── package.json                  scripts: test, typecheck, build, start, cycle, retire, dev:phone-api
├── tsconfig.json                 strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── vitest.config.ts              include src/**/*.test.ts, node environment
│
├── src/
│   ├── domain/                   PURE. no network, no clock, no randomness, no I/O
│   │   ├── indicators/           sma, ema, rma, roc, stdev, highest, tr, atr,
│   │   │   │                     dmi, supertrend, vwm, series, recursive
│   │   │   └── __golden__/       harness.ts — TradingView export grid, 10 decimals
│   │   ├── strategy/             cascade.ts (stepCascade), ladder.ts, signals.ts,
│   │   │                         params.ts (DEFAULT_PARAMS, PYRAMIDING), state.ts
│   │   ├── scanner/              gates.ts, opportunity.ts, ranking.ts, snapshot.ts,
│   │   │                         lp-model.ts, security-merge.ts
│   │   ├── risk/                 death-exit.ts, portfolio.ts, idle-slots.ts
│   │   ├── economics/            sizing.ts (gasFloorUsd, effectiveDepth, sizeLadder)
│   │   ├── market/               market-quality.ts — the contract of §3
│   │   ├── execution/            broker.ts — BrokerPort, Fill, OpenTrade,
│   │   │                         ClosedTrade, Rejection (§4.2)
│   │   ├── persistence/          store.ts — StatePort, idempotencyKeyFor
│   │   └── notifications/        alerts.ts — Alert, AlertPort, AlertThrottle
│   │
│   ├── application/              use cases; ports in, decisions out
│   │   ├── orchestrator.ts       runCycle — one pass of the whole system
│   │   ├── engine.ts             tickPosition — one position, every missed bar
│   │   ├── recovery.ts           planRecovery — the three verdicts
│   │   ├── scan.ts               scanOnce — universe → gates → score → candidates
│   │   ├── recall.ts             the last scan, re-ranked off the shelf, no network
│   │   ├── ledger.ts             positionLedger, commonFund — the walk over fills
│   │   ├── production-ladder.ts  DEFAULT_MAX_USD_PER_LEVEL, DEFAULT_MAX_DCA_PER_TOKEN
│   │   ├── paper-run.ts          deployableCapital, ladderCapitalUsd, scaledParams,
│   │   │                         slotFloorUsd, PRICE_HEADROOM_PCT
│   │   ├── portfolio-run.ts      many tokens, one plan, independent machines
│   │   ├── replay.ts             Candles + offline replay
│   │   ├── kill-switch.ts        shouldEngage — the durable stop
│   │   ├── retire.ts             an operator taking one token off the board
│   │   ├── control-api.ts        authoriseControl — the one write path's gate
│   │   ├── dashboard.ts          buildDashboard — the read model
│   │   ├── operations-view.ts    what the broker actually DID, from fills
│   │   ├── universe-view.ts      what is out there, recomputed from snapshots
│   │   ├── phone-status.ts       the cheap poll: alive? stopped? anything new?
│   │   ├── parity.test.ts        the TradingView trade-list replay
│   │   └── capital-floor.test.ts the experiment that produced §"capital floor"
│   │
│   ├── infrastructure/
│   │   ├── http.ts               makeHttpGet({timeoutMs: 20_000}), makeThrottle
│   │   ├── adapters/
│   │   │   ├── dexscreener/      universe + market numbers
│   │   │   ├── geckoterminal/    candles, pools; cached-history, cached-discovery
│   │   │   ├── goplus/           security report
│   │   │   ├── jupiter/          Solana sell quote (jupiter.ts) + token list
│   │   │   ├── pancakeswap/      BSC sell quote via eth_call + erc20-decimals
│   │   │   └── solana/           lp-heuristics (LP lock inference by venue)
│   │   ├── brokers/              paper-broker.ts, tradingview-sim.ts
│   │   ├── persistence/          postgres-store.ts, memory-store.ts, schema.sql
│   │   └── notifications/        store-alerts.ts, recording.ts (test double)
│   │
│   └── runtime/                  the only layer that reads env or opens sockets
│       ├── config.ts             loadConfig, ConfigError, describeConfig
│       ├── loop.ts               runLoop, shutdownSignal — two cadences, backoff
│       ├── main.ts               buildRuntime — the composition root
│       ├── index.ts              process entry; dynamic `pg` import, pool max 4
│       ├── retire.ts             operator CLI: npm run retire -- <chain> <addr> "<why>"
│       └── demo-server.ts        the phone API over MemoryStore, port 3101
│
├── dashboard/                    Next.js, Vercel Hobby, READ-ONLY
│   ├── app/
│   │   ├── page.tsx              positions, warnings — imports buildDashboard directly
│   │   ├── universe.tsx          every scanned token as a body in orbit
│   │   ├── operations.tsx        what the broker did
│   │   ├── console.tsx, layout.tsx
│   │   ├── demo/page.tsx         the same view from synthetic data, labelled as such
│   │   └── api/                  view · state · phone · alerts (read)
│   │       └── control/          the ONE write path — kill switch only
│   └── lib/store.ts
│
├── android/                      Kotlin, one dependency (androidx.appcompat)
│   └── app/src/main/java/com/opendoors/operador/
│       ├── WatchService.kt       foreground service, typed `specialUse`
│       ├── Api.kt                distinguishes "refused" from "unreachable"
│       ├── MainActivity.kt, Notifications.kt, Prefs.kt, BootReceiver.kt
│
├── tools/
│   ├── golden-exporter.pine      captures TradingView values via Pine Logs
│   ├── DCA-logged.pine           the reference, instrumented
│   ├── parse-golden.mjs, parse-trades.mjs
│   ├── reset.sql                 what each table costs to erase
│   └── golden/                   BLESS-1H.trades.raw.csv, solana-dataset.json
│
└── .github/workflows/
    ├── engine.yml                cron */15 as a QUEUE; one long run, timeout 350 min
    ├── retire.yml                workflow_dispatch only — nothing here runs on a timer
    └── tests.yml                 verify (tsc + vitest) · dashboard (isolated next build)
```

### 8.1 Durable state

`src/infrastructure/persistence/schema.sql` — nine tables and three indexes:

| Table | Holds | Note |
|---|---|---|
| `positions` | the working set, with `cascade`, `death_watch`, `quality` as JSONB | a column per field would turn every strategy change into a migration |
| `fills` | every fill ever, keyed by the client's idempotency key | `ON CONFLICT DO NOTHING`; **no foreign key** to `positions`, because a closed position leaves and its history must not |
| `scans` | one row per chain per pass | `latestScansByChain()` returns the newest of each |
| `checkpoint` | `savedAt`, `lastCompletedBar`, `killSwitchEngaged` | the kill switch lives here, not in the process |
| `blacklist` | death-exit verdicts and operator retirements | `ON CONFLICT DO NOTHING` — the FIRST verdict is the one that explains why |
| `alerts` | the log the phone reads forward from a cursor | cursor is a **sequence**, not a timestamp |
| `pool_discovery` | the last universe found per chain | discovery is ~10 throttled calls per chain |
| `pool_history` | bars per pool | a pool cannot lose candles, so only a SHORT count expires |
| `token_security` | cached `SecurityReport` + measured `slippagePct` | lets the examination budget rotate across the universe |

---

## 9. Numbers at a glance

Everything below is read from source, not from prose.

### Strategy (`src/domain/strategy/params.ts`, the Pine defaults — evidence, do not edit)

| Constant | Value |
|---|---|
| `PYRAMIDING` | 10 |
| `MAX_SUPPORTED_LEVELS` / `DEFAULT_PARAMS.maxLevels` | 50 |
| `baseUsd` / `amountIncrement` / `maxUsdPerLevel` | 1000 / 1.2 / 5000 |
| `dropInitPct` / `dcaBasePct` / `linearIncrementPct` | 10 / 1.0 / 3 |
| `reboundPct` / `minGapPct` / `confirmBars` / `requireGreen` | 2.5 / 5 / 20 / true |
| `rescueLevels` / `breakevenArmPct` | 10 / 1 |
| `trendAdxMin` / `trendEmaLength` / `trendSlopeBars` | 30 / 200 / 1 |
| `swingLookback` / `bbLength` / `bbStdev` / `bbwMax` / `adxLength` / `adxMax` / `requireBoth` | 20 / 50 / 1.0 / 14 / 15 / 40 / false |
| `minProfitPct` / `rocLength` / `rocSmooth` / `volumeLength` / `decayBarsRequired` | 2 / 10 / 5 / 10 / 2 |

### Production overrides (`src/application/production-ladder.ts`)

| Constant | Value | Against |
|---|---|---|
| `DEFAULT_MAX_USD_PER_LEVEL` | **15** | `DEFAULT_PARAMS.maxUsdPerLevel` = 5000 |
| `DEFAULT_MAX_DCA_PER_TOKEN` | **5** (→ 6 open entries) | `PYRAMIDING` = 10 |

`min(1000 × (1 + 1.2n), 15)` is $15 at every level — a **flat** ladder, ~$90 over six fills, where gas at $0.05/swap is 0.33% of each.

### Risk and economics

| Policy | Values |
|---|---|
| `DEFAULT_SIZING_POLICY` | `maxFillCostPct: 1.0`, `maxExitCostPct: 3.0`, `minFillUsd: gasFloorUsd(0.05, 1)` = 5 |
| `DEFAULT_PORTFOLIO_POLICY` | `totalCapitalUsd: 1000`, `maxPositions: 5`, `maxPositionPct: 30`, `minPositionUsd: 200`, `reservePct: 5` |
| `DEFAULT_DEATH_EXIT_POLICY` | `liquidityFreezeRatio: 0.5`, `liquidityExitRatio: 0.2`, `liquidityFloorUsd: 5000`, `holderDumpFreezePct: 10`, `abandonmentFreezeHours: 6`, `abandonmentExitHours: 24`, `exitConfirmations: 3`, `clearObservations: 6` |
| `DEFAULT_IDLE_SLOT_POLICY` | `idleAfterMs: 3h`, `minScoreEdge: 10` |
| `MAX_CATCH_UP_BARS` | 96 (a day at 15m) |
| `PRICE_HEADROOM_PCT` | 5 |

Note that the live engine **overrides** `minPositionUsd` every cycle with `slotFloorUsd(...)` and `targetPositionUsd` with `ladderCapitalUsd(...)`. The 200 is kept only as a conservative default for offline experiments: "a floor that is derived cannot go stale that way."

### Runtime configuration (`src/runtime/config.ts`)

| Env var | Default | Notes |
|---|---|---|
| `OPERADOR_MODE` | `paper` | `live` throws at boot |
| `OPERADOR_CHAIN` | `solana` | a LIST; `engine.yml` sets `solana,bsc` |
| `OPERADOR_TIMEFRAME` | `15m` | only `1h` and `15m` accepted |
| `DATABASE_URL` | — | required |
| `OPERADOR_CAPITAL_USD` | 1 000 | |
| `OPERADOR_MAX_POSITIONS` | **0 = no ceiling** | the only var read with `numberOrZero` |
| `OPERADOR_GAS_USD` | 0.05 | |
| `OPERADOR_CYCLE_MS` | 300 000 (5 min) | pass interval |
| `OPERADOR_SCAN_MS` | 3 600 000 (1 h) | when a pass is also a full scan |
| `OPERADOR_MAX_CYCLES` | 0 | ⚠ see §10 — setting it to `0` explicitly throws |
| `OPERADOR_MAX_SECURITY_CHECKS` | 20 | per chain; ~9 s on Solana, ~6 s on BSC each |
| `OPERADOR_MAX_USD_PER_LEVEL` | 15 | |
| `OPERADOR_MAX_DCA` | 5 | |
| `OPERADOR_IDLE_HOURS` | 3 | twelve bars at 15m |
| `OPERADOR_MIN_SCORE_EDGE` | 10 | not zero, on purpose |
| `OPERADOR_HEALTH_MS` | 600 000 | ⚠ loaded, validated, **never read** |
| `SOLANA_RPC_URL` | `api.mainnet-beta.solana.com` | ⚠ loaded, **never read** |
| `BSC_RPC_URL` | `bsc-dataseed.binance.org` | used for the PancakeSwap probe and ERC-20 decimals |

`describeConfig` is an **allow list**, not a deny list — it prints exactly `mode, chains, database (redacted), capitalUsd, maxPositions, gasUsdPerSwap, cycleMinutes`. A field added to `RuntimeConfig` later cannot leak into a boot line by being forgotten, because anything not named is never printed.

### Adapters and pacing

| Thing | Value |
|---|---|
| HTTP GET timeout | 20 000 ms |
| Jupiter throttle | 1 100 ms |
| GeckoTerminal throttle | 2 500 ms |
| PancakeSwap throttle | 250 ms |
| `AlertThrottle` window | 30 min |
| `heartbeatMs` | 60 min |
| Loop backoff | 30 s doubling to a 10 min cap |
| Postgres pool | max 4 (engine), max 2 (retire CLI) |
| `maxTokens` per chain per scan | 300 |
| Recall staleness window | `2 × scanIntervalMs` |

### Universe coverage, measured 2026-09-14

| Source | Solana | BSC |
|---|---|---|
| Jupiter token lists | 99 | — (Solana only) |
| GeckoTerminal pools | 171 | 119 |
| DexScreener boosts | 36 | 4 |
| **Unique, deduplicated** | **261** | **123** |

384 tokens per cycle. On the first run Jupiter returned ~220 and GeckoTerminal 20; the shape reversed within weeks, which is the argument for three sources rather than a favourite — "a universe built on one provider's list is a universe that halves the day that provider changes its mind."

---

## 10. Known gaps, drift, and things that are not what they look like

Documented rather than smoothed over, because each one can mislead an operator.

| Where | What is wrong |
|---|---|
| `README.md` | **Stale.** Still describes Telegram as the alert channel and `/status`, `/positions`, `/stop`, `/start` bot commands, and tells you to fill "the Telegram pair" in `.env`. Telegram was removed entirely; alerts go to the `alerts` table and the Android app reads them from a cursor. The README also says "Automated DCA trading over small-cap crypto on Solana" while the engine scans Solana **and** BSC. |
| `docker-compose.yml` | Still passes `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (silently ignored — `loadConfig` does not read them), sets `OPERADOR_CHAIN: solana` (single chain), and defaults `OPERADOR_MAX_POSITIONS: 5` while config and `engine.yml` default to 0. **Running compose is not running what Actions runs.** |
| `DEPLOY.md` | Lists `OPERADOR_MAX_POSITIONS` default as 5 (actual: 0), and tells you to watch a manual run for `[exit] "max-cycles" 1 cycles` — but the workflow sets `OPERADOR_MAX_CYCLES=120`, so a dispatch run sits in the loop for up to 350 minutes. Watch for `[boot]` and the first `[full] {...}` instead. |
| `OPERADOR_MAX_CYCLES` | The documented "0 means never — the daemon" value is reachable only by leaving the var **unset**. Setting it to `"0"` goes through `number()`, which rejects `<= 0`, and the process throws at boot. |
| `config.healthIntervalMs` / `OPERADOR_HEALTH_MS` | Loaded and validated, then read by nothing. The death watch actually runs via `healthFor` on every position on every tick, at the cycle cadence. |
| `config.solanaRpcUrl` / `SOLANA_RPC_URL` | Also dead. Solana's sell probe is Jupiter's HTTP API, which needs no RPC. Only `bscRpcUrl` is consumed. |
| `SignalSeries` | Documented in its own source as "kept for the audit log and the dashboard". **Neither reads it.** Every caller destructures `contexts` and drops `series`; the only other reference in the repo is the golden test. It is recomputed on every tick and persisted nowhere — see §7 constraint 6. |
| Dockerfile `HEALTHCHECK` | `CMD node -e "process.exit(0)"` always succeeds. It proves the node binary exists and nothing about whether the engine is cycling. The real liveness signal is the heartbeat alert and the `checkpoint` row. |
| A GitHub Actions run **pins its commit** | Checkout happens once, so a run started at 18:23 keeps running that code until it exits. A fix pushed at 18:30 does not reach production for hours. To ship immediately, cancel the run and start a new one — safe by construction, because fills are persisted as they happen and recovery reconciles anything in flight. |
| Scheduled workflows are disabled after 60 days without a commit | The engine going quiet for this reason looks identical to the engine being dead. |
| Max order rate (constraint 5) | **Never written.** `rg` over the repository finds no `orderRate`, `maxOrderRate` or `ordersPer`: nothing anywhere counts orders per unit of time, in any layer. Two things look like it and are not — `boughtThisBar` in `stepCascade` is DCA.pine's one-fill-per-bar rule, a strategy semantic scoped to a single position, and `makeThrottle` / `minIntervalMs` (`src/infrastructure/http.ts`, GoPlus, GeckoTerminal) paces **provider HTTP calls**, not order submission. Same shape as `shouldEngage` having no caller (`05-riesgo.md` §5.4): a limit that is documented, listed among the mandatory ones, and cannot fire. |
| Live mode | **Unimplemented, on purpose.** No wallet adapter exists, no signing, no balance reads. `OrderProbe` returning `'not-filled'` is correct *only* in paper; the source says explicitly that in live it must go back to `'unknown'` until a wallet adapter can ask the chain. |

### Open questions, still open

- Engine host beyond GitHub Actions: Fly.io, Railway, or a plain VPS? (Docker image and Oracle Always Free ARM remain the prepared migration path.)
- Wallet type: hot wallet with capped balance, or a vault contract with a trade-only key and an owner-only withdrawal address?

---

## 11. Where to read next

This chapter is the map, and there is no separate index — this table is it. The thirteen companion chapters own the detail, each is the authority on its own subject, and the numbers are a reading order rather than a hierarchy:

| File | Owns |
|---|---|
| `02-indicadores.md` | every `ta.*` port and the semantics parity rests on (seeding, `na` handling, the biased estimator, direction encodings), the golden-file methodology, and the `ta.bb` tuple finding in full |
| `03-estrategia-cascade-dca.md` | CASCADE DCA: the state machine, both entry doors, the ladder, the five rebound locks, the exits, the 50-signalled/10-fillable split, every parameter |
| `04-escaner.md` | universe sourcing, `TokenSnapshot`, every gate and the order it runs in, fail-closed versus fail-open, the opportunity score, ranking, the security budget |
| `05-riesgo.md` | the death exit — two stages, every invalidation signal, the guardrails, the evidence chain and the type-level construction that keeps price out of it — plus the portfolio allocator, idle slots and the kill switch |
| `06-economia.md` | `MarketQuality`, effective depth, the three budgets, the derived gas floor, the production ladder, what `PaperBroker` charges, the capital-floor experiment, cost as a U |
| `08-motor.md` | `tickPosition` and `runCycle` step by step, the catch-up walk, the execution layer, `refusesToSellAtALoss`, the desync guard, watch versus full, slot release, the common fund, `ledger.ts` |
| `09-persistencia.md` | `StatePort`, the nine tables, why idempotency lives in SQL, the idempotency key, `planRecovery` and the three verdicts, what a restart does step by step |
| `10-adaptadores.md` | DexScreener, GoPlus, Jupiter, GeckoTerminal, PancakeSwap, the HTTP seam, the sell probe as one port with two implementations, the two caches and the throttles |
| `11-vistas.md` | `buildDashboard`, `buildUniverse`, `buildOperations`, `buildPhoneStatus`, the universe canvas mark by mark, the Next.js app, and why the only write path can only make the system safer |
| `12-runtime-despliegue.md` | `loadConfig` and every environment variable, `runLoop` and the two cadences, the composition root, GitHub Actions, the retire CLI, Docker, the $0 free-tier topology |
| `13-telefono-alertas.md` | the alert contract, the durable log that replaced Telegram, the cursor as a sequence, the three endpoints, the Android app, fail-closed authorisation |
| `14-pruebas.md` | strict TDD as it is actually practised here, the measured pyramid, golden files as an external oracle, the parity harness and the three execution facts learned from the real trade list |
| `15-decisiones.md` | the decision log: symptom, root cause, fix and lesson for every incident the live market taught, and the three failure shapes that recur |
