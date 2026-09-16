# Persistence and crash recovery

This chapter documents the layer that makes unattended operation survivable: `src/domain/persistence/store.ts` (the `StatePort` contract and its data shapes), `src/infrastructure/persistence/schema.sql` (nine tables and three indexes, each shaped by an argument), `src/infrastructure/persistence/memory-store.ts` and `src/infrastructure/persistence/postgres-store.ts` (the two implementations, one of which is the reference for the other), and `src/application/recovery.ts` (the pure planner that answers *did this actually happen?* for every order that was in flight when the process died). It covers why the idempotency guarantee lives in SQL rather than in TypeScript, why the idempotency key is scoped to the bar an order was **decided** on and never the bar it filled at, why `fills` deliberately has no foreign key to `positions`, why domain objects are JSONB, why an unknown verdict halts a position instead of guessing, and what a restart does step by step. It ends with the sharp edges the source actually contains — including two divergences between the two store implementations and one table that grows without bound.

---

## 1. The premise: memory is a cache, the database is the truth

A **pass** wakes, reconciles, advances every position to the latest closed bar, and writes everything down. Nothing it needs is held in memory between passes — every adapter is HTTP polling, and every piece of state is in Postgres.

Note what that sentence no longer says. This chapter used to claim the engine runs as a **one-shot process** that exits after each cycle (`OPERADOR_MAX_CYCLES=1`), and that is not the production runtime. `.github/workflows/engine.yml:111` sets `OPERADOR_MAX_CYCLES: ${{ vars.OPERADOR_MAX_CYCLES || '120' }}` against `timeout-minutes: 350` and `OPERADOR_CYCLE_MS: 300000`: **one process runs up to 120 passes over nearly six hours**, paced by `runLoop`, and the job timeout is what ends it. See `12-runtime-despliegue.md` §5.2 and §5.4 for why the schedule was inverted that way.

The premise survives the correction, because it never actually rested on the process being short-lived. It rests on **every pass re-reading the world from the store**: `runCycle` recovers from `positions` before it decides anything, so a pass is self-contained whether or not the process outlives it. That is what makes cancelling a run mid-loop safe (`12-runtime-despliegue.md` §5.5) and a crash recoverable at all.

Two things that *do* live for the whole run, stated here so the premise is not read as stronger than it is: the `brokers` Map in `runtime/main.ts:127` — keyed by `position.id`, never evicted, and **seeded from fills exactly once per process**, so a fill written by something outside this process is invisible to an already-cached broker until the next run — and `AlertThrottle`'s window map (`13-telefono-alertas.md` §4.4). Neither is durable state; both are caches whose lifetime is now hours rather than minutes. `12-runtime-despliegue.md` §11.7 has the full list.

The requirement itself is what the header of `src/domain/persistence/store.ts` states:

> The engine's memory is a CACHE. This is the truth. An instance that can be stopped for idleness, reclaimed on a terms change, or restarted by the provider will go down without warning, and it has to come back knowing exactly where it was: mid-ladder, with a death watch armed, with an order it may or may not have already placed.
>
> Everything here is plain data. No classes, no closures, nothing that only exists while a process does.

The consequence that runs through the whole subsystem: **a restart is not "load and continue"**. It is a reconciliation, and the interesting case is not the crash — it is the crash that happened at the one instant where the engine's belief and the venue's record can differ.

---

## 2. The files, and what each one owns

| File | Lines | Owns |
|---|---|---|
| `src/domain/persistence/store.ts` | 206 | `StatePort` (23 methods), `PersistedPosition`, `PersistedFill`, `PersistedScan`, `EngineCheckpoint`, `StoredAlert`, `CachedSecurity`, `idempotencyKeyFor` |
| `src/infrastructure/persistence/schema.sql` | 143 | Nine `CREATE TABLE IF NOT EXISTS` statements and three indexes; every table carries the reason for its shape |
| `src/infrastructure/persistence/memory-store.ts` | 157 | `MemoryStore` — the **reference implementation**, not a stub |
| `src/infrastructure/persistence/postgres-store.ts` | 314 | `PostgresStore`, the `SqlClient` interface, `migrate()`, `num()`, `toFill()` |
| `src/application/recovery.ts` | 125 | `planRecovery`, `orderKeyPart`, `PendingVerdict`, `RecoveryPlan` — a **pure planner**, no side effects |
| `src/application/ledger.ts` | 116 | `positionLedger`, `commonFund` — the single derivation of "what does this hold and what has it made" |
| `src/application/retire.ts` | 146 | `retireToken` — sell, close, then blacklist, in that order |
| `src/application/kill-switch.ts` | — | `engageKillSwitch` / `disengageKillSwitch` / `killSwitchStatus`, all through the checkpoint row |
| `src/infrastructure/notifications/store-alerts.ts` | 65 | `StoredAlertSink` — the alert log's writer, with the bounded critical spool |
| `src/infrastructure/adapters/geckoterminal/cached-history.ts` | — | `CachedHistory` over `pool_history` |
| `src/infrastructure/adapters/geckoterminal/cached-discovery.ts` | — | `CachedDiscovery` over `pool_discovery` |
| `src/runtime/main.ts` | — | The **only** place a real store is constructed: `new PostgresStore(ports.sql)` + `migrate(schemaSql())` |
| `dashboard/lib/store.ts` | 27 | A second, read-only `PostgresStore` over one `pg.Pool({ max: 2 })` |
| `tools/reset.sql` | 40 | The destructive reset, documented by what each table costs to erase |

Tests: `src/application/recovery.test.ts` (202), `src/infrastructure/persistence/postgres-store.test.ts` (107), `src/infrastructure/persistence/alert-store.test.ts` (76), plus the keying tests in `src/application/engine.test.ts`.

> **There is no `memory-store.test.ts`.** `MemoryStore`'s contract is tested inside `recovery.test.ts` (the describe block *"MemoryStore — the reference implementation"*) and `alert-store.test.ts`. Searching for a file by that name finds nothing and invites the wrong conclusion that it is untested.

---

## 3. `StatePort` — the contract, method by method

One interface, two implementations. `migrate()` is deliberately **not** on the port: it is a Postgres implementation detail, not something the domain can express.

### 3.1 Positions

| Method | Signature | Semantics |
|---|---|---|
| `loadPositions` | `() => Promise<readonly PersistedPosition[]>` | The whole working set. Postgres orders by `opened_at`. |
| `savePosition` | `(position) => Promise<void>` | **Upsert.** A position's state is meant to move. |
| `closePosition` | `(positionId) => Promise<void>` | Hard `DELETE FROM positions`. "Removes a closed position from the working set; **its fills remain**." |

There is no archive table. A closed position survives only through its `fills` rows and the `alerts` it raised — which is precisely why §5.2 matters.

### 3.2 Fills

| Method | Signature | Semantics |
|---|---|---|
| `recordFill` | `(fill) => Promise<void>` | "No-op when a fill with the same idempotency key already exists." First write wins. |
| `fillsFor` | `(positionId) => Promise<readonly PersistedFill[]>` | Oldest first, ordered by `time`. |
| `allFills` | `() => Promise<readonly PersistedFill[]>` | Every fill ever, **including those of positions that have since closed**. |
| `hasFill` | `(idempotencyKey) => Promise<boolean>` | The question recovery asks first. |

`allFills` carries the longest comment in the port, and it is the justification for the missing foreign key:

> That inclusion is the point. Realised profit is the common fund the allocator spends, and most of it belongs to positions that are no longer in the working set. `fills` deliberately has no foreign key to `positions` for exactly this reason: a closed position leaves, its trade history does not.

### 3.3 Scans

| Method | Signature | Semantics |
|---|---|---|
| `saveScan` | `(scan) => Promise<void>` | One scanner pass, one chain. |
| `latestScan` | `() => Promise<PersistedScan \| null>` | The single newest row, **whatever chain it belongs to**. |
| `latestScansByChain` | `() => Promise<readonly PersistedScan[]>` | The newest scan of **each** chain. |

The port documents why the second exists at all:

> Separate from `latestScan` because the universe spans chains and a single newest row cannot represent it: scanning BSC would make every Solana token vanish from the screen, which looks exactly like the scanner having stopped finding them.

Callers today: `src/application/recall.ts` and `src/application/universe-view.ts` use `latestScansByChain()`; `src/application/dashboard.ts:67` still uses `latestScan()` — see §12.3.

### 3.4 Checkpoint

| Method | Signature | Semantics |
|---|---|---|
| `saveCheckpoint` | `(checkpoint) => Promise<void>` | Upsert of the singleton row. |
| `loadCheckpoint` | `() => Promise<EngineCheckpoint \| null>` | `null` on an empty table — never a crash. |

`EngineCheckpoint` carries `killSwitchEngaged`, which is how the kill switch becomes durable state rather than process state (§9).

### 3.5 Alert log

| Method | Signature | Semantics |
|---|---|---|
| `recordAlert` | `(alert) => Promise<StoredAlert>` | Appends and **returns the sequence it was given**. |
| `alertsSince` | `(seq, limit = 100) => Promise<readonly StoredAlert[]>` | Oldest first. The cursor is **exclusive**. |
| `latestAlertSeq` | `() => Promise<number>` | `0` when the log is empty. |

`latestAlertSeq` is a separate method on purpose:

> a client asking "am I behind?" must not have to read a page to find out — and reading the FIRST page to learn the LAST sequence is wrong the moment the log outgrows one page.

### 3.6 The three caches

| Method | Signature |
|---|---|
| `discoveredPools` | `(chain) => Promise<{ pools, discoveredAt } \| null>` |
| `recordDiscoveredPools` | `(chain, pools, at) => Promise<void>` |
| `historyBarsFor` | `(chain, poolAddress) => Promise<{ bars, measuredAt } \| null>` |
| `recordHistoryBars` | `(chain, poolAddress, bars, measuredAt) => Promise<void>` |
| `cachedSecurity` | `(chain, address) => Promise<CachedSecurity \| null>` |
| `recordSecurity` | `(chain, address, security, slippagePct, measuredAt) => Promise<void>` |

None of these hold expiry logic. **The store remembers; the caller decides how long a memory counts** — `CachedHistory`, `CachedDiscovery` and `scan.ts` each apply their own window (§10).

### 3.7 Blacklist

| Method | Signature | Semantics |
|---|---|---|
| `blacklist` | `(chain, tokenAddress, reason, at) => Promise<void>` | "Tokens the death exit has condemned. Never traded again." First verdict wins. |
| `blacklisted` | `() => Promise<ReadonlySet<string>>` | Keys are `` `${chain}:${tokenAddress}` ``. |

Note the signature takes `chain: string`, not the `Chain` union used elsewhere in the port — a small asymmetry in the source, not a decision documented anywhere.

---

## 4. The data shapes

### 4.1 `PersistedPosition`

```ts
export interface PersistedPosition {
  readonly id: string
  readonly chain: Chain            // typed, not a free string
  readonly tokenAddress: string
  readonly pairAddress: string
  readonly symbol: string

  readonly cascade: CascadeState       // the strategy's own state machine
  readonly deathWatch: DeathWatchState // including its evidence chain
  readonly quality: MarketQuality      // the death exit's liquidity baseline
  readonly capitalUsd: number

  readonly lastBarTime: number
  readonly lastPriceUsd: number | null
  readonly pendingOrders: readonly Order[]

  readonly openedAt: number
  readonly updatedAt: number
}
```

Three fields deserve their comments quoted:

- **`chain` is typed** because "the sell probe and the candle source are both chosen by it" — a free string here would push a runtime failure into the death watch.
- **`lastPriceUsd`** exists so the death watch can size a sell probe of the right magnitude: "quoting $100 of a token tells you nothing about whether a $5,000 position can leave." See `05-riesgo.md`.
- **`pendingOrders`** is the field the whole subsystem turns on: "A process that dies between 'decided to buy' and 'saw the fill' must not decide again from scratch: it reconciles these against the chain first."

Everything a position needs to resume — level, `ep1`, `cycle_low`, `last_fill`, `dca_armed`, `be_armed`, `bars_since_low`, `await_reentry`, `decay_count` — lives inside `cascade`, which is one JSONB column. The death watch's full evidence chain lives inside `deathWatch`.

### 4.2 `PersistedFill`

```ts
export interface PersistedFill {
  readonly positionId: string
  readonly orderId: string
  readonly side: 'buy' | 'sell'
  readonly time: number
  readonly price: number
  readonly qty: number
  readonly costUsd: number      // spread + impact + gas charged on this fill
  readonly comment: string
  readonly idempotencyKey: string
}
```

`costUsd` is what the chain took, per fill. It is subtracted in `commonFund` (§11.2), because "a fund built on gross profit would be handing the allocator dollars the chain already took."

### 4.3 The rest

```ts
interface PersistedScan    { scannedAt: number; chain: string; snapshots: readonly TokenSnapshot[] }
interface EngineCheckpoint { savedAt: number; lastCompletedBar: number; killSwitchEngaged: boolean }
interface StoredAlert extends Alert { seq: number }
interface CachedSecurity   { security: SecurityReport; slippagePct: number | null; measuredAt: number }
```

`StoredAlert` is the domain `Alert` plus its position in the log. The comment on it is the argument for the whole cursor design:

> The cursor is a SEQUENCE, not a timestamp. Two alerts can share a millisecond, and a timestamp cursor then has to choose between skipping one and replaying it forever — on a channel whose whole job is to deliver a death exit exactly once, neither is acceptable.

---

## 5. `schema.sql` — nine tables, and why each has the shape it has

Every statement is `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe to run on every boot. There is no migration-version table and no `ALTER` path anywhere in the repository; §6.2 explains why that is sustainable rather than negligent.

### 5.1 `positions`

```sql
CREATE TABLE IF NOT EXISTS positions (
  id             TEXT PRIMARY KEY,
  chain          TEXT        NOT NULL,
  token_address  TEXT        NOT NULL,
  pair_address   TEXT        NOT NULL,
  symbol         TEXT        NOT NULL,
  cascade        JSONB       NOT NULL,
  death_watch    JSONB       NOT NULL,
  quality        JSONB       NOT NULL,
  capital_usd    NUMERIC     NOT NULL,
  last_bar_time  BIGINT      NOT NULL,
  last_price_usd NUMERIC,
  pending_orders JSONB       NOT NULL DEFAULT '[]'::jsonb,
  opened_at      BIGINT      NOT NULL,
  updated_at     BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_token_idx ON positions (chain, token_address);
```

The three domain objects are stored verbatim as JSON:

> Stored as JSON on purpose: these are domain types that will keep evolving, and a column per field would turn every strategy change into a migration.

`positions_token_idx (chain, token_address)` is the index behind every "do we already hold this token" question — the orchestrator's `heldNow` set, the retire lookup, the blacklist comparison.

`savePosition` upserts, and **which columns it updates is itself a decision**:

```sql
ON CONFLICT (id) DO UPDATE SET
  cascade = EXCLUDED.cascade,
  death_watch = EXCLUDED.death_watch,
  quality = EXCLUDED.quality,
  capital_usd = EXCLUDED.capital_usd,
  last_bar_time = EXCLUDED.last_bar_time,
  last_price_usd = EXCLUDED.last_price_usd,
  pending_orders = EXCLUDED.pending_orders,
  updated_at = EXCLUDED.updated_at
```

`chain`, `token_address`, `pair_address`, `symbol` and `opened_at` are written once at insert and never touched again — a position's identity cannot drift, only its state.

### 5.2 `fills` — and the foreign key that is deliberately absent

```sql
CREATE TABLE IF NOT EXISTS fills (
  idempotency_key TEXT PRIMARY KEY,
  position_id     TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  side            TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  time            BIGINT  NOT NULL,
  price           NUMERIC NOT NULL,
  qty             NUMERIC NOT NULL,
  cost_usd        NUMERIC NOT NULL,
  comment         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_position_idx ON fills (position_id, time);
```

Two decisions in one table.

**The primary key is the client's idempotency key, not a serial id.** The schema says why:

> That primary key is what makes a retry after an ambiguous network failure safe: the second write collides instead of buying twice.

**There is no `REFERENCES positions(id)`, and its absence is load-bearing:**

> Deliberately NOT a foreign key to positions: fills outlive the position they belong to. A closed position is removed from the working set, and its trade history has to survive that.

`closePosition` is a hard `DELETE FROM positions WHERE id = $1`. With `ON DELETE CASCADE` — the default reflex — closing a profitable position would erase the record of its profit. And that record is not decoration: `commonFund(await store.allFills())` is what the orchestrator adds to `totalCapitalUsd` before deciding what it can spend. A foreign key here would quietly shrink the book every time a position closed well.

`fills_position_idx (position_id, time)` supports both readers: `fillsFor` (the per-position ledger, and `PaperBroker.seed`) and the time-ordered walk in `positionLedger`.

### 5.3 `scans`

```sql
CREATE TABLE IF NOT EXISTS scans (
  scanned_at BIGINT PRIMARY KEY,
  chain      TEXT   NOT NULL,
  snapshots  JSONB  NOT NULL
);
```

One row per scanner pass per chain, the full snapshot array stored as JSONB. `latestScansByChain()` reads it back with `SELECT DISTINCT ON (chain) … ORDER BY chain, scanned_at DESC`.

> **Sharp edge.** The primary key is `scanned_at` **alone**, not `(chain, scanned_at)`, and `saveScan` inserts `ON CONFLICT (scanned_at) DO NOTHING`. Two chains whose scans finish in the same millisecond would silently drop one — no error, no log line, one chain simply missing from the universe. This is safe today only because `src/runtime/main.ts:298` writes scans inside a sequential per-chain loop, minutes apart. Any future concurrent per-chain scan breaks it. Recorded here as a latent hazard, not a present bug.

### 5.4 `checkpoint`

```sql
CREATE TABLE IF NOT EXISTS checkpoint (
  singleton           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  saved_at            BIGINT  NOT NULL,
  last_completed_bar  BIGINT  NOT NULL,
  kill_switch_engaged BOOLEAN NOT NULL DEFAULT FALSE
);
```

> One row, always. `singleton` exists so an UPSERT can target it by name and there is no way to end up with two disagreeing checkpoints.

`BOOLEAN PRIMARY KEY … CHECK (singleton)` admits exactly one row: `TRUE`. The constraint is what makes `ON CONFLICT (singleton) DO UPDATE` a well-defined target — the checkpoint cannot fork, by construction rather than by convention.

### 5.5 `blacklist`

```sql
CREATE TABLE IF NOT EXISTS blacklist (
  chain         TEXT   NOT NULL,
  token_address TEXT   NOT NULL,
  reason        TEXT   NOT NULL,
  at            BIGINT NOT NULL,
  PRIMARY KEY (chain, token_address)
);
```

> A death exit is terminal, so this table is append-only by convention and the writer never updates an existing row: the FIRST verdict is the one kept.

`reason` is not optional, in the schema or in `retireToken`'s request type. A blacklist row without its reason would be a verdict with no evidence — and the death exit's fifth guardrail (`05-riesgo.md`) requires the full evidence chain to be logged.

### 5.6 `alerts`

```sql
CREATE TABLE IF NOT EXISTS alerts (
  seq   BIGSERIAL PRIMARY KEY,
  kind  TEXT   NOT NULL,
  level TEXT   NOT NULL CHECK (level IN ('info', 'warn', 'critical')),
  at    BIGINT NOT NULL,
  title TEXT   NOT NULL,
  body  TEXT   NOT NULL,
  data  JSONB
);
CREATE INDEX IF NOT EXISTS alerts_level_idx ON alerts (level, seq);
```

This table is what replaced Telegram. The schema states the failure it fixes:

> A pipe delivers to whoever is listening and forgets the rest; a phone that was off missed the death exit entirely. A LOG lets a client read from a cursor and catch up, so being asleep costs latency rather than the message.

`seq BIGSERIAL` rather than the timestamp, "because two alerts can share a millisecond and a timestamp cursor would then have to choose between skipping one and replaying it forever". `at` is kept as a separate `BIGINT` — the ordering and the clock are different facts and are stored as different columns.

`alerts_level_idx (level, seq)` is the index the phone reads through: *give me the criticals after sequence N* without scanning the whole log.

`data JSONB` is the only nullable column, and `alert-store.test.ts` pins that it survives the round trip — "an alert without its evidence is a rumour".

### 5.7 `pool_discovery`

```sql
CREATE TABLE IF NOT EXISTS pool_discovery (
  chain         TEXT   PRIMARY KEY,
  pools         JSONB  NOT NULL,
  discovered_at BIGINT NOT NULL
);
```

One row per chain; discovery is a whole-chain answer, so the chain is the key. The schema argues the expiry window from the gate rather than from intuition:

> a pool younger than it CANNOT clear the history gate anyway, which wants 250 bars — 2.6 days at 15m.

### 5.8 `pool_history`

```sql
CREATE TABLE IF NOT EXISTS pool_history (
  chain        TEXT   NOT NULL,
  pool_address TEXT   NOT NULL,
  bars         INT    NOT NULL,
  measured_at  BIGINT NOT NULL,
  PRIMARY KEY (chain, pool_address)
);
```

The table exists for one measured reason:

> Counting a pool's bars costs a full candle download — a thousand rows to learn one integer — and it was 80% of a cycle's wall time in rate-limit backoff. What makes caching it CORRECT rather than merely convenient is that a pool cannot lose candles: once it has enough for the strategy, it has enough forever. Only a short count can change, so only a short count expires.

`measured_at` exists **solely** for the short-count case; a count at or above the gate threshold never consults it.

### 5.9 `token_security`

```sql
CREATE TABLE IF NOT EXISTS token_security (
  chain        TEXT   NOT NULL,
  address      TEXT   NOT NULL,
  security     JSONB  NOT NULL,
  slippage_pct NUMERIC,
  measured_at  BIGINT NOT NULL,
  PRIMARY KEY (chain, address)
);
```

> Each examined token costs five throttled network calls, so a cycle can only afford a couple of dozen. Without a memory the same highest-scoring tokens were re-examined every fifteen minutes and everything below the cut waited forever: **106 tokens sat permanently "sin revisar" in production.**
>
> Short-lived on purpose. The honeypot answer inside a report is the one that ages worst, which is why a cached report keeps a token ELIGIBLE but never gets it traded: the sell path is re-confirmed before a position opens.

`slippage_pct` is nullable and is the **measured** impact from a real sell quote — the number `recall.ts` reads so it can size a ladder against what the venue actually said, rather than against reported TVL. See `06-economia.md`.

### 5.10 Index summary

| Index | Columns | Serves |
|---|---|---|
| `positions_token_idx` | `(chain, token_address)` | "do we already hold this?" |
| `fills_position_idx` | `(position_id, time)` | `fillsFor`, the ledger walk, `PaperBroker.seed` |
| `alerts_level_idx` | `(level, seq)` | the phone reading only what matters, from a cursor |

---

## 6. Idempotency lives in SQL, not in TypeScript

### 6.1 The conflict clause is the guarantee

`PostgresStore`'s header states the rule and the reason in one breath:

> The idempotency discipline lives in SQL, not in TypeScript: `ON CONFLICT DO NOTHING` on the fills and blacklist tables means a retry is safe even if two engine instances race. **A guarantee enforced by the database cannot be forgotten by a caller.**

The complete matrix of write behaviour:

| Table | Conflict target | Action | Why |
|---|---|---|---|
| `fills` | `(idempotency_key)` | **DO NOTHING** | A fill is a fact. A second write of the same intended order is a retry, not a new trade. |
| `blacklist` | `(chain, token_address)` | **DO NOTHING** | "a death exit is terminal and the first verdict is the one that explains why." |
| `scans` | `(scanned_at)` | **DO NOTHING** | Append-only log of passes. |
| `positions` | `(id)` | **DO UPDATE** | "a position UPSERTS, because its state is meant to move." |
| `checkpoint` | `(singleton)` | **DO UPDATE** | One row that is supposed to advance. |
| `pool_discovery` | `(chain)` | **DO UPDATE** | A measurement that improves. |
| `pool_history` | `(chain, pool_address)` | **DO UPDATE** | Same — and the source comment names the contrast explicitly: "DO UPDATE, unlike the blacklist: this is a measurement that improves, not a verdict that must keep its first answer." |
| `token_security` | `(chain, address)` | **DO UPDATE** | A fresher examination replaces a staler one. |

The dividing line is not "cache versus state". It is **verdict versus measurement**. A verdict keeps its first answer; a measurement keeps its best one.

`postgres-store.test.ts` asserts the **literal clause strings**, which looks like testing an implementation detail and is not — the clause *is* the guarantee, so the clause is what gets pinned:

```ts
expect(calls[0]!.sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING')
expect(calls[0]!.sql).toContain('ON CONFLICT (chain, token_address) DO NOTHING')
expect(calls[0]!.sql).not.toContain('DO UPDATE')   // the blacklist, specifically
expect(calls[0]!.sql).toContain('ON CONFLICT (id) DO UPDATE')
expect(calls[0]!.sql).toContain('ON CONFLICT (singleton) DO UPDATE')
```

`MemoryStore` implements the same rule in TypeScript so the reference cannot be looser than the real thing:

```ts
async recordFill(fill: PersistedFill): Promise<void> {
  if (this.fills.has(fill.idempotencyKey)) return   // first write wins
  this.fills.set(fill.idempotencyKey, structuredClone(fill))
}
```

pinned by *"is idempotent: the same fill written twice is stored once"* — the second write carries `price: 999` and the stored price is still `1`.

### 6.2 JSONB, and the migration path it buys

Nine columns hold domain objects as JSONB: `positions.cascade`, `positions.death_watch`, `positions.quality`, `positions.pending_orders`, `scans.snapshots`, `pool_discovery.pools`, `token_security.security`, `alerts.data`.

The stated reason is narrow and practical: "these are domain types that will keep evolving, and a column per field would turn every strategy change into a migration." `CascadeState` alone has nine persisted fields; `DeathWatchState` carries a growing evidence chain; `MarketQuality` has five.

The consequence is what makes the deployment story work. `migrate()` is one statement:

```ts
/** Idempotent: safe to run on every boot. */
async migrate(schema: string): Promise<void> {
  await this.sql.query(schema)
}
```

`src/runtime/main.ts` calls it unconditionally at boot with `schemaSql()`, which reads `schema.sql` off disk relative to the compiled module. There is no version table, no ordered migration list, no down path. That is only sustainable because the schema's *columns* almost never change — the shapes that change live inside JSONB, where a new field is a new key and an old row simply lacks it.

The honest cost: **the database enforces nothing about the contents of those columns.** A `CascadeState` written by an older engine and read by a newer one is a TypeScript cast, not a validated parse. Nothing in the source handles a shape mismatch, and no test covers one. That is a real gap, stated here rather than glossed.

---

## 7. The idempotency key

```ts
export const idempotencyKeyFor = (positionId: string, barTime: number, orderId: string): string =>
  `${positionId}:${barTime}:${orderId}`
```

Example: `pos-1:1800000000000:DCA-2`.

> Deterministic on purpose: the same position, the same bar and the same order id always produce the same key, so an order replayed after a crash is recognised as the one already placed rather than treated as a new one. **This is what stands between a restart and a double buy.**

The order-id part comes from `orderKeyPart`, because a `closeAll` has no id of its own:

```ts
/** `close_all` has no id of its own; its comment identifies which exit it was. */
export const orderKeyPart = (order: Order): string =>
  (order.kind === 'entry' ? order.id : `closeAll:${order.comment}`)
```

so an exit keys as `closeAll:🏁 Exit` and a death exit as `closeAll:☠️ Death Exit`.

`recovery.test.ts` pins the three non-collision properties in one test:

```ts
expect(idempotencyKeyFor('pos-1', BAR, orderKeyPart(entry))).toBe(idempotencyKeyFor('pos-1', BAR, 'DCA-2'))
expect(orderKeyPart(exit)).toBe('closeAll:🏁 Exit')
expect(idempotencyKeyFor('pos-1', BAR, 'DCA-2')).not.toBe(idempotencyKeyFor('pos-1', BAR + 1, 'DCA-2'))
expect(idempotencyKeyFor('pos-1', BAR, 'DCA-2')).not.toBe(idempotencyKeyFor('pos-2', BAR, 'DCA-2'))
```

### 7.1 The decided bar, never the filling bar

This is the single most load-bearing subtlety in the subsystem.

The execution model (see the engine chapter and `03-estrategia-cascade-dca.md`) is that an order decided at bar N's **close** fills at bar N+1's **open**. So at the moment the engine writes a fill, two bar times are in scope: `position.lastBarTime` (bar N, where the order was decided) and `barTime` (bar N+1, where it filled). Recovery, running later, only has the position — so it can only ask by `position.lastBarTime`.

`src/application/engine.ts` therefore keys by the decided bar, and says so:

```ts
for (const order of position.pendingOrders) {
  const key = idempotencyKeyFor(position.id, position.lastBarTime, orderKeyPart(order))
  // Guarded here as well as in SQL: the store would reject the duplicate
  // anyway, but a second execute() would also move the broker's cash.
  if (await store.hasFill(key)) continue
  …
}
```

with the comment above the loop:

> keyed the way RECOVERY looks it up: by the bar the order was DECIDED on, which is the position's last bar, not the one it fills at. **Writing the filling bar instead would leave recovery unable to find its own fills and it would halt every position it had just traded.**

`engine.test.ts` has a dedicated describe block for it — *"tickPosition — the fill recovery will look for"* / *"keys a fill so recovery recognises it, instead of halting a position it just traded"* — which computes the key from `decidedAt` and asserts `store.hasFill(key)`.

Note the second sentence of that in-line comment: `hasFill` is checked **in TypeScript as well as enforced in SQL**, and skipping the TypeScript guard would not be harmless. The database protects the *record*; it does not protect the simulated wallet. A second `broker.execute()` would move the broker's cash even though the fill was rejected.

### 7.2 One `closeAll`, several fills

A close sells every open entry rung, so one order produces several fills. Only the first can carry the canonical key:

```ts
// One close sells every open entry, so it produces several fills for a
// single order. The FIRST carries the order's canonical key, which is
// the one recovery asks about; the rest are suffixed.
idempotencyKey: index === 0 ? key : `${key}#${index}`,
```

Pinned by *"records one fill per rung, each keyed apart so none collides"*: a six-rung ladder exits, and the test asserts **six** sell fills with **six distinct keys** — "anything less than six here is a collision silently eating a fill."

### 7.3 A retirement is not a bar

`retireToken` keys its sale differently, on purpose:

```ts
idempotencyKey: `retire:${position.id}:${at}:${index}`,
```

> Keyed by the retirement instant, not by a bar: this sale was not decided by any bar, and pretending otherwise would collide with a real order the engine might key the same way.

---

## 8. Crash recovery

### 8.1 A planner, not an actor

```ts
export async function planRecovery(store: StatePort, probe: OrderProbe): Promise<RecoveryPlan>
```

> This module decides. It does not act: it returns a plan, so the decision is testable without a chain.

Every test in `recovery.test.ts` is consequently synchronous logic over a `MemoryStore` and a one-line probe. There is no network, no broker, no chain.

```ts
export type PendingVerdict = 'filled' | 'not-filled' | 'unknown'

export type OrderProbe =
  (position: PersistedPosition, order: Order, key: string) => Promise<PendingVerdict>

export interface PendingResolution {
  readonly positionId: string
  readonly order: Order
  readonly key: string
  readonly verdict: PendingVerdict
  readonly action: 'record-and-continue' | 'resubmit' | 'halt'
}

export interface RecoveredPosition {
  readonly position: PersistedPosition
  readonly resolutions: readonly PendingResolution[]
  readonly resumable: boolean
}

export interface RecoveryPlan {
  readonly positions: readonly RecoveredPosition[]  // safe to trade
  readonly halted: readonly RecoveredPosition[]     // need a human
  readonly blacklisted: ReadonlySet<string>
  readonly resumedFromBar: number | null
  readonly killSwitchEngaged: boolean
}
```

### 8.2 The three verdicts

The module header rejects the two-valued design explicitly:

> Three answers, three different correct actions. Getting them wrong costs a double buy, a lost position, or a silent divergence between what the engine believes and what the wallet holds — **and the third is the worst, because it keeps trading on a lie.**

| Verdict | Action | Rule | Why |
|---|---|---|---|
| a fill is already recorded | `record-and-continue` | **The store is the truth.** The venue is not even asked. | "If the store already has a fill under the order's idempotency key, the order happened — whatever the engine believed when it died." |
| `not-filled` | `resubmit` | A confirmed miss may be retried. | "The venue says it never saw the order, so resubmitting is safe." |
| `unknown` | `halt` | **Never guess.** | Both guesses are wrong half the time. |

The order of rules 1 and 2 is enforced in code, not by convention:

```ts
// Rule 1: a recorded fill settles it without asking anyone.
if (await store.hasFill(key)) {
  resolutions.push({ …, verdict: 'filled', action: 'record-and-continue' })
  continue
}
const verdict = await probe(position, order, key)
```

and pinned by *"never asks the venue about an order the store already has"*, which asserts the probe was called **exactly zero times**.

### 8.3 Why unknown must halt

> Not "assume filled", not "assume not" — both guesses are wrong half the time, and being wrong means either buying twice or holding a position the engine does not know about. A halted position keeps its state, stops trading, and asks for a human. **An unattended system is allowed to stop; it is not allowed to guess.**

The two failure modes are asymmetric in kind, not in severity:

- *Assume filled* → the engine believes it holds tokens it does not. The ladder waits for DCA triggers against a cost basis that never existed; the position is a fiction that consumes a slot and capital.
- *Assume not filled* → the engine resubmits an order the venue already executed. On a real chain that is a double buy, at a level the strategy sized once.

Both leave the engine's belief and the wallet's contents out of step, and an out-of-step engine **keeps trading on that difference** — every subsequent decision is derived from a wrong position. Halting is the only action whose cost is bounded: one position stops, everything else continues, and nothing is destroyed.

Three properties follow, each with a test:

- **One unknown halts the whole position**, not just the order: `resumable: !resolutions.some((r) => r.action === 'halt')`. Pinned by *"one unknown among several pendings halts the whole position"* — resolutions come back `['resubmit', 'halt']` and the position lands in `halted`.
- **A halted position keeps its state.** It stops, it does not reset: *"a halted position keeps its state — it stops, it does not reset"* asserts `cascade.level` is still 3 and `capitalUsd` still 500.
- **Position isolation survives recovery.** `positions` and `halted` are separate arrays and the loop continues past a halt: *"halting one position does not stop the others"*.

### 8.4 The dead stay dead

```ts
for (const position of stored) {
  if (blacklisted.has(`${position.chain}:${position.tokenAddress}`)) continue
  …
}
```

A blacklisted position appears in **neither** `positions` nor `halted`. It is skipped entirely, "whatever its state says".

That skip is also a trap for anything that writes a blacklist row without closing the position first, which is why `retire.ts` orders its writes the way it does (§9.2).

### 8.5 The probe in paper mode versus live

`src/runtime/main.ts`:

```ts
probe: async () => (config.mode === 'paper' ? 'not-filled' : 'unknown'),
```

The comment is one of the clearest bug post-mortems in the repository:

> In PAPER the broker is OURS: deterministic, in-process, and the fills table is the complete record of everything it did. No recorded fill means the order did not happen — a fact about a venue we own, not a guess. […]
>
> This said 'unknown' back when the engine had no execution step at all, and that was honest then. **It became a lie the moment orders started filling: every position was halted for an order that was merely still scheduled, and five of them sat frozen with nothing wrong.**
>
> In LIVE it must go back to 'unknown' until a wallet adapter can ask the chain. An order sent to a real venue genuinely can have landed without us hearing about it, and halting is the only honest answer to that.

`recovery.test.ts` keeps both halves alive under the describe block *"a venue we own has no unknowns"*: one test proves a paper position with a pending order resumes rather than halts; the next, *"still halts when the answer is genuinely unknown"*, proves the rule itself did not soften. **The paper probe is a fact about a specific venue, not a relaxation of the rule.**

---

## 9. What a restart does, step by step

`src/application/orchestrator.ts` → `runCycle`. The order of these steps is the safety property; it is not an implementation convenience.

### Step 0 — boot

`main(ports)` constructs `new PostgresStore(ports.sql)` and runs `await store.migrate(schemaSql())`. Every table and index is created if absent. Then `buildRuntime` wires the same store instance into `StoredAlertSink` (the `alerts` table), `CachedHistory` (`pool_history`), `CachedDiscovery` (`pool_discovery`), and the cycle deps.

### Step 1 — reconcile the past before touching the present

```ts
const recovery = await planRecovery(deps.store, deps.probe)
```

`planRecovery` reads `loadPositions()`, `blacklisted()` and `loadCheckpoint()` **in parallel**, then walks each position's `pendingOrders` applying §8.2. Each halted position raises a **critical** alert:

```
⛔ {symbol} halted
An order in flight could not be confirmed either way. The position keeps its
state and will not trade until a human resolves it.
```

with the offending keys in the alert's structured `data`. If `recovery.killSwitchEngaged`, a throttled kill-switch alert goes out too.

> Recovery runs first because an engine that scans and allocates before reconciling its own past is building on state it has not verified.

### Step 2 — rebuild each broker from its fills, then advance

For every resumable position the runtime builds (or reuses) a `PaperBroker` and seeds it:

```ts
broker.seed(await store.fillsFor(position.id))
```

> The engine runs as a one-shot process […] so a broker that keeps its position in memory is FLAT on every wake-up and the strategy never sees what it opened fifteen minutes ago. **The fills are the facts; this reads them back.**

That docstring (`paper-broker.ts:83`, and the header of `paper-broker-seed.test.ts`) still carries the one-shot premise §1 corrects, and it is stale there too. The *reason* it gives is untouched by that: a broker is seeded once per process and the process now lives for up to 350 minutes, so a brand-new position still starts flat and still has to be rebuilt from its fills. The consequence the stale phrasing hides is the other direction — a fill written outside this process does not reach a broker the run already cached.

`seed` sorts the fills by time ("a store returns rows and rows are not a queue"), replays buys into open trades and cash, removes sold rungs by `orderId`, and charges one gas per swap — with a `lastSellTime` guard because a close shares one swap between several fills.

What it cannot reconstruct is stated in its own docstring rather than left to be discovered: `realisedGrossUsd` needs each entry's untouched mid, which is not a field on a fill, so seeded trades report entry price as mid and gross reads as net for them. "Stated here rather than silently wrong, and the number is a report, not a decision."

Then `tickPosition` runs, and its **step 0** executes the previous bar's `pendingOrders` at this bar's open, writing each fill under the key from §7.1. Step 4 persists the position — with its new `pendingOrders` — **before** anything is submitted:

> The order is persisted as pending FIRST. If the process dies here, recovery finds it and asks the venue whether it happened — which is only possible because it was written down first.

Pinned by *"persists the orders as pending before they are submitted"*.

### Step 3 — decide what capital is genuinely free

Only if the kill switch is not engaged.

1. **One ledger per position, read once.** `positionLedger(await store.fillsFor(id))` for each resumable position — "three decisions below need the same answer […] and any two of them disagreeing is how a book starts double-spending."
2. **Release idle slots.** A position holding nothing may hand its slot on; `closePosition(holder.id)` deletes the row. Its fills stay. Nothing is blacklisted — "the token did not fail a safety gate, it merely stopped being the best use of a slot."
3. **Trim each kept position** to what its ladder can actually deploy, never below `deployedUsd`, and `savePosition` the trimmed row.
4. **Sum what is committed — including the halted:**

```ts
// Capital committed to halted positions is NOT free. Treating it as free is
// how an engine quietly doubles its own exposure after a bad restart.
const committed =
  kept.reduce((sum, p) => sum + p.capitalUsd, 0) +
  recovery.halted.reduce((sum, r) => sum + r.position.capitalUsd, 0)
```

5. **Add the common fund**, built from every fill ever recorded: `const fund = commonFund(await deps.store.allFills())`, then `free = max(0, totalCapitalUsd + fund.netUsd - committed)`.
6. **Subtract halted positions from the slots too:** `slotsLeft = maxPositions - keeping.length - recovery.halted.length`.

A halted position therefore keeps **both** its capital and its slot. That is the whole point: a position whose state is unresolved must not have its dollars or its seat handed to somebody else.

7. Each newly opened slot is written with `savePosition`, `pendingOrders: []`.

### Step 4 — checkpoint, then say you are alive

```ts
const lastCompletedBar = ticks.reduce((latest, t) => Math.max(latest, t.position.lastBarTime), recovery.resumedFromBar ?? 0)
await deps.store.saveCheckpoint({ savedAt: at, lastCompletedBar, killSwitchEngaged: recovery.killSwitchEngaged })
```

Then a throttled heartbeat, which is itself a row in `alerts`.

### 9.1 The kill switch is a column

`src/application/kill-switch.ts` engages and releases by reading the checkpoint and upserting it with `killSwitchEngaged` flipped, preserving `lastCompletedBar`.

> It lives in the STORE, not in the process — which is the whole point. A switch held in memory can only be thrown by a healthy engine, and a healthy engine is exactly the case where you least need one. Writing it to durable state means a phone can stop a machine it cannot reach, and a crash-looping process comes back already stopped.

`planRecovery` surfaces it as `plan.killSwitchEngaged`, and `runCycle` uses it to skip **step 3 only** — the death watch in step 2 keeps running. See `05-riesgo.md` for the asymmetry and for `shouldEngage`'s automatic limits.

### 9.2 The only two writes from outside the engine

Both are one-way safe: they can only ever leave the system holding less.

1. **`kill-switch.ts`**, reached from `POST /api/control`, upserts one boolean on the checkpoint row.
2. **`retire.ts`**, an operator taking a token off the board by hand.

`retireToken`'s write order is the interesting part:

```ts
await deps.store.closePosition(position.id)
await deps.store.blacklist(request.chain, request.tokenAddress, request.reason, at)
```

> Ordered so a crash is survivable in the direction that costs least. Closing before blacklisting can leave the token eligible for a new position — annoying, and fixed by running this again. **Blacklisting first would leave an ABANDONED bag: skipped by recovery, still held, its capital counted as free.** One is a retry; the other is a silent hole.

That hazard is a direct consequence of §8.4: `planRecovery` skips a blacklisted position entirely, so it stops being ticked while its tokens stay bought **and** it drops out of the committed-capital total — "which is how the portfolio quietly hands the same dollars to somebody else."

`retireToken` also refuses rather than inventing: a position holding tokens with `lastPriceUsd === null` is left whole, because "a sale needs a price, and the only honest one is the price somebody measured."

---

## 10. The alert log and the caches

### 10.1 `StoredAlertSink`

`src/infrastructure/notifications/store-alerts.ts` exists as a class rather than a one-line lambda for exactly two reasons, both stated in its header:

1. **Sending never throws into the engine.** "A notification channel that can stop trading is a worse problem than a missed notification."
2. **A critical that failed to land is retried.** "Swallowing the error is right for a heartbeat and wrong for a death exit."

```ts
async send(alert: Alert): Promise<void> {
  await this.drain()    // oldest first
  await this.write(alert)
}
```

| Property | Value | Why |
|---|---|---|
| Spool contents | `level === 'critical'` only | An info-level heartbeat is not worth a retry. |
| Spool bound | `spoolLimit = 50` | "an outage must not become a memory leak" |
| Drain order | oldest first, **before** each new send | "so a recovered database receives the backlog in the order the events actually happened rather than after the newest one" |
| Overflow victim | the **oldest** | "during a rolling collapse the most recent verdicts are the ones that still describe the world" |

Note the spool is process-local. It survives an outage of the database, not an outage of the process — and a critical alert lost that way leaves no trace. `recordAlert` is the durability boundary; the spool is only the bridge to it.

`MemoryStore` assigns `seq` from the log's own length; `PostgresStore` lets the database assign it and reads it back:

```sql
INSERT INTO alerts (kind, level, at, title, body, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq
```

> RETURNING seq: the database assigns the order, so two engine instances writing at once still produce one unambiguous sequence.

`alertsSince` is `WHERE seq > $1 ORDER BY seq ASC LIMIT $2`, default limit 100 — exclusive cursor, oldest first, capped page. `alert-store.test.ts` exercises all four: sequence starts at 1, ordering by seq not clock, exclusive cursor, and a 10-row page walked forward over 40 alerts.

### 10.2 The three caches and their windows

| Cache | Table | Window | Argument for the window |
|---|---|---|---|
| `CachedHistory` | `pool_history` | 6h, **short counts only** | A pool cannot lose candles. A count `>= minBars` is "settled forever" and never re-measured. |
| `CachedDiscovery` | `pool_discovery` | 6h (`DEFAULT_STALE_AFTER_MS`) | "a quarter of the 2.6 days the history gate demands" — a pool younger than the window could not clear the gate anyway, so caching cannot lose a token. |
| security (`scan.ts`) | `token_security` | 2h (`DEFAULT_SECURITY_TTL_MS`) | "the honeypot answer inside a report is the one that ages worst" |
| scans | `scans` | none stored | `recall.ts` enforces `maxAgeMs` **at read time** and returns `null` rather than serving stale evidence. |

Two failure rules apply across all of them, and both were learned the same way:

- **A failed call is never cached.** `CachedHistory`: "A failed call is not a measurement. Writing null here would turn one rate-limited request into a permanent 'this pool has no history'" — the gate would reject a good token forever on a network blip. It returns the previously known count instead.
- **An empty answer is not evidence.** `CachedDiscovery` refuses to store an empty list: "it is far more likely to be a provider having a bad minute", and on a provider exception it falls back to the stale shelf — "an old universe beats no universe" — throwing only when there is nothing at all to fall back on.

The measured payoff, cold cycle against warm, same chain, same 20 tokens:

| | Cold | Warm |
|---|---|---|
| GeckoTerminal rejections | 50 | **21** |
| Time backing off | 304s | **116s** |
| Scan | 384s | **177s** |

And the motivation for `token_security` specifically: **106 tokens sat permanently "sin revisar" in production** before it existed.

---

## 11. Reading the store

### 11.1 Everything reads through the port

`src/application/dashboard.ts`, `operations-view.ts`, `universe-view.ts`, `phone-status.ts` and `recall.ts` all read through `StatePort`. The Next.js app calls those application functions rather than writing SQL of its own — CLAUDE.md's rule that the numbers live in the application layer, so "the screen and the allocator cannot disagree about a number."

`dashboard/lib/store.ts` builds the read-only side over one module-level pool:

```ts
pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
```

> One pool for the whole app. Next.js reuses the module across requests, and a pool created per request is how a free-tier database runs out of connections at the worst possible moment.

and its error helper returns the message, never the stack:

```ts
export const failed = (error: unknown, status = 500): Response =>
  Response.json({ error: String(error).slice(0, 200) }, { status })
```

> a stack from a database client carries connection details, and these endpoints are one paste away from public.

### 11.2 `positionLedger` and `commonFund` — why `allFills` exists

`src/application/ledger.ts` is the single answer to "what does this hold and what has it made", and it **walks** the fills in time order rather than summing them:

> Totalling every buy ever made counts entries that were already sold, so a position that closed once and re-entered reports twice the capital it holds — and dividing that blend by every unit ever bought produces a cost basis the position never paid, which then feeds the unrealised number.

Three defensive details worth naming:

- A sale is capped at the held quantity: `const sold = Math.min(fill.qty, qty)` — "so a bad fill cannot invent profit out of a negative position".
- After a full exit the basis is zeroed: "a basis of 1e-17 on zero units is not a cost, it is noise."
- `commonFund` **groups by position** before computing realised profit, "because realised profit is defined against a cost basis and a basis only means anything within one position's own history" — and subtracts `costsUsd`, because "a fund built on gross profit would be handing the allocator dollars the chain already took."

This is the reason `allFills()` is on the port at all. The spendable fund is mostly made of positions that have closed and left the working set — which is the same fact that forbids the foreign key in §5.2.

### 11.3 `tools/reset.sql`

The destructive reset splits the nine tables into two groups and documents what each costs:

| Group | Tables | Cost of erasing |
|---|---|---|
| **STATE** | `positions`, `fills`, `checkpoint`, `blacklist`, `alerts` | This *is* the system. |
| **CACHE** | `scans`, `pool_discovery`, `pool_history`, `token_security` | "one slow cycle and nothing else" |

Two warnings it stops on before the `TRUNCATE`:

> `fills` is no longer just a history. Realised profit and the COMMON FUND are both derived from it, so truncating it does not erase a record — it **erases the money you made**, and the allocator goes back to believing it has exactly the capital in `OPERADOR_CAPITAL_USD`.
>
> `blacklist` holds the death-exit verdicts. Emptying it lets the scanner offer you a token that was already proven to be a rug.

Three graded options are offered rather than one button: everything; `positions, checkpoint` only ("a fresh book, not an engine with amnesia"); or only the measurement caches.

---

## 12. Sharp edges, divergences and gaps

Everything in this section is read from the source as it stands.

### 12.1 Postgres returns NUMERIC and BIGINT as **strings**

```ts
/**
 * Postgres returns NUMERIC and BIGINT as STRINGS, to avoid silently losing
 * precision in a JS number. Reading them as-is is a classic way to end up
 * comparing "1800000000000" to 1800000000000 and getting false.
 */
const num = (value: string | number | undefined): number =>
  (typeof value === 'number' ? value : Number(value ?? 0))
```

Every read goes through it. Affected columns: `capital_usd`, `last_bar_time`, `last_price_usd`, `opened_at`, `updated_at`, `price`, `qty`, `cost_usd`, `time`, `seq`, `at`, `bars`, `measured_at`, `discovered_at`, `slippage_pct`, `saved_at`, `last_completed_bar`.

Pinned by *"parses NUMERIC and BIGINT, which arrive as strings"*, which feeds `capital_usd: '500.00'`, `last_bar_time: '1800000000000'`, `last_price_usd: '0.0123'` and asserts numbers come back.

> **Gap.** `num()` defaults `undefined` to **0**, not `NaN`. A renamed or missing column therefore reads as a silent zero — a `$0` capital, or a bar time of 0 — both of which look like data rather than like a bug. `buildDashboard` already defends against one instance of this downstream (`lastCompletedBar: checkpoint?.lastCompletedBar || null`, because "an epoch date reads as a dead engine"), but the coercion itself is unguarded.

### 12.2 The two stores diverge on scan retention

| | `MemoryStore` | `PostgresStore` |
|---|---|---|
| Rows kept | **one per chain** (`Map<chain, scan>`) | **every scan, forever** (append-only) |
| Going backwards | refused: `if (held && held.scannedAt > scan.scannedAt) return` | no guard; the row is simply inserted |
| Pruning | implicit (overwrite) | **none anywhere in the repository** |

Reads agree — `DISTINCT ON (chain)` picks the newest, and the Memory map holds only the newest — so nothing is currently *wrong* on either side. But the reference implementation does not model the real one's growth: in Postgres each cycle appends a row carrying a full `TokenSnapshot[]` for up to 300 tokens per chain, and nothing ever deletes it. `tools/reset.sql` is the only pruning mechanism that exists, and it is manual.

`MemoryStore`'s comment records that this table has already produced one bug on both sides at once:

> One scan per chain, not one scan. Keeping a single row meant scanning BSC erased the Solana universe — **the reference implementation was reproducing the very bug the Postgres one had.**

### 12.3 `latestScan()` still exists, and one caller still uses it

Using `latestScan()` for the universe is the exact bug that made scanning BSC erase every Solana token from the screen. `recall.ts` and `universe-view.ts` use `latestScansByChain()` and take `Math.min(...scannedAt)` — "a universe is as fresh as its stalest half."

`src/application/dashboard.ts:67` still calls `latestScan()`, for the header field:

```ts
lastScan: scan ? { at: scan.scannedAt, tokensSeen: scan.snapshots.length } : null,
```

Read literally, that reports the newest **single chain's** scan time and that chain's token count — so on a two-chain universe `tokensSeen` under-reports. It does not affect the universe view or any allocation decision, and it is not a data-loss bug; it is a header number that means something narrower than its name suggests. Recorded as an observation.

### 12.4 Other gaps, stated plainly

- **No schema versioning.** `migrate()` executes `schema.sql` wholesale. There is no `ALTER` path and no down migration. A column that ever needs to change type or disappear has no supported route today.
- **No validation of JSONB contents on read.** A `CascadeState` from an older engine is cast, not parsed. No test covers a shape mismatch.
- **`alerts` and `scans` grow without bound.** Neither has a retention policy, a pruning job, or a `DELETE` anywhere in the source. On a free-tier database this is a capacity question that has not been answered.
- **No test exercises a real Postgres.** `postgres-store.test.ts` runs against a five-line `fakeSql` recorder. That is deliberate — it is what lets the tests assert the literal `ON CONFLICT` clauses — but it means nothing in CI proves the DDL parses or that the queries execute. CLAUDE.md's testing section lists "Adapters: integration tests against testnet/devnet" as the standard; for the store, that test does not exist yet.
- **`migrate()` is not on `StatePort`.** Correct as a layering decision, but it means a future non-SQL implementation has no contract for setup.
- **`PaperBroker.seed` cannot reconstruct `realisedGrossUsd`** (§9, step 2). Documented in the source; the number is a report, not a decision.

---

## 13. Test map

| File | What it pins |
|---|---|
| `src/application/recovery.test.ts` | The three verdicts and their actions; probe-call count of **zero** when a fill exists; key determinism and non-collision; one unknown halting a whole position; halted positions keeping state; position isolation; blacklisted tokens never resuming; first-verdict-wins; and `MemoryStore`'s own contract (idempotent writes, copies on read, fills surviving `closePosition`). |
| `src/infrastructure/persistence/postgres-store.test.ts` | The **literal** conflict clauses for fills, blacklist, positions and checkpoint; the string coercion of NUMERIC/BIGINT; JSON round-trip of the three domain objects; empty checkpoint reading as `null`; blacklist key format; `hasFill` from row count. |
| `src/infrastructure/persistence/alert-store.test.ts` | Sequence starting at 1; ordering by seq not clock; oldest-first replay; exclusive cursor; page cap and forward paging; structured `data` preserved. |
| `src/application/engine.test.ts` | `pendingOrders` persisted **before** submission; execution at the following bar's open; a fill recorded once however often the bar is replayed; the fill keyed by the **decided** bar; one fill per rung with six distinct keys on a six-rung exit. |

---

## 14. One-paragraph summary

Durable state is the only truth: the engine wakes with nothing in memory, rebuilds every position from `positions` + `fills`, and asks one question per order that was in flight — *did this actually happen?* A recorded fill settles it without asking the venue; a confirmed miss is resubmitted; **an unknown halts that position and asks for a human**, keeping both its capital and its slot so the allocator cannot spend them twice. The guarantee that makes a retry safe is a primary key and an `ON CONFLICT (idempotency_key) DO NOTHING` clause, not a TypeScript check, because a guarantee the database enforces cannot be forgotten by a caller — and the key is scoped to the bar the order was *decided* on, because keying it to the bar it *filled* at would leave recovery unable to find its own fills and halt every position the engine had just traded. `fills` has no foreign key to `positions` so that a closed position can leave the working set while the money it made stays on the books. Domain objects are JSONB so the strategy can keep evolving without a migration per field, which is what makes a boot-time `CREATE TABLE IF NOT EXISTS` the whole migration story.
