# Adapters and the outside world

This chapter documents the outer ring of the hexagon: every line of code in Operador that touches a network. Six providers, one JSON-RPC chain call, one shared HTTP seam, two cache decorators and one pure heuristic — their exact endpoints, the shapes they return, how each one fails and what that failure is allowed to mean downstream. It also covers the sell probe as a single port with one implementation per chain, the hand-written ABI encoding that makes the BSC half of it possible without an SDK, and the rate-limit story: what was measured, what actually caused it, and the two caches that fixed it along with the arguments that make them correct rather than merely convenient. For what the domain does with these shapes see `04-escaner.md` (gates, scoring, ranking) and `05-riesgo.md` (the death exit); for where the cached rows live see `09-persistencia.md`.

---

## 1. What this layer is, and what it is forbidden to be

The rule from the charter is short: **domain has zero imports from `infrastructure/`**, and clock, randomness and network are injected, never called in domain code. The adapters are the other side of that rule.

Three properties hold across every file in `src/infrastructure/adapters/`:

1. **No adapter contains a trading rule.** They translate. Nothing here decides whether a token is safe, whether a position should be frozen, or how big an order should be. The nearest thing to a judgement is the four-way classification of a sell quote (§7), and even that is a statement about the quote, not about the position.
2. **No adapter constructs its own I/O.** Every one takes an injected `HttpGet` (or, on BSC, an injected `EthCall`), and most take an injected `Throttle`, clock or `sleep`. That is why every adapter test in the repo runs on recorded responses through `stubHttp` and never opens a socket.
3. **"I could not find out" never reaches the domain disguised as "the answer is no."** This is the single most load-bearing property in the layer and it recurs in every section below: an unknown security fact stays `null`, an RPC outage is `unknown` rather than `failed`, a rate-limited measurement is not written to a cache, and an empty discovery list is not remembered.

Everything in this layer ultimately produces one of four shapes:

| Shape | Defined in | Produced by |
|---|---|---|
| `MarketSnapshot` = `Omit<TokenSnapshot, 'security'>` | `src/domain/scanner/snapshot.ts` | DexScreener |
| `SecurityReport` (and `Partial<SecurityReport>`) | `src/domain/scanner/snapshot.ts` | GoPlus, `JupiterTokens.security`, `lpLockFromVenue` |
| `SellAssessment { sellQuote, priceImpactPct }` | `src/infrastructure/adapters/jupiter/jupiter.ts` | Jupiter, PancakeSwap |
| `Candles` (oldest-first, ms timestamps) | `src/application/replay.ts` | GeckoTerminal |

Nothing flows the other way. No adapter imports from `domain/strategy` or `domain/risk` except for the `SellQuoteResult` and `SecurityReport` *types*.

---

## 2. The HTTP seam — `src/infrastructure/http.ts`

Ninety-two lines, no adapter logic, and every adapter depends on it.

### 2.1 The port

```ts
export type HttpGet = (url: string, init?: { readonly headers?: Record<string, string> }) => Promise<HttpResponse>

export interface HttpResponse {
  readonly status: number
  readonly json: () => Promise<unknown>
}
```

`HttpError(url, status, message = `HTTP ${status} for ${url}`)` carries `name = 'HttpError'`, which is what the tests assert on.

### 2.2 `makeHttpGet` — the only place `fetch` is called

```ts
export const makeHttpGet = (options: HttpOptions = {}): HttpGet
```

| Option | Default | In production |
|---|---|---|
| `timeoutMs` | `10_000` | `20_000` (`main.ts`) |
| `userAgent` | `'operador-by-open-doors/0.1'` | default |

A hard `AbortController` timeout, `accept: application/json` plus the user agent by default, caller headers merged last. Then the one decision that matters:

```ts
const text = await response.text()
let parsed: unknown
try { parsed = JSON.parse(text) } catch { parsed = { error: text.slice(0, 200) } }
```

**A non-JSON body never becomes a `SyntaxError` inside an adapter.** APIs under rate limit answer with plain text (`Rate limit`), and a parse throw deep inside a quote path is indistinguishable from a real outage — the caller would have to catch a `SyntaxError` to tell "the provider is rationing us" from "the provider is gone". Instead the body arrives as `{ error: "<first 200 chars>" }` and every adapter's normal error handling applies. `src/infrastructure/adapters/jupiter/jupiter.test.ts` pins the consequence by name: *"a plain-text rate-limit body is unknown, not a crash"*.

`makeHttpGet` itself has **no unit test**. It is the one function in the file that touches global `fetch`, and the tests cover the throttle instead. Stated here because it is a real gap, not an oversight to be discovered later.

### 2.3 `makeThrottle` — minimum spacing, shared per provider

```ts
export const makeThrottle = (
  minIntervalMs: number,
  sleep: (ms: number) => Promise<void> = …,
  now: () => number = Date.now,
): Throttle
```

`wait()` sleeps for `lastAt + minIntervalMs - now()` when that is positive, then stamps `lastAt = now()`. Work done between calls counts against the interval — `src/infrastructure/http.test.ts` pins exactly that: with a 1 000 ms interval, three calls and 400 ms of work between the second and third, the recorded sleeps are `[1000, 600]`, and a 5 000 ms gap produces no sleep at all.

`NO_THROTTLE` is the no-op default for every adapter that takes one, so a test never waits.

The throttle is deliberately *shared by provider, not by adapter*: `Jupiter` and `JupiterTokens` both talk to `lite-api.jup.ag`, so `main.ts` hands them the same `makeThrottle(1_100)` instance and their two queues become one.

### 2.4 `stubHttp` — the test transport, and its one trap

```ts
export const stubHttp = (table: Record<string, { status?: number; body: unknown }>): HttpGet & { readonly calls: string[] }
```

It records every URL in `.calls` and answers from the first table entry whose key is a **prefix** of the requested URL, found with `Object.entries(table).find(...)`. So **insertion order decides**. Tests exploit this routinely — `{ [GOPLUS_BASE]: … }` matches every GoPlus URL in one line — but the consequence is that a more specific prefix declared *after* a broader one is unreachable. An unmatched URL returns `{ status: 404, body: { error: 'no stub for <url>' } }` rather than throwing, so a mis-stubbed test fails on the adapter's own error path instead of an exception.

---

## 3. The roster at a glance

| Adapter | File | Provider / base | Key | Throttle wired in `main.ts` | Returns | Failure |
|---|---|---|---|---|---|---|
| `DexScreener` | `adapters/dexscreener/dexscreener.ts` | `https://api.dexscreener.com` | none | **none** | `MarketSnapshot[]`, `DexPair[]`, `string[]` | throws `HttpError` on any non-200 |
| `GoPlus` | `adapters/goplus/goplus.ts` | `https://api.gopluslabs.io/api/v1` | none | **private**, 2 000 ms | `SecurityReport \| null` | throws `HttpError`; `null` = never seen |
| `GeckoTerminal` | `adapters/geckoterminal/geckoterminal.ts` | `https://api.geckoterminal.com/api/v2` | none | shared, 2 500 ms | `Candles`, pools, bar count | throws `HttpError`; `historyBars` swallows → `null`; `discoverPools` swallows per page |
| `Jupiter` | `adapters/jupiter/jupiter.ts` | `https://lite-api.jup.ag` | none | shared, 1 100 ms | `QuoteResult \| QuoteFailure`, `SellAssessment` | never throws; typed failure |
| `JupiterTokens` | `adapters/jupiter/jupiter-tokens.ts` | same base | none | **same instance**, 1 100 ms | `JupiterTokenInfo \| null`, decimals, `Partial<SecurityReport>` | `null` on non-200 |
| `PancakeSwap` | `adapters/pancakeswap/pancakeswap.ts` | BSC JSON-RPC, default `https://bsc-dataseed.binance.org` | none | 250 ms | `PancakeQuote \| PancakeFailure`, `SellAssessment` | never throws; typed failure |
| `Erc20Decimals` | `adapters/pancakeswap/erc20-decimals.ts` | same RPC | none | **none** | `number \| null` | `null` on anything unreadable |
| `lpLockFromVenue` | `adapters/solana/lp-heuristics.ts` | — (pure) | — | — | `Partial<SecurityReport>` | cannot fail |
| `CachedHistory` | `adapters/geckoterminal/cached-history.ts` | decorator over GeckoTerminal | — | — | `number \| null` | never writes a failure |
| `CachedDiscovery` | `adapters/geckoterminal/cached-discovery.ts` | decorator over GeckoTerminal | — | — | `DiscoveredPool[]` | falls back to a stale shelf |

Two entries in that table are worth reading twice. **DexScreener has no throttle at all** — the class does not even accept one — and **`Erc20Decimals` shares none either**, because `main.ts` hands it the bare `bscRpc` while the 250 ms throttle lives inside the `PancakeSwap` instance. Both are defensible (DexScreener's published limits are generous, a public BSC RPC is cheap) but neither is enforced in code, and neither is counted.

The composition root is `src/runtime/main.ts:buildRuntime`, lines ~57–120. It is the only file that knows both halves.

---

## 4. DexScreener — the universe and every market number

`src/infrastructure/adapters/dexscreener/dexscreener.ts`. Public REST, no key. Published limits (Sept 2026, recorded in the file header): **300 req/min** for pair, token and search; **60 req/min** for profiles and boosts.

### 4.1 Endpoints

| Method | Endpoint | Notes |
|---|---|---|
| `tokenPairs(chain, tokenAddress)` | `/token-pairs/v1/{chain}/{token}` | every pair for a token |
| `tokens(chain, addresses)` | `/tokens/v1/{chain}/{a,b,c…}` | **max 30 addresses**, throws above it |
| `search(query)` | `/latest/dex/search?q=…` | returns `body.pairs ?? []` |
| `discoverTokens(chain)` | `/token-profiles/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1` | three calls, deduped, filtered to the chain |

`tokens` refuses rather than chunking:

```ts
if (tokenAddresses.length > 30) throw new Error('DexScreener.tokens: max 30 addresses per call')
```

`scanOnce` does the batching itself in steps of 30. A future caller that forgets loses the whole batch to an exception — which `scanOnce` records as a per-address `market` error for all 30.

`discoverTokens` hits the **60 req/min** endpoints three times per chain per scan, and it is the one universe source in `scanOnce` **not** wrapped in a try/catch: the Jupiter list and the GeckoTerminal pool list each get one, while `for (const address of await deps.dex.discoverTokens(config.chain))` runs bare. A DexScreener discovery failure therefore aborts that chain's entire scan (caught one level up, per chain, in `main.ts`).

### 4.2 The mapping — `toMarketSnapshot`

| `MarketSnapshot` field | From | Missing-value rule |
|---|---|---|
| `chain` | the caller | — |
| `address`, `symbol` | `baseToken.address`, `baseToken.symbol` | — |
| `pairAddress`, `dexId` | `pairAddress`, `dexId` | — |
| `dexLabels` | `labels` | `?? []` |
| `observedAt` | **the adapter's injected clock**, `this.now()` | never from the response |
| `priceUsd` | `Number(pair.priceUsd)` | — |
| `liquidityUsd` | `liquidity.usd` | `?? 0` |
| `fdvUsd` | `fdv` | `?? null` |
| `volumeUsd.{h1,h6,h24}` | `volume.*` | `?? 0` each |
| `priceChangePct.{h1,h6,h24}` | `priceChange.*` | `?? null` each |
| `txns.{h1,h24}` | `txns[window]` | `?? { buys: 0, sells: 0 }` |
| `pairCreatedAt` | `pairCreatedAt` | `?? null` |

The zero/null split is deliberate and matches what the gates expect: a missing **volume** is legitimately zero activity, a missing **price change** is the provider saying nothing, and the gates treat those differently (see `04-escaner.md`).

`observedAt` coming from the adapter's clock rather than the payload is a trap worth naming: construct `DexScreener` with a frozen clock — as every test does — and every snapshot claims the same observation time, so any staleness check downstream is vacuous.

### 4.3 The deepest pool wins

```ts
if (pair.chainId !== chainIdOf[chain]) continue
if (pair.priceUsd === null || pair.liquidity?.usd == null) continue
if (!current || (pair.liquidity.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(pair.baseToken.address, pair)
```

One pair per `baseToken.address`, the deepest, "because that is where the executor would trade and where liquidity-based gates should look". Pairs on another chain and pairs with no price or no reported liquidity are dropped outright — they cannot be sized against and cannot be gated.

This single choice determines `pairAddress`, which is what the engine later asks for candles and what the history cache is keyed by (§9.3).

---

## 5. GoPlus — token security, two chains, two completely different shapes

`src/infrastructure/adapters/goplus/goplus.ts`. Public endpoints, answered without a token in Sept 2026 on both chains.

| Chain | URL |
|---|---|
| Solana | `/solana/token_security?contract_addresses={address}` |
| BSC | `/token_security/56?contract_addresses={address}` |

The envelope is `{ code, message, result: Record<address, token> }`. `fetchOne` throws `HttpError` when `status !== 200` **and** when `code !== 1` (message included in the error), and returns `null` when the result object has no entry for the address — which is "GoPlus has never seen this token", not an error.

```ts
return result[address] ?? result[address.toLowerCase()] ?? null
```

**EVM results are keyed by lowercase address.** Drop that fallback and every checksummed BSC address returns `null`, which reads as "never seen", produces an all-null report, and fails every safety gate closed — a silent, universe-wide rejection of BSC that would look exactly like BSC having no safe tokens.

### 5.1 The two primitives

```ts
const flag = (v: Flag): boolean | null => (v === '1' ? true : v === '0' ? false : null)
const fractionPct = (v: string | null | undefined): number | null => { … Number.isFinite(n) ? n * 100 : null }
```

**GoPlus percentages are FRACTION strings.** `"0.0883"` means 8.83%, not 0.0883% — confirmed live, and contrary to the docs. Getting this wrong by 100× in either direction makes the holder-concentration gate either a no-op or a total blocker.

`flag` is the mechanical expression of fail-closed: anything that is not the string `'0'` or `'1'` — `null`, `undefined`, a number, a new enum value the provider adds next year — becomes `null`, and the gates fail closed on `null`. There is no default anywhere in this file.

### 5.2 Solana mapping — `GoPlus.fromSolana`

| `SecurityReport` field | Source | Rule |
|---|---|---|
| `honeypot` | — | **always `null`** — Solana has no honeypot flag here; the Jupiter sell quote fills it in |
| `mintAuthorityActive` | `mintable.status` | `flag()` |
| `freezeAuthorityActive` | `freezable.status` | `flag()` |
| `transferTaxPct` | `transfer_fee.current_fee_rate.fee_rate` | `transfer_fee === undefined` → `null`; extension present with no rate → `0`; else fraction × 100 |
| `hasBlacklist` | `balance_mutable_authority.status`, `closable.status`, `non_transferable` | OR of the trues; `null` only when **all three** are unknown |
| `lpLockedPct` | `lp_holders[]` | `lockedShare` |
| `topHoldersPct` | `holders[]` | `topShare` |
| `creatorPct` | — | `null` — GoPlus lists creator *addresses*, not their share |
| `verifiedSource`, `isProxy` | — | `null` |

Two details in that table are easy to get wrong and both are pinned by tests. The transfer-fee rule distinguishes **"no Token-2022 fee extension at all"** (`undefined` → `null`) from **"an extension that currently charges nothing"** (`0`), because GoPlus returns an empty object for plain SPL tokens and conflating the two would either report a phantom tax or hide a real one. And the Solana key is **`non_transferable`**, not the docs' `none_transferable` — a typo there silently drops one of the three inputs to `hasBlacklist` without any error.

The blacklist fold is stated in the source: "Any authority a developer keeps that can interfere with holders' funds counts as a blacklist-class power on Solana."

### 5.3 EVM mapping — `GoPlus.fromEvm`

| `SecurityReport` field | Source | Rule |
|---|---|---|
| `honeypot` | `is_honeypot` | `flag()` — an opinion, later overridden by the probe (§7.5) |
| `mintAuthorityActive` | `is_mintable` | `flag()` |
| `freezeAuthorityActive` | — | **hardcoded `false`** |
| `transferTaxPct` | `buy_tax`, `sell_tax` | `Math.max(buy ?? 0, sell ?? 0)`, `null` only when both are null |
| `hasBlacklist` | `is_blacklisted`, `transfer_pausable`, `cannot_sell_all` | OR of the trues; `null` only when all three unknown |
| `lpLockedPct` | `lp_holders[]` | `lockedShare` |
| `topHoldersPct` | `holders[]` | `topShare` |
| `creatorPct` | `creator_percent` | fraction × 100 |
| `verifiedSource` | `is_open_source` | `flag()` |
| `isProxy` | `is_proxy` | `flag()` |

`freezeAuthorityActive: false` is the one hardcoded non-null in the layer, and the comment gives the reason: *"no such primitive on EVM; pausable is folded into hasBlacklist"*. A `null` there would fail the freeze-authority gate closed on **every** BSC token forever; `false` is the truthful answer for a chain that has no such concept. Transfer tax takes the **worse** of buy and sell, because the position has to pay both.

### 5.4 The two aggregations

`lockedShare(lp)` — `null` when there is no LP data at all, otherwise the summed `percent` of every LP holder that is locked or burned:

```ts
const burned = /burn|dead/i.test(holder.tag ?? '')
  || /^0x0{36}dead$/i.test(holder.address ?? '')
  || /^1{20,}$/.test(holder.token_account ?? '')
if (holder.is_locked === 1 || burned) locked += share
```

`topShare(holders)` — `null` when there are no holders, otherwise the summed `percent` of the **first ten**, skipping burn tags and the EVM dead address.

The asymmetry is the point: **a burn address is excluded from concentration but counted toward LP lock.** Burned supply is not a wallet that can dump; burned LP is liquidity that cannot be pulled. Same address, opposite meanings, and conflating them would either invent a whale or erase a lock.

**A documented discrepancy:** `topShare`'s docstring says it ignores "burn addresses and locked (vesting) balances", but the implementation only skips burned ones — `is_locked` is declared on the holder type and never read in `topShare`. The effect is that vesting balances count toward concentration, so the gate is *stricter* than the comment promises. The comment is wrong, not the code, but a reader trusting the comment will mis-predict the gate.

### 5.5 Throttle, backoff and counters

GoPlus carries its **own private throttle** rather than taking a shared one, because its quota is per-account rather than per-endpoint:

| Option | Default | Evidence |
|---|---|---|
| `minIntervalMs` | `2_000` | *"1.3s spacing still drew 4029s on a 55-token pass; 2s with a 5s backoff holds."* |
| `maxRetries` | `2` | |
| `backoffMs` | `5_000` | doubling → 5 s, then 10 s |

`RATE_LIMITED = 4029` is an **envelope code returned with HTTP 200**, so the limit check is `response.status === 429 || body?.code === RATE_LIMITED`. Miss the second half and a rate limit reads as a successful empty response.

The backoff sleep is added **on top of** the spacing wait — `throttle()` runs at the head of every attempt — so one unlucky token costs up to `2 s + 5 s + 2 s + 10 s + 2 s ≈ 21 s` with the defaults before the `HttpError` finally escapes and the scan records that token as unchecked, which fails its gates closed.

```ts
readonly rateLimit = { hits: 0, waitedMs: 0 }
```

See §9 for what that counter was for.

---

## 6. GeckoTerminal — candles, the chain-agnostic universe, and the bar count

`src/infrastructure/adapters/geckoterminal/geckoterminal.ts`. Public API, no key. Docs put the free limit near 30 requests/minute; reality is stricter and is the subject of §9.

### 6.1 `candles` — two shape traps and one poisoning guard

```ts
async candles(chain, poolAddress, size: BarSize = ONE_HOUR, limit = 1000, beforeSeconds?): Promise<Candles>
```

`GET /networks/{network}/pools/{pool}/ohlcv/{timeframe}?limit=…[&aggregate=…][&before_timestamp=…]` → `data.attributes.ohlcv_list = [[unixSeconds, o, h, l, c, volumeUsd], …]`.

Three transformations happen in the parse loop, and every one of them is a trap for anyone who bypasses this method:

1. **Rows come newest first.** The loop walks `rows.length - 1` down to `0`. The rest of the codebase is oldest-first; a copied parse gives a time series running backwards, in which every indicator computes and none of them means anything.
2. **Timestamps are in seconds.** `time.push(seconds * 1000)`. Off by a factor of 1 000 otherwise.
3. **A zero-price row is dropped**, not zero-filled: `if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue`. The comment states the reason — *"a candle with no price is not a candle; dropping it beats poisoning every windowed indicator downstream"*. One zero close poisons EMA-200, the Bollinger basis and Supertrend for their entire window (see `02-indicadores.md`).

Rows shorter than six elements are skipped; `volume` falls back to `0`.

### 6.2 Bar sizes

```ts
export const ONE_HOUR: BarSize = { timeframe: 'hour' }
export const FIFTEEN_MINUTES: BarSize = { timeframe: 'minute', aggregate: 15 }
export const barSizeMs = (size) => ({ minute: 60_000, hour: 3_600_000, day: 86_400_000 })[size.timeframe] * (size.aggregate ?? 1)
```

`aggregate` is only sent when present, and the test pins both directions (`/ohlcv/minute?…aggregate=15` versus `/ohlcv/hour?` with no `aggregate` parameter at all). One page of 1 000 candles reaches **~41 days at 1H** and **~10.4 days at 15m**; the 250-bar history gate is **10.4 days at 1H** and **2.6 days at 15m**, both asserted with `toBeCloseTo(…, 1)`.

### 6.3 `discoverPools` — the universe that works on any chain

```ts
async discoverPools(chain: Chain, pages = 5): Promise<{ tokenAddress: string; poolAddress: string }[]>
```

Two lists, `trending_pools` and `pools`, five pages each — **ten throttled calls per chain**. The base token address is extracted from the relationship id by stripping the network prefix (`"bsc_0xabc…"` → `"0xabc…"`), the first pool seen for a token wins, and paging stops on an empty page.

**Errors are swallowed per page**: `catch { break }` abandons that list and moves to the next. A total provider outage therefore returns an **empty array rather than throwing** — which is exactly why `CachedDiscovery` must treat an empty list as non-evidence (§10.2). Remove that guard in the cache and one bad minute blanks a chain for six hours.

This method exists because **BSC was blind**. Its only universe source was DexScreener's boosts — paid promotions — which returned **nine tokens**. `discoverPools` took that to **48 unique BSC tokens** in the commit that introduced it. The reasoning in the file header is worth keeping verbatim: *"A universe built from who paid to be seen is not a universe; it is an advertising slot."* And because it is chain-agnostic, a third chain costs nothing on the universe side.

### 6.4 `historyBars` and `history`

```ts
async historyBars(chain, poolAddress, size = ONE_HOUR): Promise<number | null> {
  try { return (await this.candles(chain, poolAddress, size, 1000)).time.length } catch { return null }
}
```

One full 1 000-row candle download **to learn one integer**, and therefore the heaviest GeckoTerminal call in a cycle (§9). It swallows its own errors into `null`, so the history gate stays silent rather than firing on a network failure — the gate only fires on a count that was actually measured and came up short.

The count is capped at one page: a pool with 4 000 bars reports 1 000.

**A discrepancy worth knowing about.** The `HistoryBarsSource` interface that `CachedHistory` and `main.ts` use is `historyBars(chain, poolAddress)` — two arguments — so the size parameter always defaults to `ONE_HOUR`, even though production trades 15-minute bars (`OPERADOR_TIMEFRAME=15m`, wired into `candlesFor` as `config.barSize`). The history gate is therefore counting **1H** bars: it demands 250 of them, ~10.4 days of pool age, rather than the 2.6 days the charter's 15m table implies. That is *stricter*, not looser, so it is not a safety hole — a pool with 250 1H bars has ~1 000 15m bars — but the "younger pools qualify at 15m" reasoning does not describe what the code currently measures.

`history(chain, pool, wanted, size)` pages backwards from `Math.floor(all.time[0] / 1000)` until `all.time.length >= wanted` or an older page comes back empty. There is **no page cap**: on a deep pool with a large `wanted` this is an unbounded number of throttled calls. The engine's hot path does not use it — `candlesFor` calls `candles(..., 1000)` directly.

### 6.5 Backoff

```ts
private async getWithBackoff(url) {
  for (let attempt = 0; ; attempt++) {
    await this.throttle.wait()
    const response = await this.http(url)
    if (response.status === 200) return response.json()
    if (response.status === 429 && attempt < this.maxRetries) {
      const wait = this.backoffMs * 2 ** attempt
      this.rateLimit.hits += 1; this.rateLimit.waitedMs += wait
      await this.sleep(wait); continue
    }
    throw new HttpError(url, response.status)
  }
}
```

Defaults `maxRetries = 3`, `backoffMs = 4_000` → **4 s, 8 s, 16 s = 28 s maximum per URL**, plus the 2 500 ms spacing before each attempt. Only 429 retries; every other non-200 throws immediately.

---

## 7. The sell probe — one port, two chains

This is the section the death exit rests on. "Can this position actually be sold?" has two possible kinds of answer:

- **Quote a real sell.** A fact.
- **Read a vendor's `is_honeypot` flag.** A third party's opinion.

Solana got the fact from the start. BSC got the opinion until `PancakeSwap.assessSell` closed the gap.

### 7.1 The port

`src/application/scan.ts`:

```ts
export interface SellProbePort {
  assessSell(token: string, amountRaw: bigint, decimals: number, expectedUsd: number): Promise<SellAssessment>
}
```

`src/runtime/main.ts`:

```ts
const sellProbeFor = (chain: string) => (chain === 'bsc' ? pancake : jupiter)
```

Chosen **by the chain in hand**, not by a single configured chain. With both chains scanned every cycle, a BSC position asked through Jupiter would get a "cannot sell" that means nothing more than "wrong venue" — and the death watch would read it as a rug.

`Jupiter.probeSellPath(mint, amountRaw, expectedUsd, maxShortfallPct)` and `Jupiter.assessSell(mint, amountRaw, _decimals, …)` take a `decimals` argument they do not use, and the source says why: *"it is part of the shared SellProbePort because PancakeSwap needs it, and a port shaped around one implementation is not a port."*

### 7.2 The four verdicts

`SellQuoteResult` (defined in `src/domain/risk/death-exit.ts`) has exactly four values, and the mapping from a quote outcome to a verdict is the whole safety property:

| Quote outcome | Jupiter internal reason | PancakeSwap internal reason | `sellQuote` | What the death watch does |
|---|---|---|---|---|
| Route pays ≥ `expectedUsd × (1 − 50%)` | `ok` | `ok` | `ok` | healthy |
| Route pays less than that | `ok` | `ok` | `implausible` | evidence toward a death signal |
| No route at all | `no-route` | `no-route` | **`failed`** | **death signal** |
| Provider/RPC failure, malformed body | `http`, `malformed` | `rpc` | `unknown` | **inconclusive — never a death signal** |

The last two rows are the invariant. An RPC failure is never read as "no route": one is ignorance, the other is a death signal, and **confusing them would either liquidate a healthy position or hold a dead one**. Both test suites pin it by name — *"an RPC failure is NOT a no-route — it is inconclusive"* and *"unknown when the API itself is unreachable — inconclusive, never a death signal"*.

The split is decided by a regex on an error string, and that is the weakest link in the layer:

```ts
// PancakeSwap
reason: /revert|execution/i.test(lastDetail) ? 'no-route' : 'rpc'
// Jupiter
reason: /route/i.test(detail) ? 'no-route' : 'http'
```

An RPC provider that phrases a revert differently turns a genuine honeypot into `unknown` — safe: the position is held. An RPC whose *outage* message happens to contain the word "execution" turns an outage into `failed` — unsafe: a death signal manufactured from nothing. **Only the first direction is tested.**

`maxShortfallPct` defaults to `50` on both implementations: anything paying under half of `expectedUsd` is `implausible`.

### 7.3 Jupiter — `src/infrastructure/adapters/jupiter/jupiter.ts`

`GET /swap/v1/quote?inputMint={mint}&outputMint={USDC}&amount={raw}&slippageBps=50&swapMode=ExactIn` against `https://lite-api.jup.ag`.

```ts
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDC_DECIMALS = 6
```

`quoteSell` never throws. A transport exception becomes `{ ok: false, reason: 'http' }`; a non-200 is classified by the `/route/i` regex; a body missing `outAmount` or `priceImpactPct` as strings is `malformed`. On success:

- `outUsd = Number(quote.outAmount) / 10 ** 6`
- `priceImpactPct = Number(quote.priceImpactPct) * 100` — **Jupiter's field is a decimal fraction as a string**; `"0.0123"` is 1.23%.

`assessSell` then classifies, and returns the impact from the *same* quote. `measureSlippagePct(mint, decimals, priceUsd, referenceUsd)` sizes `BigInt(Math.floor((referenceUsd / priceUsd) * 10 ** decimals))` and returns the same reported impact, or `null` when the price is unusable or the quote failed.

One provenance note, because the charter's phrase "measured, not modelled" is doing different work on each chain: on **Solana** the impact number is the aggregator's own `priceImpactPct` for a real order — a fact about a quote, but Jupiter's arithmetic, not ours. On **BSC** it is computed here from two quotes (§7.4). Neither is a depth model; only one is our measurement.

### 7.4 PancakeSwap — `src/infrastructure/adapters/pancakeswap/pancakeswap.ts`

```ts
export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
export const WBNB           = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const BSC_USDT       = '0x55d398326f99059fF775485246999027B3197955'
export const USDT_DECIMALS  = 18   // BSC's USDT is 18 decimals, not 6
```

**Why no SDK.** A quote is one `eth_call` to `getAmountsOut`, and the ABI encoding for that one function is about forty lines of hex. From the commit: *"pulling in ethers to encode a single call would be a dependency, a bundle and a supply chain for less code than its own import."* The same reasoning covers `decimals()` in §7.6. The cost is accepted explicitly, and the test suite's heading is the acknowledgement: **"ABI encoding — written by hand, so it is tested by hand"**.

#### Encoding

```ts
const GET_AMOUNTS_OUT = '0xd06ca61f'   // getAmountsOut(uint256,address[])
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

export function encodeGetAmountsOut(amountIn: bigint, path: readonly string[]): string {
  return GET_AMOUNTS_OUT + pad(amountIn.toString(16)) + pad('40') + pad(path.length.toString(16)) + path.map(pad).join('')
}
```

Layout: `selector | amountIn | offset to array (0x40) | array length | addresses…`. The test asserts every word individually — selector, the 64-hex amount, the `0x40` offset word, the length word, lowercased left-padded addresses — and that a two-hop path produces a body of exactly `64 × 5` hex characters.

#### Decoding

```ts
export function decodeAmounts(result: string): bigint[] | null
```

It reads the length from `hex.slice(64, 128)` and elements from offset 128 onward, and returns `null` on an empty result, a zero length, or a payload shorter than the declared length.

**It ignores the declared offset word.** It assumes the returned `uint256[]` data begins at offset `0x20`, which is true for a single-return-value function like `getAmountsOut` — the test helper hardcodes `'20'` — but it is not general ABI decoding. A different return layout would decode into silent nonsense. The length sanity checks and the caller's `amounts.length !== path.length` check are the only guards.

#### Routing

```ts
const paths = [[token, BSC_USDT], [token, WBNB, BSC_USDT]]
```

Direct pair first, then through WBNB. A throw **continues to the next path** rather than returning, because at that level a reverting router and a down RPC look the same, and the decision of which it was can only be made once every path has failed. `hops = path.length - 1`.

#### Measured impact

```ts
const probeRaw = amountRaw / 1000n > 0n ? amountRaw / 1000n : 1n
…
const impact = (1 - realisedPrice / undisturbedPrice) * 100
return Math.max(0, impact)
```

Quote a thousandth of the order to learn the undisturbed price, quote the real order, take the difference. *"That is what impact IS — what your own order costs you — and it needs no model."* The clamp exists because **a negative reading is noise between two quotes, not a gift**.

The test proves it with a constant-product simulator (`out = reserveOut × in / (reserveIn + in)`): selling 10% of a reserve measures between 8% and 10%; a 10 000 000-unit pool measures under 0.01%; and a rigged probe that prices worse than the real order clamps to exactly `0`.

The cost: `assessSell` on BSC spends **two to four `eth_call`s** — one or two for the full quote, one or two for the probe.

#### Two quirks in the BSC implementation

- **`'malformed'` is declared in `PancakeFailure` and never produced.** An unexpected shape sets `lastDetail = 'router returned an unexpected shape'`, which does not match `/revert|execution/i`, so it classifies as `'rpc'` → `unknown`.
- **A zero quote on every path classifies as `'rpc'` → `unknown`, not `failed`.** `out === 0n` sets `lastDetail = 'router quoted zero out'`, which likewise fails the regex. On Solana the same condition (`outUsd <= 0`) returns `failed`. So the two implementations of one port disagree on "the venue answered, and the answer was nothing": Solana calls it a death signal, BSC calls it inconclusive. The bias is toward holding, which is the safe direction, but it is a real asymmetry and the test (*"a zero quote is a failure, not a price of zero"*) only asserts `ok: false`, not the reason. Consequently the `if (full.outUsd <= 0) return { sellQuote: 'failed' }` line inside `assessSell` is unreachable: `quoteSell` only returns `ok` when `out > 0n`.

#### The transport

```ts
export function jsonRpcEthCall(rpcUrl, post): EthCall
```

Posts `{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }`, throws on `body.error.message`, throws `'eth_call returned no result'` when `result` is not a string. Split out so the adapter is testable with a plain function, and so the caller — not the adapter — can tell a revert from an outage.

Verified live against `https://bsc-dataseed.binance.org`: **CAKE $2.3550 (1 hop), BUSD $0.9997**, and a dead address returning **no route at all**. The BUSD number is the decoder checking itself — a stablecoin pricing at a dollar is hard to reach by accident.

### 7.5 A probe result overrides a reported flag, in both directions

In `scanOnce`, after the security opinions are merged:

```ts
security = { ...security, honeypot: sellQuote === 'ok' ? false : sellQuote === 'unknown' ? security.honeypot : true }
```

A quote is a fact and a vendor's `is_honeypot` is an opinion, so `ok` clears the flag and `failed`/`implausible` set it — **but `unknown` must not overwrite a known verdict either way.** An unreachable API is not evidence of anything.

### 7.6 `Erc20Decimals` — the lookup that stands in front of every probe

`src/infrastructure/adapters/pancakeswap/erc20-decimals.ts`.

```ts
export const DECIMALS_SELECTOR = '0x313ce567'   // decimals()
const MAX_PLAUSIBLE = 36
```

Selector, no arguments, one `uint8` back. It returns `null` on: a thrown call, an empty `'0x'` response (a contract with no `decimals()` is not an ERC-20), a non-integer, a negative, and anything above 36 — the test uses `0xff` (255).

```ts
// Null rather than a default. Assuming 18 on a 6-decimal token sizes a
// sell probe a million times wrong, and a probe that large comes back
// looking exactly like a honeypot on a perfectly healthy pool.
```

The cache is a plain `Map`, permanent for the process, and **only real answers are stored** — caching a failure would make one bad RPC call permanent for the life of the process, while a token genuinely cannot change its decimals.

**This file exists because of a production incident, and the incident is the best argument in the chapter for why the decimals source is part of the probe, not a detail beside it.** The decimals lookup was Jupiter's token list *for both chains*, and Jupiter is Solana only. It returned `null` for every BSC address; `healthFor` returns `null` when decimals are `null`; so no observation was ever produced and **a BSC position could not be frozen or exited no matter what happened to it**. From the commit: *"The PancakeSwap probe was written, wired, documented as closing this exact gap, and never once called."*

It paid for itself immediately. With BSC finally probed, **CREPE — $718 000 of reported liquidity, a position the engine was holding — moved 98% on a $285 sell.** That is the reported-TVL-versus-effective-depth trap, on a chain where nothing had been watching for it.

The rule that follows: **if you add a chain, add its decimals source in the same commit, or the probe is silently unreachable.**

### 7.7 How a probe gets sized — and how a wrong price manufactures a honeypot

`main.ts:healthFor`:

```ts
const decimals = await decimalsFor.decimals(position.chain, position.tokenAddress)
if (decimals === null || position.lastPriceUsd === null || position.lastPriceUsd <= 0) return null
const referenceUsd = Math.max(position.capitalUsd, 50)
const amountRaw = BigInt(Math.floor((referenceUsd / position.lastPriceUsd) * 10 ** decimals))
```

The probe asks about the **full position**, because whether $100 can be sold says nothing about whether the position can leave. And the size comes from the caller's price — which is where the second production incident came from: a position was created with a placeholder `lastPriceUsd: 1`, so the first observation of a sub-cent token asked *"if I sell 285 units, do I get $285 back?"*, got about two dollars, called it `implausible` and froze the position before it had done anything. **Three positions sat frozen for hours; all three answered `ok` when probed live afterwards.** The guard above — `null` or non-positive price yields no observation at all — is the fix, on the principle that reporting nothing is honest while reporting an unfounded `ok` is not.

**One defect still standing in this path:** the observation is built with `source: 'jupiter'` unconditionally, including for BSC positions probed through PancakeSwap. `AssetHealthObservation.source` is a free `string` and it is what the death-exit evidence chain records (`05-riesgo.md`), so a BSC death exit would be logged as Jupiter evidence. The charter requires every death exit to carry which signal came from which source; this mislabels it.

`confirmSellable` runs the same probe at a flat `$100` immediately before capital moves, and treats anything other than `'ok'` as a no — *"'unknown' is not a yes."*

---

## 8. `JupiterTokens` and the Solana LP heuristic

### 8.1 `JupiterTokens` — `src/infrastructure/adapters/jupiter/jupiter-tokens.ts`

`GET /tokens/v2/search?query={mint}` returns an **array**, and search is **fuzzy**:

```ts
const match = list.find((t) => t.id === mint) ?? null
```

**Only an exact mint match counts.** Accepting the first result would attach another token's decimals and audit block to this mint — and decimals size the sell probe, so a fuzzy match is a mis-sized probe, which is a manufactured honeypot verdict (§7.6).

| Method | Does |
|---|---|
| `info(mint)` | exact-match lookup, cached per mint; `null` on non-200 |
| `discover(limit = 50)` | three lists: `toptrending/24h`, `toptraded/24h`, `toporganicscore/24h`; a failing list is skipped, not fatal |
| `decimals(chain, address)` | `null` for any chain but `solana`; `null` unless `Number.isInteger(info.decimals)` |
| `security(chain, address)` | `null` for any chain but `solana`; `null` when there is no `audit` block |

`discover` seeds the metadata cache for free — `this.cache.set(token.id, token)` — so the security pass that follows costs no extra request for tokens found through the lists.

The audit block becomes a **second opinion**, not a replacement:

| `Partial<SecurityReport>` | From | Rule |
|---|---|---|
| `mintAuthorityActive` | `audit.mintAuthorityDisabled` | `undefined` → `null`, else negated |
| `freezeAuthorityActive` | `audit.freezeAuthorityDisabled` | same |
| `topHoldersPct` | `audit.topHoldersPercentage` | kept only when it is a number |
| `creatorPct` | `audit.devBalancePercentage` | kept only when it is a number |

It is merged **after** GoPlus in trust order, because *"GoPlus often leaves [them] blank for Solana tokens"*.

**The cache is per-process and never expires** — a plain `Map`, no TTL. That used to be filed as harmless on the grounds that a process is one cycle long. It is not: `.github/workflows/engine.yml:111` sets `OPERADOR_MAX_CYCLES` to 120 against `timeout-minutes: 350` and a 5-minute cadence, and `runtime/main.ts:75` builds `new JupiterTokens(http, jupiterThrottle)` **once, outside the loop**. So the map lives for up to 120 passes across **nearly six hours**, and the "long-lived daemon" case this note treated as hypothetical is the production runtime (`12-runtime-despliegue.md` §5.2, §5.4).

What that actually costs, and what it does not:

- `info(mint)` caches `null` as well as a hit (`if (cached !== undefined) return cached`), so a token that answered nothing at minute 3 answers nothing for the rest of the run. Nothing retries it.
- `security()` reads its `mintAuthorityActive`, `freezeAuthorityActive`, `topHoldersPct` and `creatorPct` out of that same block — so an authority **reinstated mid-run** keeps reporting its entry-time value for as long as the process lives. It is a second opinion merged after GoPlus, and GoPlus is re-fetched on a real request whenever the scan gets that far, so this degrades the corroboration a stale-authority signal needs rather than silently authoring one.
- The blast radius is smaller than "six hours" suggests, and for a reason that has nothing to do with this adapter: the merged report is cached durably in `token_security` with a **2-hour TTL** (`scan.ts:147`, `DEFAULT_SECURITY_TTL_MS`). A token served from that cache never reaches `JupiterTokens` at all. The unexpiring Map only decides what a token looks like on the passes where the durable cache has already expired.
- `discover` re-seeds the cache with `this.cache.set(token.id, token)` on every scan pass, which is the one thing that refreshes an entry — and only for tokens that come back in the lists.

`Erc20Decimals`' permanent cache is the opposite case and is correct for the opposite reason: a token cannot change its decimals, but it can certainly have its mint authority re-examined. That asymmetry is the whole point — one of these two caches has a lifetime bound by a fact about the token, and the other by a fact about the process.

### 8.2 `lpLockFromVenue` — 21 lines, tagged as a heuristic

`src/infrastructure/adapters/solana/lp-heuristics.ts`:

```ts
const PROTOCOL_BURNED_LP = new Set(['pumpswap', 'pumpfun'])
export function lpLockFromVenue(dexId: string | undefined): Partial<SecurityReport> {
  if (dexId && PROTOCOL_BURNED_LP.has(dexId.toLowerCase())) return { lpLockedPct: 100 }
  return {}
}
```

Neither GoPlus nor Jupiter exposes LP holders for Solana pools, and the on-chain read (LP mint supply versus burned/locked balances, per DEX layout) **is not built**. One fact is reliable by protocol design: pools created by pump.fun's migration have LP burned at creation — nobody holds LP tokens to pull.

It returns `{}` — not `{ lpLockedPct: 0 }` — for every other venue, so `mergeSecurity` leaves the field unknown and the gate fails closed. The test name states the rule: *"every other venue stays unknown — and unknown fails closed"*.

This is the one adapter `application/scan.ts` imports by value rather than by type, and it is applied only when `config.chain === 'solana'`.

### 8.3 Trust order

`src/domain/scanner/security-merge.ts` folds the opinions:

```ts
const opinions: Partial<SecurityReport>[] = []
if (primary) opinions.push(primary)            // GoPlus
if (metadata.audit) opinions.push(metadata.audit)  // Jupiter audit
if (config.chain === 'solana') opinions.push(lpLockFromVenue(market.dexId))
```

On booleans, **danger from any source wins** (`honeypot`, `mintAuthorityActive`, `freezeAuthorityActive`, `hasBlacklist`, `isProxy`) — a rug only has to be caught once. On numbers (`transferTaxPct`, `lpLockedPct`, `topHoldersPct`, `creatorPct`) the **first known value** wins, which is why the array order is the trust order. `verifiedSource` is a safety *claim*, so any `false` beats every `true`.

The three providers are called concurrently (`Promise.all`), and the merge order is applied afterwards precisely so concurrency cannot disturb it.

---

## 9. Rate limiting: what was measured, and what it cost

This is the most instructive sequence in the repo, because **both estimates were wrong in ways reasoning alone could not have caught**.

### 9.1 The measurements, in order

| Stage | Measurement |
|---|---|
| Estimate | 9 s per token |
| First cycle that finished a chain | **16.8 s per token** — 336 s for twenty, against a 15-minute bar |
| Cause | each token asked three **independent** providers in sequence and paid the sum of three unrelated queues |
| After parallelising into three branches | **4.5 s per token locally** — network 15.4 s, sleeping on throttles 53.5 s, wall 68.9 s; discovery alone 44.3 s before a single token was checked; five security passes in 22.6 s |
| Same commit in GitHub Actions | still **~15 s per token** |

Two failed hypotheses later, the instrumentation was shipped with **no tuning at all** (`perf(scan): make the rate limits visible, because the numbers disagree`), and one cloud run answered it:

```
[scan:limits] solana goplus={"hits":0,"waitedMs":0} gecko={"hits":45,"waitedMs":276000}
```

**276 seconds of backoff inside a 346-second scan — 80% of the cycle — from one provider, while every other provider never complained once.** GeckoTerminal limits by IP address, and a CI runner shares its address with thousands of unrelated jobs. The quota is not ours to budget, and a throttle tuned against a quota you cannot observe is guesswork. The only winning move is **to ask less**.

### 9.2 The counters, and the diagnostic that lied

Both `GoPlus` and `GeckoTerminal` expose:

```ts
readonly rateLimit = { hits: 0, waitedMs: 0 }
```

with the justification in `goplus.ts`: *"a scan three times slower in CI than on a laptop is either a rate limit or a mystery, and a mystery cannot be fixed. Back-off that nobody can see looks exactly like code being slow."*

The counters live on adapters **shared by every chain**, so they only ever go up. The first version printed them raw and labelled the second chain with the first one's total:

```
[scan:limits] solana gecko={"hits":45,"waitedMs":276000}
[scan:limits] bsc    gecko={"hits":95,"waitedMs":556000}   ← reads as 95
```

BSC had fifty, not ninety-five — and the number was impossible on its face, **556 seconds of waiting inside a 356-second scan**. `main.ts` now snapshots before each chain and subtracts after:

```ts
const before = { goplus: { ...goplus.rateLimit }, gecko: { ...gecko.rateLimit } }
```

*"A diagnostic that misleads is worse than none"*, because an impossible number is how you start distrusting the instrument instead of reading it.

### 9.3 Every spacing and backoff, in one table

| Provider | Spacing | Where it is set | Retry policy | Worst case per URL |
|---|---|---|---|---|
| Jupiter (`Jupiter` + `JupiterTokens`, one shared instance) | 1 100 ms | `makeThrottle(1_100)` in `main.ts` | none — a failure is a typed result | — |
| GeckoTerminal | 2 500 ms | `makeThrottle(2_500)` in `main.ts` | 429 only, `maxRetries 3 × backoffMs 4_000` | 4 s + 8 s + 16 s = **28 s** of sleep |
| GoPlus | 2 000 ms | **private**, `GoPlusOptions.minIntervalMs` | 429 or envelope code 4029, `maxRetries 2 × backoffMs 5_000` | 5 s + 10 s = **15 s** of sleep, *plus* spacing before each attempt |
| PancakeSwap | 250 ms | `makeThrottle(250)` in `main.ts` | none | — |
| DexScreener | **none** | — | none | — |
| `Erc20Decimals` | **none** | — | none | — |

GoPlus first returned code 4029 after **~50 back-to-back calls**; 1.3 s spacing still drew 4029s on a 55-token pass, and 2 s with a 5 s backoff holds.

---

## 10. The two caches, and why each one is correct

Both are **decorators in `infrastructure/`**, wired by the composition root. From the commit: *"the decorator lives in infrastructure and the composition root wires it, so `scanOnce` is untouched and did not need to learn that a cache exists."* `CachedDiscovery` goes further and `implements PoolDiscoverySource`, so it is substitutable for `GeckoTerminal` itself.

Both are backed by `PostgresStore` (which satisfies `HistoryBarsCache` and `PoolDiscoveryCache` directly) and by `MemoryStore` in tests — `cached-discovery.test.ts` deliberately runs against the real `MemoryStore` rather than a hand-rolled fake.

### 10.1 `CachedHistory` — a pool cannot lose candles

`src/infrastructure/adapters/geckoterminal/cached-history.ts`.

```ts
async historyBars(chain, poolAddress) {
  const known = await this.cache.historyBarsFor(chain, poolAddress)
  if (known !== null && !this.stale(known)) return known.bars
  const measured = await this.source.historyBars(chain, poolAddress)
  if (measured === null) return known?.bars ?? null       // a failed call is not a measurement
  await this.cache.recordHistoryBars(chain, poolAddress, measured, this.options.now())
  return measured
}

private stale(known) {
  if (known.bars >= this.options.minBars) return false     // settled forever
  return this.options.now() - known.measuredAt >= this.shortLivedMs
}
```

Three rules, each with its own argument:

1. **A settled count never expires.** `minBars` is wired to `DEFAULT_GATE_POLICY.minHistoryBars = 250`. The correctness argument is not "it probably has not changed" — it is that **a pool cannot lose candles**, so re-measuring can only ever return the same verdict. Test: *"never asks again once a pool has enough history — a pool cannot lose candles."*
2. **A SHORT count expires after six hours** (`DEFAULT_SHORT_LIVED_MS`), because a young pool grows. That is the one answer that can change. Test: *"re-asks a pool that was SHORT, because that is the answer that can change."*
3. **A failure is never written.** Writing `null` would turn one rate-limited request into a permanent *"this pool has no history"*, and the history gate would then reject a perfectly good token forever on the strength of a network blip. Test: *"does not cache an unknown answer — a failed call is not a measurement."*

Chains are kept apart — the key is `(chain, poolAddress)` — because the same address can exist on two chains and they are two different pools.

**Measured, cold cycle against warm cycle, same chain, same 20 tokens:**

| | Cold | Warm | Predicted |
|---|---|---|---|
| GeckoTerminal rejections | 50 | **21** | ~17 |
| Time backing off | 304 s | **116 s** | ~100 s |
| Scan | 384 s | **177 s** | ~180 s |

About twenty GeckoTerminal calls per chain per cycle removed after warm-up. The first cycle still pays for them.

### 10.2 `CachedDiscovery` — the TTL is an argument, not a guess

`src/infrastructure/adapters/geckoterminal/cached-discovery.ts`. Written after `CachedHistory`, because once the candle downloads were cached, **discovery was most of what remained**: ten throttled calls per chain, about half an hour of every scan, during which the engine is not watching the positions that already hold money.

Unlike a bar count, a discovery list genuinely changes — new pools appear — so this one expires. The window is `DEFAULT_STALE_AFTER_MS = 6 h`, and it is chosen by an argument about what the gates would do with the answer:

> **A pool younger than the window cannot clear the history gate anyway.** The strategy needs 250 bars — 2.6 days at 15m — so a token that first appeared six hours ago would be rejected on arrival. Caching for six hours cannot lose a single token the scanner would have accepted.

Six hours is deliberately a small fraction of the gate's own window.

Two failure rules, both learned the same way:

```ts
if (found.length > 0) await this.cache.recordDiscoveredPools(chain, found, this.options.now())
```
**An empty answer is never cached.** `GeckoTerminal.discoverPools` swallows page errors and returns `[]` on a total outage (§6.3), so an empty list is far more likely to be a bad minute than a chain with no pools. Remembering it would blind the chain for the whole window. Test: *"never caches a failure — one rate limit must not blind a chain for hours."*

```ts
catch (error) { if (remembered) return [...remembered.pools]; throw error }
```
**A throw falls back to a stale shelf, but never invents one.** *"An old universe beats no universe — the alternative is a scan that sees nothing and a book that stops growing for as long as the provider is unhappy."* And when there is nothing on the shelf either, the caller sees the failure. Tests: *"falls back to a stale shelf when the provider is down"* and *"refuses to invent one when there is nothing on the shelf either."*

### 10.3 Where the rows live

| Table | Key | Written by | Upsert |
|---|---|---|---|
| `pool_history (chain, pool_address, bars, measured_at)` | composite PK `(chain, pool_address)` | `CachedHistory` | `ON CONFLICT … DO UPDATE` |
| `pool_discovery (chain, pools JSONB, discovered_at)` | PK `chain` | `CachedDiscovery` | `ON CONFLICT (chain) DO UPDATE` |

`postgres-store.ts` explains the first one's `DO UPDATE` against the blacklist's `DO NOTHING`: *"this is a measurement that improves, not a verdict that must keep its first answer."* See `09-persistencia.md`.

---

## 11. How they compose — the three live paths

### 11.1 The scan path (`scanOnce`, one call per chain)

```
universe  = JupiterTokens.discover()            (Solana only, three lists)
          ∪ CachedDiscovery.discoverPools(chain) (both chains)
          ∪ DexScreener.discoverTokens(chain)    (both chains, not error-guarded)
          → dedupe → slice(0, maxTokens = 300)
market    → DexScreener.tokens() in batches of 30 → toMarketSnapshots (deepest pool)
FREE gates → evaluateMarketGates  ← runs BEFORE any paid call
cache     → store.cachedSecurity (2 h TTL) removes already-known tokens from the budget
budget    → the rest ranked by a provisional score, cut to maxSecurityChecks
per token → Promise.all([
              goplus.securityReport,
              { JupiterTokens.security  →  decimals  →  sellProbe.assessSell },
              CachedHistory.historyBars(chain, market.pairAddress),
            ])
merge     → mergeSecurity(GoPlus, audit, venue) → honeypot override from the probe
          → store.recordSecurity → rankUniverse
```

The branch structure is the fix from §9.1: three independent providers with three independent rate limiters, so a token costs the **longest** branch rather than their sum. The sell quote is the one real dependency — it needs decimals to size the reference order — so it stays inside its own branch behind them.

**Note the cache key**: `historyBars` is called with `market.pairAddress`, so the history cache is keyed by **pool**, not by token. A token whose deepest pool changes between scans gets a fresh, uncached measurement. That is correct, but it means the hit rate depends on pool stability rather than token stability.

Three universe sources are kept rather than a favourite, and the reason is a measurement: between two live runs, **Jupiter's lists fell from ~220 to 99 while GeckoTerminal's pools rose from 20 to 171**. A universe built on one provider's list is a universe that halves the day that provider changes its mind. Full coverage table in `01-vision-general.md`.

### 11.2 The death-watch path (`deps.healthFor`)

`decimalsFor.decimals(chain, address)` → `null` means **no observation at all** → size `amountRaw` from `max(capitalUsd, 50)` and `lastPriceUsd` → `sellProbeFor(chain).assessSell(...)` → an `AssetHealthObservation` carrying **only** `sellQuote`; `liquidityUsd`, `lpStatus`, the authorities, `transfersBlocked`, `topHolderMovedPct` and `hoursSinceLastTrade` are all `null` or `'unknown'`.

That is worth stating plainly: **of the seven invalidation signals the charter lists for the death exit, the live engine currently feeds exactly one — the sell path.** LP removal, liquidity collapse, authority reinstatement, wallet blacklisting, holder dumps and abandonment are defined in the domain (`05-riesgo.md`) and have no adapter behind them yet. The whole of §7 is therefore the whole of the death watch's evidence today.

### 11.3 The candle path (`deps.candlesFor`)

`gecko.candles(position.chain, position.pairAddress, config.barSize, 1000)`, **uncached**, wrapped in a try/catch that returns `null`. The engine's dead-man behaviour on feed loss takes it from there (`08-motor.md`).

---

## 12. Testing

Every adapter test runs offline through `stubHttp` or a hand-written `EthCall`, on fixtures **trimmed from live responses** rather than copied from documentation — the file headers say so, and the git history carries the probes. The provider shapes in this chapter were confirmed against the real APIs in Sept 2026, and at least three of them differ from the published docs (GoPlus fraction strings, the `non_transferable` spelling, GeckoTerminal's newest-first seconds).

The tests that read as specifications:

| Suite | The claim it exists to pin |
|---|---|
| `pancakeswap.test.ts` | *"ABI encoding — written by hand, so it is tested by hand"*; impact measured against a constant-product simulator |
| `jupiter.test.ts` | the four verdicts, by name; *"assessSell returns the verdict and the measured impact from a single call"* (asserts `http.calls` has length 1) |
| `goplus.test.ts` | *"unknown everything → nulls, so the gates fail closed"*; 4029 retry with doubling backoff; *"gives up after maxRetries and lets the scan fail closed"* |
| `geckoterminal.test.ts` | the reversal, the seconds→ms conversion, the zero-price drop, backward paging, per-page error isolation |
| `cached-history.test.ts` | *"never asks again once a pool has enough history — a pool cannot lose candles"* |
| `cached-discovery.test.ts` | *"never caches a failure — one rate limit must not blind a chain for hours"* |
| `erc20-decimals.test.ts` | the docblock is the incident report; null on RPC failure, on `0xff`, on `'0x'` |
| `dexscreener.test.ts` | deepest pool, other-chain and priceless-pair exclusion, the 30-address refusal |
| `lp-heuristics.test.ts` | *"every other venue stays unknown — and unknown fails closed"* |

Smoke tests hit the real APIs and are skipped unless asked for:

```bash
OPERADOR_SMOKE=1 npx vitest run src/application/scan.smoke.test.ts
OPERADOR_SMOKE=1 npx vitest run src/application/collect-dataset.smoke.test.ts
```

They use `makeHttpGet({ timeoutMs: 15_000 })` and `{ timeoutMs: 20_000 }` respectively — production uses 20 s against the library's 10 s default, a deliberate loosening for throttled providers on shared addresses.

---

## 13. Traps, in one list

Collected because each one has either cost money or is one edit away from doing so.

1. **GeckoTerminal returns rows newest-first with timestamps in seconds.** Bypass `candles()` and you get a backwards series with timestamps off by 1 000×. Every indicator computes; none means anything.
2. **The decimals lookup stands in front of every sell probe.** It already cost BSC its entire death watch. Add a chain, add its decimals source in the same commit.
3. **A wrong price manufactures a honeypot.** The probe is sized from the caller's `lastPriceUsd`; a placeholder `1` froze three healthy positions for hours.
4. **The no-route/rpc split is a regex on an error string.** Only the safe direction is tested; an outage message containing "execution" would fabricate a death signal.
5. **PancakeSwap's zero-quote reads as `unknown` where Jupiter's reads as `failed`.** Same port, different verdict for "the venue answered nothing".
6. **`decodeAmounts` ignores the declared offset word.** Correct for `getAmountsOut`; not general ABI decoding.
7. **GoPlus EVM results are keyed by lowercase address.** Removing the fallback silently rejects all of BSC.
8. **GoPlus percentages are fraction strings.** `"0.0883"` is 8.83%.
9. **The Solana key is `non_transferable`**, not the docs' `none_transferable`.
10. **`GoPlus.topShare`'s docstring is wrong about locked balances** — they are counted, not skipped.
11. **`stubHttp` matches by URL prefix in insertion order.** A more specific entry declared later may never be reached.
12. **The `rateLimit` counters are cumulative and live on shared adapters.** Snapshot-and-subtract per chain, or the diagnostic lies.
13. **`DexScreener.tokens` throws above 30 addresses** instead of chunking, and `discoverTokens` is the one universe source `scanOnce` does not guard with a try/catch.
14. **`MarketSnapshot.observedAt` comes from the adapter's injected clock**, not the API response. A frozen clock makes every staleness check downstream meaningless.
15. **`GeckoTerminal.history()` has no page cap.** Unbounded throttled calls on a deep pool; the engine's hot path does not use it.
16. **`GeckoTerminal.discoverPools` swallows every page error** and returns `[]` on a total outage. That is exactly why `CachedDiscovery` must refuse to cache an empty list.
17. **`JupiterTokens`' cache never expires**, and the adapter is built once outside the loop. This was filed as "harmless in a one-shot cycle"; production runs up to 120 passes in one process, so the daemon case is the real one (§8.1).
18. **`historyBars` is always measured in 1H bars** regardless of `OPERADOR_TIMEFRAME`, because the port passes only two arguments. Stricter than documented, not looser.
19. **The death-watch observation is labelled `source: 'jupiter'` even on BSC.** The evidence chain mislabels which venue answered.
20. **DexScreener and `Erc20Decimals` have no throttle and no counter.** Their traffic is invisible to the instrumentation in §9.

---

## 14. What is not built

Stated so nobody goes looking for it:

- **No WebSocket anywhere.** Every adapter is HTTP polling. The charter's earlier claim of "live WebSocket subscriptions" was corrected; this is what the code does.
- **No wallet adapter.** `adapters/wallet/` does not exist, and `loadConfig` throws on `OPERADOR_MODE=live` for that reason. Fills come from `PaperBroker`.
- **No on-chain LP read on Solana.** `lpLockFromVenue` is the only signal, and it is tagged a heuristic.
- **No adapter for six of the seven death-exit invalidation signals** (§11.2).
- **No Tron adapter**, despite the economics table in `06-economia.md` pricing it.
- **`makeHttpGet` has no test.**

---

## 15. Cross-references

| Chapter | For |
|---|---|
| `01-vision-general.md` | universe coverage per chain, the $0/month topology |
| `12-runtime-despliegue.md` | §5.2/§5.4: one process, up to 120 passes over 350 minutes — the lifetime every in-process cache in this chapter actually gets |
| `02-indicadores.md` | what a zero-price candle would do to EMA-200, Bollinger and Supertrend |
| `04-escaner.md` | `TokenSnapshot` field by field, every gate, the security budget, `securityChecked` and `measuredImpactPct` |
| `05-riesgo.md` | `SellQuoteResult` in the two-stage death exit; why price may never be a death signal; the evidence chain |
| `06-economia.md` | what `slippagePct` and `spreadPct` are spent on; reported TVL versus effective depth |
| `08-motor.md` | `candlesFor`, `healthFor` and `confirmSellable` inside the tick; dead-man behaviour on feed loss |
| `09-persistencia.md` | `pool_history`, `pool_discovery`, `token_security`, and the `DO UPDATE` versus `DO NOTHING` split |
