# Operador by Open Doors

The system's name. "Operador" is the repo, the package and the engine;
"Open Doors" is the brand it ships under. Use the full name in user-facing
surfaces (dashboard title, alerts, docs); the short name in code.

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

**Status — domain complete** (`src/domain/scanner/`, chain-agnostic, pure):
- `snapshot.ts` — `TokenSnapshot` + `SecurityReport`, the only shape the
  domain ever sees; adapters translate API responses into it.
- `gates.ts` — the blockers. **Fail closed**: an unknown honeypot result,
  authority, blacklist, tax, LP lock or holder concentration is a failure,
  not a pass. Tested against the shapes of real rugs.
- `opportunity.ts` — the "breathing" score, 0..100, five explainable
  components (volume expansion, buy pressure, liquidity growth, activity,
  volatility). A v1 heuristic with policy weights — to be tuned against
  recorded outcomes, not a claim of alpha.
- `ranking.ts` — gates → score → sort → cut to watch slots; every candidate
  carries the `MarketQuality` the executor re-validates.

**The scanner produces a WATCHLIST, not entry signals.** It decides which
tokens are worth running the strategy on; CASCADE DCA's own gates (drop
from swing high, lateral zone) decide *when* to enter. One executor state
machine per watched token.

**Chain order: Solana first, then BSC** as a second adapter of the same port.
Sources (verified free, Sept 2026): DexScreener public API for the universe
and market numbers, GoPlus for security, Jupiter lite-api for sell quotes.

### 2. Executor — CASCADE DCA on a chosen token

Runs the reference strategy, one independent state machine per open position.

### The contract between them: `MarketQuality`

When the scanner selects a token it hands the executor **liquidity, spread and
slippage** — and keeps refreshing them while the position is open
(`src/domain/market/market-quality.ts`):

| Field | Meaning | Used for |
|---|---|---|
| `liquidityUsd` | total pool depth, both sides | sizing each ladder level; the **entry baseline** the death-exit "liquidity collapse" signal compares against |
| `spreadPct` | round-trip cost at negligible size (AMM fee + any gap) | paper fills; the floor every trade pays |
| `slippagePct` @ `referenceUsd` | measured price impact for a reference quote | extrapolating impact to the actual level sizes |
| `observedAt` | when it was measured | staleness — stale quality is no quality |

Two rules follow:

- **The executor validates, it does not trust.** A selected token whose ten
  fillable levels would cost more than the configured impact ceiling is
  refused or sized down, regardless of the scanner's verdict. Defense in depth.
- **Nominal USD is not fill size.** `usd(n)` from the ladder is what the
  strategy *wants*; the executor caps it so `spread + impact` stays bounded.
  With defaults, level 4+ ($5,000) against a $100k pool costs ~10% per fill —
  untradeable — while a $1M pool keeps every level under 1.5%.

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

### DCA ladder — 50 signalled levels, 10 fillable

**The Pine defaults ARE the production configuration** (confirmed by the
user): `max_levels = 50` in the inputs and `pyramiding = 10` in the
`strategy()` header, both intentional. They interact:

- The state machine signals DCA levels all the way to 50 — advancing `level`,
  resetting the cycle, summing nominal `total_inv` — exactly as the script does.
- TradingView's broker rejects every entry after the **tenth open one**
  (Entry + DCA-1..DCA-9). DCA-10 onward are signalled, never filled.

So the port keeps the machine faithful (`maxLevels` up to 50) and enforces
`PYRAMIDING = 10` in the **broker simulator and the live risk layer** — the
strategy signals, the venue caps. This is also why `rescue_mode` can engage:
`filled_dcas = level - 1` counts signalled levels, not fills.

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

## The capital floor — measured, not guessed

First run of `capital-floor.test.ts` over a recorded Solana market
(3 tokens with enough 1H history, ~41 days, gas $0.05/swap, 1% fill budget):

| Token | $1 | $50 | $200 | $1,000 | $5,000 | $20,000 |
|---|---|---|---|---|---|---|
| DREGG | — | — | — | +$1,044 | +$5,534 | +$5,534 |
| TROLL | — | — | +$53 | +$34 | +$34 | +$34 |
| Leafy | — | — | +$159 | +$159 | +$159 | +$159 |

Four findings, in order of how much they change the plan (1 and 3 and 4 are
**done**; 2 drives the multi-token engine):

1. **Below ~$200 the system does not trade at all.** Not "loses money" —
   places zero orders. The pool-sized ladder has its own minimum, and under it
   the broker rejects every entry for want of funds. The $1 experiment is not
   unprofitable; it is mechanically impossible.
2. **Above the pool's capacity, more capital does nothing.** Leafy returns the
   same $159 at $200 and at $20,000, because the ladder is capped by depth, not
   by the wallet. Return per dollar therefore FALLS as capital grows —
   80% at $200, 0.8% at $20,000. **Scale comes from more tokens, not more size
   per token.** This is the scanner's real justification. **Fixed**: the
   portfolio layer (`domain/risk/portfolio.ts`) splits capital across slots
   instead of into one position.
3. **The chain's cut varies enormously**: 10% of gross on DREGG, 72% on TROLL.
   Cost share is a per-token property. **Fixed**: `costEfficiency` is now a
   weighted component of the opportunity score (weight 0.2), scoring zero at a
   6% round trip. Quality is measured BEFORE scoring, because what the chain
   will take is part of how good the opportunity is.
4. **Most small caps lack the history the strategy needs.** Two of five
   candidates had 38 and 105 bars; EMA-200 cannot exist there. **Fixed**: a
   `history` gate rejects under 250 1H bars, fed by the candle adapter. An
   unmeasured count stays silent — the gate fires on evidence, not on absence.

### What the fixes changed, on the same recorded market

| Token | bars | round trip | cost eff. | score before | after | verdict |
|---|---|---|---|---|---|---|
| DREGG | 1000 | 0.95% | 0.84 | 61.9 | **68.7** | PASS |
| TROLL | 1000 | 1.59% | 0.73 | 43.2 | **47.9** | PASS |
| HEV | 38 | **11.62%** | 0.00 | 54.0 | 44.0 | **history** |
| EMBER | 105 | 1.59% | 0.73 | 34.2 | 38.8 | **history** |
| Leafy | 370 | 3.18% | 0.47 | 34.1 | 33.5 | PASS |

HEV ranked third before and is now both penalised (a 11.6% round trip scores
zero on cost) and rejected outright. DREGG, the cheapest token and the one the
paper run actually made money on, rose to the top. The ranking now prefers what
the measurements say it should.

### Cost is a U, not a slope

Two costs pull against each other as a position grows: **gas is fixed**, so its
share falls with size, and **impact is superlinear**, so its share rises. The
same recorded market, cost as a share of gross:

| Token | $50 | $200 | $1,000 | $5,000 | $20,000 |
|---|---|---|---|---|---|
| DREGG | **4%** | 6% | 10% | 27% | 27% |
| TROLL | **18%** | 26% | 72% | 72% | 72% |
| Leafy | **9%** | 12% | 12% | 12% | 12% |

Tiny positions are eaten by gas; large ones are eaten by their own price
impact. On these pools the cheapest point sits at the small end — which is the
same conclusion as finding 2, arriving by a different road: **many small
positions beat one large one, and not only for diversification. They are
cheaper to run.**

### Two sizing bugs the experiment exposed

- **The ladder was sized against the pool but not against the wallet.** A $200
  position was handed $1,000 levels, and the broker rejected each one for
  funds — which looks exactly like a strategy that produces no signals.
  `sizeLadder` now takes the available capital as a second ceiling.
- **Orders were sized to the last cent.** The state machine sizes at the signal
  bar's CLOSE and fills at the next bar's OPEN: a half-percent gap up and the
  order is unaffordable. Sizing now reserves gas for every swap of a full cycle
  plus 5% price headroom. With that, the floor where the system trades at all
  dropped from ~$200 to under $50.

**These numbers are not a forecast.** The tokens are today's trending list, over
a window in which they trended — survivorship pointing the same way as the
result. The floor and the scaling shape are the findings; the returns are not.

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

## Running it

```bash
cp .env.example .env      # fill in DATABASE_URL and the Telegram pair
docker compose up -d --build
```

The image targets **linux/arm64** (Oracle's Always Free tier is Ampere), and
the build runs `tsc --noEmit` and the full suite before it produces anything —
a native module without an ARM build fails at build time rather than at 3am on
the VPS. TypeScript is compiled to plain JS for production: shipping `tsx`
would make the runtime depend on a transpiler staying healthy.

**Live mode refuses to start.** `loadConfig` throws on `OPERADOR_MODE=live`
because no wallet adapter has been built or audited, and live trading is not a
flag anyone should be able to drift into. Paper is the only accepted value
today.

Smoke tests hit real APIs and are skipped unless asked for:

```bash
OPERADOR_SMOKE=1 npx vitest run src/application/collect-dataset.smoke.test.ts
```

## The cycle

`application/orchestrator.ts` runs one cycle of the whole system, and the
ORDER of its steps is the safety property:

```
recover → halt what cannot be trusted → tick what can →
open new positions with what is left → checkpoint → heartbeat
```

- **Recovery runs first.** An engine that scans and allocates before
  reconciling its own past is building on state it has not verified.
- **New positions come last**, because capital that might belong to an
  unresolved position is not capital to spend. A halted position keeps BOTH
  its capital and its slot — treating either as free is how an engine quietly
  doubles its own exposure after a bad restart.
- **A token already held or already blacklisted is never reopened**, however
  highly the scanner ranks it.

## The kill switch

It lives in the **store**, not in the process. A switch held in memory can only
be thrown by a healthy engine — and a healthy engine is exactly the case where
you least need one. In durable state, a phone can stop a machine it cannot
reach, and a crash-looping process comes back already stopped.

| | |
|---|---|
| **Stops** | opening any new position |
| **Keeps** | the death watch running on everything already open |

That asymmetry is deliberate: if the switch froze the death watch too, "stop
the engine" would also mean "stop protecting the money" — and the moment you
most want to stop taking new risk is often the moment an open position most
needs watching. Releasing it is a separate, explicit act.

Automatic limits (`shouldEngage`, pure so the rule is testable without a
store): drawdown past 35%, or **3 death exits in 24 hours** — several tokens
dying at once is rarely a coincidence. It is either a bad market or a bad
scanner, and neither is a reason to keep buying.

## Durable state, in Postgres

`schema.sql` + `PostgresStore`. Two decisions worth knowing:

- **Domain objects are stored as JSONB** (`cascade`, `death_watch`, `quality`).
  A column per field would turn every strategy change into a migration; these
  types are meant to keep evolving.
- **Idempotency lives in SQL, not in TypeScript.** `fills` is keyed by the
  CLIENT's idempotency key and inserts `ON CONFLICT DO NOTHING`, so a retry
  after an ambiguous network failure collides instead of buying twice — even
  if two engine instances race. A guarantee the database enforces cannot be
  forgotten by a caller. The blacklist uses the same clause, because a death
  exit is terminal and the FIRST verdict is the one that explains why.
- `fills` deliberately has **no foreign key** to `positions`: a closed position
  leaves the working set, and its trade history has to survive that.

## The dashboard

`dashboard/` — a Next.js app for Vercel's Hobby tier, and
`application/dashboard.ts` is the read model behind it.

**The numbers live in the application layer, not in the web app.** Two
implementations of "how much are we up" will eventually disagree, and the one
on the screen is the one you will believe. The page imports `buildDashboard`
directly; it writes no queries of its own.

**There is no write path in the app at all.** No order can be placed from it,
no position closed, no switch thrown. A dashboard that could trade would be a
second attack surface on the money, guarded by a URL people paste into chats —
which is exactly why the kill switch lives in Telegram, authenticated to one
chat id.

It renders **warnings, not a green badge**: kill switch engaged, orders in
flight unconfirmed, frozen positions, and — the one that matters most — a
position nobody has updated in hours. That last case is the shape of a silently
dead engine, the failure that looks identical to "nothing is happening".

Rendering is `force-dynamic`: a cached view of a trading system is worse than
no view, because a stale "all healthy" reads exactly like a live one.

## The phone

`telegram-bot.ts` — `/status`, `/stop`, `/start`, `/positions`, `/help` —
wired to Telegram by `telegram-poller.ts` and run alongside the trading loop.

Every command is authorised against a single chat id, and an unauthorised chat
gets **nothing back at all** — not an error, not a hint. An error message would
confirm the bot exists and does something worth doing, which is free
reconnaissance for whoever found the token.

Three properties of the poller:

- **Long-polling, not webhooks.** A webhook needs a public URL and a TLS
  certificate on a box whose whole appeal is being free and unexposed. Polling
  costs one idle connection and opens no ports.
- **The offset only advances past an update that was processed.** Telegram
  replays anything unacknowledged, so a crash mid-command retries it rather
  than losing it — which for `/stop` is exactly the behaviour you want.
- **A failed poll never ends the loop.** The channel that can stop trading has
  to outlive a bad network, or it is not a safety control.

## The engine tick

`application/engine.ts` advances ONE position by ONE closed bar. The order of
its four steps is the design:

1. **The death watch speaks first.** Health is assessed before the strategy
   runs, so a freeze or a death is already in force when orders are decided.
2. **The strategy evaluates the closed bar** — the same `stepCascade` that
   reproduces the TradingView backtest, unchanged.
3. **The death watch gets the last word.** `applyDeathVerdict` filters what
   the strategy wanted; vetoed orders are reported, not silently dropped.
4. **Write before sending.** Orders are persisted as `pendingOrders` BEFORE
   submission. A process that dies at this exact point is recoverable only
   because the intent was written down first.

Two guards worth naming:

- **`lastBarTime` prevents deciding twice.** A crash after saving but before
  submitting comes back, sees the bar is processed, and does nothing — rather
  than re-emitting an order it cannot know was already sent.
- **Alert levels are conservative.** Risk events (death exit, halted position,
  kill switch) are critical and are NEVER throttled. Everything else is
  throttled per position, because a channel where everything screams is a
  channel nobody reads — and the one night it matters, the message is lost in
  the noise.

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

- **Indicators**: golden-file tests against TradingView-exported values,
  captured via `tools/golden-exporter.pine` (Pine Logs — works on the free
  plan). Golden values are an EXTERNAL oracle: never regenerate them from our
  own output, or the test becomes a mirror instead of a check.
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
| 1 | `pyramiding = 10` vs 50 DCA blocks | **Intentional, both.** Machine signals to 50; broker fills 10. Ported as `maxLevels = 50` + `PYRAMIDING = 10` in execution. |
| 2 | Magic number `0.3` in `impulse_dead` | Port as a named configurable constant. |
| 3 | `min_gap_pct` dominating early DCA drops | Confirm against the tuned 10-level parameter set. |
| 4 | `confirm_bars` default vs tooltip | Confirm which value is the tested one. |
| 5 | Timeframe | 1H in the reference. Revisit for small caps, which move faster. |
| 6 | **`ta.bb` tuple mislabelled → wrong BBW** | See below. Port the behaviour as written; the fix is a separate, retuned experiment. |

### Finding: the BBW filter is inert

`DCA.pine:415` destructures Bollinger Bands as:

```pine
[bb_up, bb_mid, bb_lo] = ta.bb(close, bb_len, bb_dev)
bbw = (bb_up - bb_lo) / bb_mid * 100
```

**Pine's `ta.bb` returns `[basis, upper, lower]` — the basis comes FIRST.**
Proven against TradingView's own exported values (`sma.golden.test.ts`):

- Element 0 equals `ta.sma(close, 50)` to **0.0000000000%**
- The other two sit **exactly symmetrically** around it
- As labelled, `bb_up < bb_mid` — an upper band below its own basis is impossible

So all three names are shifted, and the BBW line actually computes
`(basis - lower) / upper * 100` instead of `(upper - lower) / basis * 100`.

**Measured impact** over 4001 bars of BLESS 1H, with Pine itself computing
both formulas side by side:

| | As written | Textbook |
|---|---|---|
| Mean BBW | 5.821 | 13.165 (**2.26×**) |
| `bbw < bbw_max(14)` | 92.5% of bars | 74.3% |
| `is_lateral` differs | — | on 4.45% of bars |

The BBW half of `is_lateral` passes on 92.5% of bars, so it filters almost
nothing; OR'd with `ADX < 40` the lateral gate is close to a constant `true`.
This is the hard evidence for the permissiveness flagged earlier.

(An earlier 301-bar sample read 100%/88%. That window was an unusually quiet
stretch — the 4001-bar figures above supersede it.)

**Decision: port the behaviour exactly as written.** The strategy's parameters
(the Pine defaults, which are the production configuration) were tuned against this behaviour, and parity with the validated backtest is
the acceptance test. Silently "fixing" it changes `is_lateral` on 4.45% of
bars against a baseline that was never tested.

The corrected formula ships alongside it as `bbwTextbook`, unused by the
strategy, so the fix can later be evaluated as an explicit A/B with retuned
`bbw_max` — not smuggled in as a bugfix.

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
| **Dashboard** — positions, death watch, warnings | **Vercel** Hobby (Next.js, read-only) | $0 | This is where Vercel belongs. **✅ built** |
| **Alerts** — death exits, crashes, kill-switch | Telegram bot | $0 | Unattended ≠ unobservable. **✅ built** |

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

   **✅ COMPLETE** — every indicator the strategy uses is pinned against
   TradingView's own values (BLESS 1H, 4001 bars + 12 seed bars):

   | Pine | Port | Parity note |
   |---|---|---|
   | `ta.sma` | `sma` | exact, price and volume scales |
   | `ta.ema` | `ema` | seed SETTLED (na until window fills, then SMA); recursion verified at length 200 |
   | `ta.rma` | `rma` | same seeded recursion, alpha 1/n |
   | `ta.roc` | `roc` | exact |
   | `ta.highest` | `highest` | exact |
   | `ta.stdev` | `stdev` | **population** (biased) — sample is off by 1% |
   | `ta.bb` | via `sma` + `stdev` | tuple is `[basis, upper, lower]` — see the BBW finding |
   | `ta.tr` / `ta.atr` | `trueRange` / `atr` | `atr` uses `handle_na` (bar 0 = high-low) |
   | `ta.supertrend` | `supertrend` | Pine direction kept: **-1 = uptrend**; 0 direction mismatches over 3001 bars |
   | `ta.dmi` | `dmi` | uses `ta.tr` WITHOUT `handle_na` (bar 0 = na); `fixnan` carry reproduced |
   | VWM (strategy's own) | `vwm` | composition pinned |

   Parity is asserted against the **export grid** (10 decimal places), not a
   fuzzy percentage — see `__golden__/harness.ts`. Recursive indicators are
   compared once converged; a wrong recursion cannot converge onto the right one.

2. **State machine** — `level` transitions, both entry gates, the DCA ladder,
   all five rebound locks, one-fill-per-bar. **✅ COMPLETE** — `stepCascade`
   in `src/domain/strategy/cascade.ts`, a transcription of DCA.pine's per-bar
   logic in its exact evaluation order, 39 scenario tests.
3. **Exits** — normal (VWM / Supertrend) and rescue breakeven. **✅ COMPLETE**
   (part of the same step function, as in the reference).

   **Architecture of the step function** — it takes two inputs that the
   reference conflates:
   - `BarContext`: indicator-derived facts (`isLateral`, `trendBullish`,
     `stBearFlip`, VWM lags, swing high), computed by the indicator layer.
   - `PositionSnapshot`: what the **broker** reports — size, average fill
     price, open P&L (`strategy.position_size` etc.). These come from FILLS.

   The distinction matters for parity: DCA.pine has no
   `process_orders_on_close`, so every order fills at the **next bar's open**
   (1 tick slippage, 0.1% commission), while the state machine sets
   `ep1 := close` on the signal bar. Exit and rescue logic read the broker's
   numbers, not the machine's — exactly as the reference does.
4. **Death exit** — two-stage, with the price-is-never-a-death-signal guardrail.
   **✅ COMPLETE** — `src/domain/risk/death-exit.ts`. `AssetHealthObservation`
   is typed so no price-shaped field can exist on it (`price?: never` and
   friends — a leak fails `tsc`). `assessAssetHealth` folds observations into
   a serialisable `DeathWatchState`; `applyDeathVerdict` filters the strategy's
   orders: frozen drops entries, dead replaces everything with `☠️ Death Exit`
   while in position and blocks entries forever. 22 scenario tests, including
   "stage-1 evidence never accumulates into an exit" and "unknown readings
   neither confirm nor clear".
5. **Economics** — sizing **✅ COMPLETE** (`src/domain/economics/sizing.ts`);
   paper fills next.

   **Budget: 1% total cost per fill** (user's decision), 3% for the single
   exit, $20 gas floor. Three bounds, and the second is the one people forget:

   - **Per fill**: spread + impact ≤ 1%. The venue fee comes out first, so a
     0.25% pool leaves 0.75% for impact.
   - **Per position**: `close_all` sells EVERYTHING in one order, so the total
     — not each level — sets what leaving costs. On a thin pool this binds
     long before the fill budget does.
   - **Floor**: a fill under $20 is not worth its gas; the ladder stops there.

   **Effective depth comes from a measured quote, never reported TVL.**
   Inverting the impact model (`depth = 200 × usd / impact%`) exposes
   concentrated pools: HEV reported $186k of liquidity and moved 5.2% on a
   $100 order — $3.8k of real depth. The executor refuses it.

   Measured against the live Solana candidates:

   | Token | Reported | Real depth | Ladder |
   |---|---|---|---|
   | EMBER | $517k | $1.0M | $13,750 over 5 levels |
   | DREGG | $171k | $67k | $909 over 4 levels |
   | SQUIRE | $125k | $14k | $183 over 4 levels |
   | HEV | $186k | **$3.8k** | **refused** |

   Against a nominal ladder of $41,200. **On real small caps the pool sets the
   position size, not the capital** — and the honest simulator is what makes
   that visible before any money moves.
6. **Parity harness** — full replay vs the TradingView trade list. **✅ GREEN.**
   `src/application/parity.test.ts` reproduces TradingView's Strategy Tester
   trade for trade from the resync point to the end of history: entry bar,
   entry price, exit bar, exit price, size, net profit, exit comment — and the
   five-entry position still open at the end. Three execution facts had to be
   learned from the real trade list, none derivable from the script:
   - **Capital rule is margin, not cash.** `margin_long = 100` rejects an
     entry when its notional exceeds equity (cash + open position marked at
     the fill bar's open) minus margin already used. DCA-4 ($5,000) filled
     with $11,200 deployed against $10,000 initial capital; DCA-5..8 were
     signalled and rejected once price fell. `TradingViewSim.capitalRule`.
   - **Quantities are truncated** to the contract step (0.001 here):
     1000 / 0.01374 = 72780.2038… fills as 72780.203. Floor, not round.
   - **Equity carries history.** The margin rule depends on every realised
     trade since the chart began, so the replay seeds TradingView's cash at
     the resync bar (both sides flat) before walking in lockstep.
7. **Persistence + crash recovery** — resume mid-position, idempotent orders.
   **✅ COMPLETE.** `domain/persistence/store.ts` defines the durable contract
   (positions with their cascade state, death watch and pending orders; fills
   keyed for idempotency; scans; checkpoints; the death-exit blacklist), with
   `MemoryStore` as the reference implementation and Postgres to follow.

   `application/recovery.ts` is the path that decides whether a restart costs
   money. For every order that was in flight when the process died it answers
   one question — *did this actually happen?* — and there are three answers,
   not two:

   | Verdict | Action | Why |
   |---|---|---|
   | a fill is already recorded | continue | the store is the truth; the venue is not even asked |
   | the venue confirms it never arrived | resubmit | retrying is safe |
   | **unknown** | **halt the position** | both guesses are wrong half the time |

   That third row is the whole design. "Assume filled" loses a position;
   "assume not filled" buys twice; and a silent divergence between what the
   engine believes and what the wallet holds is worse than either, because it
   keeps trading on a lie. A halted position keeps its state, stops, and asks
   for a human — **an unattended system is allowed to stop; it is not allowed
   to guess.** One halted position never stops the others, and a blacklisted
   token never resumes at all.

Scanner work starts only once the parity harness is green.

## Open Questions

- [ ] Engine host: Fly.io, Railway, or a plain VPS?
- [ ] Solana or BSC first?
- [ ] Wallet type: hot wallet with capped balance, or a vault contract with a
      trade-only key and an owner-only withdrawal address?
- [ ] Is 1H the right timeframe for small caps, or does it need to come down?
