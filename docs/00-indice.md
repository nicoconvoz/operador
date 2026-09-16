# Index — Operador by Open Doors, technical documentation

This is the technical documentation of **Operador by Open Doors**: a self-hosted, spot-only, on-chain trading system that watches thousands of small-cap tokens across Solana and BSC, decides which of them are worth touching at all, and runs the CASCADE DCA strategy on the survivors — with a two-stage death exit for the ones that stop being assets. It is written for the people who have to reason about this system with money in it: whoever operates the engine, whoever changes its code, and whoever has to decide whether a number on the dashboard can be true. Every chapter is checked against the source at `E:/Operador`, and where the code and the prose disagree the disagreement is **named rather than smoothed over** — known gaps, dead configuration, drifted defaults, and the handful of functions that were written, tested, documented as the fix and never called by the engine are all recorded in the chapters that own them. This is a description of what exists, not a plan of what was intended.

---

## Table of contents

| File | Title | What it answers |
|---|---|---|
| [`01-vision-general.md`](01-vision-general.md) | Overview and architecture | What the system is for, why it is two subsystems, the `MarketQuality` contract between them, the hexagonal layering, one full cycle end to end, and a directory map of the repository. |
| [`02-indicadores.md`](02-indicadores.md) | Indicators and Pine parity | How every `ta.*` function is ported and the semantics parity actually rests on — seeding, `na`, the biased estimator, direction encodings — plus golden files as an external oracle and the `ta.bb` tuple finding that makes the BBW filter inert. |
| [`03-estrategia-cascade-dca.md`](03-estrategia-cascade-dca.md) | CASCADE DCA, the reference strategy | The state machine in its exact evaluation order: both entry doors, the ladder's triggers and sizes, the five rebound locks, one fill per bar, the two exits, the 50-signalled/10-fillable split, and every parameter counted in bars. |
| [`04-escaner.md`](04-escaner.md) | The scanner | Which tokens the executor is allowed to touch at all: the three universe sources, `TokenSnapshot`, every gate and the order it runs in, fail-closed versus fail-open, the freefall gate, the opportunity score, ranking, and the rotating security budget. |
| [`05-riesgo.md`](05-riesgo.md) | Risk: the death exit, the portfolio, the slots, the kill switch | Is this asset still an asset, how capital splits across tokens, which slots are being wasted, and when the whole engine stops taking new risk — including the type-level construction that keeps price out of the death path. |
| [`06-economia.md`](06-economia.md) | Economics: sizing, costs and the capital floor | What a fill really costs: effective depth from a measured quote rather than reported TVL, the three budgets, the derived gas floor, the production ladder, what the paper broker charges, the capital-floor experiment, and the U-shaped cost curve. |
| [`08-motor.md`](08-motor.md) | The engine tick and the cycle | How a decision becomes an order: `tickPosition` step by step, the catch-up walk, the execution layer, the refusal to sell at a loss, `runCycle`'s ordering as a safety property, watch versus full, slot release, the common fund, and `ledger.ts`. |
| [`09-persistencia.md`](09-persistencia.md) | Persistence and crash recovery | Why the database is the truth and memory only a cache: `StatePort`, the nine tables, idempotency enforced in SQL, the idempotency key scoped to the deciding bar, and the three recovery verdicts — one of which is *halt and ask a human*. |
| [`10-adaptadores.md`](10-adaptadores.md) | Adapters and the outside world | Every line of code that touches a network: six providers, the shared HTTP seam, the sell probe as one port with two chain implementations, the hand-written ABI call, the rate-limit story and the two caches that fixed it. |
| [`07-paper-mode.md`](07-paper-mode.md) | Paper mode and the honest broker | What paper mode simulates and what it does not: the fill model in and out, the three rejections, `entryMid` and the gross-versus-net identity, cost attribution by cause, `seed`, and where the "paper must be honest" constraint is kept or broken. |
| [`11-vistas.md`](11-vistas.md) | Read models, the dashboard and the universe view | Every number a human sees and where it is computed: the four read models, the universe canvas mark by mark with the formula behind each, the four decisions that let it run on a phone, and why the screen shows warnings instead of a green badge. |
| [`12-runtime-despliegue.md`](12-runtime-despliegue.md) | Runtime, configuration and deployment | Where the pure system meets a process: the composition root, every environment variable with its default and its reasoning, the supervised loop and its two cadences, GitHub Actions, the retire path, Docker, the $0 stack, and documented-versus-actual drift. |
| [`13-telefono-alertas.md`](13-telefono-alertas.md) | The phone, alerts and the control path | How an unattended engine stays observable and stoppable: the alert contract and its levels, the durable log that replaced Telegram, the cursor as a sequence, the three endpoints, the Android app, and the one fail-closed write path. |
| [`14-pruebas.md`](14-pruebas.md) | Testing discipline | How this repository is tested and why: strict TDD where it actually binds, the measured pyramid, golden files that are never regenerated from our own output, the parity harness, rug fixtures, smoke tests, and every command needed to run it all. |
| [`15-decisiones.md`](15-decisiones.md) | Decision log and lessons paid for | What the live market taught, incident by incident — symptom, root cause, fix, lesson — plus the three failure shapes that keep recurring: the fix never wired, the number never configured, and the sentinel that meant two things. |

Two notes on the numbering, since this index describes what exists rather than what was planned. **Two chapters share the prefix `09`** — `10-adaptadores.md` and `07-paper-mode.md`. They are separate subjects (the outside world, and the simulated fill), and the collision is in the filenames only. And `01-vision-general.md` §11 carries its own "where to read next" table, written when there was no index; the two agree, and that table remains the authority on which chapter owns which subject.

---

## Start here

Three paths. They overlap, and none of them is the whole set in order — reading fifteen chapters front to back is not how anyone actually arrives at this system.

### To UNDERSTAND the system

For someone deciding whether the design is sound, or explaining it to someone else.

1. **`01-vision-general.md`** — the mission, the two subsystems, and the one contract between them. Everything else assumes this chapter.
2. **`03-estrategia-cascade-dca.md`** — what the system actually does with money: the ladder, the locks, the exits.
3. **`04-escaner.md`** — how a token earns the right to be traded at all, and why the safety gates fail closed.
4. **`05-riesgo.md`** — the death exit, and the distinction that makes it coherent: a stop loss exits because the price fell, a death exit because the asset stopped being an asset.
5. **`06-economia.md`** — why many small positions beat one large one, measured rather than argued.
6. **`15-decisiones.md`** — the incidents that shaped all of the above. Read last, and much of what looked arbitrary stops looking arbitrary.

*Optional depth:* `02-indicadores.md` if you want to know why parity is believable, and `07-paper-mode.md` if you want to know what a paper number is worth.

### To OPERATE it

For someone who has to keep it running, restart it, stop it, or work out at 3am whether it is alive.

1. **`01-vision-general.md`** §5 — one cycle, recovery to heartbeat. The shape of everything the engine does.
2. **`12-runtime-despliegue.md`** — configuration, the supervised loop, the GitHub Actions schedule, the retire path, and the drift between what the deploy docs say and what the code reads.
3. **`08-motor.md`** §8–§9 — what a pass does, and the difference between a cheap watch pass and an expensive full one.
4. **`13-telefono-alertas.md`** — the alerts, which levels are critical and never throttled, and the kill switch as the single write path.
5. **`11-vistas.md`** — how to read the dashboard, the universe view and the operations screen, including the warnings that matter and the one that matters most: a position nobody has updated in hours.
6. **`09-persistencia.md`** §8–§9 — what a restart does, and why a halted position is asking for you specifically.
7. **`05-riesgo.md`** §5 — when the engine stops itself, and what the kill switch deliberately does *not* stop.

*When something on the screen looks wrong:* `15-decisiones.md` first. There is a good chance the shape has been seen before.

### To CHANGE it

For someone writing code in this repository.

1. **`01-vision-general.md`** §4 and §8 — the layering rules (domain has zero imports from `infrastructure/`; clock, randomness and network are injected, never called in domain code) and the directory map.
2. **`14-pruebas.md`** — test first, what kind of test this change needs, and the rules that are not negotiable: golden values are never regenerated from our own output, and no network, sleeps or wall clock in domain tests.
3. **The chapter that owns the layer you are touching** — strategy `03`, scanner `04`, risk `05`, economics `06`, application `07`, store `08`, a provider `10-adaptadores.md`, the broker `07-paper-mode.md`, the screens `10`, config and deploy `11`, alerts `12`.
4. **`09-persistencia.md`** — if the change touches durable state, and especially if it touches the idempotency key.
5. **`15-decisiones.md`** §14–§15 — the recurring failure shapes and the standing rules they hardened into. The most expensive lesson in this repository is a function written, tested, documented as the fix, and reached only by the offline path; before calling anything done, check that yours is wired into the engine.

---

## Glossary

Terms this system uses in a specific way. Where a word has a looser meaning elsewhere, the meaning below is the one this documentation intends.

| Term | Meaning here |
|---|---|
| **cascade** | The reference strategy, CASCADE DCA v1.5 — and by extension its state machine (`stepCascade`) and durable state (`CascadeState`). "The cascade never cascaded" means the machine signalled entries and exits but no DCA level ever filled. |
| **ladder** | The full schedule of DCA levels for one token: each level's trigger price and its USD size. The strategy proposes a nominal ladder; sizing cuts it against pool depth *and* against the wallet, which are two separate ceilings and were once confused for one. |
| **rung** | One level of the ladder. Production runs a **flat** ladder — the per-rung cap is $15, so every rung is the same size — over 6 rungs. That is not the reference's shape, and it is composed on top of `DEFAULT_PARAMS` rather than by editing them, because those defaults are the backtest's evidence. |
| **tier** | The universe view's classification of a scanned token, assigned in precedence order: `dead`, `held`, `pending`, `unsafe`, `filtered`, `prime`, `eligible`. `filtered` (uninteresting) and `unsafe` (failed a safety gate) are kept apart on purpose: one is a missed chance, the other is a bullet dodged. |
| **watch pass** | The cheap pass. It recovers, halts what it must, ticks every position, checkpoints and heartbeats — but reads the **shelf** instead of scanning, and never reallocates slots. A token you hold can rug in ten minutes; an opportunity missed by an hour is only a missed opportunity. |
| **full pass** | The expensive pass: everything a watch pass does, plus a real scan (hundreds of throttled calls) and slot reallocation. A watch pass is a strict prefix of a full one — it skips exactly two steps. |
| **shelf** | The last stored scan: the token snapshots already written to the database. `recallCandidates` re-ranks them offline with no network, because gates, scoring and ranking are pure. It re-runs every gate — the shelf holds snapshots, not a pass list — and a shelf older than the recall window (2 × the scan interval) is refused outright rather than served as something stale. |
| **common fund** | Realised profit net of costs, walked over **all** fills including those of positions that have since closed and left the working set. It is added to configured capital, so a profitable engine grows its book instead of being sized against a fixed environment number forever. |
| **reservation vs commitment** | A position holding **nothing** is a *reservation*: its slot can be handed to a better candidate at zero cost. A position holding **tokens** is a *commitment*: the slot cannot come back without selling, and selling is the strategy's decision, never the allocator's. |
| **death exit** | Stage 2 of asset invalidation: liquidate the entire position at market, at whatever price exists, and blacklist the token permanently. It is the one exception to "never exit at a loss", and it stays coherent only because **price is never a death signal**. Stage 1 is the reversible *ladder freeze*: stop deploying new capital, sell nothing, resume if the signals clear. |
| **freefall** | An entry gate, never an exit. It refuses to **open** a token that has fallen more than the configured share over 1h or 6h — a collapse or a bleed, a sale already in progress rather than a discount. It is the one place price influences a decision, and it decides what to enter, on a token holding none of our money. |
| **slot** | One equal-weight share of portfolio capital assigned to one token. Equal weight on purpose: the score decides order of service, never size, because it is an untuned heuristic. A **halted** position keeps both its capital and its slot — treating either as free is how an engine quietly doubles its exposure after a bad restart. |
| **catch-up** | The walk from a position's last processed bar to the newest closed bar, one bar at a time, because a cycle is not a bar. Bounded by `MAX_CATCH_UP_BARS = 96` — one day at 15-minute bars — past which the engine was not late, it was down, and replaying a week would fill a ladder from a market that is gone. Indicators and the ladder are computed once for the whole walk; the health reading is applied once, not to every replayed bar. |

---

## A note on language

Per `CLAUDE.md`, the split is deliberate, and it is not an inconsistency:

- **The interface is Spanish** — the Android app, the dashboard, the alert bodies, the gate rejection reasons, and the order comments a human reads on screen.
- **Everything else is English** — code, identifiers, comments, commit messages, and this documentation.

So a gate failure quoted in these chapters may read *"cayó 58% en 1h — es una salida en curso, no una oportunidad"*, and that is the production string rather than a translation. Where Spanish text appears in a code sample here it is reproduced verbatim, because it is exactly what the operator will see.
