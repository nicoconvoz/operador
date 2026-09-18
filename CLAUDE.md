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
- `opportunity.ts` — the "breathing" score, 0..100, explainable components
  (volume expansion, buy pressure, liquidity growth, activity, volatility,
  **momentum**, cost efficiency). A v1 heuristic with policy weights — to be
  tuned against recorded outcomes, not a claim of alpha.

  **`momentum` answers which WAY it has been going**, and it was missing.
  `volatility` measures how much a token moved and is blind to direction, so one
  down 40% on the day and one up 40% scored identically — the shortlist was as
  happy to buy the falling knife as the climb.

  **It asks only WHETHER each window is up, never by how much.** The first
  version normalised against a per-window span — ±8% in an hour, ±40% in a day —
  and the operator was right to refuse it: there is no percentage at which a
  rise becomes "a rise", so a threshold there is a guess wearing the clothes of
  a measurement. `volatility` already carries the magnitude. Together the two
  say *moving, and upward*, which is the whole reason for having both.

  Weighted toward the RECENT, and the near hour can outvote the other two
  between them. Up on the day but falling this hour is a top rolling over; down
  on the day but rising this hour is a bottom turning. The second is the one
  worth buying, and only a weighting that lets the near window win can tell them
  apart.

  A flat token scores 0.5 and so does an unreported window. Zero movement is the
  absence of a reason either way, and silence is not evidence — the same rule the
  gates run on. Scoring either as a FALL would push the book toward whatever
  moved most in any direction, which is the bias this exists to remove.

  **`headroom` asks how much of the rise is still ahead.** Direction is not the
  whole question — the higher a token already is, the further it can fall, so
  between two risers the one that has not run yet is worth more than the one
  that has. The operator's rule.

  **Logarithmic, and it is the largest weight in the score.** The operator's
  decision, and the reason is asymmetry: *eating a 70% fall loses a fortune; taking
  a 25% gain and moving on is fine.* Those two are not symmetric, so the score
  should not be either.

  | Rise in 24h | Headroom | Score | Step |
  |---|---|---|---|
  | 0% | 1.000 | **81.80** | |
  | +25% | 0.702 | 66.72 | **15.08** |
  | +50% | 0.518 | 57.10 | 9.62 |
  | +100% | 0.280 | 44.64 | 5.48 |
  | +150% | 0.120 | 36.28 | 3.84 |
  | +200% | 0.000 | **29.99** | 2.95 |

  Big steps low, small steps high — the first percent of a run costs far more
  than the last, because the distinction worth paying for is between *barely
  moved* and *already ran*, while near the top one more percent says very little.

  The 30 at +200% is what forced the WEIGHT, not the curve. A component can only
  move the score within its share of the weights, so reaching 30 from 82 makes
  `headroom` (1.14) larger than every other term combined. That is the
  consequence, stated: **a mediocre token that has not moved scores 74.25 while
  an excellent one that rose 60% scores 63.50.** Volume, buy pressure and cost
  can no longer outvote it.

  There is no hard cut-off past `headroomFullyRunPct` (200): fully spent is
  fully spent, and a token up 400% is not worse than one up 200% in any way this
  component can measure.

  A side effect worth knowing: the neutral 0.5 now carries a quarter of the
  score, so a token about which nothing is known lands near 36 instead of under
  30. `minScore` is 0 in production, so nothing gates on it — but any threshold
  read against the old scale is now wrong.

  **A falling token gets ZERO headroom, not a neutral half.** It was 0.5 so as
  not to reward a knife for being far from its high, and that was right while
  the weight was small. It became wrong the moment this was the largest term:
  measured live, RICHDEBT was **down 64% on the day with momentum at zero and
  still scored 52.5**, because neutral on the biggest component is a GIFT rather
  than an abstention.

  The question is *how much of the upside is left*. A token going the wrong way
  has none of it — that is not punishing the fall twice, it is the honest answer
  to the question asked. Measured after the change:

  | | Score | Headroom | Momentum |
  |---|---|---|---|
  | falling −64% | **26.1** | 0.000 | 0.00 |
  | ran +152%, now falling | 27.2 | 0.000 | 0.40 |
  | ran +124%, still rising | 37.5 | 0.197 | 1.00 |
  | rising +10%, fresh | **61.8** | 0.859 | 1.00 |

  An UNREPORTED window is still neutral. Silence is not evidence — the rule the
  whole scanner runs on — and reading it as a crash would condemn every token a
  provider happened to be quiet about.

  The weights came out of `volatility` (0.15 → 0.08 + 0.14 + 0.05), because
  these complement rather than replace it: one says the token is moving, the
  second says where to, the third says how much of that is already spent.
- `ranking.ts` — gates → score → sort → cut to watch slots; every candidate
  carries the `MarketQuality` the executor re-validates.

### The sell probe — one port, two chains

"Can this position actually be sold?" is the question the whole death exit
rests on, and there are two ways to answer it:

- **Quote a real sell.** A fact.
- **Read a vendor's `is_honeypot` flag.** A third party's opinion.

Solana got the fact from the start. BSC got the opinion — until
`PancakeSwap.assessSell` closed the gap by calling the V2 router's
`getAmountsOut` through `eth_call`. Both implement the same `SellProbePort`,
so the domain never learns which chain it is on.

No SDK and no key: the ABI encoding for that one function is forty lines of
hex. Pulling in ethers to encode a single call would be a dependency, a bundle
and a supply chain for something shorter than its own import statement.

It tries the direct pair, then routes through WBNB, and **an RPC failure is
never read as "no route"** — one is inconclusive, the other is a death signal,
and confusing them would either liquidate a healthy position or hold a dead one.

Impact is **measured, not modelled**: quote a thousandth of the order to learn
the undisturbed price, quote the real order, take the difference. That is what
impact *is*.

Verified live against `bsc-dataseed.binance.org`: CAKE $2.3550 (1 hop), BUSD
$0.9997 — a stablecoin pricing at a dollar is a good sign the decoder is
right — and a dead address returning **no route at all**, which is exactly the
shape of a honeypot.

### Universe coverage per chain

Measured live, not assumed:

| Source | Solana | BSC |
|---|---|---|
| Jupiter token lists | **99** | — (Solana only) |
| GeckoTerminal pools | **171** | **119** |
| DexScreener boosts | 36 | 4 |
| **Unique, deduplicated** | **261** | **123** |

Measured again on 2026-09-14, and the shape has MOVED since the first run:
Jupiter's lists fell from ~220 to 99 while GeckoTerminal's pools rose from 20
to 171. Neither number is a constant, which is the argument for having three
sources rather than a favourite — a universe built on one provider's list is a
universe that halves the day that provider changes its mind.

Both chains together: **384 tokens per cycle.**

BSC was effectively blind. Its only source was DexScreener's boosts — which
are **paid promotions**. A universe built from who paid to be seen is not a
universe, it is an advertising slot, and nine tokens is not a market.

`GeckoTerminal.discoverPools(chain)` fixes it: trending and top pools, paged,
**working identically on both chains**. It is what Jupiter's lists are for
Solana, except chain-agnostic — which also means adding a third chain later
costs nothing on the universe side.

### Universe coverage

Jupiter's three lists return **~220 unique Solana tokens**, and they are not
biased to the newest: measured live, **101 are older than 30 days and 78 older
than 180**. The bias the scanner used to have was mine — a `maxTokens: 60` cap
put there to respect GoPlus rate limits, which truncated the universe long
before any gate had an opinion.

Fixed by running **the free gates before the paid ones**
(`evaluateMarketGates`): liquidity, age, volume, FDV, denylist and
impersonation need no network call, so they decide first and only the
survivors cost a throttled security request and a sell quote. The cap is now
**700**, which is the whole visible universe once discovery sweeps deep.

This reorders the work; it does not soften it. A token that clears the free
gates still faces the full set, security included — and a test pins that any
market failure appears in both.

### What we already hold is never a candidate

Every universe source is a list of what is **popular now** — Jupiter's lists,
GeckoTerminal's trending pools, DexScreener's boosts. A token bought six hours
ago that has since stopped trending falls out of all of them, and is then cut
twice more: by `maxTokens`, and by a security budget shared out on opportunity
score.

Measured in production: most open positions reporting *"el escáner no la
encontró en este ciclo"* — which means nobody had re-checked their honeypot
answer since the day they were bought.

That is the priority exactly inverted. **A token holding our money is not
competing for attention; it has already won.** Its security status is the one we
most need current, because it is the one a rug would cost us.

So `ScanConfig.held` puts them in the universe **before** discovery runs, past
the cap — which bounds discovery, never the book — and **ahead of every
candidate** for the security budget, unranked. A held token is not scored
against strangers for the right to be looked at.

### The two pillars: how much room is left, and whether anyone is trading it

The score has two terms that between them outweigh everything else, and both
are the operator's decisions taken for stated reasons.

**`headroom`** — how much of the rise is still ahead. *Eating a 70% fall is
ruinous; taking a 25% gain and moving on is fine.* Those are not symmetric, so
the score is not either.

**`activity`** — trades in the last hour. *A pool nobody is trading is one
nobody will buy from us either* — which is the death watch's whole subject, met
at the door instead of three hours into a position.

It was `txns / 60`, flat and capped, so a pool with sixty trades an hour and one
with five hundred scored **identically**. Every difference above the cap was
invisible to the ranking, which is the opposite of what the component is for.

Logarithmic now, the same shape as `headroom` and for the same reason: the
distinction worth paying for is between DEAD and ALIVE, not between very busy
and slightly busier.

| Trades / hour | Activity | Score |
|---|---|---|
| 4 — the gate's own minimum | 0.078 | **51.16** |
| 25 | 0.322 | 60.08 |
| 100 | 0.669 | 71.34 |
| 200 | 0.875 | 78.01 |
| 300 | 1.000 | **82.08** |

**The two pillars balance rather than one winning.** A dead pool that has not
moved scores 56.05; a live one that has already risen 60% scores 63.27. Neither
property alone carries a token, and that is the point — the shortlist wants both.

The cost of the second pillar, stated: it changed the SCALE of everything. A
token that has not moved but that nobody trades no longer scores in the
eighties. What survives from the first pillar's design is the SPREAD — running
all the way still costs most of the score — and the test pins that rather than
an absolute number, because the absolute now depends on the other pillar.

### The third pillar: what the token charges to trade it

The operator's rule, and it is arithmetic rather than taste: *penalise heavily
the ones that charge a lot, or we take losses we never had to take.*

The normal exit sells at `avg_cost * (1 + minProfitPct)`, and `minProfitPct` is
**2**. So a round trip of 2% hands back the entire target before the trade has
done anything, and one of 4% needs the token to double its own exit just to
break even. `worstRoundTripPct` is **4** — two targets — and it is DERIVED from
the strategy's own exit, like the gas floor, not picked.

It read **6**, three targets, where a toll that had already made the cycle
unprofitable still scored two thirds. And it carried a weight of 0.2 out of
3.08: **6.5% of the score.** Measurable, never decisive.

| Round trip | Efficiency | A fresh, active token then scores |
|---|---|---|
| 0% | 1.000 | **75.21** |
| 0.95% — DREGG, the cheapest measured | 0.762 | 69.56 |
| 1.59% — TROLL | 0.603 | 65.75 |
| 3.18% — Leafy | 0.205 | 56.28 |
| 11.62% — HEV | 0.000 | **51.40** |

**LINEAR, deliberately, where the other two pillars are logarithmic.** Those
encode a judgement — a fall hurts more than a rise helps; dead differs from
alive more than busy differs from busier. This one encodes arithmetic: every
basis point of toll is a basis point off the result, with no asymmetry to bend
a curve around. Borrowing the log shape because the last two used it would be a
shape copied rather than argued.

An UNMEASURED toll stays neutral at 0.5. Silence is not evidence, and the
safety gates already refuse to trade an unexamined token — so the neutral only
decides where it sits on the screen, never whether money moves.

### What a third pillar costs the first two

A score is a weighted AVERAGE, so weight added anywhere is share taken
everywhere. Stated rather than discovered later:

| | Before | After |
|---|---|---|
| headroom | 1.14 — **37.0%** | 1.14 — **30.2%** |
| activity | 1.00 — 32.5% | 1.00 — 26.5% |
| costEfficiency | 0.20 — 6.5% | **0.90 — 23.8%** |
| the other five | 0.74 — 24.0% | 0.74 — 19.6% |

The operator's *"+200% should land at 30"* was measured against a 37% headroom
share and cannot survive a third pillar arithmetically — the full run's spread
fell from 37 points to just under 30. Two tests caught it, which is why they
exist.

**So the tests now pin the ORDER, which is the decision, rather than a number,
which is a consequence.** `headroom > activity > costEfficiency > everything
else` is exactly the sequence the operator argued for, one pillar at a time,
and it is the statement that survives the next one.

### Activity, measured against the pool

`minVolume24hUsd` is an absolute floor, and an absolute floor cannot tell $10k
of volume on a $2M pool — dead — from $10k on a $25k pool, which is lively.

Measured across 252 live tokens, **turnover** (24h volume ÷ liquidity) spans
four orders of magnitude: p10 of 0.12, median **3.49**, p90 of 116.
`minTurnoverRatio` is **1**: the pool trades its own depth at least once a day.
It keeps 173 of 252 — a filter, not a wall.

Both gates survive, because they answer different questions. A ratio cannot save
a pool nobody can get $15 out of; a dollar floor cannot see that a large pool
has stopped moving.

### Two providers, one pool, opposite answers — MEASURED

The engine bought six tokens it then could not trade. Each showed `$0.00 dentro`
with its ladder at level 1 and frozen: the entry was decided, and the fill that
was supposed to happen at the next bar's open never came, because **there was no
next bar**.

The same pool address, asked of both providers at the same moment (2026-09-16):

| | GeckoTerminal | DexScreener |
|---|---|---|
| DREGG — txns 1h | **0** | **35** |
| DREGG — vol 1h | **$0** | **$2,506** |
| HEV — txns 1h | **0** | **96** |
| HEV — vol 1h | **$0** | **$15,710** |
| HEV — vol 24h | $340,260 | $698,272 |

**Not a lag.** In the same run, GeckoTerminal's own top pools were current to the
minute — SOL/USDC, USDT/USDC and PAID/SOL all had a newest bar 15 minutes old.
And its 24h volume for these pools is roughly HALF DexScreener's, which a delay
cannot explain: a pool that died five hours ago would show the same 24h total on
both. It is missing trades on these pools, not trailing behind them.

The engine sat between the two and took the worst of each:

- the activity gate **admits** on DexScreener's `txns.h1`
- the death watch **condemns** on GeckoTerminal's silence
- and the strategy is **bar-driven**, so with no bars it can do neither

So the position opens, never fills, freezes at three hours, and its capital is
stuck behind a ladder that was never going to climb.

**The rule that was missing: do not buy what you cannot watch.** Whoever is
right about the market, the engine's own answer is the same — a pool it cannot
see trading is a pool it cannot trade, and that is true regardless of who is
counting correctly.

It is enforced in two places, and both are needed:

- **`scanOnce`** measures it for the tokens that cleared every other gate — about
  thirty a scan rather than three hundred — and writes the answer onto the
  SNAPSHOT as `lastTradeAgoHours`. `staleBars` is then an ordinary gate in
  `evaluateGates`, firing on the measurement like `history` does and staying
  silent where nobody measured.

  It was first written as a post-ranking FILTER, and that was wrong in a way
  worth keeping. The dashboard re-evaluates the gates on the stored snapshot, so
  a verdict kept only inside the ranking meant the screen drew a token as
  eligible while the engine refused it: eighteen of twenty-seven Solana tokens
  sat in that state, and the operator counted six reds where there should have
  been twenty-four. Two implementations of "is this tradeable" always drift; the
  fix is one measurement both of them read.
- **`confirmEntry`** asks again at the door, because the shortlist can be an
  hour old and this is the moment capital moves.

### Safety is re-asked at the door; the OPPORTUNITY is not

`confirmEntry` first ran the whole gate set, and that conflated two different
questions:

| | Question | Re-asked before buying? |
|---|---|---|
| honeypot, authorities, LP, holders, tax, proxy, denylist, impersonation, liquidity, impact, staleBars | **Is this dangerous?** | **Yes.** These turn between the scan and the buy, and every one costs real money. |
| freefall, turnover, hourly trades, volume, FDV, age, history | **Is this worth buying?** | **No.** The scanner answered it against a universe of nine hundred, minutes ago. |

Re-arguing the second one at the door refuses entries for **the ordinary motion
the strategy exists to harvest**. On a DEX the price moves WHILE the order is
placed — somebody else's buy moves it, and ours moves it too — so a token that
slipped past the freefall threshold between being chosen and being bought has
not become dangerous. It has become cheaper, which is the premise of a DCA
ladder.

Reported live, and it is what the mistake looked like from outside: an alert log
full of *"cambió antes de comprar"* while **eight positions traded and hundreds
of candidates waited outside**.

`evaluateSafetyGates` is the half that still runs, and it still fails CLOSED: an
unknown honeypot answer or an unreadable authority is a refusal, because a token
nobody can vouch for at the moment of purchase is not bought.

**And the refusals are ONE `info` line per cycle, not a warning each.** A
refused entry is an opportunity not taken: nothing was bought, no money is at
stake, and nothing needs doing tonight. As a per-token `warn` a cycle that
declined a dozen candidates buzzed a dozen times — and a phone that buzzes for
opportunities is a phone whose notifications get turned off, after which the
death exit does not arrive either.

One hour is the threshold, argued rather than picked: it matches
`minHourlyTxns`'s own window, and it leaves the three-hour abandonment freeze
clear room. Admitting a token whose newest bar is already two hours old is
admitting one that freezes within the hour.

**A pool already found quiet is refused without another download.** The check is
a candle request against the provider that rate-limits hardest, and it runs once
per CANDIDATE — about thirty a scan, a minute of wall time, most of it spent
re-learning something that has not changed. `CachedBarActivity` and the
`pool_quiet` table remember it for an hour.

**Only the negative verdict is kept, and the asymmetry is the safety.** Caching
"this pool is alive" would cache the one answer that can turn against us between
the scan and the moment capital moves; caching "it is dead" risks only a missed
opportunity — and `confirmEntry` asks again, LIVE, at the door, so nothing is
ever bought on a remembered verdict. A null answer is remembered the same way:
no bars at all is the strongest form of "this engine cannot watch it".

A note on what was NOT done, because the obvious version is worse. Aborting a
token's examination the moment any one check fails would spend more time, not
less: its three provider calls run in PARALLEL, so a token costs the LONGEST
branch (2.5s) rather than their sum (6.7s). Serialising them to allow an early
exit saves on the minority that fail and pays triple on the majority that pass —
42 affordable tokens go from 105 seconds to about 210.

**And a frozen slot holding nothing is released at once**, window or no window.
`idle-slots` makes a reservation wait out `idleAfterMs` so a slot chosen minutes
ago is not judged before its setup had a chance — but a FROZEN one had no chance
and will get none: freezing blocks entries, so it cannot buy, and it holds
nothing to sell. Waiting three hours buys nothing at all.

### Two providers that disagree about the PRICE — MEASURED

A position read as a 100% collapse minutes after it was bought. It was neither a
rug nor a crash.

| | ZCAT, same pool, same moment |
|---|---|
| DexScreener | **$0.1318** |
| GeckoTerminal candles | **$1,429.49** |
| Ratio | **10,846×** |

The engine **sizes an order from the market price and fills it at the candle
price**, so $15.11 bought 0.0105 tokens — when that money was fifteen dollars of
a token worth a tenth of a dollar. Every gate passed: $1.9M of liquidity, $1.9M
of daily volume, seventeen days old, no blockers, up 37% on the day.

It was invisible until today. Before the screen valued positions at the LIVE
market price, everything was drawn at the candle price and the whole system
agreed with itself — consistently, and about a number that did not exist.

`priceMismatch` is the answer, and it is the sibling of `staleBars`: **a token
the engine cannot price consistently is a token it cannot trade.** Measured in
the same candle fetch the bar-freshness check already makes, so it costs
nothing, and enforced in both places — the scan, so it never reaches the
shortlist, and `confirmEntry`, because that is the moment capital moves.

The band is `maxPriceRatio` (5) and it is generous on purpose. The last CLOSED
bar is up to fifteen minutes old and these tokens move, so a tight band would
reject the whole universe. It exists to catch a mismatched UNIT, not a price
that moved.

It counts as a SAFETY gate on the screen — red, not grey. Buying one is not a
mediocre trade: it is capital converted into the wrong quantity of a token.

### A budget of TIME, not a count of tries

The operator's rule: *do not put a fixed number on it. Wait until the data
arrives and stop the instant it does — sometimes three seconds, sometimes forty
— and give up only after a maximum of sixty with nothing.*

A retry COUNT prices the wrong thing. Three tries is cheap against a provider
that answers and ruinous against one that does not, and the number that actually
matters — how long a scan takes — appears nowhere in it. `waitBudgetMs` (60s)
states it outright, and the average of the real waits then becomes a measurement
of the provider rather than an artefact of the cap.

Two properties the counting version did not have:

- **It stops the moment it HAS the data.** The budget is a ceiling, never a
  quota to spend.
- **It uses the whole budget when it must.** A doubling backoff that refuses to
  start a wait it cannot finish leaves half of it unspent — and the unspent half
  is exactly where a slow provider would have answered. The last wait is trimmed
  to what remains instead.

The doubling stays. It is the polite shape for a rate limit: ask again soon in
case it was a blip, back off hard if it was not.

**It also retired a split that had just been made.** Two clients had been given
different retry counts — patient for the book, impatient for the scan — on the
argument that a held token can rug in ten minutes while a missed opportunity is
only missed. A deadline makes that unnecessary rather than wrong: a request that
answers in three seconds costs three seconds whoever asked, so the book gets its
patience without the scan paying a fixed toll for it.

### Patience belongs where the money is — SUPERSEDED by the budget above

A single retry policy served two questions that are not the same question, and
the project already had the argument written down for the cadences: *a token you
HOLD can rug in ten minutes; an opportunity missed by an hour is only a missed
opportunity.* The retries did not know that.

| Asks about | How many | How often | Gives up after |
|---|---|---|---|
| `gecko` — STRANGERS, for the scan | ~200 | hourly | **6s** — 2 retries from 2s |
| `geckoBook` — the BOOK, for the tick | ~29 | every 5 min | **28s** — 3 retries from 4s |

The throttle is SHARED, because the quota is one quota and the IP is one IP.
Only the giving-up differs.

What the single policy cost, measured cold on a runner: **33 minutes to examine
100 tokens**, about 20 seconds each against a 2.5 second throttle. The rest was
backoff — 4 + 8 + 16 — spent on a queue that is not ours, since GeckoTerminal
limits by IP and a CI runner shares its address with thousands of unrelated
jobs. A 429 there usually means somebody else already spent the minute.

### A provider that could not answer has not condemned anything

Cutting that budget exposed a worse bug underneath, and it turned the whole book
red in one pass: **26 of 29 live positions**, Bonk among them, every one
carrying *"el proveedor de velas no devolvió ninguna operación"*.

Nothing had died. We had run out of quota.

```ts
try  { return hoursSinceLastTrade(await gecko.candles(...), Date.now()) }
catch { return null }        // ← a 429 becomes "the feed says nobody traded"
```

`null` is a VERDICT: the feed answered and there were no trades, the strongest
form of "this engine cannot watch it", and rightly a safety failure. A request
that never got an answer says nothing about the token — it says something about
us. It is the sell probe's own rule, broken in the mirror image: *an RPC failure
is never read as "no route" — one is inconclusive, the other is a death signal,
and confusing them would either liquidate a healthy position or hold a dead one.*

Worse, `CachedBarActivity` then remembered that verdict in `pool_quiet` **for an
hour**, so the book stayed red long after the provider recovered.

It throws now. The error reaches `scanOnce`, which leaves the measurement
ABSENT rather than writing null — the gate fires on evidence and stays silent —
and nothing is cached, because nobody gave a verdict to cache.

### Is it alive NOW?

The 24h figures cannot answer that. A token was reported live with **$168k of
daily volume and five hours without a new bar**: a daily average is a lagging
one, and a pool that traded heavily in the morning keeps quoting the morning
long after it died.

`minHourlyTxns` is **4**, and the number is tied to the bar size rather than
guessed. The strategy runs on 15-minute bars, so an hour holds four of them —
fewer than four trades guarantees empty bars, and an empty bar produces no
candle. That is exactly how a position ends up frozen with nothing new to act
on, so the gate refuses it at the door instead of the dashboard reporting it
afterwards.

### Fill with the small ones, complete with the big ones

`maxFdvUsd` was **$50M** for months, so every established token was excluded
outright as "not a small cap". Measured on ten days of 15-minute candles, that
was wrong about the only thing that matters — whether the strategy's own door
ever opens:

| Pool | FDV | Bars hitting the classic entry |
|---|---|---|
| USDT / USDC | $3.8B | **0%** |
| SOL / USDC | $1.27B | **4.1%** — 40 of 980 |

The classic entry is a 10% drop from the five-hour swing high. SOL hits it once
every six hours: tradeable, just rarer than a small cap. The stablecoin pair
hits it never, which is what the DENYLIST is for and not this gate.

They earn their place for a second reason that only appeared this week: **deep
pools are the ones the candle provider indexes properly**, so they do not carry
the `staleBars` failure that is currently the largest cut of all.

**Small caps remain the thesis, and the ORDER is what protects it.** The gate
now admits up to $500M, and `smallCapFdvUsd` (50M) in the ranking puts every
small cap ahead of every large one *whatever the scores say* — so a big name
only ever takes a slot nothing smaller wanted. Size first, then score.

An unknown FDV counts as SMALL. It is the normal case on a young pool, and
sorting it last would quietly demote exactly the tokens this system exists to
trade.

### The reserve: what gets bought when nothing better is free

Measured live, 509 tokens in the universe:

| Tier | |
|---|---|
| held | 25 |
| **prime + eligible** | **0** |
| pending — cleared the free gates, not yet examined | 3 |
| filtered | 412 |
| unsafe | 69 |

**Nothing passed every gate.** The book held twenty-five positions against
$1,500 of capital, deployed $372 of it, and the allocator had nothing to spend
the rest on. Which gate? One, mostly — `turnover` blocked **eighty-four tokens
on its own**, more than every other sole cause put together.

The operator's rule: *when there are not enough coins to trade, or capital is
sitting free, enable the closest scores and put those to work — always
respecting the scores as we decided them.*

The split it rests on already existed, because `confirmEntry` needed it: some
gates ask *is this dangerous?* and some ask *is this worth buying?* The second
kind is a PREFERENCE, and a preference is a reason to rank a token below
another — never a reason to leave a slot empty while it is the only thing left.

**But the reserve forgives LESS than the door does**, and the difference is the
whole design. Three of the opportunity gates are not preferences at all:

| Gate | Forgiven? | |
|---|---|---|
| `turnover`, `volume`, `marketCap` | **yes** | A deep pool that turns slowly, a thin day, a name bigger than this book prefers. Taste. |
| `idle` | **no** | Under four trades an hour a 15m bar comes back EMPTY, and an empty bar is how a position freezes with its capital unreachable — the failure this engine just spent a session repairing. |
| `age`, `history` | **no** | No bars, no indicators. The machine cannot step. |
| `freefall` | **no** | A day-long bleed is an exit in progress. Forgiving it would quietly undo `maxDailyFallPct`, decided this week and on purpose. |

Result: **3 tradeable becomes 105.**

**It shipped broken, and the reason is worth more than the feature.** The free
gates run BEFORE the paid ones, so a token they reject is never examined — no
security report, `securityChecked: false`, and an all-null report fails every
safety gate closed. `forgivableFailures` could therefore never clear it, and
the reserve was empty by construction. Measured on the first relaunch that
carried it: **1 token held, 0 in reserve, 484 filtered, 108 of them by
`turnover` alone.** The band existed; nothing could ever enter it.

So `scanOnce` forgives the same three gates at the door to the PAID stage. The
fallback has to be paid for before it can be a fallback.

That is also the second argument for the forgivable set being small. `age` is
the largest single rejection at that door — most of what the deep sweep returns
is a pool born this morning — and forgiving it would spend a throttled request
on each one so that no indicator could use it. Measured, the three that ARE
forgiven cost **129 extra examinations, about 5.4 minutes** on an hourly scan.

Three rules keep it from being a back door:

- **It goes behind every qualified token, whatever the scores say**, and is cut
  with them rather than in addition to them. A wider shortlist is a wider
  candle bill, and the slots the reserve fills are the ones nothing else could.
- **It may fill a free slot and never take an occupied one.** `idle-slots`
  hands a reservation on when something BETTER is waiting; a fallback is not
  better, and letting it evict an incumbent would swap a token the gates
  approved for one they refused — and pay gas for it.
- **The evidence travels with the candidate.** `Candidate.forgiven` carries the
  failures that were excused, so the allocator, the screen and the audit log
  cannot disagree about why a token the gates rejected ended up holding money.

It has its own TIER on the screen for the same reason. A token the engine can
buy while the canvas draws it `filtered` is the screen-versus-engine
disagreement this read model exists to prevent, and this project has paid for
that one more than once.

### Freefall — an entry gate, and deliberately not an exit

A token that has lost more than half its price in about three hours is not an
opportunity; it is an exit in progress. `maxFallPct` (50) rejects it.

Where this lives matters more than what it does. It is an ENTRY gate and must
never reach the death exit: **price may not cause an exit.** A death exit that
reacts to price is a stop loss under another name, and the ladder's premise is
that a drop is something to average into. Choosing what to ENTER on price is a
different question, and the strategy already answers it — the classic gate is a
drop from the swing high. Nothing here touches an open position: a ladder with
money in it goes on averaging down, which is its job.

Three hours is not a window the providers report. They give 1h, 6h and 24h, so
the gate reads **both short ones** rather than inventing the one it wants: a
token can collapse inside an hour and look calm over six, or bleed over six
without any single hour looking alarming.

**The 24h threshold has moved twice, and both moves are decisions rather than
tweaks.** It was ignored at first — half a day is not freefall, it is a bad day,
and the strategy was built for bad days. That reversed when the ladder was cut
to two rungs, because a shallow ladder cannot chase a day-long bleed, and it was
read at a loose **70%**.

Then a token was bought at **−64% on the day and the position sat flat**: the
collapse had happened entirely before the engine arrived, and it had joined it
for nothing. `maxDailyFallPct` is **15** now — the STRICTEST of the three
windows, which reverses the original reasoning outright. A token already down
that far does not recover on our schedule; it stops falling with our money in it.

At fifteen, the short windows keep the one job the daily one cannot do: catch a
pump that is **dumping inside the day**, where the day is still green and only
the hour shows the exit in progress.

**Only downward, and never on a rise.** A token up 300% on the day is a question
for `headroom`, which scores it near the bottom — not for a gate, which would
refuse it outright. Those are different verdicts and the code keeps them apart:
the check is `change >= -limit`, so a rise cannot trip it however violent.

An unreported window is silence, not a crash. Unlike the SAFETY gates, which
fail closed because unknown danger IS evidence, this one fires only on a number
somebody measured.

**The scanner produces a WATCHLIST, not entry signals.** It decides which
tokens are worth running the strategy on; CASCADE DCA's own gates (drop
from swing high, lateral zone) decide *when* to enter. One executor state
machine per watched token.

**Both chains, every cycle.** The scan loops `OPERADOR_CHAIN` (default
`solana,bsc`) and stores each result under its own chain, because
`latestScan()` returning a single newest row meant scanning BSC made every
Solana token vanish from the screen — which looks exactly like the scanner
having stopped finding them. `latestScansByChain()` returns the newest scan per
chain and the universe merges them; the reported scan time is the OLDEST of
them, since a universe is only as fresh as its stalest half.

One chain failing does not cost the others their turn: a rate limit on Solana
is not a reason to stop looking at BSC.
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
| Abandonment | 1 → 2 | No trades for N hours — **freeze at 3, exit at 12** |

#### What the runtime actually observed — CORRECTED

The domain above is complete and has twenty-two scenario tests. The runtime fed
it **one fact**. `healthFor` reported the sell probe and hardcoded the rest:

```ts
liquidityUsd: null, lpStatus: 'unknown', mintAuthorityActive: null,
freezeAuthorityActive: null, transfersBlocked: null,
topHolderMovedPct: null, hoursSinceLastTrade: null
```

Seven of the eight invalidation signals were blind. A token whose mint
authority came back, whose LP was unlocked, or whose pool drained could not be
SEEN — and the scan measures every one of them, and was never asked. The same
shape as the missing execution layer: written, tested, documented, and reached
only by the offline path.

`application/health-from-scan.ts` hands the scanner's verdict over, and it
declines to map three of the fields on purpose:

| Signal | Source | Why |
|---|---|---|
| `liquidityUsd` | the scan's market pass | enables liquidity collapse, stage 1 → 2 |
| `lpStatus` | `lpLockedPct` vs the gate's own `minLpLockedPct` | one definition of "unlocked", not two that drift |
| `mintAuthorityActive` | the security report | direct |
| `freezeAuthorityActive` | the security report | direct |
| `topHolderMovedPct` | **not mapped** | `topHoldersPct` is a LEVEL, not a MOVE. A token where ten wallets always held 90% has moved nothing; mapping it would fire the dev-dump signal on every concentrated token in the book, permanently |
| `transfersBlocked` | **not mapped** | `hasBlacklist` says the contract HAS the function, not that we are on it. The sell probe answers the real question |
| `hoursSinceLastTrade` | **not mapped** | we measure volume, not when the last trade happened. Deriving one from the other hands the abandonment signal a number it treats as measured |

It is also folded in **exactly once per scan**. The death exit requires
`exitConfirmations` (3) CONSECUTIVE observations carrying stage-2 evidence,
precisely so one bad reading cannot liquidate a healthy position — and feeding
the same hourly scan into every five-minute pass would turn one reading into
twelve confirmations, the exact false positive the rule exists to prevent,
wearing the rule's own clothes.

Four honest readings beat eight where half are guesses: **confirmations built
on invented data confirm nothing while looking exactly like proof.**

#### Leaving on a freeze — the operator's decision, and what it costs

`OPERADOR_EXIT_ON_FREEZE` (**on by default**) sells the whole position the
moment its ladder freezes, instead of holding it while the signals confirm or
clear.

**It is a real departure from the reference and the cost is stated, not
hidden.** A freeze fires on ONE reading with no confirmation, so this liquidates
where the two-stage design would have paused and asked — the exact false
positive `exitConfirmations: 3` was written to prevent. And a freeze is
reversible by design; a sale is not.

What it buys is the failure that actually happened. Six positions sat frozen
with their capital unreachable: **unable to buy, because frozen blocks entries,
and unable to sell, because the strategy's own exit wants a profit the token was
never going to reach.** Recovering the funds beats holding them for a recovery
nobody can promise.

Three things keep it from being a stop loss in disguise:

- **Price still cannot cause it.** The freeze comes from `AssetHealthObservation`,
  which is typed so no price-shaped field can exist on it. What sells the
  position is liquidity, an authority, an LP, a broken sell path or silence —
  never a number on a chart.
- **The token is NOT blacklisted.** Only a death verdict does that. It goes back
  to being merely FILTERED and may be bought again the day it recovers, which is
  the operator's own framing: *"esa moneda pasa a las filtradas"*.
- **It carries its own comment**, `❄️ Salida por congelamiento`, typed into
  `CloseAllOrder` beside the death exit rather than passed as a string. The
  no-loss guard tells the four exits apart in the TYPE system: the two strategy
  exits may not fill below average cost, and the risk layer's two must.

The slot follows on its own. Once sold, the position holds nothing and is still
frozen — which `idle-slots` releases at once, so the capital is back in the
allocator's hands in the same cycle.

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

#### Abandonment: the signal that had never fired

`hoursSinceLastTrade` was hardcoded `null` for the life of the project, so the
one signal the user cares most about — *"quiero tokens con mucha actividad; cuando
notemos que eso no pasa nos vamos de ahí"* — could not fire.

It was excluded deliberately, on the argument that we measure volume and not the
time of the last trade, and deriving one from the other would hand the signal an
invented number. That is true of the SCAN, which is all `health-from-scan.ts`
sees. It is false of the CANDLES: **the newest bar carrying volume IS when
somebody last traded.** `idle-hours.ts` reads it there, and `healthFor` takes the
candles the tick already fetched — no extra request.

It returns **null, never zero**, when nothing in the series ever traded. Zero
would tell the abandonment signal the pool is lively, which is the exact
opposite of what an all-empty series means.

**The thresholds now agree with the door.** They were 6 and 24 hours against an
entry gate that refuses a token with fewer than four trades in the LAST HOUR —
strict on the way in, indefinite once inside, about the same token. Three hours
is twelve empty 15m bars, three times worse than the gate tolerates, and a
freeze only pauses buying. Twelve hours is half a day without a single trade;
waiting the other half is waiting for a buyer who is not coming.

**A third failure made all of this look far worse than it was.** `assessHealth`
persisted the new death-watch state — it has to, or the clean streak restarts
every pass and a freeze clears exactly never — but it wrote the row WITHOUT
touching `updatedAt`. So the dashboard went on reporting *"sin barras nuevas hace
más de 2h"* about positions the death watch was observing faithfully every five
minutes. Ten of them at once, under a warning whose entire purpose is to name
the right suspect, naming the token while the engine was doing its job. The same
lesson as the rate-limit counters that printed 556 seconds of waiting inside a
356-second scan: a diagnostic that misleads is worse than none.

Two failures had to be fixed before any of it could be seen, and the second is
the one worth remembering: **`tickPosition` returned `already-processed` before
the death watch ran.** A position whose pool stopped producing bars got no
observation at all — so a freeze could never clear, and a dying token could
never be condemned. The watch was blind in exactly the two cases it exists for,
and the symptom was PURR sitting frozen across three relaunches while the
evidence that froze it had already been corrected.

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
   `history` gate rejects under 100 bars, fed by the candle adapter. An
   unmeasured count stays silent — the gate fires on evidence, not on absence.

   **It asked for 250 until it was measured against a live universe**, and it
   was the single biggest thing standing between the engine and a usable
   shortlist. Of 97 priced Solana tokens, 15 cleared the free gates and AGE
   ALONE blocked another 16 — age being derived from exactly this number.

   250 was calibrated for the whole indicator set, EMA-200 included. But the
   EMA feeds ONE thing: `trendBullish`, which arms the TREND RE-ENTRY — the
   second door, and one that only opens after a sell. Every new position comes
   through the CLASSIC door, a 20-bar swing high inside a lateral zone, whose
   longest lookback is the 50-bar Bollinger basis.

   So a young pool is tradeable long before it can use both doors, and the
   second one opens by itself as the pool matures: an unconverged EMA is `na`,
   `trendBullish` is false, and the re-entry cannot fire. Safe by construction
   rather than by luck.

   Measured again after the change, same gates, live: **15 of 97 became 21 of
   91** — 15% to 23% — and age-alone fell from 16 to 8. What remains is genuinely
   too young to compute a lateral zone at all.

   It counted **1H** bars for months after production moved to 15m, because the
   adapter's default was never overridden — so "250 bars" quietly demanded 10.4
   days of pool age instead of the 2.6 the table below has claimed since. A
   decision documented and not implemented, the same shape as the $15 ladder
   that ran at $1,000. The runtime now passes `config.barSize`.

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

  **And then the live engine did not call it.** Fixed in `paper-run.ts`,
  absent from `tickPosition` — so production ran a $285 position emitting
  $1,000 entries, rejected in silence, for hours. The same shape as the
  missing execution layer: a function written, tested, documented as the fix,
  and reached only by the offline path. Anything the experiment does and the
  engine does not is not a fix; it is a rehearsal of one.
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

## Bar size — 15m in production

`OPERADOR_TIMEFRAME=15m` (default). The user's decision, from trading these
tokens: on young crypto an hour is long enough for the move to be over before
the strategy has an opinion.

The 1H parity harness stays green and stays meaningful — it proves the PORT is
faithful to `DCA.pine`. Bar size is a separate choice, and reproducing the
backtest is not an argument for trading the bar the backtest used.

What 15m means concretely, since every parameter is counted in BARS:

| Parameter | Bars | At 15m | Was at 1H |
|---|---|---|---|
| EMA-200 (trend gate) | 200 | 50h | 200h |
| Bollinger basis | 50 | 12.5h | 50h |
| Swing high lookback | 20 | 5h | 20h |
| `confirm_bars` | 20 | 5h | 20h |
| History gate | 250 | 2.6 days | 10.4 days |

Two consequences to watch in the paper run:

- **Younger pools qualify.** 250 bars is 2.6 days of pool age instead of 10.
  The safety gates are unchanged, but the age one is now doing less work.
- **Gas per unit of time roughly quadruples.** Four times the bars is four
  times the cycles, and gas is per swap regardless of size.

## The gas floor is derived, not guessed

`gasFloorUsd(gasUsdPerSwap, maxGasSharePct)` replaces a hardcoded $20. A fixed
floor is a guess that stops being true the moment gas moves: $20 is generous on
Solana at $0.01 a swap and reckless on a congested chain at $0.20.

| Gas per swap | Floor at 1% tolerance |
|---|---|
| $0.01 | $1 |
| $0.05 | **$5** (the default) |
| $0.20 | $20 |

**`OPERADOR_MAX_USD_PER_LEVEL` is that cap, and it defaults to 15.** It is NOT
`DEFAULT_PARAMS.maxUsdPerLevel`, which is 5,000 because that is what
TradingView ran — the parity harness asserts those params are exactly the
backtest's inputs, so they are evidence and must not be edited to express a
preference. The runtime composes `{ ...DEFAULT_PARAMS, maxUsdPerLevel }`.

This section claimed the $15 ladder for weeks while the runtime used
`DEFAULT_PARAMS` directly and ran a $1,000 level 0 in production. Documenting a
choice is not making it.

This is what makes a **$15 ladder** viable: `max_usd_cap = 15` produces a FLAT
ladder — `min(1000 × (1 + 1.2n), 15)` is $15 at every level — totalling $150
over ten fills, where gas is 0.33% of each. The old $20 floor refused it
outright; the derived floor accepts it on Solana and still refuses it if gas
climbs to $0.20, which is the right answer in both cases.

### Buying where the price IS

`dropInitPct` is **0 in production**, against the reference's 10, and it is the
operator's decision taken against my objection.

The objection stands and is worth keeping written down: the 10% drop from the
20-bar swing high is what made the ladder's first rung a GOOD price. Without it
the entry lands as often near a high as near a low, and the ladder works from a
worse basis.

What overrode it is a measurement, not a preference. **Twenty-two of forty
positions had never bought anything**, some after three hours. A slot holding
capital and waiting is capital earning nothing, and an entry that is merely
average but HAPPENS beats a good one that never does — the exit only wants
`avg_cost + 2%`, and the ladder still averages down if the price falls.

There is a reason the threshold aged badly that is nobody's preference:
**20 bars meant 20 HOURS in the reference and means 5 at 15m.** A 10% fall
inside twenty hours is ordinary; inside five it is not. The same class of
silent change as `confirmBars` becoming eleven hours — a parameter counted in
BARS stops meaning what it meant when the bar changes.

At zero the condition is `close <= swingHigh`, which is not a tautology: it
still refuses a bar making a NEW twenty-bar high. The engine declines to buy a
vertical breakout and takes everything else.

`is_lateral` still gates it — that answers whether the market is in a regime the
ladder handles, which is a different question and was not what the decision was
about. `OPERADOR_DROP_INIT_PCT` asks for the dip back.

And zero is a REAL value here, so it cannot be parsed as "unset". `maxPositions: 0`
meaning one thing in one file and its opposite next door cost this engine every
position it could have opened.

### The bigger the gain, the less it waits

The exit is *"it stalled at the top, take the money"*, and stalling is measured
as `decayBarsRequired` (2) consecutive falling VWM bars. On an ordinary winner
that patience is right: it lets the move finish instead of selling the first red
candle.

On a violent one it is expensive. Measured on a live position:

| Bar | Gain | VWM |
|---|---|---|
| 12:00 | **+84%** | 176 |
| 12:30 | +64.9% | 199 |
| 12:45 | +46.0% | 164 ↓ |
| 13:00 | +30.5% | 116 ↓ |

`priceless` ran to +84% in half an hour. The rule waited its two falling bars
and sold at +30% — **two thirds of the gain spent on patience the size of the
move did not justify.**

So patience now falls as the gain rises, which is the operator's rule and the
right shape: the more there is to lose by waiting, the less waiting is worth.

| Gain | Falling bars the exit waits for |
|---|---|
| under 10% | **2** — the reference |
| 10–25% | **1** |
| over 25% | **0** |

Monotone by construction, so a bigger gain can only ever SHORTEN the wait. On
the table above, 25% is the bar showing **+46%** — it would have sold near the
$7 the operator watched decay to $4.94.

A small winner still gets the full two bars, and that is what stops the engine
selling every first red candle.

Both thresholds are `null` in `DEFAULT_PARAMS`, which is the reference exactly —
impatience is composed in production beside the ladder cap and the entry drop,
because the parity harness asserts those params are the backtest's own inputs.

### Two DCA rungs, not nine

`OPERADOR_MAX_DCA` defaults to **2**, so the venue holds **three** entries open:
the entry plus its ladder. It is NOT `PYRAMIDING`, which stays 10 because that
is what the `strategy()` header ran — the same rule as `maxUsdPerLevel`:
evidence that can be edited to express a preference has stopped being evidence.

The user's reason is the ladder's own geometry. With `linInc` at 3:

| Rung | Needs a fall of |
|---|---|
| DCA-1 | 1% |
| DCA-5 | **13%** |
| DCA-10 | **28%** |

A token down 28% is rarely an opportunity, and the capital those deep rungs
reserve buys more by going to another token.

Then five became **two**, for a different reason: how to avoid large losses.

| | 5 DCA | 2 DCA |
|---|---|---|
| Rungs | 6 | **3** |
| Ladder needs | $95.09 | **$47.57** |
| Positions on $1,500 | 14 | **29** |
| Most one token can cost | $90 | **$45** |
| One death, as a share of the book | 7% | **3.4%** |

**It has a price, and it is paid at the door.** A two-rung ladder cannot chase a
fall the way a ten-rung one could, so the entries have to be better — which is
why `maxDailyFallPct` exists at all and why the turnover gate arrived alongside
it. Shallower ladder, stricter door.

Both are finding 2 of the capital floor arriving by different roads: scale comes
from more tokens, not more size per token.

Both numbers live in `application/production-ladder.ts`, alone, because TWO
things need them and neither may own them: the engine that sizes the ladder and
the dashboard that draws it. The dashboard used `DEFAULT_PARAMS` instead and
showed a $1,000 rung beside a $15 order for days — a screen disagreeing with the
engine about the size of a trade, which is the exact failure the read model
exists to prevent.

A consequence worth stating: a thin pool is no longer REFUSED, it is SHRUNK.
The budgets, not the floor, are what bound the risk — a $14 fill on a $3.8k
pool costs the same 1% as a $750 fill on a deep one.

## Paper mode is the whole system, minus the spending

Everything that DECIDES is real: discovery, gates, the honeypot sell quote,
candles, the strategy, the death watch's sell probes. Only the FILL is
simulated — and pessimistically, paying the venue spread, the impact its own
size causes against measured depth, and gas per swap. A round trip at a flat
price loses money, because on a real chain it would.

That means a paper run is not a rehearsal of the decisions. It IS the
decisions, against the real market, with the only difference being that no
token moves. The numbers it produces are the ones worth arguing about.

## Running it

```bash
cp .env.example .env      # fill in DATABASE_URL and OPERADOR_CONTROL_TOKEN
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

### Three cadences, because the scan was doing two jobs at one rate

The operator asked the right question: *if we re-examine a few positions and
keep replacing, what is the big scan for?* Two things, and neither is optional:

- **Discovery.** The shelf only holds what a previous scan found. Refreshing it
  says which of the tokens you already know is best NOW; it can never mention
  one you do not know. And the shelf only ever shrinks — bought, condemned,
  fallen — so without discovery it empties.
- **Danger.** The refresh is DexScreener: price, liquidity, volume. It does not
  ask GoPlus and does not quote a sell, so an LP that unlocks, an authority that
  returns or a sell path that breaks is invisible to it — seven of the death
  watch's eight signals, on the tokens holding the money.

But the question exposed something real: those two jobs have very different
urgencies and were sharing a schedule set by the expensive one.

| Pass | Costs | Every |
|---|---|---|
| `watch` | nothing for the shortlist, one batched request to re-price the shelf | 5 min |
| `held` | the full examination over **~30 tokens**, no discovery | **20 min** |
| `full` | discovery plus everything, ~450 tokens | 1–2 h |

`held` is the same scan over a smaller universe, not a lesser one: same gates,
same security call, same sell quote, same candles. `ScanConfig.discover: false`
leaves the universe as exactly the book, and `held` was already seeded first so
the cap could never decide whether our own position got looked at.

The result is MORE protection than before and LESS time scanning: what we hold
is re-examined three times an hour instead of once, while the sweep that costs
nine minutes a chain happens half as often.

A full pass re-examines the book on its way past, so it resets the held clock
too — otherwise the pass right after a full scan would immediately owe one for
work just done.

### The shelf is priced NOW, for one batched request

The operator's idea, and it came out cheaper than he asked for: instead of a
full scan every half hour, re-examine only what already scored well, drop the
two or three that fell below what the book accepts, and let a real scan stay
rare.

A watch pass already re-ranked the stored shelf with **no network at all**. What
it could not do was change its mind, because it re-ranked the same numbers —
nothing moved until the next full scan an hour later.

Since only what the engine may act on is stored, the shelf is about **twenty**
tokens rather than five hundred, and refreshing its market half is **one
DexScreener request per thirty**. Cheap enough for every five-minute pass, not
every thirty minutes.

| | Refreshed | By |
|---|---|---|
| price, liquidity, volume, the changes, the counts | **every 5 min** | one batched request |
| security, history count, bar freshness, candle price | **every full scan** | the expensive stage |

`withLiveMarket` is the ONE definition of which half a feed may refresh, and it
is shared with the universe view. Two copies of that rule would eventually
disagree about whether a token is safe — and the safety gates fail CLOSED, so
overlaying a market response whole would turn a position red for the crime of
being refreshed.

Three properties:

- **Refreshed in memory, never written back.** `scannedAt` answers how old the
  EXAMINATION is, and letting a market refresh reset it would keep a shelf alive
  for ever on security nobody re-checked.
- **The PAIR is kept**, not adopted from the feed. The engine trades the pool it
  was examined on and takes its candles from there; following whichever pool the
  feed names today would price one venue and trade another.
- **Never fatal.** A bad minute serves the stored shelf, because a slightly old
  universe beats no universe.

What it changes about the full scan: it is now only needed to find tokens the
shelf does not have, and to re-examine what money is sitting in. That is what
makes a longer `OPERADOR_SCAN_MS` reasonable rather than a gamble.

### Two cadences, not one

The cycle above has two halves that cost wildly different amounts, and they used
to share a clock set by the expensive one:

| | Cost | What it protects |
|---|---|---|
| **Watch** — recover, advance every open position, checkpoint | one candle request and one sell probe per position; under a minute for five | money already committed |
| **Scan** — discovery, gates, ranking, allocation | hundreds of throttled calls; ~30 minutes | opportunities not yet taken |

Bundled, a held token got attention every **~35 minutes on 15-minute bars** —
the cheap half running at the pace of the expensive one. `runLoop` now paces
them separately: `OPERADOR_CYCLE_MS` (5 min) is how often a pass happens, and
`OPERADOR_SCAN_MS` (2 hours) is how often a pass is also a scan. `runCycle`
takes a `CycleKind`, and `watch` is a strict PREFIX of `full` — never a
shortcut, so recovery still runs and a position nobody can reconcile still
halts.

The asymmetry is the whole argument: **a token you HOLD can rug in ten minutes;
an opportunity missed by an hour is only a missed opportunity.**

- **Recovery runs first.** An engine that scans and allocates before
  reconciling its own past is building on state it has not verified.
- **New positions come last**, because capital that might belong to an
  unresolved position is not capital to spend. A halted position keeps BOTH
  its capital and its slot — treating either as free is how an engine quietly
  doubles its own exposure after a bad restart.
- **A token already held or already blacklisted is never reopened**, however
  highly the scanner ranks it.

## Slots reserved and never used

A slot and its capital are handed to a token **before** the strategy enters it:
the scanner says "worth running the machine on", and CASCADE DCA then waits for
its own gates — a drop from the swing high, a lateral zone. When those never
line up, the position sits at level 0 indefinitely, holding a slot against
nothing.

Measured live: a token open **five hours and twenty minutes with zero fills**,
holding $285 and one of five slots, while candidates scoring 76 and 72 waited
outside. `slotsLeft` and `committed` counted it exactly as they counted a
position three DCA levels deep.

The distinction they were missing:

> A position with fills is a **commitment**. The slot cannot come back without
> selling, and selling is the strategy's decision, never the allocator's.
>
> A position with no fills is a **reservation**. Cancelling it costs nothing,
> because nothing was ever spent.

`domain/risk/idle-slots.ts` releases only the second kind, and only when
something is waiting to use what it gives up — freeing a slot into an empty
queue is pure loss, since the incumbent might still enter. `hasFills` is read
from the FILLS, never from the cascade level: a machine can sit at level 1
believing it holds something the broker refused, and a reservation dressed as a
position is exactly the case this must not misread.

Nothing is blacklisted. The token did not fail a gate, it simply never set up,
and it is welcome back the day it does — though not in the same cycle, because
re-opening what was just released is a round trip through the database rather
than a reallocation.

`OPERADOR_IDLE_HOURS` (default 3) is the window: twelve bars at 15m, most of
the 20-bar swing-high lookback the classic entry gate uses, so the setup had a
fair chance before the slot moves on.

## Slots that are not earning them

A slot and its capital go to a token **before** the strategy enters it: the
scanner says "worth running the machine on", and CASCADE DCA then waits for its
own gates. Two ways that stops being a good deal, and they turn out to be one
rule.

|  | Holds tokens | Holds nothing |
|---|---|---|
| **What it is** | a COMMITMENT | a RESERVATION |
| **Can the slot come back?** | not without selling — and selling is the strategy's decision, never the allocator's | at no cost, because nothing is in it |

So `domain/risk/idle-slots.ts` only ever takes back slots with nothing in them,
and it judges them on what the scanner thinks **today**:

- **Never traded** → waits out `OPERADOR_IDLE_HOURS` (3) first. It was chosen by
  this same ranking minutes ago, and the opportunity score moves bar to bar:
  judging it immediately would open a position and close it on the next scan,
  which is churn wearing the costume of discipline.
- **Traded, now flat** → re-examined at once. It has shown what it can do, so
  the question is no longer "did this ever work" but "is this still the right
  token".

Either is handed on when the scanner no longer lists it at all, or when a
waiting candidate beats it by `OPERADOR_MIN_SCORE_EDGE` (10 points). The margin
is not timidity — without it the book trades against its own noise and pays gas
for the privilege. Never more slots than there are candidates to fill them, and
nothing is blacklisted: the token did not fail a safety gate, it merely stopped
being the best use of a slot.

### A frozen ladder keeps only what it already holds

Six positions frozen at once, and the operator asked the obvious question: *if
they are frozen, shouldn't they be swapped for other tokens? Do they just sit
there forever?*

Half of the answer is no, and for a good reason. The SLOT cannot move: it holds
tokens, and selling them is the strategy's decision and never the allocator's —
`idle-slots.ts` skips anything with `openQty > 0` precisely so a reservation and
a commitment are never confused.

The other half is yes, and it was not being done. **Frozen means no new capital
enters** — that is the whole definition of stage 1 — so every dollar the
position reserves against future rungs is unreachable until the freeze clears or
the token dies. Six positions were sitting on about thirty dollars each of
reserve nothing could spend, on a book bounded by CAPITAL rather than by slot
count (`maxPositions: 0`). That is a token and a half of capacity, idle.

So the trim below takes a frozen position down to what it has actually
deployed. The slot stays; only the money nothing can reach moves.

The cost, stated rather than hidden: the trim only ever goes DOWN, so a freeze
that later clears finds its position smaller and climbs fewer rungs than it
would have. That is the cheaper side — the alternative is holding capital idle
for hours against a rung that may never fire, on a book whose whole thesis is
that scale comes from more tokens rather than more size per token.

### A position keeps only what its ladder can spend

A slot used to keep whatever the portfolio handed it at birth. Measured live:
**five positions holding $285 each while a flat six-rung $15 ladder can only
ever deploy about $95.** The surplus counted as committed, so the engine could
neither spend it nor open anything with it — nine hundred and fifty dollars
doing nothing.

`ladderCapitalUsd` is the exact inverse of `deployableCapital`: run one on the
other's answer and the nominal ladder comes back. Every cycle trims each
position down to it, never below what is already deployed — that money is in the
token — and never **up**, because raising an allocation is re-risking money
nobody agreed to put there.

### The slot floor is derived, like the gas floor

Freeing that capital opened no new tokens, because the book was capped twice
over — and the lower cap was **stale**.

`minPositionUsd: 200` was a real measurement: the first capital-floor run placed
no orders below it. That measurement was superseded in the same document, by the
sizing fixes that reserve gas for a full cycle plus 5% of price headroom and
dropped the floor **to under $50**. The number never moved, so it kept dividing
free capital by 200 and capping the book at four slots.

The replacement is `slotFloorUsd`, and the subtlety is which ladder it prices.
NOT the nominal one — `scaledParams` shrinks the ladder to what the wallet
allows, so a smaller slot does not fail, it trades smaller rungs. What it cannot
do is trade rungs the chain's fixed cost would eat. So the floor is the same
ladder priced at `minFillUsd`, which is itself `gasFloorUsd`: **~$32 for six
rungs at $0.05 a swap**, and it rises with gas exactly as it should.

### The width of the book is the division

Raising the ceiling was not enough either, because the split was
`deployable / slots`: ten slots and $1,425 handed **$142 to each**, and a flat
six-rung $15 ladder can only ever spend $95. The surplus came straight back as
idle capital.

So a slot is now given `targetPositionUsd` — the wallet a full ladder needs, and
not a dollar more — and **how many slots there are is the division**.
`maxPositions` defaults to **0, meaning no ceiling**: once every slot is the
same size, what bounds the damage one token can do is that SIZE, and capping the
count only leaves capital idle.

Measured on the production ladder:

| | |
|---|---|
| Deployable from $1,500 | $1,425 |
| A six-rung $15 ladder needs | **$95.09** |
| Positions | **14** |
| Allocated | $1,331 |
| Idle | $94 |

Against five positions of $285 before, where $190 of each was reserved against
rungs that did not exist. This is finding 2 of the capital floor finally being
acted on: **scale comes from more tokens, not more size per token.**

One thing to watch: fourteen positions is fourteen candle requests per watch
pass. The providers are rate-limited by IP on a shared runner, and this is the
first change that makes the WATCH side, rather than the scan, the heavier user.

### The concentration cap is a share of the BOOK, not of the leftovers

Reported live: **40 positions where the capital funds 31.** The distribution
told the story:

| Capital allocated | Positions |
|---|---|
| $47.57 — a full ladder | 24 |
| $30–47 | 5 |
| **$1–30, several at exactly $15.99** | 9 |
| ~$0 | 2 |

$15.99 is `slotFloorUsd` — the gas floor. So once the book was mostly full, the
allocator went on opening positions AT THE FLOOR instead of stopping.

The cause is one line. `maxPositionPct` (30) exists to stop one token being too
much of the book, and it was computed against the capital the caller handed
over — which is what is **FREE**, and shrinks with every position opened. With
$50 left, 30% of it is $15: the cap fell BELOW what a ladder costs and dragged
the slot size down to the floor.

**A limit meant to prevent positions that are too BIG had started forcing
positions too SMALL** — and a $16 slot fills one rung and can never average
down, which is the entire premise of a DCA ladder.

`concentrationBasisUsd` is what it is a share of: the whole book, passed in by
the orchestrator. Absent, it falls back to the capital given, which is the old
behaviour exactly — so a caller that does not know the book is not silently
given a different rule.

### The common fund

What the system has MADE is capital too, and it was ignored: the book was sized
against a fixed number from the environment forever, so a profitable engine
never got any bigger. `commonFund` walks **every fill ever recorded**, including
those of positions that have closed and left — which is most of it, and is why
`fills` has no foreign key to `positions`.

Costs come out. They were paid in cash at the moment of each fill, so a fund
built on gross profit hands the allocator dollars the chain already took — the
single largest way a strategy that looks profitable is not.

`application/ledger.ts` is the one implementation of "what does this position
hold and what has it made". Three things need that answer — the screen, the
allocator, and the fund — and any two of them disagreeing is how a book starts
double-spending.

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

**And there is ONE builder, not two.** The server renders the first frame and
the console polls `/api/view` for every frame after it — two call sites with
their own arguments, which drifted within an hour of the second gaining a
feature. The page valued the book at the last BAR CLOSE while the poll valued it
LIVE, so opening the app showed one number and replaced it with a different one
seconds later: *"me sale 1.78 positivo y después se pasa a 2 negativo, como si al
principio se hubiera congelado en un monto que nunca fue"*.

Both numbers were real. They were answers to different questions, asked by two
copies of the same view — the exact failure this section describes, one layer
further out than it was written for. `dashboard/lib/view.ts` is the one place
now, and both call it.

**There is no write path in the app at all.** No order can be placed from it,
no position closed, no switch thrown. A dashboard that could trade would be a
second attack surface on the money, guarded by a URL people paste into chats —
which is why the single write path is a separate, token-authenticated endpoint
that can only ever make the system safer.

### The universe view

`dashboard/app/universe.tsx` draws every scanned token as a body in orbit.
Every mark is a measurement, not decoration:

| Mark | Means |
|---|---|
| Colour + glow | tier |
| Size | liquidity, on a log scale (a $40k pool and a $5M one must share a screen) |
| Colour | tier |
| Glow | money is in it; blue instead of green when the death watch froze it |
| Ripples | opportunity score — more rings, expanding faster, for better scores |
| Orbit speed | 24h volatility |
| Shape | ● Solana, ◆ BSC |

The tiers separate two things a single "rejected" list would conflate:
**filtered** is uninteresting (thin, young, quiet, too big), **unsafe** failed a
SAFETY gate. One is a missed chance; the other is a bullet dodged, and they
should not look alike.

**A held token that TURNS is the one case a tier cannot express.** The tier
short-circuits to `held` for anything with a position, so a token of ours whose
mint authority came back went on being drawn green — the engine would act, and
the screen would never show it coming. `turnedUnsafe` says both facts at once:
the body goes red while keeping its glow, with a ring that breathes faster than
anything else on the screen, and the detail sheet leads with the gate that
turned. It is not "an unsafe candidate"; it is our money in something that just
failed, which is more urgent than either fact alone.

Never true for an UNEXAMINED token. Those fail every safety gate by design — the
gates fail closed — and reading that as "it turned" would put a red alarm on
every position the security budget had not reached yet, which is how an alarm
stops being read.

**Position in the sky is deliberately meaningless.** It used to encode the tier
as a ring, which sorted every token onto a lane of its own — and a held token on
its own lane is a held token you cannot compare to anything. Bodies are now
spread across the whole disc by a hash of their address, on a `sqrt` radius so
they do not clump at the centre, and the tier survives in the colour, the glow
and the label. The user's words for it: mixed in with the others.

Tapping a body opens what it knows — score, liquidity, age, round-trip cost,
and **the five score components as bars**, so "why is this ranked here" is
answerable without reading code. That opens FULL SCREEN and is thrown away by
dragging down: it used to be a panel capped at 34vh on a phone, so the thing you
tapped to read about was the thing you then read through a letterbox.

**The sky zooms** — pinch, wheel, or the ＋/－ chips — up to 6×, about the point
under the finger so what you were looking at stays where it was. Bodies grow on
the square root of the zoom: magnifying a dot into a coin is not what zoom is
for. A drag pans, and tap versus drag is decided at the END by how far the
finger travelled, because a pan that opens a detail sheet is a pan nobody can
perform.

**Every token the executor may act on is named** — held, prime and eligible. The
label was once reserved for held, so the shortlist was a crowd of anonymous
dots, which is a picture of a shortlist rather than a shortlist. The tiers that
arrive in dozens are collapsed into clusters, so naming the rest costs nothing.

It runs on a phone, which forced four decisions:

- **Glows are pre-rendered sprites**, drawn once. A radial gradient per body
  per frame is the most expensive thing a canvas does, and it is pure waste
  when the image never changes.
- **The body count is capped by screen size** (60 on a phone, 200 otherwise).
  Tokens arrive brightest-first, so the cap drops noise rather than signal.
- **Everything scales with the crowd.** A two-rung ladder doubles the book, and
  dots sized for fourteen positions are one green smear at twenty-nine. Bodies,
  cluster markers and labels shrink on the **square root** of the body count —
  area is what crowds a canvas, not radius — floored so a dot stays tappable.

  The HALO is what actually floods, not the dot: at radius × 7.5 each, four
  glowing positions already touch. Held tokens are drawn tighter the more of
  them there are (×7.5 at six, ×3.4 at twenty-nine) — except an alarmed one,
  which keeps its full reach, because the position that turned must not shrink
  into the crowd it is in.

  Labels shrink too and grow back as you zoom, rather than being dropped. The
  shortlist keeps its names; the zoom is what makes them readable.
- **Rendering stops when the tab is hidden.** A background tab painting at
  60fps is a battery leak nobody ever sees.
- **`prefers-reduced-motion` renders one still frame.**

`/demo` renders the same view from synthetic data, labelled as such — a demo
that passes for live is how people end up trusting a screenshot.

### The profit moves, because it is valued at the live price

The one number the system exists to produce sat still for fifteen minutes at a
time, and the reason was structural rather than cosmetic: every position was
valued at `lastPriceUsd`, the close of the last bar the ENGINE processed. On
15-minute candles that changes four times an hour.

The engine is right to decide on closed bars — that is the execution model the
parity harness pinned. But the screen is not showing a decision. It is showing
what the position is WORTH, and that moves continuously.

So `buildOperations` takes `livePrices` and values the book at the market price
now. Three rules keep it from becoming a second source of truth:

- **Only the VALUATION uses it.** The ladder stays on the prices the engine
  actually acted on, or the screen would disagree with the machine about where
  the rungs are.
- **It is never fatal.** A provider having a bad minute falls back to the bar
  close, and `priceIsLive` says which the reader is looking at. Stale and
  labelled beats absent.
- **One batched request per chain**, thirty addresses at a time, against a limit
  of three hundred a minute.

The poll went to **ten seconds**, because the poll rate now IS how often the
number can move. And the figure PULSES green or red on change — a digit quietly
replacing another digit is a change nobody notices. The tint is a background, so
a figure that is negative and rising still reads as negative, and it fades on
its own rather than leaving the screen coloured by something that happened a
minute ago.

**The arrow is coloured by DIRECTION and the number by its SIGN**, because they
answer different questions. The arrow first inherited the number's colour, which
put a GREEN ▼ on a profit that was falling — a figure can be positive and
getting worse, and the mark that exists to say "it just moved, and which way"
was saying the opposite.

### What we HOLD is priced now, not an hour ago

The unrealised figure already moved live. Everything EXPLAINING it did not: the
liquidity, the volume, the 24h change, the transaction counts and the score
computed from them all sat at whatever the hourly scan last saw. So the one
screen the operator watches showed a number moving on top of an hour-old reason.

The fix costs **not one extra request**. The same batched DexScreener response
that feeds the live price already carries the whole market half of a snapshot,
and every field but the price was being discarded. `buildUniverse` now takes
`liveMarkets` and re-scores the held tokens from it.

Three rules, and they are the same three the live price already followed:

- **Only what the feed can actually answer.** Security, the history count, the
  bar-freshness measurement and the candle price come from the expensive stage
  of a scan; a market response knows none of them. Overlaying it whole would
  blank the evidence these gates fire on — and they fail closed, so a position
  would turn red for the crime of being refreshed.
- **Held only.** Refreshing the other five hundred would be a real bill. The
  argument for these is that they are few and that they are ours.
- **Never fatal.** A provider having a bad minute falls back to the stored
  numbers rather than emptying the screen of the one thing on it holding money.

And ONE fetch serves both readers. The universe wants the market to re-score;
the operations view wants the price to value. Fetching twice would double a bill
already paid and let two views disagree about the same token in the same frame —
which is the exact failure the single builder exists to prevent.

### The free tier's real limit was network, and the screen was the one spending it

The whole project stopped — dashboard AND engine writes — with
*"Your account or project has exceeded the quota."* Not storage, not compute
hours: **network transfer**, of which Neon's free tier gives **5 GB a month**.

| | |
|---|---|
| The page polls `/api/view` every | 10 s |
| Each poll pulled back the whole universe as JSONB | ~490 KB |
| Per day | **4.2 GB** |
| Per month | **127 GB against a 5 GB allowance** |

The allowance was gone in **thirty-four hours**, and when it went the engine's
writes went with it. An unattended system whose store stops answering does not
degrade — it stops, holding thirty positions nobody is watching.

**The cure is not a slower screen.** The figure on it is `qty × livePrice`: the
quantity comes from Postgres and barely moves, the PRICE comes from DexScreener
and is not this database's business at all. So the ten-second poll stays, the
number goes on ticking, and what stops repeating is the question whose answer
was already known.

`cacheFor` wraps the six reads the dashboard makes, once per module so every
viewer of every tab shares one answer — per METHOD rather than around
`buildView`, because the three builders ask for overlapping things and a cache
around the whole view would still pay for `loadPositions` three times.

| Read | Window | Against |
|---|---|---|
| `latestScansByChain`, `latestScan`, `blacklisted` | **15 min** | a scan, which happens once an HOUR |
| `loadPositions`, `allFills`, `loadCheckpoint` | **2 min** | the engine tick, every FIVE minutes |

**127 GB a month becomes 3.1 — forty-one times less**, with room under the
limit rather than just inside it. The first attempt used 5 min and 60 s and
landed at 7.3 GB, still over: a fix that lands just past the limit is not a fix.

Two properties carry more weight than the caching:

- **The in-flight promise is shared**, not only the settled value. Several
  viewers, or one page asking twice in a frame, would otherwise each pay for the
  same read and the saving would evaporate exactly under load.
- **A failure is never cached.** Remembering "the database was down" turns one
  bad moment into two minutes of blank screen — the same rule the discovery and
  history caches already run on.

**The ENGINE is never cached.** It opens its own store and this module is not in
its path: a trading decision taken on a two-minute-old position is not a saving,
it is a bug.

And the storage side was leaking too, separately: `scans` wrote the whole
universe as JSONB per chain per scan and **nothing ever deleted a row**, though
nothing ever read an old one either. `saveScan` now prunes its own chain, and
`tools/free-space.sql` clears what accumulated.

### The radar carries what we may act on, nothing else

Measured on one live scan:

| | Tokens | Stored | Share |
|---|---|---|---|
| filtered | 187 | 146 KB | 64% |
| unsafe | 108 | 81 KB | 35% |
| **everything tradeable** | **2** | **1 KB** | **1%** |

**Ninety-nine percent of what was written, read back on every poll and drawn on
a phone was tokens nobody will ever touch** — and the same bytes are what
exhausted a 5 GB monthly transfer allowance in thirty-four hours.

The operator's rule: *do not even put them on the radar.* Nothing is lost by
forgetting a rejection, because the universe is re-discovered from scratch on
every scan — a token that becomes tradeable comes back on the next pass with
fresh numbers rather than stale ones.

`worthStoring` keeps a snapshot when the token is a CANDIDATE (reserve
included) or when we HOLD it.

**The held clause is the trap in this change**, and it has its own test. A token
of ours whose mint authority came back fails every safety gate, and it is the
most urgent thing this screen can say — `turnedUnsafe` exists for exactly that.
Dropping it as "rejected" would delete the alarm and leave the dashboard
serenely quiet about our money sitting in something that just turned.

What is lost, stated rather than discovered later: the per-token REASONS for
every rejection. Tallying those across the rejected set is what found three
separate bugs in a single day — `turnover` blocking 108 tokens on its own, a
history gate stuck at "99 < 100", and 26 positions reddened by a rate limit. A
histogram of gate → count would keep that power for a few hundred bytes, and is
the obvious next step if diagnosing a quiet scanner ever gets hard again.

### A freeze that will not say why

Six positions showed `❄️ congelada` and not one of them said what for. The
evidence chain is recorded by `assessAssetHealth`, persisted with the position,
and extracted by `buildDashboard` as `deathSignals` — and rendered by **nobody**,
so diagnosing a freeze meant reading the database.

That is the wrong person to make do that. Only the operator can decide whether a
token really died or the engine is wrong about it, and `❄️` answers neither. The
detail sheet now lists the reasons under the label, newest first.

The same shape as every other gap in this project: written, tested, documented,
and reached by one path only.

### Registro — the tape in a room of its own

`recentFills` grows without bound and the screen does not. A page listing every
buy and sell since the engine started is a page whose top nobody reaches — and
on a phone it is the whole page.

It lived under the positions in **Operaciones**, which answers *what is open*.
What happened is a different question asked at a different moment, so it moved
to its own tab: **thirty rows with their comment and cost**, and it is in ONE
place rather than two, because the same list in two tabs is noise.

The rest is a file. `/api/fills` returns every fill ever recorded as CSV, newest
first, and takes `from` and `to`. The download sits at the TOP of the tab,
before the rows — somebody who came for the file should not scroll past thirty
lines to find it.

**Both ends include their whole day.** A date input hands over `2026-09-10`,
which parses to midnight, so "the 1st to the 10th" read literally returns
nothing at all from the 10th — and the most recent day is the one the operator
most wanted. A **backwards range returns nothing**, not everything: an empty
file says "check the dates" while a full one says "here is what you asked for"
about something nobody asked for. And a date that is present but unreadable is
**rejected**, never ignored — quietly dropping it hands back a file believed to
be filtered, and a wrong export is worse than a refused one when what is
exported is the audit trail.

The filename carries the range, because a folder of exports all called
`operador-<today>.csv` is a folder nobody can tell apart a week later.

**A sale says what it MADE.** The tape showed a line marked VENTA with its
price and its size and nothing about whether it was a win — the one thing a
reader wants from that line. `realisedBySell` keeps the per-sale figure the
ledger was already computing and throwing away: same walk, same basis, so the
tape cannot disagree with the total above it. A BUY shows a dash, never a zero,
because a purchase has made nothing YET and a zero reads as a trade that broke
even. Costs are not subtracted, since the tape already shows what the chain took
in its own column and taking it off twice would make every line disagree with
the header.

**And the order comments are Spanish on the screen and English in the code.**
`🏁 Exit` is a typed member of `CloseAllOrder['comment']` that the parity harness
compares against TradingView's own trade list — it is EVIDENCE, not a label. So
the translation lives in `registry.tsx`, which is exactly the seam the project's
own rule describes: the interface is Spanish, and code, identifiers and comments
stay English. An unrecognised comment is shown as it came rather than blanked,
because it is still the truth about what the engine did.

Two details in `fills-csv.ts` that matter more than they look. The price is
written at **full precision**, because these are micro-caps and 0.0016426 at two
decimals is 0.00 — a tape of identical zeroes is worse than no file. And a fill
whose position is gone is **named by its id, not blanked**: `fills` deliberately
has no foreign key to `positions`, so a closed position's history outlives it,
and those rows are most of the file.

The Android shell needed a `setDownloadListener` for any of it to work. A
WebView ignores downloads silently — no error, no hint that anything was meant
to happen — so the link would have done nothing on the device the operator
actually watches this on. It hands the URL to the system browser, which already
knows how to save a file, ask for permission, and show it in the shade.

It renders **warnings, not a green badge**: kill switch engaged, orders in
flight unconfirmed, frozen positions, and — the one that matters most — a
position nobody has updated in hours. That last case is the shape of a silently
dead engine, the failure that looks identical to "nothing is happening".

Rendering is `force-dynamic`: a cached view of a trading system is worse than
no view, because a stale "all healthy" reads exactly like a live one.

**There is no meta refresh, and its absence is load-bearing.** One lived in
`layout.tsx` — `content="60"` — from before the page could update itself. The
console has polled `/api/view` every twenty seconds since, swapping the data
underneath precisely so the canvas keeps turning and the reader keeps their
place; the meta tag went on reloading the whole document over the top of it.

Every sixty seconds, mid-read, the browser threw the page away: back to the
Universo tab, scrolled to the top, orbits restarted, selection gone. It read as
the app reopening on its own, and it was reported that way. What located it was
the user noticing it happened **on the web as well as in the Android shell** —
nothing in Kotlin can do that to a browser.

**A fix that survives its own replacement stops being a fix.** The tab and the
scroll position are now remembered in `sessionStorage` anyway, because a page
load can still arrive from outside — a deploy invalidating an open tab's chunk,
Android reclaiming a WebView — and landing somewhere else is a bad answer to
any of them.

## The phone

`android/` — an Android app, and `dashboard/app/api/` the endpoints it reads.
**This replaced Telegram entirely.**

Telegram was a PIPE: the engine pushed, and whatever was not delivered was
gone. A phone that was off, out of signal, or not yet installed missed the
death exit entirely — and nothing recorded that it had. The replacement is a
LOG. `StoredAlertSink` writes every alert to the `alerts` table; the app reads
forward from a cursor. Being asleep costs latency, never the message, and the
same table is the audit trail the pipe never was.

The cursor is a **sequence**, not a timestamp. Two alerts can share a
millisecond, and a timestamp cursor then has to choose between skipping one and
replaying it forever — on a channel whose whole job is to deliver a death exit
exactly once, neither is acceptable.

Three properties worth naming:

- **A critical that fails to write is retried.** Swallowing the error is right
  for a heartbeat and wrong for a death exit. `StoredAlertSink` spools
  criticals, bounded, and drains them on the next send — so "the database
  blinked" is not a reason to lose the one message the channel exists for.
- **Sending still never throws into the engine.** A notification channel that
  can stop trading is a worse problem than a missed notification.
- **`info` alerts never become notifications.** They are in the feed and on the
  dashboard. A phone that buzzes on every heartbeat is a phone whose
  notifications get turned off, and then the death exit does not arrive either.

### A log that goes backwards is a different log

`seq` is a `BIGSERIAL`, so within one database it only climbs — which is why the
cursor is a sequence and not a timestamp. The phone kept that guarantee and
drew the wrong conclusion from it:

```kotlin
if (serverCursor <= prefs.cursor) return
```

A server cursor BELOW the phone's own does not mean "nothing new". It means the
alerts table was **reset** — a new project, a restored backup, a truncate — and
the cursor the phone is holding belongs to a history that no longer exists. With
the comparison as written the poll returned on every pass and **the phone went
silent forever**, with no error and no symptom: the ongoing notification would
go on saying the engine was healthy while delivering nothing. A death exit would
simply never arrive.

Found the day the operator moved the database, and before the move rather than
after — which is the only reason it is a paragraph here and not an incident.

It adopts the new cursor instead of replaying from zero, which is the rule a
fresh install already follows: start from now. Alerts belonging to a database
this phone never saw are not news.

### The one write path

Removing Telegram removed the phone kill switch, which CLAUDE.md lists as
mandatory. `POST /api/control` restores it, and earns its exception to the
read-only rule by being **one-way safe**: it can stop the engine from opening
new positions and release that stop, and it cannot place an order, size one,
close one, or touch a wallet.

Authorisation **fails closed**. With no `OPERADOR_CONTROL_TOKEN` set, or one
under 24 characters, the endpoint refuses everything — because "we forgot to
set it" and "anyone may stop the engine" must not be the same state. The
comparison is constant-time; a plain `===` on a secret returns as soon as it
finds a differing byte, which over enough requests leaks the prefix.

### The app

Kotlin, one dependency (`androidx.appcompat`). `HttpURLConnection` and
`org.json` ship with Android; three libraries to poll two endpoints would be
more dependency than program.

A **foreground service** does the watching, typed `specialUse` rather than
`dataSync` — Android 15 caps `dataSync` at six hours per day, which is exactly
the wrong limit for something whose job is to be watching at 3am. It restarts
on boot, but only if watching was not deliberately paused.

The API distinguishes **"the server refused"** from **"could not reach it"**,
and the ongoing notification says which. A monitor that cannot tell "nothing
happened" from "I cannot see" is worse than no monitor.

See `android/README.md` for building and pointing it at an engine.

### Language

The interface is **Spanish** — app, dashboard and alert text. Code,
identifiers, comments and documentation stay English.

## The engine tick

`application/engine.ts` advances ONE position to the LATEST closed bar,
walking every bar it missed. The order of its steps is the design:

0. **Execute what the PREVIOUS bar decided, at THIS bar's open.** An order
   decided at a close fills at the NEXT bar's open — the execution model the
   parity harness pinned. The engine writes its intentions down and the
   following tick carries them out, which is also what makes a crash between
   the two survivable. Each fill is keyed the way RECOVERY looks it up: by the
   bar the order was DECIDED on, not the one it filled at.

   **This step did not exist until the system was live.** The engine decided
   orders, wrote them as `pendingOrders`, alerted — and never sent them
   anywhere. `recordFill` had no caller outside the stores that implement it,
   and `broker.execute` was reached only from `replay.ts`. Five positions ran
   in production showing `0 compra / 0 venta`, which is what a decision engine
   with no execution looks like from outside: busy and completely still.

   The second half of the same gap: `PaperBroker` kept its position in memory,
   and the engine now wakes as a one-shot process. Every cycle started flat, so
   even with execution the strategy would never have seen what it opened
   fifteen minutes earlier. `PaperBroker.seed` rebuilds it from the recorded
   fills — the same principle the operations view already ran on: **the fills
   are the facts.**

1. **The death watch speaks first.** Health is assessed before the strategy
   runs, so a freeze or a death is already in force when orders are decided.
2. **The strategy evaluates the closed bar** — the same `stepCascade` that
   reproduces the TradingView backtest, unchanged.
3. **The death watch gets the last word.** `applyDeathVerdict` filters what
   the strategy wanted; vetoed orders are reported, not silently dropped.
4. **Write before sending.** Orders are persisted as `pendingOrders` BEFORE
   submission. A process that dies at this exact point is recoverable only
   because the intent was written down first.

**The walk exists because a cycle is not a bar.** The engine used to advance
one bar per call, which is correct only while a cycle is faster than a bar. In
production a cycle took ~37 minutes against 15-minute bars, so it saw TEN of
every TWENTY-TWO — and every parameter counted in BARS silently changed
meaning. `confirmBars: 20` stopped being five hours and became eleven, longer
than these positions live, so the rebound confirmation could never complete.
The measured result: **ten entries, six exits, and not one DCA fill.** The
cascade never cascaded, and no parameter was wrong — the clock was.

A slow scheduler is now a latency problem, which is what it always should have
been. Bounded at `MAX_CATCH_UP_BARS` (96, a day at 15m): past that the engine
was not late, it was down, and replaying a week would fill a ladder from a
market that is gone.

### The bar it decided on had not finished

Constraint 7 says signals evaluate on CLOSED bars only, and for the life of
this project not one of them did.

GeckoTerminal's newest row is the interval **currently being built**. Its close
is wherever the price happens to sit at the instant of the request — ask again
sixty seconds later and the same bar answers differently. Verified live: the
17:30 bar came back closing at 0.000966353, then at 0.000963356 a minute after.
Nothing dropped it, and `tickPosition` reads `candles.time.length - 1` as the
newest closed bar.

So the engine decided on a running quote, stamped `lastBarTime`, and **never
looked at that bar again once it really closed**. Every decision it has ever
made was taken on a candle that did not exist yet.

The operator found it from the tape: *BinanceTown bought only 11 dollars.*

| | |
|---|---|
| Price the order was sized at (bar mid-flight) | **0.0013161** |
| Where that bar actually CLOSED | **0.00100069** |
| Fill, at the next bar's open | 0.0010038 |
| A $15 rung bought | **$11.44** |

The 16:30 bar ran from 0.000418 to a high of 0.00146521 and settled at
0.00100069 — a 213% intrabar pump. The engine looked in while it was vertical.

Measured across the whole open book, `fillUsd / nominalUsd` on the entry rung:

| | Gap |
|---|---|
| p10 | **−5.1%** |
| median | +0.2% |
| p90 | **+2.8%** |
| BinanceTown | **−23.7%** |

The median says the mechanism is ordinary and the tails say what it costs. This
is not a distribution of execution slippage — it is *how far a 15m micro-cap
travels between mid-bar and the bell*, which is a number the engine should
never have been exposed to at all.

**It could not be caught offline, and that is the pattern.** The parity harness
replays a fixed OHLCV series where a forming bar does not exist, so the port
stayed faithful to `DCA.pine` while production read something `DCA.pine` never
sees. The same shape as the missing execution layer and the ladder the engine
did not size: correct on the offline path, broken on the live one.

The fix is in the ADAPTER, not the engine, because the adapter is what knows
the bar size — it built the request. One line, and everything downstream
inherits it: the strategy's indicators, `staleBars`, `priceMismatch`,
`idle-hours`. Two implementations of "has this bar closed" would drift.

**It costs one bar of latency and that is the correct price.** Deciding on a
closed bar is late by construction; the alternative was not being early, it was
being wrong. What it also costs, stated: the newest candle is now up to 30
minutes old rather than 15, which `maxPriceRatio` (5) absorbs without noticing
and `maxBarAgeHours` (1) still clears.

### The threshold the fix made unreachable

Dropping the forming bar had a second consequence nobody looked for, and it
emptied the book.

The history gate asks a THRESHOLD, not a depth — *"at least 100?"* — so the
runtime passes `minHistoryBars` straight through as the number of rows to
download. A hundred requested, the newest **discarded**, ninety-nine counted.
For every pool, on both chains, forever.

Measured the next morning on a fresh database: **162 tokens rejected with "99
barras de historial < 100"**, zero eligible, zero reserve, and a book of FOUR
positions where the day before it ran thirty.

And the four are the joke that makes the lesson stick. The gate fires on
EVIDENCE, never on absence — an unmeasured count stays silent — so the only
tokens that got through were the ones whose history request had **failed**. The
engine bought the four it knew least about, and it was right to, by its own
rules.

`historyBars` now asks for `enough + 1`. The compensation belongs beside the
discard: pushing it onto the caller puts the reason in a different file from the
cause, and the next caller gets it wrong again.

The economy that test was written for is untouched — it was never about the
exact number, it was about not downloading a thousand rows to answer a boolean.

### A rule change is not a reason to wipe

Every time the selection rules moved, the recommendation was the same: truncate
and start over, because the book had been chosen by rules that no longer
existed. That was right about the SCORES and wrong about the FILLS.

The scores are re-derived from the stored snapshots on every scan and every
dashboard build — they heal by themselves and always did. The fills are the
only real data this system has, and a truncate throws them away with everything
else: what was bought, at what price, what it cost, what it made.

What genuinely went stale is one number. `ep1` is the price every rung, every
separation lock and every rebound is measured from, and the engine set it from
bars that had not finished. BinanceTown was anchored at **0.0013161** and bought
at **0.0010038** — a ladder hung off a price no close ever showed.

`resyncCascade` re-derives it, before the tick, from the position's own buys:

| | Taken from |
|---|---|
| `ep1` | the **first** buy — the anchor is a fixed point, and an average would move every time a rung fills, so the rungs would chase the thing they hang off |
| `lastFill` | the **last** buy, because that is what `minGapPct` measures down from |
| everything else | **nothing.** `level`, `totalInv`, `decayCount`, `awaitReentry` are a record of what happened, and rewriting a counter is how a ladder fills the same rung twice |

**A repair, not a rule.** Inside `RESYNC_TOLERANCE_PCT` (10) nothing happens, so
Pine's own close-to-open gap survives and the parity harness is untouched — it
replays a fixed series where the two agree. Past it the fills win, because the
fills are the facts. Ten is argued: the legitimate gap is now nil (a bar's open
IS the previous bar's close on these pools), and the worst anchor measured was
23.7% out.

It reports as ONE `info` line per cycle, like the refusals. Nothing was bought
and nothing was sold; the engine simply carried on from a number closer to the
truth than the one it had.

### A token it cannot PRICE is a token it does not trade

The operator's rule, and it is wider than the bug that produced it: *if the two
sources disagree about the price, do not work that coin at all.*

`priceMismatch` already refuses such a token at the door — but it is only ever
asked at the scan and at the entry, and the damage lands at the EXIT. From the
tape:

| USDF | |
|---|---|
| 04:45 buy | 0.030637 — $15.06 |
| 06:45 sell `🏁 Exit` | 0.031247 — **+$0.30** |
| 07:00 buy | 0.031564 — $15.06 |
| 09:30 sell `❄️ Salida por congelamiento` | **0.0000021879 — $0.001** |

**14,426×**, two and a half hours apart, in the same position. Not a rug and not
a crash: a unit nobody agreed on, the second time after ZCAT's 10,846×.

What let it through is a rule that is otherwise right. The no-loss guard
deliberately exempts the two RISK exits — a death exit sells because the asset
stopped being an asset, and holding out for a better price on something
unsellable is how you hold it forever. But that turns *accept whatever price
exists* into **accept any number at all**, and $15.06 became a tenth of a cent.

So the check moved from the door to the tick, and from the exit to everything:
`pricesDisagree(marketPrice, candleClose)` and the position does nothing —
no entry, no DCA, no exit — until the two agree again.

- **The observation never stops.** `AssetHealthObservation` is typed so no
  price-shaped field can exist on it, so the death watch is unaffected and goes
  on running. A feed that lost its decimal point is not a reason to look away
  from a token that might be dying.
- **Silence is not evidence.** No second opinion means no verdict, or a quiet
  provider would halt the whole book.
- **ONE definition**, `domain/market/price-agreement.ts`, used by the gate and
  by the engine. Two implementations of "can this be priced" would eventually
  disagree about which tokens are safe.
- **The second opinion is never the candle feed.** Asking it to check itself
  agrees perfectly about a number that does not exist — which is precisely how
  both of these happened.
- **CRITICAL and never throttled.** Only a person can tell a broken feed from a
  real collapse, and until they do, real money is sitting still.

### If it can act now, it does not wait for the next candle

The creator's decision, and the reason is fifteen minutes of nothing:

```
se abre la posición
  ↓ hasta 15 min   el tick con barra nueva DECIDE y anota la orden
  ↓ hasta 15 min   el tick siguiente la EJECUTA en la apertura
```

Half an hour before a token the scanner chose holds anything at all — and the
second wait protects nothing, because the decision is already taken on a bar
that already closed.

**Bar-close semantics are untouched.** What moves is when the order reaches the
venue, not what it was decided on. A real venue does not make you wait for a
candle to send an order it already agreed to.

**The fill price is the MARKET price**, not the next bar's open and not the
candle. The candle is still read — it is what `pricesDisagree` checks the market
against — but it is no longer what money changes hands at.

It is safe now and would not have been this morning. The live market price
arrives every cycle for everything held, and the tick REFUSES to trade a token
at all when that price and the candle disagree. So an immediate fill is priced
against a number already confirmed by a second source, which is precisely what
the old path could never say about the next bar's open.

**And it repairs a leak rather than opening one.** Production sold BinanceTown
at **−13.1% under `🏁 Exit`** because the gap between the deciding close and the
filling open was −14.8%: the no-loss guard held at the close and the market
moved before the fill arrived. Filling now REMOVES that gap instead of guarding
against it — the guard compares against the price the order actually fills at,
because they are the same number.

Four things keep it honest:

- **One `settle`, two callers.** The orders a previous bar decided and the ones
  just decided share every detail that matters — the idempotency key, the
  no-loss guard, the per-fill suffix. A second copy of that is how a retry buys
  twice.
- **Keyed by the bar that DECIDED**, never the one it fills at. Recovery looks a
  fill up by exactly that.
- **Only the NEWEST bar.** A catch-up replaying twenty missed bars fills each at
  its own open, as it always did. Filling a bar from four hours ago at today's
  price would rewrite history with a number that did not exist then.
- **Silence is not evidence.** With no live price the order waits for the next
  bar's open exactly as before.

What it costs, stated: the parity harness pins that an order decided at a close
fills at the NEXT bar's open, and that is TradingView's model. It stays green
and stays meaningful — it replays a fixed series where no live price exists — so
the deviation is composed in production beside `dropInitPct` and the $15 ladder
cap, not smuggled into the port.

### Never exit at a loss — enforced where it actually leaks

The rule was enforced at DECISION time, where price is above average cost by
construction. It leaked at EXECUTION time, where the next bar's open can be
anywhere. Production sold BinanceTown at **-13.1% under the comment `🏁 Exit`**
because the gap between the deciding close and the filling open was -14.8%.

On 15-minute small caps the execution gap is routinely **larger than the entire
+2% profit target**, so a rule that only holds at the close does not hold. A
real venue can look at the price before sending the order, so now it does: a
non-death `closeAll` does not fill below average cost.

Nothing is rolled back when that happens, and the reason is worth keeping.
`stepCascade` resets the cycle on `!inPosition && wasInTrade` — it reacts to the
BROKER going flat, never to the exit being signalled. A sale that does not
happen leaves the broker holding, so the machine never resets and the ladder
survives on its own. The obvious design here is a remembered pre-exit snapshot;
it is unnecessary, and it would have needed a column the store does not have.

### An order the venue refused is never silent

`PaperBroker` records every rejection — `pyramiding`, `capital`, `flat` — into
`rejections`, and it has done since the simulator was written. **The parity
harness reads it. The engine never did.** So an order decided at one close and
turned away at the next open vanished between the two, leaving a clock icon on
the screen and no explanation anywhere.

It was found while diagnosing something else, and the diagnosis was WRONG: the
thirty positions carrying pending orders with zero fills were simply waiting for
the next bar, and they filled on their own minutes later. The gap is real all
the same — an engine that decides orders into a void looks exactly like an
engine that is working, and that is the failure this project has paid for more
than any other.

`warn`, not `info`: this one is a decision that was made, written down, and then
did not happen.

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

## House rule: never invent a number the world will tell you

Decided after it went wrong three times in one day, always the same way.

**A timing constant is a claim about somebody else's system.** Every one in this
codebase was chosen by us and none was ever checked: GeckoTerminal at 2,500ms,
Jupiter at 1,100, GoPlus at 2,000, three retries doubling from four seconds. A
guess like that is wrong in BOTH directions at once — too slow against a
provider that never pushes back, too fast on the day one does — and the cost of
each is invisible from the other side.

| Was | Is | What told us |
|---|---|---|
| 3 retries, doubling from 4s | a **60s deadline**, stop the instant the data arrives | 33 minutes to examine 100 tokens, ~20s each against a 2.5s throttle |
| Jupiter at a flat 1,100ms | starts at **zero**, backs off only on a 429, speeds back up when they stop | GoPlus reported **zero rejections** across a hundred calls; nobody had ever measured Jupiter's |

**And what a failure COSTS decides whether to wait at all.** It is the sell
probe's own distinction, applied to timing:

| A refused | leaves | so |
|---|---|---|
| sell quote | `honeypot` unknown → the gates fail closed → a good token thrown out as unsellable | **wait** |
| pool page | a few names off a list `CachedDiscovery` already backs with the previous one | **go on** |

Discovery therefore waits for NOTHING, and it is not a judgement that it matters
less. *An old universe beats no universe* was already written down; a page that
does not arrive is not evidence, and there is nothing a wait could buy. Getting
that backwards cost **nine minutes of a log printing only `[boot]`** — thirty
pages a chain, each spending the full sixty-second budget on an answer that
changed nothing, before the first progress line even exists.

**And a request slower than the provider's own answers is not worth waiting
for.** The operator's rule again, one level down: measure what it normally
delivers over a number of connections, leave a small space in case it takes a
little longer, restart it past that, and move on if the second one is slow too.

Not the AVERAGE. Half of any sample sits above its own mean by definition, so an
average cut-off restarts half of everything — doubling the load on a provider
exactly when it is struggling. The base is the **slowest answer that recently
worked**: the upper edge of normal, measured rather than chosen. The margin on
top is proportional (a quarter), so it scales with whatever the provider turns
out to be instead of claiming to know it.

Wrapped per PROVIDER, because a shared baseline is the average of different
things — GoPlus answers in about half a second, Jupiter in one, GeckoTerminal in
one and a half — and an outlier is only an outlier against its own kind. It
never judges before it has a history, and it restarts exactly ONCE: a second
slow answer is the provider describing itself rather than one unlucky
connection.

It replaces a 20-second timeout nobody measured — forever on an API that answers
in 80ms, too soon on one having a bad afternoon. The timeout stays as the last
line of defence; the hedge decides long before it.

The rule, in three parts:

- **Prefer a DEADLINE to a count.** "Wait until it answers, give up after sixty
  seconds" prices the thing that matters — how long a scan takes. "Try three
  times" prices nothing, and is cheap against a provider that answers and
  ruinous against one that does not.
- **Let the provider set the pace.** A 429 is the only evidence about somebody
  else's quota that exists. Start at no wait, slow down when refused, speed back
  up when the refusals stop — otherwise one bad minute costs the whole hour, and
  a fixed interval has that failure permanently.
- **A number you cannot justify is a bug waiting.** `minPositionUsd: 200`
  survived its own measurement being superseded and capped the book at four
  slots for weeks. `maxSecurityChecks: 20` outlived the cost that justified it.
  Both were right once.

Two things that make starting at zero SAFE rather than reckless, and neither is
optional:

- **The counters already exist.** Every adapter records its own 429s and the
  scan prints them as `[scan:limits]`. Going too fast is visible in one run,
  which is what turns this from a guess into an experiment.
- **A refusal must never be read as a verdict.** An unanswered sell quote leaves
  `honeypot` unknown, the gates fail closed, and a perfectly good token is
  thrown out as unsellable. Speed was never free — it was paid for in candidates
  nobody could see being lost, which is why Jupiter now retries at the pace it
  was just asked for instead of reporting a failure.

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

### What a cycle actually costs — measured, twice, after guessing wrong twice

The first cloud cycle was killed by its own timeout, and the numbers only made
sense after instrumenting. Worth keeping, because both of my estimates were
wrong in a way reasoning alone could not have caught.

| | |
|---|---|
| Estimated per token | 9s |
| First measurement | **16.8s** |
| After parallelising the three providers | 4.5s locally, still ~15s in CI |
| The actual cause | GeckoTerminal, 45 rate-limit rejections, 276s of backoff — **80% of the cycle** |
| Every other provider | GoPlus: zero hits, zero waiting |

**GeckoTerminal limits by IP, and a CI runner shares its address with thousands
of unrelated jobs.** The quota is not ours to budget. Tuning a throttle against
a quota you cannot observe is guesswork; the only winning move is to ask less.

The heaviest call was `historyBars` — a full thousand-row candle download,
made to learn one integer, once per checked token. `CachedHistory` keeps that
integer in `pool_history`, and what makes that CORRECT rather than merely
convenient is that **a pool cannot lose candles**: once it has enough history
for the strategy it has enough forever. Only a SHORT count expires, after six
hours, because a young pool grows. A failed call is never cached — writing null
would turn one rate-limited request into a permanent "this pool has no
history", and the gate would reject a good token forever on a network blip.

Measured, cold cycle against warm cycle, same chain, same 20 tokens:

| | Cold | Warm |
|---|---|---|
| GeckoTerminal rejections | 50 | **21** |
| Time backing off | 304s | **116s** |
| Scan | 384s | **177s** |

Two lessons, both paid for: **instrument before optimising** — the bottleneck
was in neither of my hypotheses — and **a diagnostic that misleads is worse
than none**, which the first version of these counters proved by reporting a
cumulative total as a per-chain one and printing 556 seconds of waiting inside
a 356-second scan.

And then discovery was what remained — ten throttled calls per chain, most of
the 116s, and about half an hour of a scan during which the engine is not
watching the positions that already hold money. `CachedDiscovery` keeps the
list in `pool_discovery`.

Unlike a candle count, a discovery list genuinely CHANGES: new pools appear. So
it expires, and the window is not a guess about how fast the market moves — it
is an argument about what the gates would do with the answer:

> **A pool younger than the window cannot clear the history gate anyway.** The
> strategy wants 250 bars, which is 2.6 days at 15m, so a token that first
> appeared six hours ago is rejected on arrival. Caching for six hours cannot
> lose a single token the scanner would have accepted.

Same two failure rules as the history cache, learned the same way: a failure is
never cached, because an empty list would turn one rate limit into a chain that
does not exist for six hours — and a failure falls back to the STALE list,
because an old universe beats no universe.

#### Downloading less, rather than downloading faster

Three economies, and none of them is a cleverer request — each is a request
that stops being made.

**A pool too young to hold the bars is refused by subtraction.** `minAgeHours`
was 24 while `minHistoryBars` is 250, which at 15m is **62.5 hours**. So a pool
thirty hours old passed the free gate and then cost a **thousand-row candle
download** to learn it had about a hundred bars and failed anyway — the heaviest
call in the cycle, made to produce one integer a subtraction already knew.
`minAgeForHistory(bars, barMinutes)` raises the floor to exactly what history
requires, never below the standing 24h.

It matters most for `new_pools`, added to discovery in the same week: nearly
every result there is younger than this. They are now refused at the door for
free, instead of each paying for a download it was always going to fail.

It only ever REJECTS. An old pool nobody trades has no candles either — the
abandonment case — so the real count is still measured for whatever survives.

**And that measurement asks for 250 rows, not 1,000.** The gate asks a
THRESHOLD, not a depth: "at least 250?" A saturated count means "enough or
more", which is all any caller can use, and a SHORT count is still exact —
which is what `CachedHistory` needs, since it expires a short count after six
hours because a young pool grows, and keeps a settled one forever because a pool
cannot lose candles.

**Counting the bars the strategy actually trades.** See finding 4 above: it
counted 1H bars while production runs 15m, so the gate was four times stricter
than documented.

#### A cold shelf is swept to the bottom

The user's rule: with nothing cached, sweep EVERYTHING before starting — newer
and older, all of it — and only then go to the positions.

It rests on a distinction the cache was already making and not using. Nothing
remembered is not the same as something remembered that expired:

| | Asks | Depth |
|---|---|---|
| **Cold** — nothing on the shelf | what EXISTS | 10 pages, GeckoTerminal's own ceiling |
| **Refresh** — a list expired | what APPEARED since | 5 pages |

Five pages of trending answers the refresh question well and the cold one
badly. The tail of the list is old, quiet pools — exactly the half a
popularity ranking never reaches — and old pools do not move, so paying the
deep sweep once is enough.

**`new_pools` was missing while `discoverPools`'s own comment claimed it.** The
lists were `trending_pools` and `pools`; every other source in the universe
ranks by popularity NOW, so nothing was ever there for being new. Most of what
it returns will be rejected by the history gate — 250 bars is 2.6 days, and a
pool born this morning cannot have them. What it catches is the token that is
old whose POOL is new: a migration, a redeploy, a second venue, invisible to
every popularity list until it trends, by which time the move is over.

**The cap had to rise with it**, to 700. Three lists at ten pages is up to six
hundred pools per chain, and a 300 cap would have discarded half of that by
arrival order — paying for the sweep and throwing away its tail. Affordable
because the expensive stage is capped separately: market data is one
DexScreener call per thirty tokens, the free gates cost nothing, and security
stays bounded by `maxSecurityChecks` and rotates through its cache, so a wider
universe reaches FURTHER over cycles rather than costing more per cycle.

And the cut now reports what it DROPPED, not only what it kept. A log that
prints the survivors alone reads identically whether the cap bit or the day was
quiet — so the one number that would tell you to raise it was the one nobody
could see.

**The order stays as it is.** "Only then start with the positions" is already
true on a cold start, because a cold start has no positions. Moving the scan
ahead of the tick for the case where positions DO exist would leave open money
unwatched for half an hour, which is the trade the watch pass was built to
avoid: an opportunity missed by an hour is only missed.

#### Every scan is the full scan

`OPERADOR_MAX_SECURITY_CHECKS` capped the expensive stage at **20 tokens per
chain**, and that cap answered a question which has since been re-measured out
of existence. It was set when a scan cost 384 seconds and every examination was
a thousand-row candle download — a cycle could not finish inside a bar with more.

Four things changed underneath it:

| | Then | Now |
|---|---|---|
| Tokens reaching the paid stage | everything discovered | **~10%** — 57 of 480, 41 of 452, measured |
| Rows per history count | 1,000 | **250** |
| A scan happens | every cycle | **once an hour**, watch passes in between |
| Ninety-eight examinations cost | — | **4 minutes** at the measured 2.5s each |

So the default is **null — unbounded**. Every token that cleared the free gates
is examined, on every scan. A cap is now something you ASK for, on a day the
providers are unhappy, rather than something you get.

**Zero is refused, not read as "no limit".** `maxPositions: 0` meant "no
ceiling" in `planPortfolio` and "zero slots" in the orchestrator's subtraction,
and with an empty book the engine opened nothing, ever. A value that means one
thing in one file and its opposite next door is not a sentinel, it is a trap.
Absent means unbounded; a number means that number.

This also retired `bootstrap.ts` and the `examinedCount` port it needed. They
existed to lift the budget for the first pass alone; with no budget to lift,
keeping them would have been a mechanism with nothing left to do.

The cost is named rather than hidden: the scan runs AFTER the tick, so once an
hour the next tick waits for it — about one 15m bar of extra latency on the
positions, bought in exchange for the whole universe being examined hourly
instead of a twentieth of it.

#### The beginning of everything is not a cycle

Sweeping discovery deeper achieved nothing on its own, and the reason is the
stage AFTER it. `maxSecurityChecks` is **20 per chain per cycle** — a good rule
for a recurring cycle, where each examined token costs a throttled GoPlus call,
a sell quote and a candle download, and the pass has to finish inside a
15-minute bar. What it cannot reach is reported unchecked, the cache remembers
what was looked at, and the next cycle reaches further down the list.

Against a **virgin Neon** that budget is a trap:

| | |
|---|---|
| Discovered by the deep sweep | up to 700 per chain |
| Examined on the first pass | **20** |
| Share of the universe | **2.8%** |
| Everything else | `securityChecked: false` → gates fail closed → ineligible |
| Time to cover the rest at 20/scan | **~3 days** |

And the engine does not wait those three days. It opens its first positions out
of that 2.8% sample — and **a slot handed out is a commitment**: it does not
come back without selling, which is the strategy's decision and never the
allocator's. The book would be filled on day one, from the first twenty tokens
that happened to clear the free gates, while the other six hundred and eighty
arrived over the rest of the week to find no room.

This was first fixed for the first pass ALONE, with a self-terminating
`bootstrap.ts` that lifted the budget while nothing had ever been examined. The
section above superseded it: the budget is gone from every scan, so there is
nothing left to lift and the mechanism was removed rather than left in place
with nothing to do.

**How long the cold run takes — measured per token, extrapolated**

One real token per chain, timed end to end (2026-09-16, from a home IP):

| | GoPlus | decimals | sell quote | history | longest branch |
|---|---|---|---|---|---|
| Solana (USDC) | 1.02s | 0.32s | 0.98s | 1.51s | **1.51s** |
| BSC (CAKE) | 0.43s | — | 0.92s | 1.22s | **1.22s** |

The three providers run as three parallel branches, so a token costs the
LONGEST of them and not their sum. But tokens are examined **sequentially**, so
across them the THROTTLES bind, not the latencies:

| Provider | Interval | Calls per token | Floor |
|---|---|---|---|
| GoPlus | 2,000ms | 1 | 2.0s |
| Jupiter | 1,100ms | 2 | 2.2s |
| **GeckoTerminal** | **2,500ms** | **1** | **2.5s** |

**2.5 seconds per token**, set by GeckoTerminal — not by any latency.

The one unknown was how many tokens the FREE gates let through, so it was
measured too: a real cold run stopped at `maxSecurityChecks: 0`, which halts
immediately before the paid stage (2026-09-16, home IP, the economies above in
place):

| | Discovered | Clear the free gates | Rate | Discovery |
|---|---|---|---|---|
| Solana | 480 | **57** | 11.9% | 187s |
| BSC | 452 | **41** | 9.1% | 209s |

**Roughly one token in ten reaches the paid stage.** The gates are doing far
more work than assumed — an estimate of 80–150 survivors per chain was nearly
three times the truth.

| | Solana | BSC |
|---|---|---|
| Discovery | 187s | 209s |
| Examination (57 and 41 × 2.5s) | 143s | 103s |
| **Total** | **5.6 min** | **5.2 min** |

**About eleven minutes for both chains**, against the "one to three hours" this
section claimed before the economies. Also worth noting: `dropped: 0` — the
700-token cap never bit at 480 and 452, so it is a ceiling and not a cut.

**On the runner it took 15 minutes**, against an estimate of twenty to
thirty-five. The shared-IP penalty is real but far smaller than the older
figures implied — 11 minutes at home became 15, a factor of 1.36 rather than the
two or three assumed from a cold scan measured before discovery and history were
cached. Recorded because the estimate was wrong in the safe direction, and the
next person reasoning about GeckoTerminal's limits should use this number and
not the 304-second one.

**The hourly scan is cheaper than that cold one, and by construction.** The cold
run paid for DEEP discovery — 30 calls per chain — while an hourly scan finds it
cached for six hours, and refreshes at five pages rather than ten. And an
examination stands for `securityTtlMs` (2 hours), so a scan only re-examines
what has aged past it plus whatever is new. Steady state is the paid stage
alone: **about four minutes**, not fifteen. Everything is written as it goes
(`recordSecurity` per token, `saveScan` per chain), so a killed job loses no
work — but the run after it is no longer the beginning of anything and drops
back to 20 per scan. To redo a bootstrap that was cut short, clear
`token_security` for that chain and relaunch.

### The engine does not need a server — CORRECTED

This section used to say the opposite, citing "live WebSocket subscriptions to
price and liquidity feeds". **There is not a single WebSocket in the
codebase.** Every adapter — DexScreener, GoPlus, Jupiter, GeckoTerminal,
PancakeSwap — is HTTP polling, and every piece of state (positions, ladder,
death watch, in-flight orders, the alert log) is in Postgres.

So a cycle reads the database, decides, writes, and exits. There is nothing
for a long-lived process to hold between cycles because there is nothing in
memory, which is what makes `OPERADOR_MAX_CYCLES=1` honest rather than a
shortcut: it does exactly what the daemon does, once.

The engine therefore runs on **GitHub Actions on a schedule** (see `DEPLOY.md`),
with two limits worth knowing:

- GitHub's cron is best effort; a run can start ten minutes late under load.
  Tolerable on 15-minute bars, not on 1-minute ones.
- A scheduled workflow is disabled after 60 days without a commit.

Vercel still cannot host it, and the reason is unchanged: a serverless function
has no continuity. A scheduler is not a serverless runtime — it starts a whole
process, which is all a cycle ever needed.

The Docker image remains the migration path to a real daemon (Oracle Always
Free ARM) the day a WebSocket feed or a sub-minute bar makes one necessary.

### Topology — $0/month stack

The whole system runs on free tiers. Verified September 2026.

| Component | Runs on | Cost | Notes |
|---|---|---|---|
| **Engine** — scanner, executors, death-exit monitor | **GitHub Actions**, one cycle every 15 minutes | $0 | Unlimited minutes on a public repo. Oracle Always Free ARM remains the upgrade path. |
| **State & event log** | Postgres — Supabase or Neon free tier | $0 | Durable truth. Engine memory is a cache, never the source. |
| **Dashboard** — positions, death watch, warnings | **Vercel** Hobby (Next.js, read-only) | $0 | This is where Vercel belongs. **✅ built** |
| **Alerts + kill switch** — on the phone | Android app (`android/`), reading the alert log | $0 | Unattended ≠ unobservable. **✅ built** |

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
6. **Kill switch reachable from a phone**, independent of the engine process —
   the Android app, writing to the store the engine reads.
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
