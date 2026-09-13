# Operador

## Mission

A self-hosted trading system that **watches thousands of small-cap crypto tokens
at once**, detects when one starts moving, and deploys the **CASCADE DCA**
strategy into it — spot only, on low-fee chains, from a dedicated wallet.

Not TradingView. Not forex. Not futures. Not leverage.
Spot, on-chain, harvesting volatility on assets that are volatile by nature.

Reference strategy: [`DCA.pine`](DCA.pine) — CASCADE DCA v1.5, Pine Script v6,
spot long, 1H, bar-close driven. Author: Jesús Nicolás Astorga. MPL-2.0.

## The system is two subsystems

Keep these separate. They fail for different reasons and are tested differently.

### 1. Scanner — "which token is worth touching at all"

Watches the universe continuously. Ranks and gates candidates. This is where
most of the risk lives, and most of the work.

- Universe: thousands of tokens across Solana, BSC, and other low-fee chains.
- **Safety gates (hard blockers, evaluated before anything else):**
  - Honeypot detection — can the token actually be sold?
  - Liquidity depth and whether the LP is locked or burned
  - Holder concentration — top-N wallet share
  - Mint authority / freeze authority still active?
  - Contract age, verified source, proxy/upgradeable flags
  - Transfer tax, blacklist functions
- **Opportunity signal** — the token "breathing": volume expansion, volatility
  regime shift, liquidity growth.
- Output: a ranked shortlist of tokens the executor is *allowed* to trade.

A token that fails any safety gate is never traded, regardless of how good the
price signal looks.

### 2. Executor — CASCADE DCA on a chosen token

Runs the reference strategy, one independent state machine per open position.

## Reference Strategy — CASCADE DCA v1.5

Spot **long only**, bar-close driven. No intrabar execution.

### State machine

`level`: 0 = flat, 1..11 = position open with N-1 DCAs filled.

```
level 0 ──(initial entry OR trend re-entry)──> level 1
level n ──(DCA-n fires)──────────────────────> level n+1
any     ──(exit)────────────────────────────> level 0, await_reentry = true
```

Persistent state to reproduce exactly: `level`, `ep1` (anchor entry price),
`total_inv`, `cycle_low`, `last_fill`, `dca_armed`, `be_armed`,
`bars_since_low`, `await_reentry`, `decay_count`.

### Entry gates (two doors, mutually exclusive per cycle)

1. **Classic** — `close <= swing_high(20) * (1 - drop_init%)` AND `is_lateral`.
2. **Trend re-entry** — armed only after a sell (`await_reentry`), fires **once**:
   Supertrend bullish AND `ADX >= tr_adx_min` AND `+DI > -DI` AND
   `close > EMA(200)` AND `close > close[tr_slope]` AND NOT `is_lateral`.

`is_lateral` = `BBW < bbw_max` OR `ADX < adx_max` (AND if `require_both`).

### DCA ladder — 10 levels

**10 levels is intentional and validated.** `pyramiding = 10` in the Pine source
is the real ceiling, not a bug. The 11..50 blocks are dead code in the reference
and must not be ported.

- Trigger for level `n`: `ep1 * (1 - drop(n)/100)`
  - Linear: `drop(n) = dca_base_pct + (n-1) * lin_inc`
  - Geometric: `drop(n) = dca_base_pct * geo_mult^(n-1)`
- Size for level `n`: `min(base_usd * (1 + amt_inc * n), max_usd_cap)` USD
- **Anti-stacking rebound confirmation** — all five locks must hold to fill:
  1. `cycle_low <= trigger(level)` → arms `dca_armed`
  2. `cycle_low <= last_fill * (1 - min_gap_pct/100)` → hard separation lock
  3. `bars_since_low >= confirm_bars` → bottom confirmed, not self-triggering
  4. `close >= cycle_low * (1 + rebound_pct/100)` → actual bounce
  5. `close > open` if `require_green`
- **One fill per bar maximum** (`bought_this_bar`). Non-negotiable.
- After any fill: `last_fill = close`, `cycle_low = na`, `dca_armed = false`,
  `bars_since_low = 0`. A **new bottom** is required to arm the next level.

### Exits

- **Normal exit** — `close > avg_cost * (1 + min_profit/100)` AND
  (`impulse_dead` OR Supertrend bearish flip). This is the "it stalled at the
  top, take the money" rule.
  - `VWM = EMA(ROC(close, roc_len) * volume/SMA(volume, vol_sm_len), roc_sm)`
  - `impulse_dead = decay_count >= decay_req AND vwm[decay_req] > 0.3`
- **Rescue breakeven** — when `filled_dcas >= rescue_levels`, arms at
  `close >= avg_cost * (1 + be_arm_pct/100)`; fires when open P&L returns to `<= 0`.
- Both close the **entire** position. **No stop loss — never exit at a loss on
  price.** The only exception is the Death Exit below.

### Death Exit — the one exception to "never exit at a loss" — DECIDED

"Never exit at a loss" assumes the asset mean-reverts. New small caps frequently
do not: they rug, get abandoned, liquidity is pulled, and the price goes to zero
and stays. The DCA ladder deploys its **largest** orders at the **lowest** prices,
so on a dying token the system commits maximum capital right before it becomes
unsellable.

**Decision: the system exits a dead asset, even at a loss.**

The distinction that makes this coherent:

> A **stop loss** exits because the *price* fell.
> A **death exit** exits because the *asset stopped being an asset*.

The no-loss rule stays fully intact for price movement. It does not apply to an
instrument that no longer functions.

#### Two-stage response

Invalidation is graded, because acting late means not being able to act at all.

**Stage 1 — Ladder Freeze** (on *suspicion*): stop deploying new DCA levels
immediately. No new capital enters. The position is held, nothing is sold.
Reversible: if signals clear for a sustained window, the ladder resumes.

**Stage 2 — Death Exit** (on *confirmation*): liquidate the entire position at
market, accepting whatever price exists. Mark the token permanently blacklisted.
Irreversible.

#### Invalidation signals

Evaluated continuously for every open position, independent of price.

| Signal | Stage | Detection |
|---|---|---|
| Sell path broken | 2 | Periodic **sell quote for the full position size** fails or returns implausible output. This is the canonical honeypot/rug test — run it on a schedule, not just at entry. |
| LP removed or unlocked | 2 | LP burn/lock status changed; LP withdrawal event observed |
| Liquidity collapse | 1 → 2 | Pool depth below absolute floor, or below X% of depth at entry |
| Mint / freeze authority reinstated | 2 | On-chain authority check |
| Wallet blacklisted / transfers paused | 2 | Contract state or failed transfer simulation |
| Dev or top-holder dump | 1 | Top-N holder moves a significant share of supply |
| Abandonment | 1 → 2 | No trades for N hours; volume near zero |

#### Guardrails — non-negotiable

1. **Price is never a death signal.** No price decline, drawdown depth, or DCA
   level count may trigger either stage. If price ever leaks into this path, the
   death exit silently degrades into a stop loss and the strategy's premise dies
   with it. Enforce this in the type system if the language allows it.
2. **Confirmation required.** Every signal needs multi-source agreement or N
   consecutive observations. A single RPC returning stale or zero data must not
   liquidate a healthy position. False positives here cost real money.
3. **Freeze is cheap, exit is not.** Bias Stage 1 toward firing early — it only
   pauses buying. Bias Stage 2 toward requiring proof.
4. **A death exit may fail**, because a broken sell path is itself a death
   signal. This is why detection runs continuously: the goal is to leave on the
   *first* confirmed signal, not to discover the exit is already closed.
5. **Every death exit is logged with its full evidence chain** — which signal,
   which source, which observations. These become test fixtures.

## Economics — the hard floor

Every on-chain order pays: **gas + DEX swap fee + slippage**. On small caps the
slippage term dominates and is a function of order size vs pool depth.

Rough per-swap fixed cost:

| Chain | Gas per swap | DEX fee | Notes |
|---|---|---|---|
| Solana | ~$0.01–0.20 (priority fee dependent) | 0.25–1% (AMM) | plus ~$0.40 one-time ATA rent, mostly recoverable |
| BSC | ~$0.10–0.30 | 0.25% (PancakeSwap) | |
| Tron | ~$1–3 unless TRX is staked for energy | 0.3% (SunSwap) | **Not viable for small orders without staking** |

A full CASCADE cycle is up to **11 buys + 1 sell = 12 swaps**. Fixed costs alone
run **$0.60–$3.00 per cycle** before slippage.

**Consequence:** below a certain capital, fees exceed the edge and the strategy
cannot be profitable regardless of how good the signal is. The engine must model
gas, swap fee, and depth-based slippage honestly in paper mode — so the
**paper results themselves reveal the true minimum capital**, rather than us
guessing at it.

Deriving that floor from the simulator is an explicit project deliverable.

## Scope

| In scope | Out of scope |
|---|---|
| Scanner over thousands of tokens, multi-chain | Strategy research / new alpha |
| Continuous asset-invalidation monitoring (death exit) | Price-based stop losses |
| Safety gates: honeypot, LP lock, holder concentration | Futures, leverage, shorts, margin |
| CASCADE DCA executor, 10 levels | Forex, TradingView dependency |
| Solana + BSC first; other low-fee chains after | Custody of third-party funds |
| Dedicated wallet, isolated and capped | Tax/accounting reporting |
| Honest fee/slippage simulator (paper mode) | Manual/discretionary trading UI |

## Core Constraints

1. **Paper first, and paper must be honest.** A simulator that ignores gas,
   swap fees, and depth-based slippage produces results that do not transfer.
   Modeling those three is a correctness requirement, not a refinement.
2. **Safety gates are blocking.** No trade on a token that fails honeypot,
   liquidity, or authority checks. Ever.
3. **Dedicated wallet only.** The operator never touches a wallet it does not
   exclusively control. Funds isolated and capped.
4. **Green path to live**: strategy parity → honest paper sim → small live size.
5. **Kill switch is mandatory** and reachable independently of the main process.
   Per-position caps, total exposure cap, and max order rate enforced in code.
6. **Every decision is auditable.** Persist inputs, indicator values, signal,
   order, fill, gas paid, realized slippage, and timestamps.
7. **Bar-close semantics are sacred.** Signals evaluate on **closed** bars only.
8. **Position isolation.** One token dying must not affect any other position.

## Architecture

Hexagonal / ports & adapters. Domain is pure, deterministic, network-free.

```
domain/
  indicators/     BB, ADX/DMI, Supertrend, ROC, EMA/SMA, VWM — pure functions
  strategy/       state machine, entry gates, DCA ladder, exit rules
  scanner/        safety gates, opportunity scoring, ranking
  risk/           exposure caps, loss limits, kill switch policy
  economics/      fee, gas, and slippage models
application/      use cases: on_bar_close, evaluate_universe, place_order,
                  reconcile_position
infrastructure/
  adapters/chains/      solana, bsc, tron — same port
  adapters/dex/         jupiter, pancakeswap, ... — quote + swap
  adapters/marketdata/  OHLCV + liquidity + holder data
  adapters/wallet/      signing, balances, nonce/blockhash management
  adapters/persistence/ event log, fills, metrics
```

Rules:
- New chain or DEX = new adapter. It never changes the domain.
- Domain has zero imports from `infrastructure/`.
- Clock, randomness, and network are injected — never called in domain code.
- Domain state is serializable. Any position must be fully reconstructable from
  persisted state after a crash — this is what makes unattended operation safe.
- Indicators must match Pine Script semantics exactly (`ta.*` initialization,
  warmup, and `na` handling are where parity breaks).

## Testing (Strict TDD)

Test first. Always. Non-negotiable for anything that can move money.

- **Indicators**: golden-file tests against TradingView-exported values.
- **State machine**: unit tests per transition, including every rebound lock
  and the one-fill-per-bar rule.
- **Parity**: replay compared against the TradingView trade list, same OHLCV.
- **Safety gates**: fixtures from real honeypots and real rugs. The gate must
  catch known-bad tokens, not just pass known-good ones.
- **Death exit**: replay fixtures of real rugs (LP pulls, honeypot flips,
  abandonment) proving both stages fire. Plus negative tests proving that deep
  price drawdown alone — at any DCA level — never triggers either stage.
- **Economics**: slippage model validated against actual executed swaps.
- **Risk**: explicit tests proving caps and the kill switch fire.
- **Adapters**: integration tests against testnet/devnet.

No network, no sleeps, no wall-clock dependencies in domain tests.

## Conventions

- Conventional commits. No AI attribution in commit messages.
- All code, comments, identifiers, and docs in English.
- Secrets and keys never in the repo. Env-only, never logged.
- `DCA.pine` is the **reference specification** for executor behavior.
  Deviations are decided explicitly, never drifted into.

## Known deviations from the Pine reference

Decided, not accidental:

| # | Item | Decision |
|---|---|---|
| 1 | `pyramiding = 10` vs 50 DCA blocks | **Intentional.** 10 levels is the validated config. Levels 11–50 are dead code; do not port. |
| 2 | Magic number `0.3` in `impulse_dead` | Port as a named configurable constant. |
| 3 | `min_gap_pct` dominating early DCA drops | Confirm against the tuned 10-level parameter set. |
| 4 | `confirm_bars` default vs tooltip | Confirm which value is the tested one. |
| 5 | Timeframe | 1H in the reference. Revisit for small caps, which move faster. |

## Runtime & Deployment

**Language: TypeScript.** Decided. The on-chain ecosystem is genuinely TS-first
(Jupiter, viem/ethers, RPC clients), and the type system can enforce the
death-exit guardrail structurally.

### The engine is a long-running process — not serverless

This is a hard constraint, not a preference. The engine must hold:

- Live WebSocket subscriptions to price and liquidity feeds
- One in-flight state machine per open position
- Continuous death-exit monitoring, independent of the 1H bar cycle

Serverless functions terminate, cannot hold sockets, and have no continuity
between invocations. **Vercel cannot host the engine.**

### Topology — $0/month stack

The whole system runs on free tiers. Verified September 2026.

| Component | Runs on | Cost | Notes |
|---|---|---|---|
| **Engine** — scanner, executors, death-exit monitor | Oracle Cloud **Always Free** ARM (Ampere A1) | $0 | 2 OCPU / 12 GB RAM / 200 GB. See gotchas below. |
| **State & event log** | Postgres — Supabase or Neon free tier | $0 | Durable truth. Engine memory is a cache, never the source. |
| **Dashboard** — positions, P&L, shortlist, death-exit log | **Vercel** Hobby (Next.js, read-only) | $0 | This is where Vercel belongs, and it fits well |
| **Alerts** — death exits, crashes, kill-switch | Telegram bot | $0 | Unattended ≠ unobservable |

Fallback if Oracle capacity is unavailable: **GCP e2-micro**, genuinely always
free but a shared core with a ~0.25 vCPU entitlement. Enough for the executor
alone; too small for a scanner over thousands of tokens.

#### Free-tier gotchas — design around these

1. **Oracle idle reclamation.** Instances under ~5% CPU for 24 hours are
   automatically stopped. A bot idling between 1H bars is exactly that profile.
   The scanner workload should keep CPU above the floor naturally; if it does
   not, this becomes a real outage source. **Monitor actual CPU and alert if it
   approaches the threshold.**
2. **Terms change without notice.** Oracle halved the Always Free ARM allowance
   (4 OCPU/24 GB → 2 OCPU/12 GB) on 2026-06-15 with no announcement, and
   terminated over-limit instances. Free infrastructure can disappear on
   someone else's schedule.
3. **ARM architecture.** Build for `linux/arm64`. Native Node modules must have
   ARM builds — check before committing to a dependency.
4. **Capacity errors are common** on Oracle ARM in popular regions. Expect to
   retry instance creation, or pick a less contested region.

#### Why free is the right call *right now*

Free tiers can be reclaimed, throttled, or silently re-specced. For a system
holding real money that is a genuine risk — but during the **paper phase there
is no money at stake**, so the risk costs nothing. Match infrastructure
reliability to capital at risk:

- **Paper phase** → free tier. Correct choice.
- **Before real capital** → a paid VPS (~$5/month). Against a system trading
  real funds, that is not a cost worth optimizing.

**This migration must be a deploy, not a rewrite.** Ship the engine as a Docker
container with all state in Postgres. Then the host is an implementation detail,
swappable in an afternoon — which is the whole point of keeping infrastructure
in the outer layer.

#### Free tier makes crash recovery mandatory, not optional

An instance that can be stopped for idleness, reclaimed for a terms change, or
restarted by the provider *will* go down without warning. Every recovery
requirement below is what makes the free tier survivable at all.

### Running unattended — operational requirements

Running 24/7 with no human in the loop changes what "correct" means.

1. **All state is persisted, always.** `level`, `ep1`, `cycle_low`, `last_fill`,
   `dca_armed`, `be_armed`, `bars_since_low`, `await_reentry`, `decay_count` —
   written durably on every change. In-memory state is a cache.
2. **Crash recovery reconstructs from the database**, never from memory. An
   unattended process *will* crash. Restart must resume mid-position without
   double-buying, skipping a level, or losing a death-exit watch.
   Recovery is a tested path, not a hope.
3. **Process supervision** with automatic restart and restart-loop detection.
4. **Idempotent order submission.** A retry after an ambiguous network failure
   must never place the same buy twice. Client-side order IDs, reconciled
   against on-chain state before acting.
5. **Reconcile on startup.** Compare believed positions against actual wallet
   balances before resuming. Disagreement halts and alerts — it never guesses.
6. **Kill switch reachable from a phone**, independent of the engine process.
7. **Heartbeat + alerting.** A silent engine is indistinguishable from a dead
   one. It must say it is alive, and shout when it is not.
8. **Dead-man behavior on feed loss.** If market data goes stale, the engine
   freezes ladders rather than acting on stale prices.

## Build Order — DECIDED

**1. Executor first. 2. Scanner second.** Not negotiable, and the reason matters:

The executor has a **known correct answer**. Port CASCADE DCA, replay the same
OHLCV TradingView used, compare trade for trade. Parity is an objective,
binary acceptance test — we know exactly when it is done.

The scanner has **no ground truth**. There is no reference implementation to
diff against. Building it first means building blind, with no way to tell a
working scanner from a broken one.

Build what can be verified. Then build what must be discovered.

### Executor milestones

1. **Indicators** — SMA, EMA, stdev/Bollinger, ROC, ATR, Supertrend, DMI/ADX, VWM.
   Pure functions, golden-file tested against TradingView exports. Parity breaks
   here first, so nothing proceeds until these match.
2. **State machine** — `level` transitions, both entry gates, the DCA ladder,
   all five rebound locks, one-fill-per-bar.
3. **Exits** — normal (VWM / Supertrend) and rescue breakeven.
4. **Death exit** — two-stage, with the price-is-never-a-death-signal guardrail.
5. **Economics** — gas, swap fee, depth-based slippage models.
6. **Parity harness** — full replay vs the TradingView trade list.
7. **Persistence + crash recovery** — resume mid-position, idempotent orders.

Scanner work starts only once the parity harness is green.

## Open Questions

- [ ] Engine host: Fly.io, Railway, or a plain VPS?
- [ ] Solana or BSC first?
- [ ] Wallet type: hot wallet with capped balance, or a vault contract with a
      trade-only key and an owner-only withdrawal address?
- [ ] Is 1H the right timeframe for small caps, or does it need to come down?
