# Runtime, configuration and deployment

This chapter documents the outermost layer: `src/runtime/`, where the pure, port-driven system finally meets a process. It covers the composition root that wires real HTTP adapters onto the application's ports; every environment variable the system reads, with its default and the reasoning behind that default; the supervised loop and the two cadences that make watching cheap and hunting rare; the GitHub Actions topology and why a scheduler replaced the server the charter originally demanded; the manual `retire` path, which is the only way a human overrules the engine; the demo server; the $0 free-tier stack and the gotchas that come with it; and the Docker image that exists so the eventual migration to a real daemon is a deploy rather than a rewrite. It closes with a section on documented-versus-actual drift, because several numbers in `DEPLOY.md`, `docker-compose.yml` and `.env.example` no longer match the code.

The cycle this layer schedules is in `08-motor.md`; the store it opens a pool onto, in `09-persistencia.md`; the adapters it constructs, in `10-adaptadores.md`; the dashboard and phone API it deploys alongside, in `11-vistas.md`; the sizing constants it composes, in `06-economia.md`; the portfolio, idle-slot and kill-switch policies whose knobs appear in the variable table, in `05-riesgo.md`.

---

## 1. Where the code is

| File | Lines | What it is |
|---|---|---|
| `src/runtime/config.ts` | 240 | `loadConfig`, `ConfigError`, `describeConfig`. The only reader of `process.env` in the engine path. |
| `src/runtime/main.ts` | 386 | `buildRuntime` — the composition root — plus `schemaSql()` and `main()`. |
| `src/runtime/index.ts` | 46 | Process entry point. The only file that opens a real connection. |
| `src/runtime/loop.ts` | 173 | `runLoop` and `shutdownSignal`. The supervised loop and its two cadences. |
| `src/runtime/retire.ts` | 89 | Operator CLI: take one token off the board, by hand. |
| `src/runtime/demo-server.ts` | 145 | The phone API on `MemoryStore`, for developing the Android app without a database. |
| `src/application/production-ladder.ts` | 52 | `DEFAULT_MAX_USD_PER_LEVEL = 15`, `DEFAULT_MAX_DCA_PER_TOKEN = 5`, `productionLadder(env)`. Shared by the engine and the dashboard. |

Tests:

| File | Lines | Covers |
|---|---|---|
| `src/runtime/config.test.ts` | 95 | Defaults; numeric refusals; unknown mode/chain; the live-mode refusal and that it says what to do instead; the `describeConfig` allow list and the redaction; the 15m default and the 1h alternative; the $15 ladder cap and that overriding it never touches `DEFAULT_PARAMS`. |
| `src/runtime/loop.test.ts` | 312 | Bounded runs; interval sleeps; backoff doubling and capping; recovery announcement; clean shutdown and the second-signal exit; the two cadences; "it begins with what it already knows"; per-pass reporting. |

Deployment:

| File | Lines | What it is |
|---|---|---|
| `.github/workflows/engine.yml` | 112 | The engine on a schedule. One long run that paces itself. |
| `.github/workflows/retire.yml` | 55 | `workflow_dispatch` only. Deliberately never on a timer. |
| `.github/workflows/tests.yml` | 49 | `verify` (tsc + vitest) and `dashboard` (Vercel-shaped install). |
| `Dockerfile` | 44 | Two-stage `linux/arm64` build. The migration path to a daemon. |
| `docker-compose.yml` | 18 | Local run only. **Stale** — see §11. |
| `DEPLOY.md` | 248 | The Spanish operator guide: Neon → token → repo → secrets → first run → Vercel → phone. |
| `.env.example` | 38 | The documented env surface. Incomplete — see §11.4. |
| `tools/reset.sql` | 40 | Starting over, with each table labelled STATE or CACHE. |

---

## 2. The composition root

### 2.1 What "composition root" means here

The rule the architecture rests on is that the domain has zero imports from `infrastructure/`, and the application layer takes ports. Somewhere that has to stop being true, or nothing ever runs. `main.ts` says so in its own header:

```ts
/**
 * Composition root — the only place that knows about both halves of the system.
 *
 * Everything above this file takes ports. This is where real adapters get
 * wired to them, which is why it is the one file allowed to touch the
 * environment, the filesystem and the clock.
 */
```

Three privileges are concentrated here and nowhere else:

| Privilege | Where |
|---|---|
| Reading the environment | `loadConfig()` in `config.ts`, called from `main()` |
| Reading the filesystem | `schemaSql()`, which reads `schema.sql` off disk |
| Reading the clock | `now: () => Date.now()` handed to `CycleDeps`, `CachedHistory`, `CachedDiscovery` and `recallCandidates` |

Everything below receives those as values. That is what makes the cycle testable without a network, a database or a wall clock — see `08-motor.md`.

### 2.2 The boot sequence

Three files, in order.

**`src/runtime/index.ts` — the process.**

```ts
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[fatal] DATABASE_URL is required')
  process.exit(1)
}

// Imported dynamically so the whole codebase stays installable and testable
// without a Postgres driver present.
const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
```

Four things this file does that are decisions, not boilerplate:

- **`pg` is imported dynamically.** The comment gives the reason: the codebase stays installable and testable without a Postgres driver present. `pg` is a real dependency in `package.json`, but the import is deferred so nothing at module-load time in the rest of the tree depends on it existing.
- **The `QueryResultRow` cast lives here.** `pg` types rows as `QueryResultRow`; the store knows the shape it asked for. The cast sits at the boundary "rather than leaking into the port."
- **`postJson` is built here too**, because JSON-RPC needs the parsed body and not just a status — that is what the BSC sell probe and the ERC-20 decimals reader run on (`10-adaptadores.md`).
- **`process.exitCode = 1`, never `process.exit(1)`**, on a fatal error, inside a `try/finally` whose `finally` is `await pool.end()`. Setting the code lets the pool drain; calling `exit` would kill the process with connections open.

**`src/runtime/main.ts` — `main(ports)`.**

```
loadConfig()                → throws ConfigError on anything wrong
console.log('[boot]', …)    → the redacted line, via describeConfig
new PostgresStore(sql)
  .migrate(schemaSql())     → idempotent; safe on every boot
buildRuntime(config, ports) → { deps, cycleConfig, throttle }
shutdownSignal()            → a promise that resolves on SIGINT/SIGTERM
runLoop(deps, cycleConfig, throttle, { … })
console.log('[exit]', …)    → stoppedBy and the cycle count
```

`migrate` is one statement — `await this.sql.query(schema)` — and `schema.sql` is written so that running it on every boot is a no-op after the first (`09-persistencia.md`). That is why there is no separate migration step anywhere in the deployment: the engine creates what it needs, and `DEPLOY.md` step 1 can honestly say *"No hace falta crear ninguna tabla."*

**`schemaSql()` reads relative to the module, not the working directory:**

```ts
export const schemaSql = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../infrastructure/persistence/schema.sql'), 'utf8')
```

This is exactly why the `Dockerfile` has an explicit copy after compiling — `tsc` does not carry non-TypeScript assets into `dist/`:

```dockerfile
RUN npx tsc --noEmit false --outDir dist --module nodenext --moduleResolution nodenext \
 && cp src/infrastructure/persistence/schema.sql dist/infrastructure/persistence/schema.sql
```

Change the build command and migrations break at boot with `ENOENT` on a path nobody will think to look at.

### 2.3 `buildRuntime` — the wiring, port by port

```ts
export function buildRuntime(config: RuntimeConfig, ports: RuntimePorts): Runtime
```

`RuntimePorts` is deliberately tiny — everything real reduces to two capabilities:

```ts
export interface RuntimePorts {
  readonly sql: SqlClient
  /** POST returning a parsed body, for JSON-RPC. */
  readonly postJson: (url: string, body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>
}
```

HTTP GET is not among them: `buildRuntime` constructs it itself with `makeHttpGet({ timeoutMs: 20_000 })`. The default in `src/infrastructure/http.ts` is 10,000 ms; the runtime doubles it, because these providers are slow under load and a 10-second abort turns a sluggish response into a failed cycle.

**Adapters and their throttles.**

| Adapter | Constructed as | Throttle | Used for |
|---|---|---|---|
| `DexScreener` | `new DexScreener(http)` | none | universe + market numbers |
| `GoPlus` | `new GoPlus(http)` | none | security reports |
| `Jupiter` | `new Jupiter(http, jupiterThrottle)` | 1,100 ms | Solana sell probe |
| `JupiterTokens` | `new JupiterTokens(http, jupiterThrottle)` | 1,100 ms (shared) | Solana decimals + metadata security |
| `GeckoTerminal` | `new GeckoTerminal(http, geckoThrottle)` | 2,500 ms | candles, history counts, pool discovery |
| `PancakeSwap` | `new PancakeSwap(bscRpc, makeThrottle(250))` | 250 ms | BSC sell probe |
| `Erc20Decimals` | `new Erc20Decimals(bscRpc)` | none (shares the RPC) | BSC decimals |

The comment states the rule: *"One throttle per provider, shared by every adapter that talks to it."* `Jupiter` and `JupiterTokens` are two adapters against one quota, so they share `jupiterThrottle`. Handing each its own would let them collectively exceed the spacing the throttle exists to enforce.

**The two caches, wrapped into one `history` port.**

```ts
const cachedHistory = new CachedHistory(gecko, store, {
  now: () => Date.now(),
  minBars: DEFAULT_GATE_POLICY.minHistoryBars,
})
const cachedDiscovery = new CachedDiscovery(gecko, store, { now: () => Date.now() })
const history = {
  historyBars: (chain, pool) => cachedHistory.historyBars(chain, pool),
  discoverPools: (chain) => cachedDiscovery.discoverPools(chain),
}
```

Both caches are backed by `store` — the same `PostgresStore` — so they survive the process, which is the entire point when the process is a GitHub Actions run that exits every few hours. Their reasoning is in `10-adaptadores.md`; what matters here is why the composition root is where they are applied:

- `CachedHistory` takes its expiry threshold from the gate policy itself (`DEFAULT_GATE_POLICY.minHistoryBars`, which is 250). A count at or above the gate's threshold is *settled forever* — a pool cannot lose candles — so only a short count expires, after six hours. Wiring `minBars` from the gate rather than duplicating the number means a change to the gate cannot silently desynchronise the cache.
- `CachedDiscovery` expires after six hours, and its justification is a claim about the gates rather than about the market: a pool younger than the window could not clear the history gate anyway.

**The sell probe, chosen by the chain in hand.**

```ts
const bscRpc = jsonRpcEthCall(config.bscRpcUrl, ports.postJson)
const pancake = new PancakeSwap(bscRpc, makeThrottle(250))
const sellProbeFor = (chain: string) => (chain === 'bsc' ? pancake : jupiter)
```

Not by a configured chain — by the chain of the token being asked about. The comment names the failure this prevents: with both chains scanned, *"a BSC position asked through Jupiter would get a 'cannot sell' that means nothing more than 'wrong venue' — and the death watch would read it as a rug."* Given that a broken sell path is a stage-2 death signal (`05-riesgo.md`), asking the wrong venue would liquidate healthy BSC positions on a category error.

**Decimals, from a source that knows the chain.** This one shipped as a bug and the comment keeps the postmortem:

```ts
const erc20 = new Erc20Decimals(bscRpc)
const decimalsFor = {
  decimals: (chain: Chain, address: string) =>
    chain === 'bsc' ? erc20.decimals(chain, address) : jupiterTokens.decimals(chain, address),
  security: (chain: Chain, address: string) => jupiterTokens.security(chain, address),
}
```

> This used to be Jupiter's token list for BOTH chains, and Jupiter is Solana only — so it answered null for every BSC address. Since the decimals lookup stands in FRONT of every sell probe, that one null meant BSC tokens were never honeypot-tested and BSC positions ran with no death watch at all. The PancakeSwap probe was written, wired, and unreachable.

The shape of that bug is worth naming because it recurs: a correct component reached through an incorrect precondition is indistinguishable, from outside, from a component that was never built. Note also that `decimalsFor.security` is *not* chain-switched — it always asks `jupiterTokens`, which is Solana-only. That is consistent with how it is consumed (a metadata opinion that merges into the security report and contributes nothing when absent), but it does mean BSC's security report never receives that second opinion.

**One broker per position, seeded from the fills.**

```ts
const brokers = new Map<string, PaperBroker>()
const brokerFor = async (position: PersistedPosition) => {
  let broker = brokers.get(position.id)
  if (!broker) {
    broker = new PaperBroker({
      gasUsdPerSwap: config.gasUsdPerSwap,
      initialCapital: position.capitalUsd,
      maxOpenEntries: config.maxDcaPerToken + 1,
      quality: () => position.quality,
    })
    broker.seed(await store.fillsFor(position.id))
    brokers.set(position.id, broker)
  }
  return broker
}
```

Two properties, both load-bearing:

- **Isolation.** Every position keeps its own broker, so *"one position's cash can never be spent by another — the same isolation the live wallets will need to enforce for real."* This is constraint 8 of the charter (position isolation) implemented at the only layer that can implement it in paper mode.
- **Seeding.** The engine wakes as a fresh process every cycle. `broker.seed(await store.fillsFor(position.id))` rebuilds what is held from the recorded fills, *"which are the only record that survives a process. Without this every cycle would start flat and the ladder would be rebuilt from level zero, forever."* The retire CLI rebuilds its broker the same way, deliberately, so the two agree about what is held.

**The `CycleDeps` handed to the orchestrator**, in the order they appear:

| Dep | Implementation | Notes |
|---|---|---|
| `store` | `PostgresStore(ports.sql)` | Also serves as `securityCache` inside the scan and as the backing store for both caches. |
| `alerts` | `StoredAlertSink(store, onError)` | Writes to the `alerts` table; spools up to 50 *criticals* on failure. |
| `probe` | `async () => config.mode === 'paper' ? 'not-filled' : 'unknown'` | See below. |
| `candlesFor` | `gecko.candles(chain, pairAddress, config.barSize, 1000)`, `null` on throw | One page of 1,000 bars: ~10.4 days at 15m. |
| `healthFor` | decimals → size a probe → `sellProbeFor(chain).assessSell(…)` | See below. |
| `brokerFor` | the cached `PaperBroker` above | |
| `confirmSellable` | a $100 probe; `true` only on `sellQuote === 'ok'` | |
| `recall` | `recallCandidates(store, …)` with `maxAgeMs: 2 * config.scanIntervalMs` | No network at all. |
| `scan` | per chain: `scanOnce` → `store.saveScan` → collect | Sorted across chains by score. |
| `now` | `() => Date.now()` | The only clock in the system. |

**`probe` — "did this pending order actually happen?"** The comment on this three-line function is the longest in the file, and it earns it:

> In PAPER the broker is OURS: deterministic, in-process, and the fills table is the complete record of everything it did. No recorded fill means the order did not happen — a fact about a venue we own, not a guess. […] This said 'unknown' back when the engine had no execution step at all, and that was honest then. It became a lie the moment orders started filling: every position was halted for an order that was merely still scheduled, and five of them sat frozen with nothing wrong.
>
> In LIVE it must go back to 'unknown' until a wallet adapter can ask the chain.

`planRecovery` halts a position on `unknown` (`08-motor.md`, `09-persistencia.md`), and halting is correct when the answer is genuinely unknowable. In paper it was knowable, and the conservative answer froze five healthy positions. The instruction for live mode is explicit and sits in the code, not in a ticket.

**`healthFor` — the death watch's one observation per tick.**

```ts
const referenceUsd = Math.max(position.capitalUsd, 50)
const amountRaw = BigInt(Math.floor((referenceUsd / position.lastPriceUsd) * 10 ** decimals))
```

Two rules:

- **Size against the full position.** *"Probe the FULL position, not a token amount: whether $100 can be sold says nothing about whether the position can leave."* The floor of $50 exists so a tiny position still asks a question big enough to be meaningful.
- **Missing inputs return `null`, never a cheerful default.** If decimals are unknown or `lastPriceUsd` is null or non-positive: *"Reporting nothing is honest; reporting an unfounded 'ok' is not."* An absent observation neither confirms nor clears a death signal, which is exactly the behaviour `assessAssetHealth` is built for.

The returned `AssetHealthObservation` populates only `sellQuote`; `liquidityUsd`, `lpStatus`, the authority flags, `transfersBlocked`, `topHolderMovedPct` and `hoursSinceLastTrade` are all `null`/`'unknown'`. That is a real limit of today's runtime and it is worth stating plainly: **of the seven invalidation signals in the charter, the live engine only ever feeds one.** The others are implemented in the domain (`05-riesgo.md`) and wired to nothing.

**`confirmSellable` — asked again at the moment capital moves.**

```ts
return assessment.sellQuote === 'ok'
```

Not `!== 'blocked'`. The comment: *"'unknown' is not a yes. An unanswered sell path at the moment of entry is exactly the shape of the thing this prevents."* The reason it is asked twice at all is that the scanner's verdict is cached on purpose so the examination budget can rotate — a trade that is fine for ranking and wrong at the instant money commits.

**`scan` — per chain, with per-chain rate-limit deltas.**

```ts
const before = { goplus: { ...goplus.rateLimit }, gecko: { ...gecko.rateLimit } }
```

The counters live on adapters shared by every chain, so they are cumulative. Reporting them raw *"labelled the second chain with the first one's total — a diagnostic that misleads is worse than none."* The first version of these counters reported 556 seconds of waiting inside a 356-second scan, which is how the bug was found. The per-chain line is:

```
[scan:limits] solana goplus={"hits":0,"waitedMs":0} gecko={"hits":21,"waitedMs":116000}
```

The loop is also individually try/caught per chain, logging `[scan:<chain>]` on failure — *"a rate limit on Solana is not a reason to stop looking at BSC"* — and the surviving candidates from every chain are sorted together by `opportunity.score` descending, *"because slots are scarce and the best opportunity should win wherever it lives."*

### 2.4 `CycleConfig` — composed, never edited into the evidence

```ts
cycleConfig: {
  params: { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel },
  gasUsdPerSwap: config.gasUsdPerSwap,
  maxOpenEntries: config.maxDcaPerToken + 1,
  sizing: { ...DEFAULT_SIZING_POLICY, maxOpenEntries: config.maxDcaPerToken + 1 },
  portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: config.totalCapitalUsd, maxPositions: config.maxPositions },
  heartbeatMs: 60 * 60 * 1000,
  idleSlots: {
    idleAfterMs: config.idleSlotHours * 60 * 60 * 1000,
    minScoreEdge: config.minScoreEdge,
  },
},
throttle: new AlertThrottle(30 * 60 * 1000),
```

The spread is the whole point. `DEFAULT_PARAMS.maxUsdPerLevel` stays 5,000 and `PYRAMIDING` stays 10 because the parity harness asserts them against the TradingView trade list. `production-ladder.ts` states the rule:

> Neither number may be expressed by editing `DEFAULT_PARAMS` or `PYRAMIDING`. Those are what TradingView ran and the parity harness asserts them: they are EVIDENCE, and evidence that can be edited to express a preference stops being evidence. Production composes its own values on top.

`config.test.ts` pins both halves of that in a single test — the override works *and* `DEFAULT_PARAMS.maxUsdPerLevel` is still 5,000:

```ts
expect(loadConfig({ ...valid, OPERADOR_MAX_USD_PER_LEVEL: '50' }).maxUsdPerLevel).toBe(50)
expect(DEFAULT_PARAMS.maxUsdPerLevel).toBe(5_000)
```

`maxOpenEntries` appears twice on purpose — once for the broker's own ceiling and once inside the sizing policy — because sizing a ladder for ten rungs while the venue holds six *"would reserve capital for four rungs that are never coming."*

Two constants are hardcoded here rather than configurable: `heartbeatMs` at one hour and the `AlertThrottle` window at thirty minutes. Risk alerts (death exit, halted position, kill switch) bypass the throttle entirely; see `05-riesgo.md`.

### 2.5 `production-ladder.ts` — one home for two numbers

```ts
export const DEFAULT_MAX_USD_PER_LEVEL = 15
export const DEFAULT_MAX_DCA_PER_TOKEN = 5

export function productionLadder(env: Readonly<Record<string, string | undefined>>): ProductionLadder
```

These live in the application layer, not in `config.ts`, because **two consumers need them and neither may own them**: the engine, which sizes and fills the ladder, and the dashboard, which draws it. The file's header records what happened when the dashboard owned its own copy:

> The dashboard drew `DEFAULT_PARAMS` instead and showed a $1,000 rung beside a $15 order for days — a screen disagreeing with the engine about the size of a trade, which is the exact failure `buildDashboard` exists to prevent.

`productionLadder(env)` is what `dashboard/app/page.tsx` and `dashboard/app/api/view/route.ts` call. Its validator is deliberately *softer* than `config.ts`'s: a non-finite or non-positive value falls back to the default rather than throwing, because a web page failing to render over a malformed variable is worse than a web page rendering the default. The engine, which moves money, throws instead.

**Operational consequence worth knowing:** the engine reads these through `loadConfig` in GitHub Actions; the dashboard reads them through `productionLadder` in Vercel. Override `OPERADOR_MAX_USD_PER_LEVEL` in one and not the other and the screen goes back to disagreeing with the engine — the failure this file was created to eliminate, reintroduced through deployment configuration rather than code.

---

## 3. Configuration

### 3.1 The two validators, and the trap in one of them

```ts
const required = (env: Env, key: string): string => {
  const value = env[key]?.trim()
  if (!value) throw new ConfigError(`${key} is required`)
  return value
}

const numberOrZero = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${key} must be zero or a positive number, got "${raw}"`)
  return value
}

const number = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${key} must be a positive number, got "${raw}"`)
  return value
}
```

`?.trim()` on every read is what makes blank equal missing — an empty secret is not a secret, and an env var set to `""` by a CI expression that evaluated to nothing must not read as a configured value. (`config.test.ts` names this behaviour in a test title and then asserts nothing inside it; see §11.6.)

**`number()` rejects zero.** That is right for a capital figure and wrong for `OPERADOR_MAX_CYCLES`, whose documented meaning of zero is "run forever":

```ts
maxCycles: number(env, 'OPERADOR_MAX_CYCLES', 0),
```

The fallback is 0, but the fallback only applies when the variable is **unset or blank**. Setting `OPERADOR_MAX_CYCLES=0` in GitHub Actions to mean "daemon" fails at boot with:

```
OPERADOR_MAX_CYCLES must be a positive number, got "0"
```

The daemon behaviour is reachable only by leaving the variable out entirely. The same trap applies to every other variable in the table below except `OPERADOR_MAX_POSITIONS`, which is the one read through `numberOrZero` and the one where zero has a real meaning.

### 3.2 Every variable the engine reads

Read by `loadConfig` in `src/runtime/config.ts`. "Validator" is the function each goes through; a `—` means the value is a string or an enum checked inline.

| Variable | Validator | Default | Meaning and why the default is what it is |
|---|---|---|---|
| `DATABASE_URL` | `required` | **none** | Postgres connection string. The only truly mandatory variable, and `index.ts` checks it a second time before even importing `pg`, because a missing database should fail before a driver loads. |
| `OPERADOR_MODE` | — | `paper` | `paper` or `live`. **`live` throws unconditionally** — see §3.3. |
| `OPERADOR_CHAIN` | — | `solana` | A comma-separated LIST, not a value: `solana`, `bsc`, or `solana,bsc`. Each entry is trimmed, lowercased and checked. A list because *"the universe spans chains: running one at a time meant the screen showed whichever scanned last and the other looked like it had stopped existing."* `engine.yml` sets `solana,bsc`. |
| `OPERADOR_TIMEFRAME` | — | `15m` | `1h` or `15m` only, mapped to `FIFTEEN_MINUTES = { timeframe: 'minute', aggregate: 15 }` or `ONE_HOUR = { timeframe: 'hour' }`. 15m is the user's decision from live trading: *"on young tokens an hour is long enough for the move to be over before the strategy has an opinion."* Anything else is refused because it is *"a timeframe nobody has measured."* |
| `OPERADOR_CAPITAL_USD` | `number` | `1_000` | Total capital the portfolio allocator splits across slots. Feeds `DEFAULT_PORTFOLIO_POLICY.totalCapitalUsd`. |
| `OPERADOR_MAX_POSITIONS` | `numberOrZero` | `0` | Hard ceiling on concurrent positions. **Zero means no ceiling** — the capital decides, at one ladder's worth each. The reasoning, identical in `config.ts` and `engine.yml`: with every slot the same size, what bounds the damage one token can do is that size, not the count, and a count cap only leaves capital idle. *"$1,500 at a $95 ladder is about fourteen tokens; five was paired with $200 slots."* |
| `OPERADOR_GAS_USD` | `number` | `0.05` | Gas per swap, in USD. Feeds both the paper broker's charge and the derived gas floor (`06-economia.md`), so the ladder is sized against the cost it will actually pay. $0.05 is a Solana figure; a congested chain at $0.20 moves the floor to $20. |
| `OPERADOR_CYCLE_MS` | `number` | `300_000` (5 min) | Time between PASSES. On 15m bars this sets how quickly a closed bar gets acted on. |
| `OPERADOR_SCAN_MS` | `number` | `3_600_000` (1 h) | How often a pass is also a full scan. Separate clock because the halves cost wildly different amounts; see §4.2. |
| `OPERADOR_HEALTH_MS` | `number` | `600_000` (10 min) | Documented as "how often the death watch re-probes the sell path." **It is loaded, validated, and then never read by anything** — see §11.1. |
| `OPERADOR_MAX_CYCLES` | `number` | `0` (never) | Stop after this many *successful* cycles. `main()` passes it only when `> 0`. `engine.yml` sets 120. See the zero trap in §3.1 and the failure-counting gotcha in §4.6. |
| `OPERADOR_MAX_SECURITY_CHECKS` | `number` | `20` | Tokens per chain given the expensive treatment each scan. Each costs about five serial rate-limited calls — ~9 s on Solana, ~6 s on BSC — so 20 keeps a two-chain scan near five minutes. What the budget cannot reach is reported as **unchecked**, not dropped. |
| `OPERADOR_MAX_USD_PER_LEVEL` | `number` | `15` (`DEFAULT_MAX_USD_PER_LEVEL`) | USD cap per ladder rung in production. At 15 the ladder is **flat**, not growing: `min(1000 × (1 + 1.2n), 15)` is $15 at every level, $150 over ten fills, where gas at $0.05/swap is 0.33% of each — *"which is what makes a ladder this small viable at all."* Explicitly **not** `DEFAULT_PARAMS.maxUsdPerLevel` (5,000), which is evidence. |
| `OPERADOR_IDLE_HOURS` | `number` | `3` | Hours a reserved slot may sit without a single fill before returning to the pool. A slot is handed out *before* the strategy enters, so a token whose gates never line up holds capital against nothing — measured live at five hours and twenty minutes. Three hours is twelve bars at 15m, *"most of the 20-bar swing-high window the classic entry gate looks back over, so the setup had a fair chance."* |
| `OPERADOR_MAX_DCA` | `number` | `5` (`DEFAULT_MAX_DCA_PER_TOKEN`) | DCA rungs production will actually fill, per token. The entry is not one of them, so 5 means **six open entries**. The user's reasoning is the ladder's own geometry: with `linInc` at 3, DCA-5 already needs a 13% fall and DCA-10 needs 28%, and *"a token down 28% is rarely an opportunity."* Explicitly **not** `PYRAMIDING` (10), which parity asserts. |
| `OPERADOR_MIN_SCORE_EDGE` | `number` | `10` | Points a waiting candidate must beat a flat position by to take its slot. Not zero on purpose: *"the opportunity score is a heuristic that moves bar to bar, so swapping on any difference would trade the book against its own noise and pay gas for it."* |
| `SOLANA_RPC_URL` | — | `https://api.mainnet-beta.solana.com` | **Loaded and never consumed** — Solana's sell probe is Jupiter's HTTP API, which needs no RPC. See §11.1. |
| `BSC_RPC_URL` | — | `https://bsc-dataseed.binance.org` | The JSON-RPC endpoint behind `PancakeSwap.assessSell` and `Erc20Decimals`. The default is noted in the code as *"Confirmed reachable without a key; Ankr's public endpoint now requires one."* |

### 3.3 Variables read elsewhere

`loadConfig` is not the whole surface. These are read directly by other processes, and none of them go through `ConfigError`:

| Variable | Read by | Notes |
|---|---|---|
| `OPERADOR_CONTROL_TOKEN` | `dashboard/app/api/control/route.ts`, `src/runtime/demo-server.ts` | The one credential that can change anything, and it can only ever *stop* the engine. Minimum 24 characters or the endpoint refuses everything. **The engine itself never reads it** — the kill switch is read from the store — yet `engine.yml` passes it anyway (§11.2). |
| `DATABASE_URL` | `dashboard/lib/store.ts`, `dashboard/app/api/state/route.ts` | The dashboard opens its own pool against the same database. |
| `OPERADOR_MAX_USD_PER_LEVEL`, `OPERADOR_MAX_DCA` | `productionLadder(process.env)` in `dashboard/app/page.tsx` and `dashboard/app/api/view/route.ts` | Must match the engine's, or the screen lies about trade size. |
| `OPERADOR_GAS_USD`, `OPERADOR_MAX_DCA` | `src/runtime/retire.ts` | Read with `Number(process.env.X ?? default)` — **unvalidated**. A malformed value becomes `NaN` here instead of a `ConfigError`. See §6.4. |
| `PORT`, `OPERADOR_DASHBOARD_PORT`, `OPERADOR_DASHBOARD_URL`, `OPERADOR_DEMO_ALERT_MS` | `src/runtime/demo-server.ts` | Demo only. |
| `OPERADOR_SMOKE` | `src/application/*.smoke.test.ts` | Gates the tests that hit real APIs. |

### 3.4 Live mode refuses to start

```ts
if (config.mode === 'live') {
  throw new ConfigError(
    'live mode is not available: no wallet adapter has been built or audited. ' +
      'Run OPERADOR_MODE=paper until one exists and has been reviewed.',
  )
}
```

The refusal is unconditional and cannot be bypassed by any other variable. The comment: *"Live mode is not a flag you drift into. Nothing in this repo can place a real order yet, so refusing is the only honest answer."*

`config.test.ts` asserts two separate things about it, and the second is the interesting one:

```ts
it('refuses live mode while no wallet adapter exists', … toThrow(/no wallet adapter/))
it('the refusal says what to do instead', … toThrow(/OPERADOR_MODE=paper/))
```

An error that stops you without telling you what to do next is a worse error. Pinning the remedy in a test means a future edit cannot quietly drop it.

### 3.5 Eager validation — the whole point of this file

Every numeric variable is validated at boot, before `pg` connects and before a single HTTP call goes out. The header states why:

> Validated eagerly and loudly at boot. A system that holds money must never discover a missing wallet key three hours in, halfway through a ladder — failing to start is a good outcome; starting wrong is not.

In the deployed topology this has a concrete payoff: a broken secret fails in the "Run the engine" step of a GitHub Actions job, visible in red in the Actions tab, rather than mid-ladder on a live position. `engine.yml` says so in a comment on the step itself.

### 3.6 `describeConfig` — an allow list, not a deny list

```ts
export const describeConfig = (config: RuntimeConfig): Record<string, unknown> => ({
  mode: config.mode,
  chains: config.chains.join(','),
  database: config.databaseUrl.replace(/:\/\/[^@]*@/, '://***@'),
  capitalUsd: config.totalCapitalUsd,
  maxPositions: config.maxPositions,
  gasUsdPerSwap: config.gasUsdPerSwap,
  cycleMinutes: config.cycleIntervalMs / 60_000,
})
```

Seven fields, and the test asserts the key set **exactly**:

```ts
expect(Object.keys(described).sort()).toEqual(
  ['capitalUsd', 'chains', 'cycleMinutes', 'database', 'gasUsdPerSwap', 'maxPositions', 'mode'],
)
```

The comment in the test explains why it asserts the shape rather than the absence of one known secret:

> A boot line is copied into issues and pasted into chats. This asserts the SHAPE rather than the absence of one known secret: a field added to the config later cannot leak by being forgotten here, because anything not named is simply never printed.

That is the difference between an allow list and a deny list, stated as a test. The database URL is additionally regex-redacted: `postgres://user:secret@host:5432/db` prints as `postgres://***@host:5432/db`.

The resulting boot line is the first thing in every Actions log:

```
[boot] {"mode":"paper","chains":"solana,bsc","database":"postgres://***@ep-x.aws.neon.tech/neondb","capitalUsd":1000,"maxPositions":0,"gasUsdPerSwap":0.05,"cycleMinutes":5}
```

---

## 4. The supervised loop

### 4.1 What a `setInterval` would not give you

`src/runtime/loop.ts` opens with the three properties it exists for:

> 1. **A cycle never overlaps itself.** Cycles take as long as the providers take; an interval that fires regardless would run two engines over the same positions.
> 2. **A failed cycle does not kill the process.** Providers go down. The loop backs off, alerts once, and tries again — and it says so when it recovers, because an error with no "resolved" is an error you keep worrying about.
> 3. **Shutdown is clean.** A SIGTERM mid-cycle finishes that cycle before exiting. Dying between "decided" and "persisted" is exactly the state recovery has to untangle, so not creating it is cheaper than handling it.

Property 1 is enforced twice, at two layers: `await runCycle(...)` then `await sleep(...)` inside the loop, and `concurrency: { group: engine, cancel-in-progress: false }` in `engine.yml` for the case where GitHub starts a second *run*.

### 4.2 The two cadences

The single most consequential decision in this file. `LoopOptions` carries two intervals:

```ts
readonly intervalMs: number        // between PASSES
readonly scanIntervalMs?: number   // how often a pass ALSO scans
```

and the kind of each pass is decided by one expression:

```ts
const kind: CycleKind =
  options.scanIntervalMs === undefined || lastScanAt === null || deps.now() - lastScanAt >= options.scanIntervalMs
    ? 'full'
    : 'watch'
```

| | `watch` | `full` |
|---|---|---|
| What it does | recover, halt, advance every open position, checkpoint | all of that, then discovery, scoring, ranking, allocation |
| What it costs | one candle request and one sell probe per position — *under a minute for five* | hundreds of throttled calls, *about half an hour* |
| Default cadence | every 5 minutes (`OPERADOR_CYCLE_MS`) | every hour (`OPERADOR_SCAN_MS`) |

The justification appears verbatim in four separate files — `loop.ts`, `config.ts`, `orchestrator.ts` and `engine.yml` — which is a reasonable signal of how load-bearing it is:

> A token you HOLD can rug in ten minutes; an opportunity missed by an hour is a missed opportunity and nothing worse.

The measured failure it fixes: sharing one clock meant the cheap half ran at the pace of the expensive one, and **a held token got attention every ~35 minutes on 15-minute bars.**

Three details:

- **`scanIntervalMs` omitted means every pass is a full cycle** — the original behaviour, kept and tested (`'scans every pass when no scan interval is set — the old behaviour, unchanged'`).
- **`lastScanAt` is stamped AFTER the pass, not before**: *"the interval is time between the end of one scan and the start of the next, so a scan that took half an hour does not immediately owe another one."*
- **A watch pass still allocates**, from the shelf, via `recall` — see `08-motor.md`. It is a strict prefix of a full pass in everything except where its candidates come from.

### 4.3 "It begins with what it already knows"

```ts
let lastScanAt: number | null = (await deps.recall?.())?.scannedAt ?? null
```

One line, and it fixes a measured pathology. The comment:

> A shelf fresh enough to ALLOCATE from is fresh enough to START from.
>
> The first pass always scanned, so every restart spent half an hour of throttled discovery before it could put anything in a free slot — with a scan minutes old sitting in the database. Cancel a run, relaunch it, and the clock started over: **three relaunches in twenty-three minutes never once reached the allocation step**, and from outside that is indistinguishable from a book that refuses to grow.

`recall` returns `null` when the shelf is missing or past its window, so `lastScanAt` stays null and the first pass scans — the right answer in that case. Three tests pin all three branches: a recent shelf means zero scans on the first pass, no shelf means one, and a shelf past its window means one.

This matters far more under the long-run Actions design than it would under a daemon, because every cancel-and-redeploy is a restart. Without it, shipping a fix cost half an hour of blindness on top of the restart.

**Coupling worth knowing:** `recall`'s own staleness window is `2 * config.scanIntervalMs` (two hours by default) — *"one missed scan is a delay, two is a shelf nobody should be spending from"* — while the loop's scan trigger is `scanIntervalMs` (one hour). A shelf between one and two hours old is therefore both "too old to skip scanning" and "fresh enough to allocate from", which is intended. But the two numbers move together: changing `OPERADOR_SCAN_MS` changes both.

### 4.4 Failure, backoff and recovery

```ts
} catch (error) {
  failures++
  consecutiveFailures++
  const degraded = alert('provider-degraded', '⚠️ Ciclo fallido', String(error).slice(0, 300), deps.now(), { consecutiveFailures })
  if (throttle.shouldSend(degraded)) await deps.alerts.send(degraded)

  const backoff = Math.min(baseBackoff * 2 ** (consecutiveFailures - 1), maxBackoff)
  await sleep(backoff)
  continue
}
```

| Knob | Default | Why |
|---|---|---|
| `backoffMs` | 30,000 | First wait after a failure. |
| `maxBackoffMs` | 600,000 (10 min) | *"caps the backoff so a long outage does not become an hour of silence"* — the test's own title. |

Doubling: 30 s, 1 m, 2 m, 4 m, 8 m, then 10 m forever. The reason for backing off at all is stated as a causal claim, not a nicety: *"hammering a provider that is already failing is how a temporary outage becomes a rate-limit ban."*

And the recovery announcement:

```ts
if (consecutiveFailures > 0) {
  await deps.alerts.send(alert('provider-degraded', '✅ Recuperado', `De vuelta a la normalidad tras ${consecutiveFailures} ciclo(s) fallido(s).`, deps.now()))
  consecutiveFailures = 0
}
```

Same `kind`, different title — the test asserts `degraded[1].title !== degraded[0].title` rather than matching prose, and says why: *"these strings are display copy and were once coupled tightly enough that translating the app broke the test suite."* Every loop test asserts alert **kind** and numbers, never wording. That is the convention to follow when adding one.

### 4.5 Shutdown

```ts
let stop = false
options.stopSignal?.then(() => { stop = true })
```

The signal only sets a flag, and the flag is checked in two places: at the top of the loop, and again immediately after the cycle completes —

```ts
// Checked again after the cycle so a stop during a long cycle takes effect
// immediately rather than after another full interval of sleeping.
if (stop) break
await sleep(options.intervalMs)
```

A test pins that a stop raised during a cycle never sleeps the interval (`expect(sleeps).not.toContain(9_999)`), and another pins that a signal resolved *before* the loop starts still lets one whole cycle finish.

`shutdownSignal` turns POSIX signals into that promise, and takes its `on` and `exit` as injectable parameters purely so it can be tested without touching the real process:

```ts
export function shutdownSignal(
  on: (signal: string, handler: () => void) => void = (s, h) => { process.on(s as NodeJS.Signals, h) },
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void>
```

A **second** SIGINT/SIGTERM exits immediately with code 1: *"if someone is pressing Ctrl-C twice they want out now, and refusing would be arrogance rather than safety."*

The `Dockerfile`'s `STOPSIGNAL SIGTERM` exists so a `docker stop` reaches this path rather than being a kill.

### 4.6 What the loop reports, and two things it does not

Every completed pass calls `onPass`, and `main()` logs:

```
[watch] {"positions":5,"bars":1,"opened":0,"released":0,"halted":0,"seconds":41}
[full]  {"positions":5,"bars":1,"opened":2,"released":1,"halted":0,"seconds":1834}
```

The reason this exists is the same reason the heartbeat exists:

> A WATCH pass prints nothing of its own — it runs no scan, so there is no progress to report — and four minutes of empty log looked exactly like a hung process. It was a working engine advancing bars. A silent engine is indistinguishable from a dead one.

`bars` is `Math.max(...)` over every tick's `barsAdvanced`, so it reports the *deepest* catch-up walk in the pass rather than a sum.

Two gotchas live in the `catch` block's `continue`:

- **A failed cycle does not increment `cycles`.** `maxCycles` therefore counts only *successful* passes. A provider outage that fails every pass never terminates via `max-cycles`; it loops at the 10-minute capped backoff until `stopSignal` fires or the job's 350-minute timeout kills the run. The `[exit]` line will then report fewer cycles than the run actually attempted.
- **A failed pass never calls `onPass`.** The `continue` skips both `onPass` and the interval sleep, so a failing pass produces only the throttled `provider-degraded` alert and *no* `[full]`/`[watch]` log line. `loop.test.ts` pins this — but under the title `'reports a failed pass too, rather than going quiet on the one that matters'` while asserting `expect(passes).toEqual([])`. **The title says the opposite of the assertion.** Trust the assertion; the title describes a behaviour the loop does not have.

Two alerts bracket every run, both of kind `engine-started`: `🚀 Operador by Open Doors / Motor iniciado.` before the first iteration, and `🛑 Motor detenido / N ciclo(s), M fallo(s).` after the last.

Finally, `main()` closes with:

```
[exit] "max-cycles" 120 cycles
```

`stoppedBy` is `'max-cycles'` or `'signal'`. There is no third value: a crash inside `runLoop` propagates to `index.ts`, which logs `[fatal]` and sets `process.exitCode = 1`.

---

## 5. Deployment: GitHub Actions

### 5.1 Why a scheduler and not a server

`DEPLOY.md` corrects the charter in its own words, and the correction is worth quoting because the original claim was wrong in a specific, checkable way:

> El charter decía que el motor tenía que ser un proceso permanente, por suscripciones WebSocket. **Eso ya no es cierto y hay que decirlo:** no queda ni un WebSocket en el código.

Every adapter — DexScreener, GoPlus, Jupiter, GeckoTerminal, PancakeSwap — is HTTP polling, and every piece of state (positions, ladder, death watch, in-flight orders, the alert log) is in Postgres. A cycle reads the database, decides, writes, and exits. **There is nothing for a long-lived process to hold between cycles because there is nothing in memory.**

That is what makes the scheduler honest rather than a shortcut, and it is also the thing to re-check before trusting it again: the moment one WebSocket subscription or one in-memory cache that must outlive a cycle appears, the argument collapses and the Docker image becomes the answer instead.

Vercel still cannot host the engine, and the reason is unchanged: a serverless function has no continuity. A scheduler is not a serverless runtime — it starts a whole process, which is all a cycle ever needed.

### 5.2 One long run, not many short ones

`engine.yml` used to ask GitHub to fire every 15 minutes and run exactly one cycle. The measurement that killed that design:

> Measured over twelve hours, that produced THREE scheduled runs, 137 and 172 minutes apart. Every short gap in the run list was a `workflow_dispatch` — a human pressing the button. GitHub's cron is best effort and it deprioritises high-frequency schedules; a `*/15` that lands hourly-or-worse is the normal case, not an outage.

The fix inverts the dependency. One run now holds the loop open for hours and **paces itself** at the configured cadence:

> The cron only has to succeed once every ~5.5 hours, and the worst gap ever measured was 2h52m — an unreliable dependency turned into a reliable one by asking it for far less.

### 5.3 The cron as a queue

The schedule is still `*/15`, for a different reason:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

concurrency:
  group: engine
  cancel-in-progress: false
```

With that concurrency group, a fire landing during a run becomes the **pending** run and starts the moment the current one exits. GitHub keeps at most one pending run per group — a newer arrival cancels the older pending one — so frequent firing cannot pile up a backlog. It just keeps one run always ready, which makes the gap between long runs **seconds**.

`cancel-in-progress: false` is the safety half: *"A cycle writes to the database. Two at once would both try to open positions against the same capital, so a late run waits rather than overlapping."*

### 5.4 The job

```yaml
jobs:
  cycle:
    runs-on: ubuntu-latest
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - name: Run the engine
        env: { … }
        run: npm run cycle
```

`npm run cycle` is `tsx src/runtime/index.ts` — TypeScript straight from source, which is fine on a runner and deliberately *not* how the Docker image runs (§8.2).

**`timeout-minutes: 350`** is ten minutes under GitHub's 6-hour job ceiling, *"so the loop's own budget is what ends the run and the cancel is never what ends a cycle mid-write."*

The environment block, with every default:

| Variable | Value in `engine.yml` |
|---|---|
| `DATABASE_URL` | `secrets.DATABASE_URL` |
| `OPERADOR_CONTROL_TOKEN` | `secrets.OPERADOR_CONTROL_TOKEN` (unused by the engine — §11.2) |
| `OPERADOR_MODE` | `paper` (hardcoded) |
| `OPERADOR_CHAIN` | `solana,bsc` (hardcoded) |
| `OPERADOR_TIMEFRAME` | `15m` (hardcoded) |
| `OPERADOR_CAPITAL_USD` | `vars.OPERADOR_CAPITAL_USD \|\| '1000'` |
| `OPERADOR_MAX_POSITIONS` | `vars.OPERADOR_MAX_POSITIONS \|\| '0'` |
| `OPERADOR_GAS_USD` | `vars.OPERADOR_GAS_USD \|\| '0.05'` |
| `OPERADOR_MAX_SECURITY_CHECKS` | `vars.OPERADOR_MAX_SECURITY_CHECKS \|\| '20'` |
| `OPERADOR_CYCLE_MS` | `vars.OPERADOR_CYCLE_MS \|\| '300000'` |
| `OPERADOR_SCAN_MS` | `vars.OPERADOR_SCAN_MS \|\| '3600000'` |
| `OPERADOR_MAX_CYCLES` | `vars.OPERADOR_MAX_CYCLES \|\| '120'` |

Note what is **not** there: `OPERADOR_MAX_USD_PER_LEVEL`, `OPERADOR_MAX_DCA`, `OPERADOR_IDLE_HOURS`, `OPERADOR_MIN_SCORE_EDGE`, `BSC_RPC_URL`. All of those run on their code defaults in production, which is intentional — but it also means changing the production ladder requires editing `production-ladder.ts`, not setting a variable, unless you add the variable to both this workflow and Vercel.

`OPERADOR_MAX_CYCLES: 120` is described as generous: with watch passes cheap, *"the 350-minute job timeout is what ends a run, not this. It is here so a pathological loop cannot spin forever."* At a 5-minute cadence 120 passes is about 10 hours of pass time, comfortably more than the job can live.

### 5.5 A run pins its commit

The property that costs the most in daily use, stated in the workflow's own header:

> **A RUN PINS ITS COMMIT.** The checkout happens once, at the start, so a run started at 18:23 keeps running that code until it exits — a fix pushed at 18:30 does not reach production for another five hours. That is the price of the long loop, and it is paid on every deploy. To ship immediately: cancel the run and start a new one. Cancelling mid-cycle is safe by construction — fills are persisted as they happen and recovery reconciles anything that was in flight.

Two things make that remedy safe rather than reckless, and both are documented elsewhere in this system:

- **Fills are persisted as they happen**, keyed by the client's idempotency key with `ON CONFLICT DO NOTHING` (`09-persistencia.md`), so a cancel cannot double-buy on the way back.
- **Recovery runs first on the next boot** and answers "did this order actually happen?" with three possible answers, one of which is *halt and ask a human* (`08-motor.md`).

And the seeding fix of §4.3 is what makes the restart cheap: the new run allocates from the existing shelf instead of re-discovering the universe.

**Deploy procedure, in full:**

1. Push the fix. `tests.yml` runs on the push.
2. Actions → engine → cancel the in-progress run.
3. The pending run (there is almost always one, thanks to the `*/15` queue) starts within seconds on the new commit — or press **Run workflow** if there is none.
4. Watch for `[boot]` and then the first `[watch]`/`[full]` line.

### 5.6 The other two workflows

**`retire.yml`** — `workflow_dispatch` only, `timeout-minutes: 5`, three typed inputs (`chain` as a `choice` of `solana`/`bsc`, `address`, `reason`). It is deliberately a separate file:

> Separate from `engine` on purpose. The engine decides for itself and runs unattended; this is a person overruling it. Sharing a workflow would mean sharing a schedule, and **nothing here should ever run on a timer.**

It runs concurrently with the engine on purpose, and the header explains why that is survivable: *"the sale is recorded as a fill with its own idempotency key, and the fills are what the broker is rebuilt from — so the next cycle sees a flat position and a token that recovery now skips."*

**`tests.yml`** — two jobs on push to `master`/`main`, on pull requests, and on dispatch:

| Job | Timeout | Steps |
|---|---|---|
| `verify` | 15 min | `npm ci` → `npx tsc --noEmit` → `npx vitest run` |
| `dashboard` | 10 min | `npm ci` → `npm run build`, **with `working-directory: dashboard`** |

The second job exists because of a specific shipped failure:

> A local `next build` resolves modules through the REPOSITORY's node_modules, so a file under `src/` importing a dev-only package (vitest, say) compiles happily here and fails on Vercel, which installs only dashboard's own dependencies. **That exact mistake shipped a broken deploy once.** This job installs nothing but `dashboard/package.json`, so the two agree or this fails.

Note the asymmetry: `verify` uses `cache: npm` and `dashboard` deliberately does not configure a cache keyed on the root lockfile — the job's whole purpose is to reproduce an isolated install.

---

## 6. The retire operator workflow

### 6.1 Why it exists

The dashboard is read-only and the control endpoint is one-way safe, so nothing outside the engine can close a position — deliberately. `retire` is the exception, and `src/application/retire.ts` records the case that forced it:

> the first real case arrived fast: a fifteen-day-old memecoin was scanned, ranked and allocated capital under the symbol "BTC", because the impersonation gate knew WBTC and not BTC. The gate is fixed; **the gate only stops NEW positions.**

It also draws a distinction that keeps the audit log meaningful:

> This is not a death exit. A death exit is a VERDICT — the asset stopped being an asset, and the evidence chain is part of the record. Retiring is a DECISION, made by a person for a reason the system could not compute, and calling it a death would put a diagnosis in the log that nothing diagnosed.

Hence its own alert kind, `token-retired`, rather than `death-exit`.

### 6.2 The CLI

```bash
npm run retire -- <chain> <address> "<reason>"
```

`src/runtime/retire.ts` validates **before anything connects**:

| Check | Failure | Exit code |
|---|---|---|
| `chain ∈ {solana, bsc}` | `[fatal] chain must be one of solana, bsc` | 1 |
| address present | `[fatal] a token address is required` | 1 |
| `reason.length >= 10` | `[fatal] a reason is required, and it has to say something` | 1 |
| `DATABASE_URL` present | `[fatal] DATABASE_URL is required` | 1 |
| use case refuses | `[refused] <reason>` | **2** |

The ten-character minimum is not arbitrary fussiness:

> A retirement with no reason is a row in the blacklist that nobody can audit later, and "why is this token banned" is the only question that row exists to answer.

**The two exit codes are distinct on purpose**, and a script that only checks for non-zero conflates them: 1 means *you typed it wrong*, 2 means *the system declined*. There is exactly one refusal today (§6.3).

The pool is `max: 2` (against the engine's 4), and `pg` is dynamically imported here too.

### 6.3 What it does, in order

`retireToken` in `src/application/retire.ts`:

1. Find the open position by `${chain}:${tokenAddress}`.
2. **No position?** Blacklist and return. The blacklist alone is the whole job — it is what stops the scanner offering the token next cycle.
3. Rebuild the broker from `store.fillsFor(position.id)` — *"exactly as the engine does it. The fills are the facts; anything else would be a second opinion about what is held."*
4. Read the holding with `broker.snapshot(position.lastPriceUsd ?? 0).size`. Size does not depend on the mark, so it can be read without a price — *and it must be*, because the next step is exactly the case that needs refusing.
5. **Refuse** if `holding > 0 && position.lastPriceUsd === null`:
   > `${symbol} tiene tokens y no hay precio medido para venderlos. No se inventa un precio: la posición queda intacta.`

   Inventing a price *"would put a fiction in the ledger every other number in this system is derived from"* — and the ledger is what realised profit and the common fund are computed from (`08-motor.md`).
6. Sell everything with one `closeAll`, recording each fill with the key `retire:${position.id}:${at}:${index}` — keyed by the retirement instant, not by a bar, *"because this sale was not decided by any bar, and pretending otherwise would collide with a real order the engine might key the same way."*
7. `closePosition(id)` **then** `blacklist(chain, address, reason, at)`.
8. Send the `token-retired` alert with the reason, the proceeds, and the count of cancelled pending orders.

**Step 7's order is the one to remember**, and the comment gives the asymmetry:

> Closing before blacklisting can leave the token eligible for a new position — annoying, and fixed by running this again. Blacklisting first would leave an ABANDONED bag: skipped by recovery, still held, its capital counted as free. One is a retry; the other is a silent hole.

That is also why blacklisting *alone* would be worse than doing nothing: `planRecovery` skips a blacklisted position, so the position stops being ticked while its tokens stay bought, and it drops out of the committed total — *"which is how the portfolio quietly hands the same dollars to somebody else."*

### 6.4 One-way safety, and one unvalidated edge

Retire is one-way safe in the same sense as the kill switch: **it can only ever leave the system holding less.** It cannot open a position, size one, or move capital toward anything.

The rough edge: `retire.ts` does not call `loadConfig`. It reads two variables directly:

```ts
gasUsdPerSwap: Number(process.env.OPERADOR_GAS_USD ?? 0.05),
maxOpenEntries: Number(process.env.OPERADOR_MAX_DCA ?? 5) + 1,
```

A malformed `OPERADOR_GAS_USD` yields `NaN` here rather than a `ConfigError`, and `NaN` gas would propagate into the recorded fill's `costUsd`. `retire.yml` only ever passes `OPERADOR_GAS_USD` from a repository variable, so the realistic exposure is a typo in the Actions variables page — but it is an inconsistency with the eager-validation rule that governs everything else in this layer.

---

## 7. The demo server

`src/runtime/demo-server.ts`, run with `npm run dev:phone-api`, serves the phone API on **port 3101** backed by `MemoryStore`.

Its design rule:

> The Android app needs something to talk to before a database exists, and a hand-rolled fake would test the fake. This runs the REAL read models, the REAL authorisation and the REAL kill switch against `MemoryStore` — so what it proves about the app transfers, and **the only thing not exercised is the SQL.**

| Route | Behaviour |
|---|---|
| `GET /api/phone` | `buildPhoneStatus(store, { now })` — the real read model. |
| `GET /api/alerts?since&limit` | `store.alertsSince(since, limit)`; limit defaults to 50 and is capped at 200; returns `{ alerts, cursor }` where the cursor is the last `seq`. |
| `GET /api/control` | `killSwitchStatus(store)`. |
| `POST /api/control` | `authoriseControl(TOKEN, …)`, then `engageKillSwitch` / `disengageKillSwitch`. Anything but `kill`/`resume` is a 400. |
| anything else | 302 to the dashboard's `/demo`. |

Two details that are decisions:

- **The redirect derives its host from the client's `Host` header**, not a constant: *"a phone that connects to 10.0.2.2 or to a LAN address cannot follow a redirect to `localhost`, because on a phone localhost is the phone."*
- **It invents an alert every 45 seconds**, rotating a six-entry script that covers every level the phone treats differently (`dca-filled`, `ladder-frozen`, `death-exit`, `heartbeat`, `position-halted`, `scan-empty`), *"because an alerting channel you cannot watch arrive is a channel you have not tested."*

**Do not point this at real state.** Its default token is the literal string `demo-token-not-for-real-money` and it prints the active token to stdout on boot. That is correct for a demo and catastrophic anywhere else.

---

## 8. Docker: the migration path

The image is not used in the deployed topology. It exists so that moving to a real daemon — Oracle Always Free ARM, or a $5/month VPS before real capital — is *"un deploy, no una reescritura."*

### 8.1 The build stage is the gate

```dockerfile
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
…
RUN npx tsc --noEmit && npx vitest run --reporter=dot
```

> The suite is the gate. An image that cannot pass its own tests never ships.

And the platform comment:

> Oracle's Always Free tier is Ampere ARM, so that is the target. A native module without an ARM build fails HERE, at image build time, rather than at 3am on the VPS.

**Read that promise precisely.** `--platform=$BUILDPLATFORM` is on the **build** stage only, so `tsc` and `vitest` run natively (fast) on whatever machine is building. The arm64 target is supplied by the buildx invocation, and the runtime stage inherits it. So the "fails here" guarantee applies to the runtime stage's `npm ci --omit=dev`, and only when you actually build with `--platform linux/arm64`. Building without it produces an image that will not run on Ampere.

### 8.2 The runtime stage

```dockerfile
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5m --timeout=10s --start-period=1m --retries=3 CMD node -e "process.exit(0)"
CMD ["node", "dist/runtime/index.js"]
```

| Line | Reasoning |
|---|---|
| compiled JS, not `tsx` | *"tsx or ts-node in production means the runtime depends on a transpiler being healthy, which is one more thing to go wrong at 3am."* Note the contrast with `npm run cycle` on Actions, which does use `tsx`. |
| `USER node` | *"A container that holds wallet keys has no business running as a user that can rewrite its own filesystem."* |
| `STOPSIGNAL SIGTERM` | Reaches `shutdownSignal`, so `docker stop` finishes the current cycle instead of dying between "decided" and "persisted". |
| `npm ci --omit=dev` | Where a missing ARM build of a native dependency surfaces. |

**The `HEALTHCHECK` is a no-op.** `node -e "process.exit(0)"` always succeeds: it proves the node binary exists in the image and nothing about whether the engine is cycling. Do not read a healthy container as a healthy engine. The real liveness signals are the heartbeat alert and the `checkpoint` row — which is exactly what the Android app watches, and why it can say *"motor en silencio desde …"* when a container is happily green.

### 8.3 `docker-compose.yml` is for local runs, and it is stale

```yaml
services:
  engine:
    build: .
    restart: unless-stopped
    environment:
      OPERADOR_MODE: paper
      OPERADOR_CHAIN: solana
      DATABASE_URL: ${DATABASE_URL}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
      OPERADOR_CAPITAL_USD: ${OPERADOR_CAPITAL_USD:-1000}
      OPERADOR_MAX_POSITIONS: ${OPERADOR_MAX_POSITIONS:-5}
      OPERADOR_CYCLE_MS: ${OPERADOR_CYCLE_MS:-300000}
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

Three ways it no longer matches the system (details in §11.3): the Telegram pair was removed from the codebase entirely and is silently ignored; `OPERADOR_CHAIN: solana` means BSC vanishes from the universe view; and `OPERADOR_MAX_POSITIONS` defaults to 5 where the code and the workflow default to 0. **Running compose is not running what Actions runs.**

The log rotation (`10m × 3`) is the one part that is purely about the container: on a small VPS, unbounded JSON logs from a process that prints a line per pass will fill the disk before anything else does.

---

## 9. The $0 stack

### 9.1 Topology

| Component | Runs on | Cost | Why there |
|---|---|---|---|
| Engine — scanner, executors, death watch | **GitHub Actions**, one long self-paced run | $0 | Unlimited minutes on a public repo. Oracle Always Free ARM is the upgrade path. |
| State & event log | **Postgres** — Neon or Supabase free tier | $0 | Durable truth. Engine memory is a cache, never the source. |
| Dashboard | **Vercel** Hobby (Next.js, read-only) | $0 | Where Vercel actually belongs: a read model, not a runtime. |
| Alerts + kill switch | **Android app**, reading the alert log | $0 | Unattended ≠ unobservable. |

`DEPLOY.md` walks it in seven steps: Neon → control token → repo → secrets → first manual run → Vercel → phone.

### 9.2 The minutes math

| Repo visibility | Actions minutes | A 15-minute cycle |
|---|---|---|
| Public | unlimited | fits comfortably |
| Private | 2,000/month free | **does not fit** (~2,900 needed) |

The documented workaround for a private repo is changing the cron to `*/30`, which lands around 1,700 minutes. Note that under the long-run design the cron frequency mostly controls *how fast a finished run is replaced*, so `*/30` costs a worse worst-case gap rather than half the coverage.

### 9.3 Service-specific gotchas

| Service | Gotcha |
|---|---|
| **Neon** | 0.5 GB on Free. The alert log is the only table that grows without bound. |
| **Supabase** | Take the **Connection Pooling** string (port **6543**), not the direct one. |
| **Vercel** | Root Directory is `dashboard`, and **"Include files outside of the Root Directory" must be on** — `DEPLOY.md` calls it *obligatorio*. The dashboard imports the domain and application layers from `src/` so the numbers on screen come from the same functions the engine runs, rather than a second implementation that will eventually disagree. |
| **Vercel** | Hobby allows 100 GB of traffic; a personal dashboard does not approach it. |
| **GitHub** | A scheduled workflow is **disabled after 60 days without a commit** to the repository. This is named in `engine.yml`, in `DEPLOY.md`'s "why no server" section, *and* in its troubleshooting table — because the engine going quiet for this reason looks exactly like the engine being dead. |
| **GitHub** | Cron is best effort; §5.2 has the measurements. |

### 9.4 Free-tier gotchas for the eventual daemon

Carried from the charter and still true for the Oracle path:

1. **Idle reclamation.** Oracle stops instances under ~5% CPU for 24 hours. A bot idling between bars is exactly that profile; the scanner workload should keep CPU above the floor, but this must be monitored rather than assumed.
2. **Terms change without notice.** Oracle halved the Always Free ARM allowance (4 OCPU/24 GB → 2 OCPU/12 GB) on 2026-06-15 and terminated over-limit instances.
3. **ARM architecture.** Build for `linux/arm64`; check native modules before adding a dependency.
4. **Capacity errors** are common on Oracle ARM in popular regions.

And the rule that makes free acceptable at all: **match infrastructure reliability to capital at risk.** During the paper phase there is no money at stake, so a reclaimed instance costs nothing. `DEPLOY.md` states the boundary plainly: *"Antes de poner capital real, mové el motor a un VPS pagado (~5 USD/mes)."*

Free tiers also make crash recovery mandatory rather than optional. An instance that can be stopped for idleness, reclaimed for a terms change, or restarted by the provider *will* go down without warning — which is why recovery is a tested path (`08-motor.md`) rather than a hope.

### 9.5 Starting over: `tools/reset.sql`

Run in Neon's SQL editor. Nothing is reversible, and the engine recreates every table at boot, so nothing has to be put back. The script's value is that it labels each table:

| Group | Tables | Cost of erasing |
|---|---|---|
| **STATE** | `positions`, `fills`, `checkpoint`, `blacklist`, `alerts` | This IS the system. |
| **CACHE** | `scans`, `pool_discovery`, `pool_history`, `token_security` | One slow cycle. |

Two warnings it stops on before the `TRUNCATE`:

- **`fills` is no longer just a history.** Realised profit and the common fund are both derived from it, so truncating it *"does not erase a record — it erases the money you made, and the allocator goes back to believing it has exactly the capital in `OPERADOR_CAPITAL_USD`."*
- **`blacklist` holds the death-exit verdicts.** Emptying it lets the scanner offer a token already proven to be a rug.

The script offers two narrower options, commented out: `TRUNCATE positions, checkpoint` for a fresh book that keeps what was learned (*"usually what 'let's start clean' actually means: a fresh book, not an engine with amnesia"*), and truncating the four cache tables after changing a gate or a scoring policy.

---

## 10. Operating it

### 10.1 What a healthy log looks like

```
[boot] {"mode":"paper","chains":"solana,bsc",…}
[scan:universe] {"stage":"universe","chain":"solana",…}
[scan:budget] {"stage":"budget","chain":"solana",…}
[scan:limits] solana goplus={"hits":0,"waitedMs":0} gecko={"hits":21,"waitedMs":116000}
[scan:limits] bsc goplus={"hits":0,"waitedMs":0} gecko={"hits":14,"waitedMs":71000}
[full] {"positions":5,"bars":1,"opened":2,"released":0,"halted":0,"seconds":1834}
[watch] {"positions":7,"bars":1,"opened":0,"released":0,"halted":0,"seconds":38}
…
[exit] "max-cycles" 120 cycles
```

A `[watch]` line every five minutes is the signal that the engine is alive. Their absence for longer than a cycle interval, with no `[fatal]`, is the shape of a hung provider call — the HTTP timeout is 20 s per request, but a scan makes hundreds of them.

### 10.2 Reading a failure

| Symptom | Where to look |
|---|---|
| The run dies at `[boot]` | Configuration. `loadConfig` names the variable and the bad value. This is the intended failure mode. |
| `[fatal]` with a stack | Something threw out of `runLoop` — not a cycle failure, which is caught. |
| `⚠️ Ciclo fallido` alerts, no `[watch]`/`[full]` lines | Every pass is failing. Remember a failed pass logs nothing and does not count toward `maxCycles` (§4.6). |
| The universe is empty in the dashboard | Did `engine` run at all? Check the Actions tab. |
| The phone says *"motor en silencio desde …"* | The workflow stopped running — check the 60-day disable first. |
| The panel says *"Datos congelados"* | Vercel cannot reach the database; check the function logs, not the engine. |

### 10.3 The kill switch is not in this layer

Worth stating here because it is the one control that deliberately does *not* live in the runtime: the kill switch is a row in the store, read by the cycle, written by `POST /api/control` on Vercel. A switch held in the process could only be thrown by a healthy engine, which is exactly the case where you least need one. See `05-riesgo.md` and `11-vistas.md`.

Consequently there is no environment variable that stops the engine, and `OPERADOR_CONTROL_TOKEN` in `engine.yml` does nothing.

---

## 11. Known drift, dead config, and rough edges

Everything in this section was verified against the source while writing this chapter. It is listed because reference documentation that quietly omits what does not match is worse than none.

### 11.1 Configuration that is loaded and never used

| Variable | Field | Status |
|---|---|---|
| `OPERADOR_HEALTH_MS` | `config.healthIntervalMs` | Validated (default 600,000) and **never read**. `main()` does not pass it to `runLoop`, and `LoopOptions` has no such field. The death watch actually runs via `healthFor` on **every position on every tick**, at the pass cadence. Setting this changes nothing; believing it throttles the sell probes would be wrong. |
| `SOLANA_RPC_URL` | `config.solanaRpcUrl` | Validated (default `https://api.mainnet-beta.solana.com`) and **never read**. Only `bscRpcUrl` is consumed, at `main.ts:104`. Solana's sell probe is Jupiter's HTTP API, which needs no RPC. |

Both are documented in `.env.example`, which makes them look operational. They are not.

### 11.2 `OPERADOR_CONTROL_TOKEN` in `engine.yml`

Passed to the engine job; read only by `dashboard/app/api/control/route.ts` and the demo server. Harmless, but misleading: it suggests the engine authenticates something, when in fact it reads the kill switch from the store and authenticates nothing.

### 11.3 `docker-compose.yml`

| Line | Problem |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram was removed entirely; `loadConfig` does not read them. Silently ignored. |
| `OPERADOR_CHAIN: solana` | Single chain, so BSC disappears from the universe — the exact failure that motivated making `OPERADOR_CHAIN` a list. |
| `OPERADOR_MAX_POSITIONS: …:-5` | Defaults to 5 where `config.ts` and `engine.yml` default to 0. |

### 11.4 `.env.example`

- **`OPERADOR_CYCLE_MS` appears twice** — `180000` on line 13 and `300000` on line 33. Which wins depends on the consumer's last-wins behaviour; either way, two values for one variable in one file is a bug waiting to confuse someone.
- **Six variables the engine reads are not documented there at all**: `OPERADOR_SCAN_MS`, `OPERADOR_MAX_CYCLES`, `OPERADOR_MAX_SECURITY_CHECKS`, `OPERADOR_IDLE_HOURS`, `OPERADOR_MAX_DCA`, `OPERADOR_MIN_SCORE_EDGE`. §3.2 above is the complete list; `.env.example` is not.

### 11.5 `DEPLOY.md`

- Its Variables table lists `OPERADOR_MAX_POSITIONS` default **`5`**; the actual default is **`0`** (no ceiling), in both `config.ts` and `engine.yml`. It also describes it as *"cuántas posiciones a la vez"* without mentioning that zero is meaningful.
- Step 5 tells you to expect `[exit] "max-cycles" 1 cycles` from a manual run. Under the current workflow (`OPERADOR_MAX_CYCLES=120`, `timeout-minutes: 350`) a dispatch run stays in the loop for up to 350 minutes and prints no such line. **Watch for `[boot]` and the first `[full] {...}` instead, then cancel the run when satisfied.**
- `README.md` still says `cp .env.example .env # fill in DATABASE_URL and the Telegram pair`.

### 11.6 Tests

- `config.test.ts` contains an **empty test**: `it('treats blank as missing — an empty secret is not a secret', () => {})`. The behaviour is real (`required()` and every `?.trim()` treat blank as missing) but it is untested and always green.
- The same file's `'refuses to start without a database, a bot token or a chat id'` is a leftover title from the Telegram era; the `valid` fixture now holds only `DATABASE_URL`, so the loop body runs exactly once.
- `loop.test.ts`'s `'reports a failed pass too…'` asserts the opposite of its name (§4.6).

### 11.7 Runtime rough edges

- **The `brokers` Map is never evicted.** Keyed by `position.id`, it grows for the life of the process — across up to 120 passes in a 350-minute run — and a closed position's broker stays resident. Harmless at paper scale, but it has a correctness consequence: **a broker is seeded from fills exactly once per process.** A fill written by something *outside* this process — the retire tool, for instance — is invisible to an already-cached broker until the next run. (The retire tool's own flow is unaffected, because it closes the position and recovery then skips it.)
- **`recall`'s `watchSlots` falls back to 50 when `maxPositions` is 0**, while the live `scan` path passes `config.maxPositions` — i.e. 0 — straight through:

  ```ts
  // recall
  watchSlots: config.maxPositions > 0 ? config.maxPositions : 50,
  // scan
  watchSlots: config.maxPositions,
  ```

  The two ranking policies are therefore not identical when the ceiling is uncapped, which is the production default.
- **`healthFor` labels every observation `source: 'jupiter'`**, including BSC positions probed through PancakeSwap. `AssetHealthObservation.source` is a free-form `string` and it is copied into the death-exit evidence record. The verdict is unaffected; the audit trail is mislabelled, on a field whose entire purpose is saying which source said so.
- **The history gate counts 1H bars, not bars of the configured timeframe.** `history.historyBars(chain, pool)` is called with no `BarSize`, and `GeckoTerminal.historyBars`'s parameter defaults to `ONE_HOUR`. The gate's own failure message says so explicitly (`${bars} bars of 1H history < ${policy.minHistoryBars}`), and `HistoryPort`'s doc comment agrees. So the 250-bar requirement is **~10.4 days of pool age**, not the 2.6 days that `CachedDiscovery`'s comment and the charter's timeframe table state for 15m. This makes the six-hour discovery cache *more* clearly safe, not less — but the "2.6 days" figure quoted in several comments is not what the gate measures.
- **Only one of the seven death-exit invalidation signals is fed in production.** `healthFor` populates `sellQuote` and leaves liquidity, LP status, the authorities, transfer blocking, holder movement and abandonment as `null`/`'unknown'`. The domain implements all of them (`05-riesgo.md`); the runtime supplies one.

---

## 12. Summary of the numbers

| Thing | Value | Source |
|---|---|---|
| HTTP GET timeout | 20,000 ms | `main.ts` (`makeHttpGet` default is 10,000) |
| Jupiter throttle | 1,100 ms | `main.ts` |
| GeckoTerminal throttle | 2,500 ms | `main.ts` |
| PancakeSwap throttle | 250 ms | `main.ts` |
| Engine pool size | 4 | `index.ts` |
| Retire pool size | 2 | `retire.ts` |
| Pass interval | 300,000 ms (5 min) | `OPERADOR_CYCLE_MS` |
| Scan interval | 3,600,000 ms (1 h) | `OPERADOR_SCAN_MS` |
| Shelf staleness window | 2 × scan interval (2 h) | `main.ts` |
| Heartbeat | 3,600,000 ms (1 h) | `main.ts`, hardcoded |
| Alert throttle window | 1,800,000 ms (30 min) | `main.ts`, hardcoded |
| First backoff / cap | 30,000 ms / 600,000 ms | `loop.ts` defaults |
| Max cycles (Actions) | 120 | `engine.yml` |
| Job timeout | 350 min (ceiling 360) | `engine.yml` |
| Cron | `*/15` as a queue | `engine.yml` |
| Security checks per chain | 20 | `OPERADOR_MAX_SECURITY_CHECKS` |
| Tokens per chain per scan | 300 | `main.ts`, hardcoded (`maxTokens`) |
| Universe measured 14/09/2026 | Solana 261, BSC 123 = 384 | `DEPLOY.md` |
| History cache expiry (short counts) | 6 h | `cached-history.ts` |
| Discovery cache expiry | 6 h | `cached-discovery.ts` |
| Alert spool bound | 50 criticals | `store-alerts.ts` |
| Demo server port / alert cadence | 3101 / 45,000 ms | `demo-server.ts` |
| Container log rotation | 10 MB × 3 | `docker-compose.yml` |
| Control token minimum | 24 characters | `DEPLOY.md`, `authoriseControl` |
