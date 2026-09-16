# The phone, alerts and the control path

This chapter documents how an unattended engine stays **observable** and **stoppable**: the alert contract in `src/domain/notifications/alerts.ts`, the durable alert log (`alerts` table, `StatePort.recordAlert` / `alertsSince` / `latestAlertSeq`) that replaced Telegram, the spooling sink `StoredAlertSink`, the cheap read model `buildPhoneStatus`, the three HTTP endpoints the phone talks to (`/api/phone`, `/api/alerts`, `/api/control`), the Android app in `android/` — its foreground service, its notification channels, its cursor and its kill-switch button — the fail-closed authorisation in `src/application/control-api.ts`, the demo server that lets all of it be exercised without Postgres, and `retire.ts`, the operator's manual escape hatch. It covers why the channel is a log and not a pipe, why the cursor is a sequence and not a timestamp, why `info` never reaches the lock screen, and the places where the source is sharper than the design intends.

---

## 1. Where the code is

| File | Layer | What it owns |
|---|---|---|
| `src/domain/notifications/alerts.ts` | domain (pure) | `AlertKind`, `AlertLevel`, `Alert`, `AlertPort`, the `LEVELS` table, `alert()`, `AlertThrottle` |
| `src/domain/notifications/alerts.test.ts` | domain | The level table and the throttle rules, as named tests |
| `src/domain/persistence/store.ts` | domain | `StoredAlert`, and the three log methods on `StatePort` |
| `src/infrastructure/notifications/store-alerts.ts` | infrastructure | `StoredAlertSink` — the production `AlertPort` |
| `src/infrastructure/notifications/store-alerts.test.ts` | infrastructure | The spool contract, against a `FlakyStore` |
| `src/infrastructure/notifications/recording.ts` | infrastructure | `RecordingAlerts`, the test double |
| `src/infrastructure/persistence/schema.sql` | infrastructure | The `alerts` table and `alerts_level_idx` |
| `src/infrastructure/persistence/postgres-store.ts` | infrastructure | `recordAlert` / `alertsSince` / `latestAlertSeq` in SQL |
| `src/infrastructure/persistence/memory-store.ts` | infrastructure | The reference implementation of the same three |
| `src/infrastructure/persistence/alert-store.test.ts` | infrastructure | Log semantics: ordering, exclusivity, paging, structured detail |
| `src/application/phone-status.ts` | application | `buildPhoneStatus`, `STALE_AFTER_MS` |
| `src/application/control-api.ts` | application | `authoriseControl`, `MIN_TOKEN_LENGTH` |
| `src/application/kill-switch.ts` | application | `engageKillSwitch` / `disengageKillSwitch` / `killSwitchStatus`, plus the pure `shouldEngage` |
| `src/application/retire.ts` | application | `retireToken` — the manual exit |
| `src/runtime/retire.ts` | runtime | The operator CLI (`npm run retire`) |
| `src/runtime/demo-server.ts` | runtime | The phone API over `MemoryStore` (`npm run dev:phone-api`) |
| `dashboard/app/api/phone/route.ts` | dashboard | `GET` the cheap poll |
| `dashboard/app/api/alerts/route.ts` | dashboard | `GET` the feed from a cursor |
| `dashboard/app/api/control/route.ts` | dashboard | `POST` the kill switch — the only write path in the system |
| `android/app/src/main/java/com/opendoors/operador/*.kt` | android | `MainActivity`, `WatchService`, `Api`, `Notifications`, `Prefs`, `BootReceiver` |
| `android/app/src/main/AndroidManifest.xml` | android | The `specialUse` service declaration, the boot receiver, seven permissions |
| `android/build-apk.sh` | android | Finds a usable JDK and SDK, then builds |

The read models and the dashboard they feed are documented in `11-vistas.md`; the engine steps that *emit* these alerts are in `08-motor.md`; the `alerts` table alongside the other eight is in `09-persistencia.md`; the kill switch as a risk control is in `05-riesgo.md`. This chapter is the channel itself, end to end.

---

## 2. Why Telegram was replaced: a pipe versus a log

The argument is written in four places in the source, in nearly the same words each time — `schema.sql:75`, `store-alerts.ts:7`, `alert-store.test.ts:6`, `runtime/main.ts:65` — which is a fair signal of how much it cost to learn:

> Telegram was a PIPE: the engine pushed, and whatever was not delivered was gone. A phone that was off, out of signal, or not yet installed missed the death exit entirely, and nothing recorded that it had. This is a LOG. The app reads it from a cursor and catches up, so being asleep costs latency rather than the message.

The trade is explicit and it is not free:

| | Pipe (Telegram) | Log (`alerts` + cursor) |
|---|---|---|
| Latency | push, seconds | poll, up to `pollSeconds` (default 60s) |
| Delivery when the receiver is offline | lost, silently | queued in the table, delivered on catch-up |
| Delivery when the receiver was never installed | lost | full history available |
| Audit trail | none | the same table |
| Who owns the transport | a third party's bot API | Postgres, which the system already depends on |

The second row is why the swap happened; the fourth row is the dividend. A death exit's evidence chain (`05-riesgo.md`) is written into `alerts.data` as JSONB, so "which signal, which source, which observations" survives as queryable state rather than as a chat message someone has to scroll back to.

### 2.1 What the removal exposed

`RecordingAlerts` — the test double that collects alerts instead of delivering them — used to live in the Telegram adapter's file. Its header now says why it does not:

> When Telegram was removed the whole test suite would have gone with it — which is the tell that a test double was sharing a file with a delivery mechanism it never depended on.

It is now `src/infrastructure/notifications/recording.ts`, sixteen lines, and it is what `retire.test.ts`, `kill-switch.test.ts` and the engine tests assert against.

### 2.2 One leftover, and it is dead

`docker-compose.yml:11-12` still passes `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` into the engine container. **Nothing reads them.** A search across `src/` and `dashboard/` finds the strings only in comments explaining that Telegram is gone. They are harmless but misleading, and `.env.example` does not mention them at all — the one credential it documents is `OPERADOR_CONTROL_TOKEN`. Treat the compose entries as debris to delete, not as configuration.

---

## 3. The alert contract

`src/domain/notifications/alerts.ts` is pure domain: no I/O, no clock, no network. Its header states the job:

> "Unattended" does not mean "unobservable". A silent engine and a dead engine look identical from outside, so this contract exists to make the difference visible — and to make sure the messages that matter are not buried under the ones that do not.

### 3.1 The shapes

```ts
export type AlertLevel = 'info' | 'warn' | 'critical'

export interface Alert {
  readonly kind: AlertKind
  readonly level: AlertLevel
  readonly at: number
  readonly title: string
  readonly body: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface AlertPort { send(alert: Alert): Promise<void> }
```

`level` is not a parameter. It is derived from `kind` by the factory:

```ts
export const alert = (kind, title, body, at, data?): Alert => ({ kind, level: LEVELS[kind], ... })
```

A caller therefore cannot promote a heartbeat to critical, and cannot demote a death exit. Loudness is a property of the *kind of event*, decided once, in one table.

### 3.2 The twelve kinds and their fixed levels

There are **twelve** `AlertKind` values, grouped in the source by what they are about.

| Group | Kind | Level | Fires when |
|---|---|---|---|
| Trading | `position-opened` | `info` | an entry order fills |
| Trading | `position-closed` | `info` | a `closeAll` fills |
| Trading | `dca-filled` | `info` | a DCA rung fills |
| Risk | `death-exit` | **`critical`** | the death watch returns `exit` |
| Risk | `ladder-frozen` | `warn` | the death watch returns `freeze`, or an exit was refused for the no-loss rule |
| Risk | `position-halted` | **`critical`** | recovery could not confirm an in-flight order, or the broker/machine desync guard fired |
| Risk | `kill-switch` | **`critical`** | the switch is engaged, released, or found engaged during a cycle |
| Risk | `token-retired` | **`critical`** | a human retired a token, or an idle slot was handed back |
| Operations | `engine-started` | `info` | the loop starts, and again when it stops |
| Operations | `heartbeat` | `info` | end of every cycle |
| Operations | `scan-empty` | `warn` | a scan produced no tradeable candidates |
| Operations | `provider-degraded` | `warn` | a cycle threw, a cycle recovered, concentration exceeded target, or a sell path failed re-confirmation |

The comment above `LEVELS` says why the table is short on criticals:

> an alert channel where everything screams is a channel nobody reads, and the one night it matters the message will be lost in the noise.

`token-retired` is the interesting entry, and the source explains it rather than leaving it to be inferred:

> A person reached in and took a token off the board. Critical is not about danger here, it is about never being throttled: this is the one event the log must carry even if it repeats, because it is the only kind the system did not decide for itself.

That reasoning is exactly right for a manual retirement, and it has a consequence the source does not flag — see §4.3.

The test that pins this is named for the rule: *"risk events are critical, trading events are not"*.

---

## 4. Throttling — protecting attention, never at the cost of risk

```ts
export class AlertThrottle {
  constructor(private readonly windowMs: number = 30 * 60 * 1000) {}

  shouldSend(alert: Alert, key: string = alert.kind): boolean {
    if (alert.level === 'critical') return true
    const last = this.lastSent.get(key)
    if (last !== undefined && alert.at - last < this.windowMs) return false
    this.lastSent.set(key, alert.at)
    return true
  }
}
```

Three properties, in the order they matter:

1. **Criticals are never suppressed.** The check is the first line, before any window lookup. *"A degraded provider can fire every minute for an hour; a death exit fires once and must never be swallowed. Rate limiting protects attention, and attention is only worth protecting for things that can wait."* The test is named *"NEVER suppresses a critical, however often it fires"*.
2. **The key defaults to the kind, and callers override it.** Scoped keys (`no-loss:<positionId>`, `ladder-frozen:<positionId>`, `released:<positionId>`, `unsellable:<address>`) exist so *"one noisy token does not mute another"* — also a named test.
3. **The window is 30 minutes**, set once at `src/runtime/main.ts:338` as `new AlertThrottle(30 * 60 * 1000)`.

### 4.1 Every emission site

Compiled from the source, not from the docs. "Throttled" means the call is guarded by `shouldSend`.

| Site | Kind | Level | Throttled | Key |
|---|---|---|---|---|
| `runtime/loop.ts:95` engine start | `engine-started` | info | no | — |
| `runtime/loop.ts:124` recovered after failures | `provider-degraded` | warn | **no** | — |
| `runtime/loop.ts:130` cycle threw | `provider-degraded` | warn | yes | `provider-degraded` (default) |
| `runtime/loop.ts:146` engine stopped | `engine-started` | info | no | — |
| `application/orchestrator.ts:139` halted position | `position-halted` | critical | no | — |
| `application/orchestrator.ts:152` switch found engaged | `kill-switch` | critical | guarded, **inert** | default |
| `application/orchestrator.ts:195` nothing passed the gates | `scan-empty` | warn | yes | `scan-empty` (default) |
| `application/orchestrator.ts:245` idle slot handed back | `token-retired` | critical | guarded, **inert** | `released:<id>` |
| `application/orchestrator.ts:359` above concentration target | `provider-degraded` | warn | yes | `provider-degraded` (default) |
| `application/orchestrator.ts:365` sell path not re-confirmed | `provider-degraded` | warn | yes | `unsellable:<address>` |
| `application/orchestrator.ts:410` heartbeat | `heartbeat` | info | yes | `heartbeat` (default) |
| `application/engine.ts:254` exit refused, position kept | `ladder-frozen` | warn | yes | `no-loss:<id>` |
| `application/engine.ts:272` death exit | `death-exit` | critical | no | — |
| `application/engine.ts:274` ladder frozen | `ladder-frozen` | warn | yes | `ladder-frozen:<id>` |
| `application/engine.ts:296` broker/machine desync | `position-halted` | critical | no | — |
| `application/engine.ts:343` entry or DCA filled | `position-opened` / `dca-filled` | info | no | — |
| `application/engine.ts:345` position closed | `position-closed` | info | no | — |
| `application/kill-switch.ts:47` engaged | `kill-switch` | critical | no | — |
| `application/kill-switch.ts:57` released | `kill-switch` | critical | no | — |
| `application/retire.ts:124` token retired | `token-retired` | critical | no | — |

### 4.2 Two guards that can never fire

`orchestrator.ts:152` and `orchestrator.ts:245` both wrap a **critical** alert in `shouldSend`. Because `shouldSend` returns `true` for criticals before it looks at the window, those guards are dead code, and the practical consequences are real:

- **While the kill switch is engaged, every pass writes a critical `kill-switch` alert.** It sits above step 2, so watch passes raise it too. On the production cadence (`OPERADOR_CYCLE_MS: 300000`, a pass every five minutes — §4.4) that is **twelve** vibrating, Do-Not-Disturb-piercing notifications an hour for as long as the engine is deliberately stopped — the state a human just chose. Nothing in the code caps it.
- **Every idle-slot handback raises a critical `token-retired` notification**, even though its own body says *"el token no queda vetado"* — the slot was recycled, nothing was blacklisted, no money moved. It is graded identically to a human pulling a token off the board.

Neither is a correctness bug; both are attention bugs, and attention is the resource this whole file exists to protect. The fix is a decision about the level table, not about the call sites (see §6.4 for why that decision is not free either).

### 4.3 Two warnings that share one key

`runtime/loop.ts:130` (a cycle threw) and `orchestrator.ts:359` (capital is above the concentration target) are both `provider-degraded` with the **default** key. They therefore share one 30-minute window: a concentration warning at minute 0 silences a genuine cycle failure at minute 10, and vice versa. The two events have nothing to do with each other.

### 4.4 The throttle is per process, and the process is a whole run

`AlertThrottle` holds an in-memory `Map`. What sets its useful lifetime is therefore the lifetime of the process, and **that is a whole run, not one cycle**:

```ts
// runtime/main.ts:338
throttle: new AlertThrottle(30 * 60 * 1000),
// runtime/main.ts:357 — built once, then handed to the loop
const report = await runLoop(deps, cycleConfig, throttle, { … })
```

`runLoop` takes one `throttle` and passes that same instance to every `runCycle`. In production one process runs up to **120 passes over 350 minutes** at a 5-minute cadence (`.github/workflows/engine.yml:111`, `OPERADOR_MAX_CYCLES: 120`, `OPERADOR_CYCLE_MS: 300000`, `timeout-minutes: 350`; `12-runtime-despliegue.md` §5.2 and §5.4). So the map spans the run, and the consequences are the opposite of what this section used to claim:

- the 30-minute window suppresses repeats **across passes**, for hours — not within one cycle;
- **`heartbeat` is throttled like anything else.** `orchestrator.ts:419` sends it through `if (throttle.shouldSend(beat))`, and `heartbeat` is `info`, not `critical`, so the window applies. At a 5-minute cadence roughly **one pass in six** emits a beat; the other five are silent by design, not because nothing happened;
- `engine-started` is the exception, and not because of its level: `loop.ts` calls `deps.alerts.send(...)` for it **directly, without consulting the throttle**, once before the loop and once after. Twice per run, always.

So a 350-minute run costs about a dozen `info` rows — two `engine-started` and eleven-or-so heartbeats — rather than three per cycle every fifteen minutes. The log grows far more slowly than the old note implies.

The thing to carry forward is that **assuming a fresh map per cycle is wrong**, and it is wrong in the direction that hides things: a repeated `info` or `warning` raised on pass 3 stays suppressed through pass 8.

A throttled heartbeat sounds like it should weaken the liveness signal, and it does not, because the liveness signal is not the heartbeat. `buildPhoneStatus` derives `engineStale` from `checkpoint.savedAt` (`phone-status.ts:56`, `:65`), and `saveCheckpoint` is written on **every** pass at `orchestrator.ts:408` — one line before the beat, and never through the throttle. The phone learns the engine is alive from the checkpoint; the heartbeat is the human-readable copy in the feed. Keeping those two separate is what lets the beat be throttled to a readable rate without the "silently dead engine" warning losing resolution.

Criticals are untouched by any of this: `shouldSend` returns `true` for them before it looks at the window (§4.2), so a death exit is never suppressed no matter how long the process has been running.

### 4.5 `heartbeatMs` is declared and never read

`CycleConfig.heartbeatMs` (`orchestrator.ts:88`, *"Emit a heartbeat when this long has passed since the last one"*) is set to one hour in `runtime/main.ts:330` and in two test rigs. **No code reads it.** The heartbeat's cadence is governed entirely by `AlertThrottle` — per §4.4, one map for the whole run — so the effective interval is the throttle's **30 minutes**, not the configured hour. The two numbers disagree and the declared one loses silently, which is the part worth fixing: an operator reading `heartbeatMs: 60 * 60 * 1000` will expect half as many beats as they get.

---

## 5. The log

### 5.1 The port

```ts
export interface StoredAlert extends Alert { readonly seq: number }

recordAlert(alert: Alert): Promise<StoredAlert>
alertsSince(seq: number, limit?: number): Promise<readonly StoredAlert[]>
latestAlertSeq(): Promise<number>
```

Three rules, each carrying its reason in the source:

**The cursor is a sequence, not a timestamp.**

> Two alerts can share a millisecond, and a timestamp cursor then has to choose between skipping one and replaying it forever — on a channel whose whole job is to deliver a death exit exactly once, neither is acceptable.

**`alertsSince` is exclusive.** `WHERE seq > $1`, oldest first — *"a client that passes back the last sequence it received never sees it twice."*

**`latestAlertSeq` is a separate method on purpose.**

> a client asking "am I behind?" must not have to read a page to find out — and reading the FIRST page to learn the LAST sequence is wrong the moment the log outgrows one page.

### 5.2 The table

`schema.sql:74-94`:

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

The `CHECK` makes the three levels a database constraint, not just a TypeScript union. The index on `(level, seq)` exists so a level-filtered feed does not scan the log; the primary key alone would not serve it. `data` is JSONB for the same reason positions are (`09-persistencia.md`): the payload of an alert is meant to keep evolving.

### 5.3 The two implementations

| | Postgres | Memory |
|---|---|---|
| `recordAlert` | `INSERT ... RETURNING seq` — *"the database assigns the order, so two engine instances writing at once still produce one unambiguous sequence"* | `seq = this.alerts.length + 1` — *"never from the clock: ordering must survive two alerts raised in the same millisecond"* |
| `alertsSince` | `WHERE seq > $1 ORDER BY seq ASC LIMIT $2`, default limit 100 | `filter(a => a.seq > seq).slice(0, limit)`, default limit 100 |
| `latestAlertSeq` | `SELECT seq FROM alerts ORDER BY seq DESC LIMIT 1`, `0` when empty | `this.alerts.at(-1)?.seq ?? 0` |

`MemoryStore` is not a convenience fake; it is the reference implementation that defines what correct means, and it deliberately reproduces the ordering guarantee rather than leaning on insertion order alone.

### 5.4 What the log tests pin

`src/infrastructure/persistence/alert-store.test.ts`, seven cases, each named as the rule it protects:

| Test | Asserts |
|---|---|
| an empty log has nothing to say | `alertsSince(0) === []` |
| stamps each alert with a sequence, starting at one | first `seq` is 1, level comes from the kind |
| orders by sequence, not by clock | two alerts at the same `at` keep insertion order and get `[1, 2]` |
| reads oldest first | a phone that was asleep replays events in the order they happened |
| the cursor is exclusive | `alertsSince(lastSeq)` is empty; `alertsSince(1)` skips the first |
| caps a page | 40 alerts, `limit 10` returns `beat 0..9`; paging from `page[9].seq` returns `beat 10` |
| keeps the structured detail | `data` round-trips — *"an alert without its evidence is a rumour"* |

### 5.5 Erasing the log, and the sequence

`tools/reset.sql` includes `alerts` in its full-reset `TRUNCATE`. Worth knowing: plain `TRUNCATE` in Postgres does **not** restart a `BIGSERIAL`, so after a reset the next alert continues from where the sequence left off. That happens to be the safe behaviour for every phone already in the field — their stored cursors stay below the new rows, so catch-up resumes correctly. Adding `RESTART IDENTITY` to that statement would silently break every installed app: new alerts would be numbered *below* each phone's cursor and `drainAlerts` would never see them again. This is an inference from Postgres semantics, not a comment in the file; if that line is ever edited, it is the thing to remember.

---

## 6. `StoredAlertSink` — the sink that does not take the engine down with it

`src/infrastructure/notifications/store-alerts.ts`, 65 lines, the production `AlertPort`.

```ts
constructor(
  private readonly store: Pick<StatePort, 'recordAlert'>,
  private readonly onError: (error: unknown) => void = () => {},
  private readonly spoolLimit = 50,
)
```

Note the `Pick<StatePort, 'recordAlert'>`: the sink can see exactly one method of the store, so it cannot read a position or write a fill even by accident.

### 6.1 Sending never throws into the engine

`write()` catches, hands the error to `onError`, and returns. The reason is in the header: *"A notification channel that can stop trading is a worse problem than a missed notification."* The test is named for it, and asserts `resolves.toBeUndefined()` while `onError` collected one error.

In production `onError` is `console.error('[alerts]', error)` (`runtime/main.ts:70`, `dashboard/app/api/control/route.ts:39`, `runtime/retire.ts:61`).

### 6.2 A critical that fails to land is retried

```ts
async send(alert: Alert): Promise<void> {
  await this.drain()   // spool first
  await this.write(alert)
}
```

and in `write`'s catch:

```ts
if (alert.level !== 'critical') return
this.spool.push(alert)
if (this.spool.length > this.spoolLimit) this.spool.shift()
```

Four decisions, each with a test:

| Decision | Reason | Test assertion |
|---|---|---|
| Drain **before** writing the new alert | *"a recovered database receives the backlog in the order the events actually happened rather than after the newest one"* | written kinds are `['death-exit', 'heartbeat']`, in that order |
| Only criticals are spooled | *"Swallowing the error is right for a heartbeat and wrong for a death exit"* | a lost heartbeat and a lost `scan-empty` never reappear; only `'landed'` is written |
| The spool is bounded (default 50) | *"an outage must not become a memory leak"* | — |
| Overflow drops the **oldest** | *"during a rolling collapse the most recent verdicts are the ones that still describe the world"* | `spoolLimit: 3`, ten deaths, then recovery → `['died 7', 'died 8', 'died 9', 'alive']` |

`drain()` stops at the first failure and keeps the backlog: *"Still down. Keep the backlog; the next alert tries again."*

### 6.3 What that costs during an outage

`drain()` runs on **every** `send`, including sends that are themselves about to fail. A chatty engine against a dead database therefore performs up to `spoolLimit + 1` failing writes per alert. It is bounded and it never throws, but it is not free, and each failure also fires `onError` — so a long outage produces a lot of `[alerts]` lines in the log.

### 6.4 The level table and the durability guarantee are the same decision

Only criticals are spooled. Demoting a kind from `critical` to `warn` in `LEVELS` — which is the obvious fix for the two noise problems in §4.2 — silently removes that kind's retry-on-failure guarantee at the same time. The two properties are welded together by `write()`'s one `if`. Any change to the level table is also a change to what survives a database blink.

---

## 7. `buildPhoneStatus` — the cheap poll

`src/application/phone-status.ts`, 70 lines.

```ts
export interface PhoneStatus {
  readonly generatedAt: number
  readonly killSwitchEngaged: boolean
  readonly lastEngineUpdate: number | null   // null when it has never checkpointed
  readonly engineStale: boolean
  readonly positions: number
  readonly frozen: number
  readonly cursor: number                    // newest alert sequence
}
```

It reads exactly three things, in parallel: `loadPositions()`, `loadCheckpoint()`, `latestAlertSeq()`.

**Cheapness is a requirement, not a preference.** From the header: *"No fills, no P&L, no scan. This runs every minute, forever, on a free-tier database — and the moment it stops being cheap it stops being something you can leave running."* And on the omission that looks strangest: *"P&L is not here on purpose. It is a number you go and LOOK at; the phone poll answers a different question: is the engine alive, is it stopped, and has anything happened that I have not seen."*

That is enforced by a test, not by discipline — a `Proxy` counts `fillsFor` calls and asserts `0`.

### 7.1 Staleness

```ts
export const STALE_AFTER_MS = 45 * 60 * 1000
engineStale: lastEngineUpdate === null || now - lastEngineUpdate > staleAfter
```

45 minutes is **three missed 15-minute cycles**: *"Long enough that a slow scan or a restart does not cry wolf, short enough that a dead engine is noticed within the hour."*

The `=== null` half is the important one. An engine that has **never** checkpointed is reported stale, not healthy:

> never having run and running fine are not the same state, and defaulting the unknown one to green is how a dead engine goes unnoticed.

The Android side mirrors the same fail-safe default: `json.optBoolean("engineStale", true)` — if the field is missing or unparseable, the phone assumes the worst.

### 7.2 The cursor, and the bug that has a regression test

`cursor` comes from `latestAlertSeq()`, never from the last element of `alertsSince(0)`. The inline comment says why:

> One row, from the END of the log. Reading the first page to find the last sequence stalls at the page size and the app silently stops noticing new alerts.

The test writes **130** alerts and asserts `cursor === 130` — named *"the cursor must not stall at 100"*, which is `alertsSince`'s default limit.

---

## 8. The HTTP surface

Three routes, all `force-dynamic`, all `cache-control: no-store`. They import from `src/application/` and write no SQL of their own (the rule in `11-vistas.md`). `dashboard/lib/store.ts` gives them one shared `pg.Pool` (`max: 2`) and a `failed()` helper that returns *"the message, never the stack: a stack from a database client carries connection details, and these endpoints are one paste away from public."*

| Route | Method | Auth | Returns |
|---|---|---|---|
| `/api/phone` | GET | none | `PhoneStatus` |
| `/api/alerts` | GET | none | `{ alerts, cursor }` |
| `/api/control` | GET | none | `{ engaged, since }` |
| `/api/control` | POST | **Bearer token** | `{ engaged, since }` after acting |

### 8.1 `/api/alerts`

```ts
const since = Number.parseInt(params.get('since') ?? '0', 10)
const limit = Number.parseInt(params.get('limit') ?? '50', 10)
const alerts = await store.alertsSince(
  Number.isFinite(since) && since > 0 ? since : 0,
  Math.min(Number.isFinite(limit) && limit > 0 ? limit : 50, MAX_PAGE),  // MAX_PAGE = 200
)
return Response.json({ alerts, cursor: alerts.at(-1)?.seq ?? (since > 0 ? since : 0) })
```

The echoed `cursor` exists because *"a client that derives it wrong silently replays or skips alerts"* — and note the fallback: an empty page echoes the cursor the caller sent, so a client that follows the echo never rewinds to 0. (The Android app happens to derive its own from `alerts.last().seq`, which is the same value whenever the page is non-empty; the echo is there for the next client.)

Defaults: page 50, hard cap 200. Note the store's own default is 100 — it never applies here, because the route always passes a limit.

### 8.2 Read is open, write is not

`GET /api/control` needs no token: *"it is already on the dashboard."* The dashboard is read-only and unauthenticated by design, so the switch's *state* is not a secret. Only `POST` is authorised.

---

## 9. The one write path, and its fail-closed authorisation

`src/application/control-api.ts`, 54 lines, with the design constraint in its header:

> The dashboard is read-only by design: no order can be placed from it, no position closed. The single exception is the kill switch, and it earns that exception by only ever making the system SAFER — it stops new positions and can never open one. A control surface that could trade would be a second attack surface on the money, guarded by a URL people paste into chats.

### 9.1 The verdict table

```ts
authoriseControl(configured: string | undefined, presented: string | null,
                 options: { fromHeader?: boolean } = {}): ControlVerdict
```

| Condition | Verdict | Status |
|---|---|---|
| `configured` missing | refuse | **503** `control token is not configured` |
| `configured.length < 24` | refuse | **503** `control token is not configured` |
| `presented === null` | refuse | 401 `not authorised` |
| header present but not `Bearer <x>` | refuse | 401 |
| token mismatch (any length) | refuse | 401 |
| exact match | allow | — |

`MIN_TOKEN_LENGTH = 24`: *"Short enough to type once into a phone, long enough not to be guessed."*

### 9.2 Fail closed, and why 503

An unconfigured or weak token produces **503, not 401** — the server is declaring itself unfit to answer, rather than telling the caller they guessed wrong. The header states the principle: *"we forgot to set it" and "anyone may stop the engine" must not be the same state.* The test is named *"refuses when no token is configured, instead of allowing"*.

Operationally this is a trap worth naming: a deploy that forgot `OPERADOR_CONTROL_TOKEN` looks like a **server fault**, not an auth failure. If you read 401 as "wrong token" and 503 as "server down", you will debug the wrong machine.

### 9.3 Constant time, and the length side channel

```ts
const secretsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

> a plain `===` on a secret returns as soon as it finds a differing byte, which over enough requests tells an attacker how much of the prefix is right.

Length is compared first and separately, which is the standard shape — and the test that matters is named *"a wrong token of a different length is still just wrong — length must not leak"*: a length mismatch returns the same `401 not authorised`, never a distinguishable error.

### 9.4 `Bearer`, or nothing

```ts
const bearer = (header: string): string | null => {
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match ? match[1]! : null
}
```

*"`Authorization: Bearer <token>` — anything else is not a credential."* `Basic`, a bare token, or a lowercase `bearer` all return `null` → 401.

### 9.5 What the POST actually does

`dashboard/app/api/control/route.ts`:

1. `authoriseControl(process.env.OPERADOR_CONTROL_TOKEN, request.headers.get('authorization'), { fromHeader: true })`
2. body must be `{ action: 'kill' | 'resume' }` — anything else is 400
3. `engageKillSwitch(store, alerts, 'manual', detail.slice(0, 200) ?? 'stopped from the phone', now)` or `disengageKillSwitch(store, alerts, now)`
4. respond with `killSwitchStatus(store)`

The `alerts` sink is a `StoredAlertSink` over the same store:

> Routed through the same alert log the engine writes to, so the phone sees its own action arrive the same way it sees a death exit — and so the audit trail records that a human stopped this, not a loss limit.

The `detail` is truncated to 200 characters before it is written. The `reason` is hardcoded `'manual'` here, which is what distinguishes it in `alerts.data` from the `'loss-limit'`, `'provider-failure'` and `'reconciliation'` values `KillSwitchReason` allows.

### 9.6 The switch itself

Covered fully in `05-riesgo.md` §5; the three properties that matter to this chapter:

- **It lives in the store, not the process.** *"a switch held in memory can only be thrown by a healthy engine, and a healthy engine is exactly the case where you least need one."* `engageKillSwitch` rewrites the `checkpoint` row, preserving `lastCompletedBar`, and nothing else.
- **It stops new positions and keeps the death watch running.** *"A switch that froze the death watch too would mean 'stop the engine' also meant 'stop protecting the money'."* The Android confirmation dialog spells this out to the user in Spanish, before they tap.
- **Releasing is a separate, explicit act.** Nothing re-enables the engine by itself.

**And the automatic limits do not fire.** `shouldEngage` (35% drawdown, or 3 death exits in 24h) is pure, tested, documented in `CLAUDE.md` — and has **no caller in production**. A repository-wide search finds it only in its own test file and in the docs. The only things that call `engageKillSwitch` are the control route and the demo server, both of which pass `'manual'`. This is already recorded in `05-riesgo.md` §5.4; it is repeated here because from the phone's point of view it means the switch is *entirely* manual today.

---

## 10. The Android app

`android/`, Kotlin, **one** dependency.

### 10.1 What it is, and what it is not

> An APK cannot contain the system: the dashboard is a server that reads Postgres, and no phone hosts that. So this is a shell around a URL — and saying so plainly matters, because an app that pretends to hold the data would leave you staring at a cached screen during exactly the outage you needed to see.

What it adds over a browser tab is precisely two things a tab cannot do: **it keeps watching while closed**, and **it can stop the engine**.

### 10.2 The files

| File | Lines of responsibility |
|---|---|
| `MainActivity.kt` | setup screen, WebView, top bar, kill-switch button, settings dialog, permission prompts. Programmatic views, no XML layouts |
| `WatchService.kt` | the foreground service: poll, drain, notify, describe |
| `Api.kt` | HTTP over `HttpURLConnection` + `org.json`; three result types |
| `Notifications.kt` | three channels, notification ids, per-kind prefixes |
| `Prefs.kt` | private `SharedPreferences`: URL, token, cursor, poll interval, watching |
| `BootReceiver.kt` | restart the watch after a reboot, if it was not paused |
| `AndroidManifest.xml` | the `specialUse` service, the boot receiver, seven permissions |
| `build.gradle.kts` | `compileSdk`/`targetSdk` 35, `minSdk` 26, Java 17, one dependency |
| `build-apk.sh` | finds a JDK in 17..21 and the SDK, then builds |
| `res/xml/network_security_config.xml` | cleartext permitted, with its expiry condition written down |

### 10.3 `Api` — three results, not two

```kotlin
sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class Refused(val status: Int, val message: String) : Result<Nothing>   // reached it; it said no
    data class Unreachable(val cause: String) : Result<Nothing>                  // never reached it
}
```

> A monitor that collapses those two treats a lost signal as good news, which is the exact failure it exists to prevent.

| Call | Endpoint |
|---|---|
| `Api.status(prefs)` | `GET /api/phone` |
| `Api.alertsSince(prefs, since, limit = 50)` | `GET /api/alerts?since=&limit=` |
| `Api.control(prefs, action, detail)` | `POST /api/control` with `Authorization: Bearer <token>` |

`TIMEOUT_MS = 12_000` for both connect and read. Non-2xx responses are read from `errorStream`, and the body's `error` field becomes the `Refused` message (falling back to `"HTTP <status>"`).

Two sharp edges in this file:

- **`Api.map` turns a JSON parse failure into `Refused(200, "unreadable response: …")`.** A 200 that is not JSON reads as a *refusal*, not as a network problem. Put a captive portal or a proxy that returns an HTML login page in front of the engine and the ongoing notification will say *"El servidor rechazó"* when the truth is "something intercepted the request".
- **`Api.control` short-circuits locally** when the token pref is empty: `return Result.Refused(401, "no control token set")` — without touching the network. A kill switch that "the server refuses" may be a request that never left the phone.

### 10.4 `WatchService` — the part that keeps watching

**Why a foreground service at all.** It is the only way Android lets an app keep polling while closed, and the permanent notification it requires *"is not a tax — it is the honest statement that something is running on your behalf."*

**Why `specialUse` and not `dataSync`.** From the manifest comment:

> specialUse, not dataSync. Android 15 caps dataSync at six hours per day, which is exactly the wrong limit for something whose job is to be watching at 3am.

The manifest carries the justification string the type requires:

```xml
<service android:name=".WatchService" android:exported="false"
         android:foregroundServiceType="specialUse">
    <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
              android:value="Continuous monitoring of the user's own trading engine for risk alerts" />
</service>
```

`startForeground` passes `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` on SDK ≥ 34 (`UPSIDE_DOWN_CAKE`) and the two-argument form below that.

**`START_STICKY`:** *"if Android kills the process for memory, it comes back. A watchdog that does not restart is a watchdog that was never there."*

**The loop.** One non-daemon thread named `operador-watch`, guarded by an `AtomicBoolean`. It sleeps in **2000 ms slices** rather than one long sleep *"so stopping the service is immediate rather than taking up to a full poll interval."* When not configured or not watching, it updates the ongoing notification to `"Sin servidor configurado"` or `"En pausa"` and keeps looping.

**`poll`:**

| `Api.status` result | Action |
|---|---|
| `Ok` | clear `lastReportedTrouble`, `drainAlerts(prefs, status.cursor)`, rewrite the ongoing notice with `describe(status)` |
| `Refused` | `trouble("El servidor rechazó: " + message)` |
| `Unreachable` | `trouble("No se puede contactar al motor")` |

`trouble()` always updates the ongoing notification text but logs only on change, *"so a persistent failure is reported once, not every minute."*

**`describe(status)`** builds the one honest status line, joined by ` · `:

`DETENIDO` / `Funcionando` · `N posición(es)` · `N congeladas` (only when > 0) · `visto HH:mm` or — the case that matters — `motor en silencio desde HH:mm`, annotated in the source as *"The failure that looks exactly like nothing happening."* A never-checkpointed engine stamps as `nunca`.

### 10.5 `drainAlerts` — the cursor discipline

```kotlin
if (serverCursor <= prefs.cursor) return

// A fresh install starts from now rather than replaying a month of
// history into the notification shade.
if (prefs.cursor == 0L) { prefs.cursor = serverCursor; return }

var guard = 0
while (prefs.cursor < serverCursor && guard < MAX_PAGES) {
    guard += 1
    val page = Api.alertsSince(prefs, prefs.cursor, PAGE_SIZE)
    if (page !is Api.Result.Ok) return
    val alerts = page.value
    if (alerts.isEmpty()) return
    for (alert in alerts) {
        if (alert.level != "info") Notifications.raise(this, alert)
    }
    prefs.cursor = alerts.last().seq
}
```

Four properties:

1. **The cursor advances only after the page's notifications have been raised.** *"A crash between the read and the notification therefore replays the page rather than skipping it… a duplicate alert is a nuisance, a missing one is the whole failure."*
2. **A fresh install jumps to the server cursor** instead of replaying history into the shade.
3. **`info` is filtered here, not on the server.** It stays in the feed and on the dashboard; it never becomes a notification.
4. **A failed page returns without advancing the cursor** — correct (nothing is skipped), but it also means a server that intermittently refuses stalls the notification stream entirely rather than catching up partially.

`PAGE_SIZE = 50`, `MAX_PAGES = 20` → at most **1000 alerts drained per poll**. The guard exists to prevent an unbounded loop, but it is also a latency ceiling: a phone more than 1000 alerts behind needs several poll intervals to catch up, so a death exit buried 1500 alerts back arrives minutes late.

### 10.6 `Notifications` — three channels, because they are three different promises

| Channel | Id | Importance | Used for |
|---|---|---|---|
| `Riesgo` | `critical` | `IMPORTANCE_HIGH`, vibration on | `critical` alerts — must break through Do Not Disturb |
| `Actividad` | `activity` | `IMPORTANCE_DEFAULT` | `warn` alerts |
| `Vigilancia` | `watch` | `IMPORTANCE_MIN`, `setShowBadge(false)` | the permanent ongoing notice |

> A death exit must break through Do Not Disturb; a DCA fill must not. The engine already grades its own alerts — this maps that grading onto the only thing Android lets the user actually control, which is the channel.

`IMPORTANCE_MIN` for the watch channel is deliberate: *"this one is always present. A permanent notification that makes a sound is a permanent annoyance."*

**Ids.** `ID_ONGOING = 1` is fixed *"the ongoing notification is replaced, never stacked."* Alerts use `ID_ALERT_BASE (1000) + alert.seq` *"so the same alert seen twice replaces itself instead of arriving twice, and two different alerts never collapse into one."*

**Prefixes**, prepended to the title: `☠️ death-exit`, `⛔ position-halted`, `🛑 kill-switch`, `❄️ ladder-frozen`, nothing otherwise.

Criticals also get `CATEGORY_ALARM` and `PRIORITY_HIGH`; everything else gets `CATEGORY_STATUS` / `PRIORITY_DEFAULT`. Both `update` and `raise` are wrapped in `runCatching` and `update` checks `areNotificationsEnabled()` first — a revoked notification permission must not crash the watch thread.

**One unguarded edge:** `ID_ALERT_BASE + alert.seq.toInt()`. `seq` is a Kotlin `Long` fed by a Postgres `BIGSERIAL`, and `.toInt()` truncates. Past 2³¹ alerts, or after a manual sequence reset, two different alerts can land on the same notification id and silently replace each other; a truncated value of `-999` would collide with `ID_ONGOING`. Nothing in the code guards it. At four info rows per 15-minute cycle this is decades away, so it is a latent edge rather than a live one.

### 10.7 `Prefs`

Private `SharedPreferences` named `operador`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `server_url` | String | `""` | normalised on write |
| `control_token` | String | `""` | trimmed on write; empty means read-only app |
| `cursor` | Long | `0` | the last sequence actually *shown* |
| `poll_seconds` | Int | `60` | `coerceIn(30, 3600)` on write |
| `watching` | Boolean | `true` | a deliberate pause |

`Prefs.normalise("192.168.1.5:3100")` → `"http://192.168.1.5:3100"`; an existing scheme is preserved, trailing slashes trimmed. `endpoint(path)` is `serverUrl.trimEnd('/') + path`.

The 60-second default is argued, not assumed: *"Fast enough that a death exit reaches the phone while it still matters, slow enough to be invisible on the battery — and the engine only decides once every fifteen anyway."*

**The threat model for the token is stated in the file:**

> the token can only STOP the engine. It cannot place an order, move a coin, or reach a wallet — so the worst a stolen token buys is the ability to halt your own trading, which is the failure mode we chose on purpose.

### 10.8 `MainActivity`

**First run** is a setup screen: server address and an optional control token, with the note *"Solo hace falta para detener el motor desde el teléfono. Nunca puede abrir una orden."* Once configured, `render()` shows the dashboard screen and starts `WatchService` if `watching`.

**The dashboard screen** is a top bar over a full-bleed `WebView` pointed at `prefs.serverUrl`. JavaScript and DOM storage on, zoom off, background painted `#0d1117` before the page loads *"No white flash before the page paints."*

**Three decisions in this file are scars:**

- **No reload on resume.** *"reloading on top of that threw away the canvas, snapped every orbit back to its starting angle and dropped the viewer's selection, which reads as the screen flinching for no reason."* The `⟳` button remains for a deliberate rebuild, and `sendControl` likewise does not force a reload — *"the page picks the new state up on its next poll."*
- **The kill-switch control says `PARAR`, in words.** *"It was a power glyph until a device without that codepoint drew it as an empty box — the most consequential control in the app, rendered as nothing. A word cannot go missing from a font."*
- **`onReceivedError` only paints the failure screen for `request.isForMainFrame`** — *"a failed favicon must not paint an error over a page that loaded fine."* The failure page names the host and tells the user to check the machine running the dashboard.

**The kill-switch flow.** With no token, `confirmKillSwitch` toasts and opens settings rather than sending anything. Otherwise an `AlertDialog` with three buttons — `Detener el motor` / `Volver a arrancarlo` / `Cancelar` — over a message that spells out what does *not* happen: open positions are kept, the death watch keeps running, nothing is sold. *"a mis-tap that stops a running engine is expensive, and 'are you sure' is the cheapest possible guard against a pocket."* `sendControl` runs on a plain `Thread` and posts a Toast back to the main looper, distinguishing `Ok` / `Refused` / `Unreachable` — the last one reported as *"no se pudo contactar al motor: queda como estaba"*, which is the honest statement that nothing changed.

**Settings** re-edits URL, token and poll interval, toggles watching (starting or stopping the service immediately), and — only when the app is not already exempt — offers the battery-optimisation exemption. `requestBatteryExemption` tries `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and falls back to the settings **list** screen, *"Some OEM builds hide the direct intent."*

**Permissions**: `POST_NOTIFICATIONS` is requested at `onCreate` on SDK ≥ 33 (`TIRAMISU`).

### 10.9 `BootReceiver`

```kotlin
if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
if (prefs.configured && prefs.watching) WatchService.start(context)
```

> A phone reboots at 4am for an update and the watch is gone until someone opens the app — which, for a monitor, means it was never a monitor. This brings it back. Only if the user had it watching: a reboot must not undo a deliberate pause.

### 10.10 Build, signing and toolchain

| Setting | Value | Reason |
|---|---|---|
| `namespace` / `applicationId` | `com.opendoors.operador` | |
| `compileSdk` / `targetSdk` | 35 | |
| `minSdk` | **26** | *"notification channels exist from here, which removes an entire branch of compatibility code from the alerting path"* |
| `versionCode` / `versionName` | 1 / `0.1.0` | |
| Java / Kotlin JVM target | 17 | |
| Dependencies | **one**: `androidx.appcompat:appcompat:1.7.0` | *"three libraries to poll two endpoints would be more dependency than program"* |
| `release` signing | the **debug** key | *"this is sideloaded onto one phone. A release keystore buys distribution we are not doing."* |
| `allowBackup` | `false` | the cursor and the token are not backed up |

**`build-apk.sh` exists because the newest JDK is the wrong JDK.** AGP supports 17 through 21; *"Gradle 8.14 does not even parse a JDK 25 version string, and fails with the bare number as its entire error message."* The script probes `JAVA_HOME`, `~/.jdks`, `%USERPROFILE%/.jdks`, Eclipse Adoptium, `Program Files/Java`, and Android Studio's bundled `jbr`, accepts only a version in `[17, 21]`, and **refuses to build rather than guessing**. Then it locates the SDK from `ANDROID_HOME` / `ANDROID_SDK_ROOT` or four conventional paths. Output: `android/operador-<variant>.apk`.

Its other warning is about `local.properties`:

> a Java properties file, so a Windows path in it needs every backslash doubled — a single one silently becomes an escape sequence and the build fails with "invalid file name", which points at nothing.

**`allowBackup="false"` has a consequence worth stating:** restoring onto a new phone starts the cursor at 0, which by the fresh-install rule jumps to the server cursor and **skips whatever was pending**. A device migration is not a resumption.

### 10.11 Cleartext, and what it exposes

`network_security_config.xml` permits cleartext, with the reason and the expiry condition both written down:

> Cleartext is permitted because during the paper phase the engine runs on a machine on the same LAN, reached as `http://192.168.x.x:3100` — an address that cannot hold a certificate. The app only ever loads the one URL its owner typed in, so the exposure is that URL and nothing else. Once the dashboard is behind HTTPS, set `cleartextTrafficPermitted` to false.

`android/README.md` states the residual exposure plainly: anything on the network that finds the address can **read** your positions. It cannot trade — there is no write path — and it cannot stop the engine without the token. But it can look.

### 10.12 The battery caveat, which the app cannot fix

Android may delay the service's work in deep sleep, and some OEM builds (Xiaomi, Huawei, Samsung are named in the README) are aggressive enough that the battery-optimisation exemption is not optional if you want the interval you configured. The app offers the button; it cannot enforce the outcome. The alert still arrives — later.

One measurement footnote: the wait loop does `slept += slice` (a full 2000) even when the actual `Thread.sleep` was `minOf(slice, waitMs - slept)`, a shorter final nap. For a `pollSeconds` that is not a multiple of 2, the loop exits slightly early. Harmless, but do not treat `pollSeconds` as exact.

---

## 11. The demo server

`src/runtime/demo-server.ts`, run with `npm run dev:phone-api`.

> The Android app needs something to talk to before a database exists, and a hand-rolled fake would test the fake. This runs the REAL read models, the REAL authorisation and the REAL kill switch against `MemoryStore` — so what it proves about the app transfers, and the only thing not exercised is the SQL.

| Setting | Value |
|---|---|
| `PORT` | 3101 (`0.0.0.0`) |
| Dashboard redirect | `http://<client host>:3100/demo`, or `OPERADOR_DASHBOARD_URL` |
| `TOKEN` | `OPERADOR_CONTROL_TOKEN`, default `demo-token-not-for-real-money` (printed at startup) |
| `ALERT_EVERY_MS` | 45 000 |
| Seed | two positions (`DREGG` solana, `LEAFY` solana frozen — `TROLL` maps to bsc in the factory), one checkpoint, one `engine-started` |

It serves `/api/phone`, `/api/alerts` and `/api/control` with the same functions the dashboard routes use, and redirects everything else to the dashboard's `/demo`. That redirect host is derived from the **client's** `Host` header rather than hardcoded:

> a phone that connects to 10.0.2.2 or to a LAN address cannot follow a redirect to `localhost`, because on a phone localhost is the phone.

It invents an alert every 45 seconds from a six-entry `SCRIPT` that deliberately covers **every level the phone treats differently** — `dca-filled` (info, silent), `ladder-frozen` and `scan-empty` (warn, Actividad), `death-exit` and `position-halted` (critical, Riesgo), `heartbeat` (info) — *"because an alerting channel you cannot watch arrive is a channel you have not tested."* Each invented alert also rewrites the checkpoint, so `engineStale` stays false while the demo runs.

---

## 12. `retire.ts` — the operator's escape hatch

### 12.1 Why it exists

The originating incident is in the file header:

> a fifteen-day-old memecoin was scanned, ranked and allocated capital under the symbol "BTC", because the impersonation gate knew WBTC and not BTC. The gate is fixed; the gate only stops NEW positions.

That is the general shape: a gate fix protects the future, and something is already open. The dashboard is read-only and the control endpoint is one-way safe, so nothing else can close a position.

### 12.2 A decision, not a verdict

> This is not a death exit. A death exit is a VERDICT — the asset stopped being an asset, and the evidence chain is part of the record. Retiring is a DECISION, made by a person for a reason the system could not compute, and calling it a death would put a diagnosis in the log that nothing diagnosed.

It is one-way safe in the same sense as the kill switch: *"it can only ever leave the system holding less. It cannot open a position, size one, or move capital toward anything."* (`05-riesgo.md` §2.14 makes the same distinction from the death-exit side.)

### 12.3 The shapes

```ts
interface RetireDeps  { store: StatePort; brokerFor: (p: PersistedPosition) => Promise<BrokerPort>; alerts: AlertPort; now: () => number }
interface RetireRequest { chain: Chain; tokenAddress: string; reason: string }
interface RetireResult  { retired: boolean; symbol: string | null; soldQty: number; proceedsUsd: number; cancelledOrders: number; refusal?: string }
```

### 12.4 The algorithm, and the one ordering that matters

1. Match the position on `` `${chain}:${tokenAddress}` ``.
2. **No position** → `blacklist` and return `{ retired: true, symbol: null }`. The blacklist *is* the whole job: it is what stops the scanner offering the token next cycle.
3. Build the broker (`brokerFor`) and read `broker.snapshot(position.lastPriceUsd ?? 0).size`. Size does not depend on the mark, *"and it must be, because 'holds tokens but has no measured price' is exactly the case that has to be refused below."*
4. **Refuse** if `holding > 0 && position.lastPriceUsd === null` — nothing is written, and a Spanish refusal explains why (§12.5).
5. If holding, `broker.execute([{ kind: 'closeAll', comment: '🏁 Exit' }], lastPriceUsd, at)` and record each fill.
6. `closePosition(position.id)` — **then** `blacklist(...)`.
7. Send a **critical** `token-retired` alert naming the reason, the amount sold, any cancelled pending orders, and the fact that the token is now blacklisted.

Step 6's order is the load-bearing one:

> Closing before blacklisting can leave the token eligible for a new position — annoying, and fixed by running this again. Blacklisting first would leave an ABANDONED bag: skipped by recovery, still held, its capital counted as free. One is a retry; the other is a silent hole.

Concretely: `planRecovery` **skips** a blacklisted position (`09-persistencia.md` §8.4), so blacklisting a held token stops it being ticked while its tokens stay bought, *and* drops its capital out of the committed total — after which the portfolio allocator hands the same dollars to another slot. **Never call `store.blacklist` on a held token without selling and closing first.**

### 12.5 The refusal

```ts
if (holding > 0 && position.lastPriceUsd === null) {
  return { retired: false, ..., refusal: `${position.symbol} tiene tokens y no hay precio medido para venderlos. No se inventa un precio: la posición queda intacta.` }
}
```

> Booking a sale at an invented price would put a fiction in the ledger every other number in this system is derived from, so the position stays whole and a human gets told why.

The test asserts both halves of "nothing was written": the position is still loaded **and** the token is **not** blacklisted.

### 12.6 The idempotency key

```ts
idempotencyKey: `retire:${position.id}:${at}:${index}`
```

> Keyed by the retirement instant, not by a bar: this sale was not decided by any bar, and pretending otherwise would collide with a real order the engine might key the same way.

`09-persistencia.md` §7.3 covers the key scheme in full.

### 12.7 The CLI

```bash
npm run retire -- <chain> <address> "<reason>"
```

`src/runtime/retire.ts` is a **separate process from the engine, on purpose**:

> The engine decides for itself and is meant to run unattended; this is a person overruling it, and the two should not share a process, a schedule, or a reason to be running.

Validation happens **before anything connects**:

| Check | Failure |
|---|---|
| chain ∈ `['solana', 'bsc']` | `exit 1` |
| address present | `exit 1` |
| `reason.length >= 10` | `exit 1` |
| `DATABASE_URL` set | `exit 1` |
| `retireToken` returned `retired: false` | prints `[refused] …`, `exit 2` |

> A retirement with no reason is a row in the blacklist that nobody can audit later, and "why is this token banned" is the only question that row exists to answer.

The broker is rebuilt from the recorded fills — `PaperBroker.seed(await store.fillsFor(position.id))` — *"exactly as the engine does it. The fills are the facts; anything else would be a second opinion about what is held."* It reads `OPERADOR_GAS_USD` (default `0.05`) and `OPERADOR_MAX_DCA` (default 5, `+1` for the entry) so the simulated broker charges what the engine's does.

### 12.8 Seven tests, seven rules

| Test | Rule |
|---|---|
| closes the position and blacklists the token | the happy path writes both |
| cancels an entry that had not filled yet | `cancelledOrders: 1`, `soldQty: 0`, no sell fill |
| sells what the position actually holds before closing it | `soldQty ≈ 7.5`, exactly one sell fill |
| refuses to sell at a price nobody measured | `retired: false`, position intact, token **not** blacklisted |
| blacklists a token it holds no position in | `symbol: null`, blacklist written |
| says what it did, loudly | the alert is `critical` and quotes the reason verbatim |
| is safe to run twice | second run finds nothing and still reports `retired: true` |

The last one deserves a caveat the test does not state: the blacklist insert is `ON CONFLICT DO NOTHING`, so the **first** reason is the one that persists. Re-running with a better-worded reason will not update the row.

### 12.9 Two caller hazards

- **`retireToken` returns `retired: false` with a `refusal` string; it does not throw.** The CLI maps that to exit code 2. Any other caller that ignores `result.retired` will believe a refused retirement succeeded.
- **The alert body and the refusal are Spanish**, per the project's interface-language convention; the reason string is whatever the operator typed.

---

## 13. Sharp edges, collected

Everything below is in the source today.

| # | Where | What |
|---|---|---|
| 1 | `orchestrator.ts:152` | While the kill switch is engaged, a **critical** `kill-switch` alert is written every pass, watch passes included — twelve vibrating notifications an hour at the 5-minute cadence, for a state the user chose. The `shouldSend` guard around it cannot fire, because criticals bypass the throttle |
| 2 | `orchestrator.ts:245` | An idle-slot handback uses kind `token-retired` → critical → notifies like a manual retirement, although nothing was blacklisted and no money moved. Its `released:<id>` throttle key is likewise inert |
| 3 | `loop.ts:130` + `orchestrator.ts:359` | Two unrelated `provider-degraded` warnings share the default throttle key, so either can silence the other for 30 minutes |
| 4 | `orchestrator.ts:88`, `main.ts:330` | `heartbeatMs` is configured to one hour and **never read**; the real cadence is `AlertThrottle`'s 30 minutes, held for the whole run (§4.4/§4.5) |
| 5 | `alerts.ts` + `store-alerts.ts` | The level table and the retry-on-failure guarantee are one decision. Demoting a kind out of `critical` silently removes its spooling |
| 6 | `store-alerts.ts` | `drain()` runs on every `send`, so a long outage does up to `spoolLimit + 1` failing writes per alert (bounded, never thrown, but noisy) |
| 7 | `Notifications.kt:101` | `ID_ALERT_BASE + alert.seq.toInt()` truncates a `BIGSERIAL`. Past 2³¹ alerts — or after a sequence reset — ids can collide, including with `ID_ONGOING` |
| 8 | `WatchService.kt` | `MAX_PAGES × PAGE_SIZE = 1000` alerts per poll is also a latency ceiling for a phone that was off a long time |
| 9 | `WatchService.kt:139` | A non-`Ok` page returns without advancing the cursor — correct, but an intermittently refusing server stalls the whole notification stream |
| 10 | `Api.kt:93` | A 200 response that is not JSON is reported as `Refused`, not `Unreachable`. Captive portals and proxies will read as "the server refused" |
| 11 | `Api.kt:82` | `control` short-circuits to `Refused(401, "no control token set")` without any network call when the token pref is empty |
| 12 | `control-api.ts:40` | A missing `OPERADOR_CONTROL_TOKEN` returns **503**, not 401 — deliberate, but it looks like a server fault to whoever is debugging |
| 13 | `kill-switch.ts:93` | `shouldEngage` has no production caller. The automatic drawdown and death-cluster limits documented in `CLAUDE.md` do not fire |
| 14 | `docker-compose.yml:11-12` | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are still passed to the container and read by nothing |
| 15 | `AndroidManifest.xml` | `allowBackup="false"` means a device migration starts the cursor at 0, which jumps to "now" and skips whatever was pending |
| 16 | `network_security_config.xml` | Cleartext is on. Anything on the LAN that finds the dashboard can read positions (it cannot trade, and cannot stop the engine without the token) |
| 17 | `retire.ts` | The blacklist is `ON CONFLICT DO NOTHING`; a second retirement never improves the recorded reason |

---

## 14. Cross-references

| Chapter | For |
|---|---|
| `05-riesgo.md` | The death exit that produces the critical alerts; the kill switch's asymmetry; `shouldEngage`; retiring vs. dying |
| `08-motor.md` | Where each alert is emitted inside the tick and the cycle; the no-loss refusal; the desync guard |
| `09-persistencia.md` | The `alerts` table among the nine; idempotency keys, including `retire:`; recovery skipping blacklisted positions |
| `11-vistas.md` | `buildPhoneStatus` as a read model; `control-api.ts` from the dashboard's side; why the web app computes nothing |
| `android/README.md` | The operator-facing build and setup guide |
| `12-runtime-despliegue.md` | §5.2/§5.4: one process, up to 120 passes over 350 minutes — the lifetime `AlertThrottle`'s window actually spans |
