# The scanner

This chapter documents the half of Operador that decides **which tokens the executor is allowed to touch at all**: the universe sources it draws from, the `TokenSnapshot` that is the only shape its domain ever sees, every gate it applies and in what order, the split between gates that fail closed and gates that fail open, the freefall gate and why it lives with entry and not with exit, the opportunity score and its six weighted components, the ranking pipeline, and the bounded security budget that makes a universe of 300 tokens affordable on a throttled free tier. The executor — CASCADE DCA, the state machine, the death exit — is a different subsystem with different failure modes; see `01-vision-general.md` for how the two fit together and `06-economia.md` for the cost models the scanner feeds.

---

## 1. What the scanner is for, and what it refuses to be

The scanner produces a **watchlist, not entry signals**. That distinction is load-bearing and is stated in the header of `src/domain/scanner/opportunity.ts`:

> The scanner does NOT time entries; CASCADE DCA does that with its own swing-high drop and lateral-zone gates. The scanner ranks which tokens are worth running the strategy on.

Two separate questions, answered by two separate subsystems:

| Question | Answered by | Where |
|---|---|---|
| Is this token worth running the strategy on at all? | the scanner | `src/domain/scanner/` |
| Given that it is, *when* do we buy? | CASCADE DCA's own gates | `src/domain/strategy/cascade.ts` |

So a token can sit on the watchlist for days without a single order being placed. That is the normal case, not a failure.

Three more things the scanner refuses to be:

- **It is not a price model.** Exactly one gate reads price movement (`freefall`, §6), and it is an entry filter. Nothing in the scanner predicts direction; `buyPressure` is deliberately floored at neutral when sellers dominate, because the scanner is looking for *attention*, not for a forecast.
- **It is not chain-aware.** `src/domain/scanner/` imports nothing from `infrastructure/`. Adapters translate DexScreener, GoPlus, Jupiter, PancakeSwap and GeckoTerminal responses into a `TokenSnapshot`, and the domain never learns which chain it is on or which vendor said what. Adding a third chain costs an adapter, not a gate.
- **It is not a claim of alpha.** The opportunity score is labelled in its own source as "a v1 heuristic to be tuned against recorded outcomes". Its components are exposed individually precisely so a ranking can be argued with.

The scanner is also where most of the risk lives. A wrong executor loses a trade; a wrong scanner buys something unsellable.

---

## 2. The only shape the domain sees — `TokenSnapshot`

`src/domain/scanner/snapshot.ts`. Everything downstream — gates, score, ranking, the dashboard, `recall` — reads this and nothing else.

```ts
export type Chain = 'solana' | 'bsc'
```

### Market fields

| Field | Type | Source | Notes |
|---|---|---|---|
| `chain`, `address`, `symbol` | — | DexScreener | `address` is the base token mint/contract |
| `pairAddress` | `string` | DexScreener | the **deepest** pool for that token; see below |
| `dexId?` | `string` | DexScreener | `'raydium'`, `'pumpswap'`, `'orca'`… drives the LP model |
| `dexLabels?` | `readonly string[]` | DexScreener | `['CLMM']`, `['DLMM']` — also drives the LP model |
| `observedAt` | `number` (ms) | adapter clock | |
| `priceUsd` | `number` | DexScreener | used to size the reference sell |
| `liquidityUsd` | `number` | DexScreener | **reported** depth — a claim, not a measurement |
| `fdvUsd` | `number \| null` | DexScreener | |
| `volumeUsd` | `{h1,h6,h24}` | DexScreener | never null; missing windows become `0` |
| `priceChangePct` | `{h1,h6,h24}`, each nullable | DexScreener | null means the provider said nothing |
| `txns` | `{h1,h24}` of `{buys,sells}` | DexScreener | |
| `pairCreatedAt` | `number \| null` | DexScreener | `hoursOld()` derives age from it |

`DexScreener.toMarketSnapshots` picks **one pool per token — the deepest one**, "because that is where the executor would trade and where liquidity-based gates should look."

### Security fields — `SecurityReport`

Ten nullable fields: `honeypot`, `mintAuthorityActive`, `freezeAuthorityActive`, `transferTaxPct`, `hasBlacklist`, `lpLockedPct`, `topHoldersPct`, `creatorPct`, `verifiedSource`, `isProxy`.

The file's own statement of what `null` means is the single most important sentence in the subsystem:

> `null` means "the source could not tell us". For security fields that is not neutral: the gates fail closed on unknown critical facts.

### The three fields that each exist because of a production bug

These were added later, and each one is a scar:

| Field | Type | The bug it fixed |
|---|---|---|
| `securityChecked?` | `boolean \| undefined` | Without it, "nobody has looked at this token" and "we looked and it is dangerous" rendered identically. The live universe screen read **`insegura 219, filtrada 6`** when almost all 219 were simply too thin to bother with. |
| `measuredImpactPct?` | `number \| null \| undefined` | **CREPE reported $718,000 of liquidity and moved the price 98% on a $285 sell.** It passed every other gate and became a position. Reported TVL is an aggregator's claim; this is what the venue answered when asked to sell. |
| `historyBars?` | `number \| null \| undefined` | The first capital-floor run found two of five candidates with **38 and 105** closed 1H bars. EMA-200 cannot exist there. |

`securityChecked` is a **three-state field**, and this trips people:

- `true` — examined this cycle, or a cached report was reused
- `false` — explicitly not examined (free-gate reject, or past the budget cut)
- `undefined` — the scan did not say; **treat as checked**, because every snapshot written before the field existed had been

Downstream code must therefore test `=== false` and never `!securityChecked`. `universe-view.ts` gets this right (`snapshot.securityChecked !== false`) and the difference is the entire `pending` tier.

---

## 3. The universe — three sources, deduplicated

Universe assembly is stage 1 of `scanOnce` (`src/application/scan.ts`). Three sources, unioned through a `Set`, then sliced to `maxTokens`:

| # | Call | Adapter | Chains | What it returns |
|---|---|---|---|---|
| 1 | `decimals.discover?()` | `JupiterTokens.discover(limit = 50)` | Solana only | `toptrending/24h`, `toptraded/24h`, `toporganicscore/24h` |
| 2 | `history.discoverPools?(chain)` | `CachedDiscovery` → `GeckoTerminal.discoverPools(chain, pages = 5)` | both | `trending_pools` + `pools`, 5 pages each |
| 3 | `dex.discoverTokens(chain)` | `DexScreener` | both | `/token-profiles/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1` |

### Measured coverage

Live, 2026-09-14:

| Source | Solana | BSC |
|---|---|---|
| Jupiter token lists | **99** | — (Solana only) |
| GeckoTerminal pools | **171** | **119** |
| DexScreener profiles + boosts | 36 | 4 |
| **Unique, deduplicated** | **261** | **123** |

Both chains together: **384 tokens per cycle.**

### Why three sources and not a favourite

The shape **moved between runs**: Jupiter's lists fell from roughly 220 to 99 while GeckoTerminal's pools rose from 20 to 171. Neither number is a constant. A universe built on one provider's list is a universe that halves the day that provider changes its mind.

And BSC was effectively blind before source 2 existed. Its only source was DexScreener's boosts, which are **paid promotions**, and it returned **nine tokens**. From the `HistoryPort` docstring: a universe built from who paid to be seen is not a universe, it is an advertising slot.

`GeckoTerminal.discoverPools` is what fixed it — it is what Jupiter's lists are for Solana, except chain-agnostic, which also means a third chain costs nothing on the universe side.

### The cap, and why it stopped truncating

`maxTokens` is **300** in production, and it applies to the deduplicated union. It used to be **60**, a number chosen to respect GoPlus rate limits — and it therefore truncated the universe *before any gate had an opinion*. The cap was not biased toward new tokens; it was just arbitrary. Measured: of the roughly 220 Jupiter-listed Solana tokens, **101 were older than 30 days and 78 older than 180**.

What made 300 affordable was moving the free gates in front of the paid ones (§5.1), not raising a quota.

Note that DexScreener's own hard limit — 30 addresses per `tokens()` call — is handled by **batching**, not by the cap.

### Failure behaviour, which is not uniform

Sources 1 and 2 are wrapped in `try/catch` and degrade into a `ScanError` with address `'*'`. **Source 3 is not**:

```ts
for (const address of await deps.dex.discoverTokens(config.chain)) universe.add(address)
```

A DexScreener outage therefore throws out of `scanOnce` and kills that chain's entire pass. It is survivable only because `main.ts` wraps each chain in its own `try/catch`. This is an inconsistency, not a design: anyone adding a fourth source by copying that line inherits it.

---

## 4. The pipeline

`scanOnce(deps, config, previous = new Map())` in `src/application/scan.ts`, one pass per chain.

```
1  universe   three sources ∪, deduplicated, sliced to maxTokens (300)
2  market     dex.tokens() in batches of 30 → deepest pool per token
3  free gates evaluateMarketGates — zero network calls
3b cache      cachedSecurity() within TTL (2h) → fully evaluated, free
4  budget     unexamined = affordable − remembered; sort by provisionalScore; slice
5  paid       3 concurrent branches per token → mergeSecurity → probe overrides
6  rank       rankUniverse: evaluateGates → quality → score → minScore → sort → slice
```

`scannedAt = now()` is taken **once** and stamps every `observedAt` / `measuredAt` in the pass, so a scan is a single point in time.

### Progress, because silence is undiagnosable

`ScanProgress` has five stages — `universe`, `market`, `budget`, `checked`, `done`. From the source:

> A scan can spend ten minutes inside throttled network calls. Without this it spends them in silence, and a silent process that gets killed by a timeout tells you nothing about WHERE it was.

`checked` fires only on `done % 10 === 0` ("a log that scrolls is a log nobody reads"). With the production budget of 20 that means it fires exactly twice; with a budget under 10, never.

### Error isolation

Every expensive branch has its own `try/catch` recording a `ScanError { address, stage }` where stage is `'market' | 'security' | 'quote' | 'history'`. A token whose security call 503s still produces a snapshot, still faces the gates, and still fails closed — pinned by `'isolates errors: a token whose security call fails is recorded and fails closed, the rest proceed'`.

One caveat: the `errors` array conflates per-token batch failures (`address` = the token) with whole-universe source failures (`address` = `'*'`), both under stage `'market'`. A consumer counting market errors per token over-counts during a provider outage.

---

## 5. The gates

`src/domain/scanner/gates.ts`. Two entry points over one policy object.

```ts
export function evaluateMarketGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult
export function evaluateGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult
```

```ts
export interface GateFailure {
  readonly gate: GateName
  /** 'unknown' when the gate failed closed on missing data. */
  readonly reason: 'failed' | 'unknown'
  readonly detail: string
}
```

The `reason` field exists for exactly one purpose: to keep "we checked and it is bad" separate from "we could not check" in the audit log. Both reject; they are not the same claim.

### 5.1 Free before paid — an optimisation of order, not of strictness

`evaluateMarketGates` is the subset decidable from the market snapshot alone — no network call. The source states the rule:

> Security costs one throttled request per token and the universe is larger than that budget, so what can be decided from the market snapshot alone is decided first. A token rejected here was rejected on the same rules it would have faced anyway — **this reorders the work, it does not soften it.**

That invariant is pinned by a dedicated test, `'never passes something the full gates would reject on market grounds'`: for a set of failing snapshots, **every gate name in the cheap failure list must also appear in the full one**.

Two gates deliberately do **not** appear in the cheap pass — `history` and `impact` — because both depend on data the free pass has not fetched (a candle count, a sell quote). If you add a new free gate, add it to both functions.

### 5.2 The complete gate table

`DEFAULT_GATE_POLICY`, in the exact order `evaluateGates` evaluates them:

| # | Gate | Threshold | Unknown → | Free pass? | Why |
|---|---|---|---|---|---|
| 1 | `denylist` | 7 Solana mints | n/a | ✅ | Stablecoins, wrapped natives and LSTs "are money, not a trade" |
| 2 | `impersonation` | symbol must match its canonical mint | n/a | ✅ | A token wearing a name it does not own |
| 3 | `marketCap` | `fdvUsd > 50,000,000` | **tolerated** | ✅ | "Above this a token is not the kind of asset CASCADE DCA was tuned for" |
| 4 | `impact` | `measuredImpactPct > 10%` | **tolerated** | ❌ | A pool with no way out is not a worse opportunity, it is not an opportunity |
| 5 | `honeypot` | `true` | **REJECT** | ❌ | Can this be sold at all |
| 6 | `mintAuthority` | active | **REJECT** | ❌ | Infinite mint |
| 7 | `freezeAuthority` | active | **REJECT** | ❌ | The dev can lock your tokens |
| 8 | `blacklist` | present | **REJECT** | ❌ | Contract can blacklist wallets / pause transfers |
| 9 | `transferTax` | `> 5%` | **REJECT** | ❌ | Tax trap |
| 10 | `lpLocked` | `< 80%` | **REJECT** (LP-token venues only) | ❌ | The dev can pull liquidity |
| 11 | `topHolders` | top-10 `> 40%` | **REJECT** | ❌ | Whale-heavy |
| 12 | `creatorShare` | `> 10%` | **tolerated** | ❌ | Informative; concentration already covers the dangerous case |
| 13 | `proxy` | `isProxy === true` **and** `chain === 'bsc'` | tolerated | ❌ | "An upgradeable proxy can change the rules after you buy" |
| 14 | `liquidity` | `< $20,000` | cannot be unknown | ✅ | |
| 15 | `age` | `< 24h` | **REJECT** | ✅ | The one market gate that fails closed |
| 16 | `history` | `< 250` closed 1H bars | **tolerated** | ❌ | "The indicators are not wrong, they are ABSENT" |
| 17 | `volume` | 24h `< $10,000` | cannot be unknown | ✅ | |
| 18 | `freefall` | `−50%` over 1h **or** 6h | **tolerated** | ✅ | An exit in progress, not an opportunity |

`evaluateMarketGates` runs gates 1, 2, 3, 14, 15, 17, 18 — in that order.

**The order of the failure list is itself pinned.** A rug that fails several gates reports all of them, and a test asserts the exact array:

```
['honeypot:failed', 'mintAuthority:failed', 'lpLocked:failed', 'topHolders:failed', 'liquidity:failed']
```

Reordering the checks inside `evaluateGates` breaks that test even when behaviour is unchanged.

### 5.3 Fail closed — and exactly where it stops

The safety gates treat a `null` as a rejection:

```ts
if (s.honeypot === null) failures.push(fail('honeypot', 'unknown', 'sell simulation unavailable'))
else if (s.honeypot) failures.push(fail('honeypot', 'failed', 'sell simulation failed'))
```

The same pattern for `mintAuthority`, `freezeAuthority`, `blacklist`, `transferTax`, `lpLocked`, `topHolders` — and, unusually for a market gate, `age`. The justification, from the file header: *the cost of a false negative here is a wallet full of something unsellable.*

**But not every gate fails closed, and the split is a deliberate argument**, stated most clearly on the `impact` gate:

> Fires only on a MEASURED value. An impact nobody quoted is unknown, and unknown cost is not evidence of a bad pool — unlike the safety gates, which fail closed because **unknown danger IS evidence**.

Fail-open gates: `impact`, `history`, `freefall`, `creatorShare`, `marketCap`, and `proxy`/`verifiedSource` outside BSC. The principle: safety gates guard against a rug, so silence is suspicious; the others guard against a bad entry, so rejecting on silence would reject on absence rather than on evidence. For `impact` and `history` there is a second, practical reason — rejecting on an unmeasured value would blind the scanner to every token the probe budget could not reach that cycle.

### 5.4 Thresholds are inclusive on the safe side

The comparisons are strict (`<`, `>`), never `<=` / `>=`, and a test pins it: a token sitting exactly on `minLiquidityUsd`, `minLpLockedPct`, `maxTopHoldersPct`, `maxTransferTaxPct` or `minHistoryBars` **passes**.

### 5.5 Denylist and impersonation — "not a trade at all"

`SOLANA_DENYLIST` holds seven mints: USDC, USDT, wSOL, mSOL, jitoSOL, stSOL, USD1.

`SOLANA_CANONICAL_SYMBOLS` maps **13 symbols onto 10 distinct mints** (SOL/WSOL share one, BTC/WBTC share one, ETH/WETH share one). A token wearing one of those names at any other address fails `impersonation`.

Matching is lenient by design:

```ts
const normaliseSymbol = (symbol: string): string => symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
```

> "usdc", " USDC ", "$USDC" and "USDC." all mean USDC to a victim.

Two incidents produced this gate, and the second produced its extension:

- **The fake USDC.** The first live scan proposed a "USDC" on Raydium with a **$96k pool and 39% of supply in ten wallets**.
- **The fake BTC.** With only `WBTC` in the map and not `BTC`, a **fifteen-day-old memecoin** at `E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx` wearing the ticker `BTC`, with a **$267k pool**, was scanned, ranked and **allocated** with not one blocker against it. Bitcoin and Ether have no native mint on Solana, so the wrapped tokens are the only things those names can honestly refer to — both unwrapped names now point at the same wrapped mints.

### 5.6 The LP-lock gate is *skipped*, never *passed*, on concentrated venues

`src/domain/scanner/lp-model.ts` answers one question: can an LP lock even exist on this venue?

| Model | Venues | Meaning |
|---|---|---|
| `lp-token` | Raydium AMM v4 / CPMM, PumpSwap, PancakeSwap | LP tokens exist; burned or locked means liquidity cannot be pulled |
| `concentrated` | Orca Whirlpools, Raydium CLMM, Meteora DLMM | positions are NFTs; **there is no LP token to lock** |

```ts
if (lpModelOf(snapshot.dexId, snapshot.dexLabels) === 'lp-token') {
  if (s.lpLockedPct === null) failures.push(fail('lpLocked', 'unknown', 'LP lock status unknown'))
  else if (s.lpLockedPct < policy.minLpLockedPct) { … }
}
```

The condition wraps **both** branches. On a concentrated venue, "unknown lock" is a category error, not a danger — the rug vector there is the provider withdrawing, which no lock prevents. The defenses are the liquidity gate at entry and the death watch's continuous liquidity monitoring (see the death-exit chapter).

And `lpModelOf(undefined)` returns `'lp-token'`: an **unrecognised venue must still prove its lock**.

Where the lock number comes from on Solana is itself worth knowing. Neither GoPlus nor Jupiter exposes LP holders for Solana pools, and the on-chain read is not built. `src/infrastructure/adapters/solana/lp-heuristics.ts` supplies one fact that is reliable by protocol design:

```ts
const PROTOCOL_BURNED_LP = new Set(['pumpswap', 'pumpfun'])
export function lpLockFromVenue(dexId: string | undefined): Partial<SecurityReport> {
  if (dexId && PROTOCOL_BURNED_LP.has(dexId.toLowerCase())) return { lpLockedPct: 100 }
  return {}
}
```

It is tagged a **heuristic** deliberately, so the audit log can show where the number came from, and it is merged **last** in trust order. Every other venue stays unknown and fails closed.

### 5.7 The impact gate — measured, not reported

```ts
const impact = snapshot.measuredImpactPct
if (impact !== null && impact !== undefined && impact > policy.maxReferenceImpactPct) {
  failures.push(fail('impact', 'failed', `a reference sell moves the price ${impact.toFixed(1)}% — there is no way out`))
}
```

Why 10%, from the policy comment: the score already penalises cost — `costEfficiency` reaches zero at a 6% round trip — **but a penalty only reorders a list**. Ten percent is already far beyond anything the 1%-per-fill and 3%-exit budgets could rescue, and "past it there is nothing to size down to, because the measurement was taken at the smallest size worth quoting."

The gap between reported and real depth is the whole point:

| Token | Reported liquidity | What a quote said | Effective depth |
|---|---|---|---|
| CREPE | $718,000 | 98% impact on a **$285** sell | ~$580 |
| HEV | $186,000 | 5.2% on a $100 sell | **$3,800** |
| EMBER | $517,000 | — | $1.0M |
| DREGG | $171,000 | — | $67k |
| SQUIRE | $125,000 | — | $14k |

(Effective depth inverts the model: `depth = 200 × usd / impact%`.)

One caveat that the gate cannot fix: `measuredImpactPct` is the impact of a **reference** sell — $100 in production — not of a real position. A pool can clear the 10% gate at reference size and still be untradeable at ladder size. That is exactly why the executor re-validates `MarketQuality` and `sizeLadder` caps nominal USD; see `06-economia.md`.

### 5.8 The history gate

`minHistoryBars: 250`, on **closed 1H candles**. From the policy comment: EMA-200 seeds at bar 199 and takes hundreds more to converge; the Bollinger basis needs 50. "Below this the indicators are not wrong, they are ABSENT — and a strategy with absent indicators does not trade, it guesses." See `02-indicadores.md` for the warmup semantics this depends on.

Pinned fixtures are the real ones: `historyBars: 38` and `historyBars: 105` both fail; 250 and 1000 pass; `null` and absent say nothing.

Note the unit mismatch worth being aware of: the gate counts 1H bars and is fed by `HistoryPort.historyBars(chain, poolAddress)`, which the runtime wires to `CachedHistory` over `GeckoTerminal` at `ONE_HOUR`, while production trades **15m** bars (`OPERADOR_TIMEFRAME=15m`). 250 1H bars is ~10.4 days of pool life; the bar count the strategy actually consumes at 15m is a different number. The gate is therefore a **pool-age proxy** more than a literal statement about the executor's own series.

---

## 6. The freefall gate — an entry gate, never an exit

```ts
function freefall(snapshot: TokenSnapshot, policy: GatePolicy): GateFailure | null {
  const windows = [['1h', snapshot.priceChangePct.h1], ['6h', snapshot.priceChangePct.h6]] as const
  for (const [label, change] of windows) {
    if (change === null || change >= -policy.maxFallPct) continue
    return fail('freefall', 'failed', `cayó ${Math.abs(change).toFixed(0)}% en ${label} — es una salida en curso, no una oportunidad`)
  }
  return null
}
```

### Why it is here and not in the death exit

This is the one place in the system where price is allowed to influence a decision, and the boundary is stated categorically in both the source and the test file:

> A death exit that reacts to price is a **stop loss under another name**, and the ladder's premise is that a drop is something to average into. Choosing what to ENTER on price is a different question, and the strategy already answers it — the classic gate is a drop from the swing high.

The death exit's guardrail — *price is never a death signal* — is enforced structurally in `src/domain/risk/death-exit.ts`, where `AssetHealthObservation` is typed so no price-shaped field can exist on it. The freefall gate does not weaken that: it decides what to **open**, on a token holding none of our money.

### Why 1h and 6h, and never 24h

The user's rule was "do not open on a token that has fallen more than half in about three hours". Providers report 1h, 6h and 24h — three sits between two of them, so the gate reads **both** rather than inventing the window it wants:

- half gone inside an hour is a **collapse**
- half gone over six hours is a **bleed**
- a token can crash within an hour and look calm over six, or bleed over six without any single hour looking alarming

24h is excluded on purpose: *half a day is not freefall, it is a bad day, and the strategy was built for bad days.* Pinned by a test where `h24: -80` passes cleanly.

### What it deliberately lets through

| Input | Verdict | Reason |
|---|---|---|
| `h1: -62` | `freefall:failed` | collapse |
| `h6: -55` | `freefall:failed` | bleed |
| `h1: -18, h6: -40, h24: -45` | **passes** | "that is what the ladder is for" — a gate rejecting this would be a stop loss applied before the position opens |
| `h24: -80`, short windows calm | **passes** | not freefall |
| all three `null` | **passes** | silence is not a crash |
| `h1: +220, h6: +340` | **passes** | not fooled by a rise |

### One Spanish string

`freefall`'s detail is the only Spanish string in the scanner domain, because gate details surface directly in the Spanish dashboard and alerts. Every other detail in the file is English. Do not "fix" it without checking the UI (see `01-vision-general.md` on the language split: interface Spanish, code and docs English).

---

## 7. Merging security opinions

`src/domain/scanner/security-merge.ts` folds several providers' partial reports into one `SecurityReport`, field by field, under three rules:

| Rule | Fields | Behaviour |
|---|---|---|
| `dangerWins` | `honeypot`, `mintAuthorityActive`, `freezeAuthorityActive`, `hasBlacklist`, `isProxy` | any source reporting `true` wins, **regardless of order** — "a rug only has to be caught once" |
| `firstKnown` | `transferTaxPct`, `lpLockedPct`, `topHoldersPct`, `creatorPct` | the first non-null value wins, so **sources must be passed in trust order** |
| inverted | `verifiedSource` | a safety *claim*, so a single `false` beats any `true` |

Trust order in `scan.ts` is fixed and the concurrency must not disturb it:

```ts
if (primary) opinions.push(primary)                                    // GoPlus
if (metadata.audit) opinions.push(metadata.audit)                      // Jupiter token audit
if (config.chain === 'solana') opinions.push(lpLockFromVenue(market.dexId))  // venue heuristic
```

Everything unknown stays unknown, so the gates still fail closed — pinned by its own test.

### A probe result beats any reported flag, in both directions

After the merge:

```ts
security = { ...security, honeypot: sellQuote === 'ok' ? false : sellQuote === 'unknown' ? security.honeypot : true }
```

Quoting a real sell is a **fact**; a vendor's `is_honeypot` is a third party's **opinion**. GoPlus does not even expose a honeypot flag for Solana (`GoPlus.fromSolana` returns `honeypot: null` unconditionally) — on that chain the sell quote is the only answer there is.

Crucially, `'unknown'` overrides nothing. An RPC or HTTP failure is inconclusive; a missing route is a death signal. Confusing the two would either liquidate a healthy position or hold a dead one. Both `'failed'` (no route) and `'implausible'` (pays less than half of `expectedUsd`) collapse to `honeypot: true`.

### The sell probe — one port, two chains

```ts
export interface SellProbePort {
  assessSell(token: string, amountRaw: bigint, decimals: number, expectedUsd: number): Promise<SellAssessment>
}
```

| Chain | Implementation | How impact is obtained |
|---|---|---|
| Solana | `Jupiter.assessSell` (lite-api, quote into USDC) | `priceImpactPct` returned directly (a fraction string, ×100) |
| BSC | `PancakeSwap.assessSell` (V2 router `getAmountsOut` via `eth_call`) | **measured**: quote 1/1000 of the order for the undisturbed price, quote the real order, take the difference |

PancakeSwap tries `[token, USDT]` first, then `[token, WBNB, USDT]`. Negative impact readings are clamped to zero ("noise between two quotes, not a gift"). No SDK: the ABI encoding for one function is forty lines of hex, and "pulling in ethers to encode a single call would be a dependency, a bundle and a supply chain for something shorter than its own import statement." Verified live against `bsc-dataseed.binance.org`: CAKE $2.3550 (1 hop), BUSD $0.9997, and a dead address returning **no route at all** — the shape of a honeypot.

Plausibility threshold: `maxShortfallPct = 50`. A consequence worth knowing — `expectedUsd` comes from `referenceUsd` and the DexScreener price, so a **stale or wrong price in the market snapshot produces a false honeypot verdict** and the gate rejects a healthy token.

### The decimals dependency, which once failed silently

The sell quote is sized in base units:

```ts
const amountRaw = BigInt(Math.floor((config.referenceUsd / market.priceUsd) * 10 ** decimals))
```

and `decimals === null` short-circuits the probe entirely. Jupiter's token list was originally used for both chains — and Jupiter is Solana-only, so it returned `null` for every BSC address. **BSC tokens were never honeypot-tested, and the PancakeSwap probe was written, wired and unreachable.** `Erc20Decimals` (selector `0x313ce567`) is the fix, and it refuses to default to 18: assuming 18 on a 6-decimal token sizes a probe a million times wrong, and a probe that large comes back looking exactly like a honeypot on a perfectly healthy pool.

---

## 8. The opportunity score

`src/domain/scanner/opportunity.ts`.

```ts
export function scoreOpportunity(
  snapshot: TokenSnapshot,
  policy: OpportunityPolicy,
  previous: TokenSnapshot | null = null,
  quality: MarketQuality | null = null,
): Opportunity
```

> **Note on a documentation drift:** `CLAUDE.md` and parts of the dashboard copy describe "five explainable components". The implementation has **six** — `costEfficiency` was added later (weight 0.2) and `OpportunityComponents` carries all six. This chapter documents the code.

### The six components

| Component | Weight | Formula | Scale constant |
|---|---|---|---|
| `volumeExpansion` | **0.30** | `clamp01((h1 / (h24/24)) / 3)`; `0` when `h24 === 0` | `fullExpansionRatio: 3` |
| `costEfficiency` | **0.20** | `quality === null ? 0.5 : clamp01(1 − 2(spreadPct + slippagePct)/6)` | `worstRoundTripPct: 6` |
| `buyPressure` | **0.15** | `clamp01((buyShare − 0.5) × 2)`; `buyShare = 0.5` when no trades | — |
| `volatility` | **0.15** | `clamp01((abs(h1) + abs(h6)/2) / 20)` | `fullVolatilityPct: 20` |
| `liquidityGrowth` | **0.10** | `clamp01((liq/prevLiq − 0.5) / 1)`; ratio `1` with no previous | — |
| `activity` | **0.10** | `clamp01((buys+sells)_1h / 60)` | `fullActivityTxnsPerHour: 60` |

```ts
return { score: (100 * weighted) / weightSum, components }
```

The score is **weight-normalised**, so weights are pure ratios and need not sum to 1. Pinned: a `{volumeExpansion: 1, everything else: 0}` policy scores exactly 100 on a tripling token.

### The reasoning behind the odd shapes

- **`buyPressure` is asymmetric on purpose.** Sellers dominating floors at 0 rather than going negative — pinned by `'sellers dominating scores no lower than neutral'`. The scanner is looking for **attention**, not predicting direction.
- **`volatility` uses the absolute move**, because the ladder needs drops as much as pumps to work. Pinned by `'a moving price scores higher than a flat one — the ladder needs drops to work'`.
- **Unmeasured cost is neutral, never generous.** `quality === null → 0.5`, "so a token is never rewarded for a toll nobody checked." Same principle for `liquidityGrowth` with no previous snapshot.
- **`costEfficiency` exists because of a measurement, not a theory.** The first capital-floor run saw the chain take **10% of gross on DREGG and 72% on TROLL** under the same strategy and the same budget. The venue's toll is a property *of the token*, and a ranking that ignores it ranks a trap alongside a bargain. `worstRoundTripPct: 6` scores zero because a full cycle pays the fill cost in and the exit cost out.

### What adding `costEfficiency` and `history` changed, on the same recorded market

| Token | bars | round trip | `costEfficiency` | score before | after | verdict |
|---|---|---|---|---|---|---|
| DREGG | 1000 | 0.95% | 0.84 | 61.9 | **68.7** | PASS |
| TROLL | 1000 | 1.59% | 0.73 | 43.2 | **47.9** | PASS |
| HEV | 38 | **11.62%** | 0.00 | 54.0 | 44.0 | **history** |
| EMBER | 105 | 1.59% | 0.73 | 34.2 | 38.8 | **history** |
| Leafy | 370 | 3.18% | 0.47 | 34.1 | 33.5 | PASS |

HEV ranked third before; it is now both penalised and rejected outright. DREGG — the cheapest token, and the one the paper run actually made money on — rose to the top.

### The floor nobody expects

A "quiet" token does not score zero. A steady, balanced, flat token with 20 trades in the hour and no measured quality scores about **28/100**:

```
volumeExpansion 1/3 ×0.30 = 0.100      (ratio 1 of 3 — steady is not zero)
buyPressure     0   ×0.15 = 0
liquidityGrowth 0.5 ×0.10 = 0.050      (no previous → ratio 1)
activity        1/3 ×0.10 = 0.033
volatility      0   ×0.15 = 0
costEfficiency  0.5 ×0.20 = 0.100      (unmeasured → neutral)
                            ─────
                score      = 28.3
```

`minScore` has to be tuned with that floor in mind. Production runs `minScore: 0` and lets `watchSlots` do the cutting; the dashboard uses `PRIME_SCORE = 45` to separate `prime` from `eligible`.

### Two hazards

- **All-zero weights divide by zero.** `weightSum === 0` yields `NaN`, which sorts unpredictably and silently fails `score < minScore`. There is no guard.
- **`liquidityGrowth` is dead weight in production.** `previous` is never supplied: `main.ts` calls `scanOnce(deps, config)` with two arguments, and `recall.ts` passes `new Map()` deliberately. Every token therefore scores exactly `0.5` on that component, contributing an identical 5 points and discriminating between nothing. `recall.ts` at least says why — "understating a token's momentum is the safe direction to be wrong in when spending from a shelf" — the live scan does it silently.

---

## 9. Ranking

`src/domain/scanner/ranking.ts`.

```ts
export function rankUniverse(
  universe: readonly TokenSnapshot[],
  previous: ReadonlyMap<string, TokenSnapshot>,
  quality: QualityLookup,
  policy: RankingPolicy,
): ScanResult
```

The pipeline, in a fixed and tested order:

1. **`evaluateGates` first, always.** A failure pushes into `rejected` with the full `GateResult` and `continue`s — a rejected token is **never scored**.
2. **Quality is measured before scoring**, not after: `const marketQuality = quality(snapshot)` — "because what the chain will take is part of how good the opportunity is, not a detail settled afterwards." This is precisely why `costEfficiency` is a scoring component and not a post-hoc filter.
3. **Score.**
4. **`minScore` cut** — and here the semantics matter: a token below the minimum is dropped **without** being added to `rejected`. Pinned as `'drops safe-but-boring tokens below the minimum score without calling them rejected'`. Passing every gate and being uninteresting is not the same verdict as being refused.
5. **Sort**, with a deterministic tie-break:
   ```ts
   candidates.sort((a, b) => b.opportunity.score - a.opportunity.score || a.snapshot.address.localeCompare(b.snapshot.address))
   ```
   Without the tie-break, the watch-slot cut would be arbitrary between equal-scoring tokens and the budget's provisional ordering would not be reproducible.
6. **Slice to `watchSlots`.**

### What a candidate carries

```ts
export interface Candidate {
  readonly snapshot: TokenSnapshot
  readonly opportunity: Opportunity
  readonly marketQuality: MarketQuality
}
```

`MarketQuality` is the contract between the two subsystems — liquidity, spread, slippage at a reference size, and when it was observed. **The executor re-validates it rather than trusting it**; `liquidityUsd` at entry also becomes the baseline the death watch's "liquidity collapse" signal compares against. See `06-economia.md`.

### `tokenKey`

```ts
export const tokenKey = (snapshot: TokenSnapshot): string => `${snapshot.chain}:${snapshot.address}`
```

The canonical identity used by every caller — the previous-snapshot lookup, the quality map, the held/blacklist sets, the dashboard's `id`.

### The `QualityLookup` is synchronous, and that is the point

```ts
export type QualityLookup = (snapshot: TokenSnapshot) => MarketQuality
```

The domain never fetches quality. That is what lets `recall.ts` re-rank the last stored scan offline in milliseconds, and it is also what forces `recall.ts` to pre-read the async security cache into a `Map` before calling `rankUniverse`.

**A hazard in `scan.ts`:** the lookup is handed in as `(s) => quality.get(tokenKey(s))!` — a non-null assertion. Tokens pushed as market-rejected or budget-skipped have **no** quality entry. It is safe only because they carry `UNKNOWN_SECURITY`, which fails the honeypot gate closed and short-circuits before the lookup ever runs. Any future softening of the fail-closed rule must fix that line in the same commit, or it becomes a `TypeError` inside `scoreOpportunity` (which guards `quality === null`, not `undefined`).

---

## 10. The security budget, and why it rotates

Each surviving token costs one throttled GoPlus request, one sell quote, one metadata call and one candle count — measured at roughly **nine seconds on Solana and six on BSC**. A cycle must finish well inside one 15-minute bar. Hence `maxSecurityChecks`, `OPERADOR_MAX_SECURITY_CHECKS`, default **20 per chain** ("20 keeps two chains around five minutes").

### Stage 3b — a cached report is an answer, not a pending state

```ts
const ttl = config.securityTtlMs ?? DEFAULT_SECURITY_TTL_MS   // 2 hours
if (known && scannedAt - known.measuredAt < ttl) remembered.set(market.address, known)
```

A remembered token becomes a **fully evaluated** snapshot — `securityChecked: true`, its cached `measuredImpactPct`, a full `MarketQuality` — at zero network cost. That is what frees the budget to reach further down the list. Pinned: `'a token with a fresh report stays fully evaluated, at no network cost'` asserts zero `token_security` calls on cycle 2 with all three tokens still candidates.

### Why two hours and not a day

From the `ScanConfig` docstring:

> the honeypot answer inside a report is the one that ages worst, and it is the one the whole thing rests on. A cached report is why a token stays **eligible** between checks; it is NOT why it gets **traded** — the sell path is re-confirmed before a position is opened.

That re-confirmation is `CycleDeps.confirmSellable`, called in the orchestrator immediately before each allocation, where `'unknown'` is explicitly not a yes. It is an **optional** dependency — absent, positions open on the scanner's verdict alone — so removing it from `main.ts` would silently re-open a two-hour-old honeypot verdict as grounds for committing capital, and nothing in `scan.ts` would notice.

### Stage 4 — rank before spending, with free information

```ts
const unexamined = affordable.filter((market) => !remembered.has(market.address))
const budget = config.maxSecurityChecks ?? unexamined.length
const ordered = budget >= unexamined.length
  ? unexamined
  : [...unexamined].sort((a, b) => provisionalScore(b, config) - provisionalScore(a, config))
```

> Taking the first N in discovery order would spend a throttled security call and a sell quote on whichever token a provider happened to list first — and **on a bounded budget, the order IS the choice.**

The test rig deliberately places the liveliest token in the *middle* of discovery order, so a first-N implementation would pick the dullest.

### The one line that makes the budget rotate

`unexamined = affordable − remembered` is the whole fix for a measured production failure. Without a memory, the provisional ordering is deterministic, so the budget was spent on **the same twenty tokens every fifteen minutes** while **106 tokens sat permanently `sin revisar`**. Pinned by `'spends the next cycle's budget on tokens nobody has looked at yet'`: the second cycle's checked set must not equal the first's.

### What the budget cannot reach is reported, not dropped

```ts
for (const market of ordered.slice(budget)) {
  snapshots.push({ ...market, security: UNKNOWN_SECURITY, historyBars: null, securityChecked: false })
}
```

It appears on the screen and in the stored scan; it simply cannot be a candidate, because the gates fail closed. `universe-view.ts` renders it as **`pending`**, never as `unsafe`.

### Stage 5 — three branches, one `Promise.all`

```ts
const [primary, metadata, historyBars] = await Promise.all([askGoPlus(), askMetadataProvider(), askHistory()])
```

Three providers, three independent rate limiters. Until the first real cycle measured it, three queues waited on each other for nothing: **16.8 seconds per token against a 15-minute bar**. A token now costs the **longest branch** rather than their sum (4.5s locally; still ~15s in CI). The sell quote is the one real dependency — it needs the decimals to size a $100 order — so it stays nested inside the metadata branch.

### `provisionalScore` — and how it differs from the real one

```ts
const provisionalScore = (market, config): number =>
  scoreOpportunity({ ...market, security: UNKNOWN_SECURITY, historyBars: null }, config.ranking.opportunity, null, {
    liquidityUsd: market.liquidityUsd,
    spreadPct: config.spreadPct,
    slippagePct: market.liquidityUsd > 0 ? estimatePriceImpactPct(config.referenceUsd, market.liquidityUsd) : 100,
    …
  }).score
```

Two things to know about it:

- It ranks on a **modelled** impact derived from **reported** liquidity — the exact number the rest of the system refuses to trust. So a deep-looking-but-concentrated pool (HEV: $186k reported, $3.8k real) outranks an honest one *for the purpose of deciding who gets examined*. It cannot make such a token a candidate — the real score and the `impact` gate both use the measurement — but it can spend the budget on it.
- It is called **inside the sort comparator**, so `scoreOpportunity` runs O(n log n) times instead of n. Pure and cheap, but at `maxTokens: 300` it is a real per-cycle cost, and the shape suggests memoisation was intended.

---

## 11. The caches that make a cycle fit inside a bar

Measured on the first cloud cycle: **GeckoTerminal was 80% of it** — 45 rate-limit rejections and 276 seconds of backoff, against GoPlus's zero hits and zero waiting. GeckoTerminal limits by IP, and a CI runner shares its address with thousands of unrelated jobs, so the quota is not ours to budget. The only winning move is to ask less.

| Cache | File | Window | Why it is correct |
|---|---|---|---|
| `CachedHistory` | `adapters/geckoterminal/cached-history.ts` | a **settled** count never expires; a short one expires after 6h | **A pool cannot lose candles.** Once it has enough history for the strategy it has enough forever; only a young pool grows. |
| `CachedDiscovery` | `adapters/geckoterminal/cached-discovery.ts` | 6h | "A pool younger than the window cannot clear the history gate anyway" — 250 bars is 2.6 days at 15m, so caching six hours **cannot lose a single token the scanner would have accepted**. |
| security cache | `StatePort.cachedSecurity` / `recordSecurity` | 2h | §10 |
| `JupiterTokens.cache` | in-process `Map` | process lifetime | seeded free by `discover()` |
| `Erc20Decimals` | in-process | process lifetime | "A token cannot change its decimals, so one answer lasts the process." |

**A failed measurement is never cached** — stated three separate times, and the same rule each time:

- `CachedHistory`: "Writing null here would turn one rate-limited request into a permanent *this pool has no history*."
- `CachedDiscovery`: an empty list is never recorded, and on a throw it falls back to the stale shelf, because *an old universe beats no universe*.
- `Erc20Decimals`: only real answers are cached.

Measured, cold cycle against warm, same chain, same 20 tokens:

| | Cold | Warm |
|---|---|---|
| GeckoTerminal rejections | 50 | **21** |
| Time backing off | 304s | **116s** |
| Scan | 384s | **177s** |

One derivation to keep in mind: `CachedDiscovery`'s six-hour window is justified *by the history gate*, not by market speed. If `minHistoryBars` or the bar size ever drops, that argument expires with it and the window must be re-derived.

### Rate-limit reporting

`GoPlus.rateLimit` and `GeckoTerminal.rateLimit` are `{ hits, waitedMs }` counters. `main.ts` snapshots both **before each chain** and logs the delta after, because the counters live on adapters shared by every chain: reporting them raw labelled the second chain with the first one's total, and **a diagnostic that misleads is worse than none** — the first version printed 556 seconds of waiting inside a 356-second scan.

A remaining blind spot: `waitedMs` counts **backoff only**, not polite spacing. GoPlus's 2s minimum interval and GeckoTerminal's 2.5s shared throttle are invisible, so a scan that is slow purely from spacing reports `hits=0 waitedMs=0` and looks like slow code. Jupiter, JupiterTokens and PancakeSwap have no counters at all.

### Throttles, as configured

| Adapter | Spacing | Retries | Backoff |
|---|---|---|---|
| GoPlus | 2000ms internal (1.3s "still drew 4029s on a 55-token pass") | 2 | 5000ms doubling |
| GeckoTerminal | 2500ms shared Throttle | 3 | 4000ms doubling (worst case ~28s on one call) |
| Jupiter + JupiterTokens | 1100ms shared | — | — |
| PancakeSwap | 250ms | — | — |

GoPlus signals rate limiting as **HTTP 429 *or* a 200 body with `code: 4029`**. Only `fetchOne` knows that; anything reading GoPlus responses without going through it will read a 4029 as a successful envelope.

---

## 12. The three consumers of the scanner domain

Because gates, scoring and ranking are pure, three different callers re-run them.

### `scanOnce` — the live pass

`src/application/scan.ts`. Everything above. Output:

```ts
export interface ScanOutcome extends ScanResult {
  readonly snapshots: readonly TokenSnapshot[]   // ALL of them, rejects and unchecked included
  readonly errors: readonly ScanError[]
  readonly scannedAt: number
}
```

`main.ts` loops `config.chains`, saves each chain's scan under its own chain, and finally sorts candidates **across** chains — slots are scarce and the best opportunity should win wherever it lives. One chain throwing is caught and logged; the others still run.

Scans are stored **per chain** (`latestScansByChain()`) because a single newest row meant scanning BSC made every Solana token vanish from the screen, which looks exactly like the scanner having stopped finding them. The reported scan time is the **oldest** of them: a universe is only as fresh as its stalest half.

### `buildUniverse` — the dashboard read model

`src/application/universe-view.ts` re-runs `evaluateGates` + `scoreOpportunity` over stored snapshots, because storing a second, prettier version of those decisions would be a second place for them to be wrong. It adds a tier, a magnitude and a reason.

```ts
const SAFETY_GATES = new Set(['honeypot','mintAuthority','freezeAuthority','blacklist','transferTax','lpLocked','topHolders','creatorShare','proxy','impersonation'])
const PRIME_SCORE = 45
```

Seven tiers: `held`, `prime`, `eligible`, `pending`, `filtered`, `unsafe`, `dead`.

The tiering logic exists because of the `insegura 219, filtrada 6` bug. An unexamined token has an all-null report and the gates fail closed, so a naive reading calls every thin pool a dodged bullet. Three rules fix it, and all three live here rather than in the gates:

1. `SAFETY_GATES` separates "this could hurt you" from "not interesting".
2. Security blockers are **filtered out of the displayed reasons** when `securityChecked === false` — measured, **180 of 185 filtered tokens led with security blockers that were true and useless**.
3. A token that is unexamined **and** failed a market gate becomes `filtered`, not `pending`, because it will never be examined.

Note that `buildUniverse` falls back to `estimatePriceImpactPct(100, reportedLiquidity)` when nothing was measured, and the file says so explicitly: that is the **optimistic** half of the pair, the one that said $718,000 about CREPE. It is a display estimate; the executor still measures.

A position is also never invisible: held tokens missing from the latest scan are drawn from the position's own record, with blockers saying the scanner did not see them — because an empty blockers list reads as "checked and fine", which is the one thing nobody checked.

### `recallCandidates` — the offline twin

`src/application/recall.ts` re-runs stage 6 over `latestScansByChain()` with **no network at all**, reading measured impact out of the same security cache `scan.ts` writes. It exists because opening a position was fused to *running* a scan, so a free slot waited out half an hour of throttled discovery with candidates already examined, already stored, already good.

Two things keep it honest: **measured impact, never reported TVL**; and **staleness is refused, not ignored** — past `maxAgeMs` (production: twice the scan interval) it returns `null` rather than something old.

One consequence to remember: a recalled candidate scores **lower** than the same token did during the live scan, because `previous` is an empty map. Understating momentum is the safe direction to be wrong in when spending from a shelf.

---

## 13. Production configuration

| Setting | Value | Where |
|---|---|---|
| `maxTokens` | 300 | `main.ts` (literal) |
| `maxSecurityChecks` | 20 per chain | `OPERADOR_MAX_SECURITY_CHECKS`, default 20 |
| `referenceUsd` | $100 | `main.ts` (literal) |
| `spreadPct` | 0.3% | `main.ts` (literal) |
| `securityTtlMs` | 2h | `DEFAULT_SECURITY_TTL_MS` |
| `minScore` | 0 | `main.ts` |
| `watchSlots` | `config.maxPositions` (scan) / `maxPositions > 0 ? maxPositions : 50` (recall) | `main.ts` — see §14 |
| chains | `solana,bsc` in CI; `solana` in docker-compose; **`solana` is the code default** | `OPERADOR_CHAIN` |
| scan interval | 1h | `OPERADOR_SCAN_MS` |
| gate policy | `DEFAULT_GATE_POLICY` unmodified | `main.ts` |
| opportunity policy | `DEFAULT_OPPORTUNITY_POLICY` unmodified | `main.ts` |

Smoke tests hit real APIs and are skipped unless asked:

```bash
OPERADOR_SMOKE=1 npx vitest run src/application/scan.smoke.test.ts
```

`scan.smoke.test.ts` runs `maxTokens: 60` with a 300s timeout and prints a gate tally per `${gate}:${reason}`; it describes itself as "not a parity check — a look". `collect-dataset.smoke.test.ts` uses `scanOnce` at `maxTokens: 300` to record `tools/golden/solana-dataset.json`, the fixture the capital-floor analysis replays offline — separated from the analysis because "an experiment you can only run by waiting on rate limits is an experiment you will not re-run".

---

## 14. Known gaps, discrepancies and hazards

Stated plainly rather than smoothed over.

1. **`watchSlots: 0` silently empties a full scan.** `main.ts` passes `watchSlots: config.maxPositions` to `scanOnce`, while the recall path guards it (`config.maxPositions > 0 ? config.maxPositions : 50`). `OPERADOR_MAX_POSITIONS` defaults to `0`, and `0` means *uncapped* everywhere else (`config.ts`, `orchestrator`'s `maxPositions <= 0` check). The GitHub Actions workflow sets it to `'0'` explicitly. `rankUniverse` ends with `candidates.slice(0, policy.watchSlots)`, so with that configuration a **`full` pass returns zero candidates** and the orchestrator emits `🔍 Nada pasó los filtros` — while a `watch` pass through `recall` works normally. This looks like an oversight in the scan branch, not an intended asymmetry. **Unverified against a live run; flagged from the code.**
2. **The history gate does not fire on cache-hit tokens.** The remembered path builds its snapshot with `historyBars: null`, and `CachedSecurity` stores only `{ security, slippagePct, measuredAt }`. For up to two hours a token can be a candidate with its bar count never consulted, even though `CachedHistory` would answer for free.
3. **`liquidityGrowth` is inert in production** (§8). Weight 0.1 is spent on a constant.
4. **All-zero opportunity weights produce `NaN`** with no guard (§8).
5. **`previous` is dead API surface.** `scanOnce`'s third parameter is exercised only by tests.
6. **The `OPERADOR_CHAIN` default disagrees with the docs.** `config.ts` defaults to `'solana'`; `CLAUDE.md` says `solana,bsc`. CI sets `solana,bsc` explicitly, docker-compose sets `solana`.
7. **"Five components" vs six** (§8) — documentation drift, not a code defect.
8. **Stage 3b awaits `cachedSecurity` sequentially**, once per affordable token — up to 300 serial round trips to Postgres before any network work starts, invisible in the progress stream, which jumps from `market` straight to `budget`.
9. **The TTL check treats clock skew as freshness.** `scannedAt - known.measuredAt < ttl` is satisfied forever by a `measuredAt` in the future, which two engine instances with skewed clocks can produce.
10. **`impact` is evaluated under the comment header "Critical security facts: unknown is a failure"**, but it deliberately fails *open*. The code is right and the header is misleading.
11. **Two section comments in `scan.ts` are both numbered `4`** (the budget block and the final rank block). Cosmetic, but it makes "stage 4" ambiguous in conversation.
12. **The DexScreener universe call is unguarded** (§3), unlike the other two sources.
13. **A stale price produces a false honeypot** (§7), because `expectedUsd` is derived from the market snapshot's `priceUsd`.
14. **The LP-lock number on Solana is a venue heuristic, not an on-chain read.** The real check — LP mint supply against burned and locked balances, per DEX layout — is not built. Everything outside `pumpswap`/`pumpfun` stays unknown and fails closed, which is the safe direction, but it also means the gate rejects honest Raydium pools for want of data rather than for evidence.
15. **The opportunity score has never been tuned against recorded outcomes.** It says so itself. The weights are policy, the scales are guesses that survived a few live scans, and the only component with a measurement behind it is `costEfficiency`.
