/**
 * The two numbers that make the production ladder differ from the reference.
 *
 * They live here, alone, because TWO things need them and neither may own
 * them: the engine, which sizes and fills the ladder, and the dashboard, which
 * draws it. The dashboard drew `DEFAULT_PARAMS` instead and showed a $1,000
 * rung beside a $15 order for days — a screen disagreeing with the engine about
 * the size of a trade, which is the exact failure `buildDashboard` exists to
 * prevent.
 *
 * Neither number may be expressed by editing `DEFAULT_PARAMS` or `PYRAMIDING`.
 * Those are what TradingView ran and the parity harness asserts them: they are
 * EVIDENCE, and evidence that can be edited to express a preference stops being
 * evidence. Production composes its own values on top.
 *
 * No database, no clock, no network — so the web app can import it without
 * dragging the runtime into its build.
 */

import { DEFAULT_DEEP_RUNG_POLICY } from '../domain/strategy/deep-rung.js'
import { DEFAULT_DIP_BOUNCE_POLICY } from '../domain/strategy/dip-bounce.js'

/**
 * What every buy of a holding is, in dollars, the first included. *Comprá 1
 * USD, y armá escalones de 1 USD con la misma regla.* The operator — then
 * *en vez de 1 USD que sean 5 por escalón, todo lo demás igual.* A slot is
 * therefore twenty steps of $5, $100, and the book holds capital / $100.
 */
export const DEFAULT_STEP_USD = 5

/**
 * Buys per holding, the first included: the first buy and FIVE DCAs, $30 a
 * token at $5 a step, so $5,000 holds 166 tokens. It was twenty, and fifty
 * before that — *usemos sólo 5 DCA por token.* Fifty tokens at $100 put a
 * whole day's result in the hands of two or three that sank; the $1 experiment
 * had been stable because the same capital was spread over 250.
 * `DEFAULT_DIP_BOUNCE_POLICY` keeps twenty, so the rule's own tests stand.
 */
export const DEFAULT_MAX_STEPS = 6

/**
 * The dip that arms DCA 1's watch and the bounce off its low that buys, in
 * percent. Every later DCA asks more: see `DEFAULT_DIP_STEP_PCT`, and
 * `domain/strategy/dip-bounce.ts` for the rule.
 *
 * *El DCA 1 = el DCA 7, el DCA 2 = el DCA 8, y así.* The operator. It was 3%
 * and 2% — *ante una caída del 3% y una subida del 2%* — which the growing
 * steps took to 15% and 8% only at DCA 7; the ladder now starts there. The
 * five DCAs reach at least 8%, 17%, 26%, 35% and 44% under the first buy, and
 * on 2026-09-30 the reversals the book caught sat near −50%. Replayed on that
 * day's 126 positions, it held half the capital under water (−$81 on $475
 * against −$165 on $920) for three fewer take-profits. The domain policy keeps
 * 3 and 2.
 */
export const DEFAULT_DIP_PCT = 15
export const DEFAULT_BOUNCE_PCT = 8

/**
 * How many points each DCA adds to the dip it asks — and to its collapse
 * ceiling — and to the bounce. *3% suma 2%, el 2% suma 2% por cada DCA*, then
 * *el rebote dejalo que aumente de 1%, no de a 2%*, then the ceiling *crece 2
 * puntos por DCA, igual que la caída*. The operator.
 *
 * | Buy | Dip | Bounce | Ceiling |
 * |---|---|---|---|
 * | 2nd (DCA 1) | 3% | 2% | 20% |
 * | 3rd (DCA 2) | 5% | 3% | 22% |
 * | 4th (DCA 3) | 7% | 4% | 24% |
 * | 11th (DCA 10) | 21% | 11% | 38% |
 * | 20th (DCA 19) | 39% | 20% | 56% |
 *
 * CURVE bought five times in sixteen minutes while its price moved −0.5%,
 * −1.2%, −1.8% and −2.9%: a 2% bounce eats most of a 3% dip in a choppy token,
 * and it ended with fourteen buys and −30%. Zero is a REAL value — every buy on
 * the same dip, bounce and ceiling, the flat rule this replaced:
 * `OPERADOR_DIP_STEP_PCT=0`, `OPERADOR_BOUNCE_STEP_PCT=0`. The ceiling has no
 * variable of its own: it grows with the dip, so the seventeen points between
 * the dip that arms and the fall that collapses hold at every step.
 */
export const DEFAULT_DIP_STEP_PCT = DEFAULT_DIP_BOUNCE_POLICY.dipStepPct
export const DEFAULT_BOUNCE_STEP_PCT = DEFAULT_DIP_BOUNCE_POLICY.bounceStepPct

/**
 * The deepest fall a step still buys on, in percent under the reference. "If
 * it fell more than 20% it is a collapse, not a dip: don't buy there. Wait
 * until it is back within 20%." The operator, on the first hour and a half at
 * $5: every token doing well bought on falls of 3% to 15.6%, while YAP and
 * BAGSPAY bought on 31–34% and lost $35 of the $52 that went. Zero turns it
 * off: `OPERADOR_MAX_DIP_PCT=0`. See `domain/strategy/dip-bounce.ts`.
 *
 * The first buy's and DCA 1's: every later DCA's grows with the dip, by
 * `DEFAULT_DIP_STEP_PCT` — 38% for DCA 10, whose dip is 21%.
 *
 * OFF in production. *Sacá el techo de derrumbe; lo único que quiero que
 * proteja de derrumbe es que se quite el 50% del capital.* The operator, after
 * the growing dips contained SDOG's −35% in five well-spaced buys without the
 * ceiling ever firing. What still refuses a buy in a collapse is the live pool
 * check: liquidity under half of what it was at entry
 * (`liquidityFreezeRatio`). `OPERADOR_MAX_DIP_PCT=20` brings the ceiling back.
 */
export const DEFAULT_MAX_DIP_PCT = 0

/**
 * Whether the deep rung — $20 after a fall of more than 80% and a 10% rebound —
 * still buys. OFF: every buy is a dip-bounce step now. `OPERADOR_DEEP_RUNG=1`
 * brings it back, and its numbers below are still its own.
 */
export const DEFAULT_DEEP_RUNG = false

/**
 * Whether the cascade's own doors — the classic drop from the swing high and
 * the trend re-entry — may buy. OFF: *nada se compra cuando una moneda pasa a
 * candidata*; only dip-bounce steps buy — the first one on selection, the
 * rest on a dip and a bounce. `OPERADOR_CASCADE_ENTRIES=1` brings them back.
 * The momentum door is shut too: `OPERADOR_BUY_ON_SELECTION` now buys the
 * first dip-bounce STEP on selection, never through the cascade.
 */
export const DEFAULT_CASCADE_ENTRIES = false

/**
 * USD cap per level of the reference ladder — which in production is ONE
 * STEP, the dollar every dip-bounce buy is. The cascade's own entries and
 * rungs are switched off; the number still prices the slot's ladder the way
 * the allocator and the trim read it.
 *
 * It was FIFTEEN: *dos escalones solamente: uno con $15.* Bought in the same
 * pass the token became a candidate, the slot reserving that buy alone.
 *
 * It was TEN, with ladder A: *arriesguémonos, activá la A.* A smaller first buy
 * and bigger rungs under it, so the money goes in where the price is lower.
 * See `DEFAULT_MAX_DCA_PER_TOKEN` for the replay that chose it. And before
 * that fifteen, flat: `min(1000 × (1 + 1.2n), 15)` is 15 everywhere, and the
 * rungs bought the same fifteen.
 */
export const DEFAULT_MAX_USD_PER_LEVEL = DEFAULT_STEP_USD

/**
 * DCA rungs production will fill, per token. The entry is not one of them, so
 * one means two open entries.
 *
 * ONE — the deep rung: *dos escalones solamente: uno con $15; si el precio cae
 * más de 80% y hay un rebote de 10%, nueva compra DCA de $20.* The operator.
 * See `domain/strategy/deep-rung.ts` for the rule and `DEFAULT_DEEP_RUNG_*`
 * below for its numbers. Every other path that could buy a rung is OFF, each
 * one a variable away: the chained drop ladder (`DEFAULT_DROP_LADDER`), its
 * volatility spacing (`DEFAULT_DCA_ADAPTIVE`, `DEFAULT_DCA_REALTIME`), the
 * liquidity brake's bounce buy (`DEFAULT_PRODUCTION_LIQUIDITY_BRAKE_PCT`), the
 * buy-pressure ladder (`OPERADOR_PRESSURE`) and the cascade's own rungs
 * (`minGapPct: 100`).
 *
 * What it costs, stated: at most **$35 in one token**, against ladder A's $135
 * — and a position that falls 30%, 50% or 70% is held with nothing bought,
 * waiting for the TP, the freeze exit or the death exit. Only a fall of more
 * than 80% that then turns up 10% buys the rung.
 *
 * What came before, kept because each step had a reason:
 *
 * FIVE — ladder A: a $10 first buy, then $15, $20, $25, $30 and $35 at −10%,
 * −15%, −20%, −25% and −30% of it. *Arriesguémonos, activá la A.* The same
 * replay of all 336 real entries (09-23 → 09-27, 5-minute closes, 0.66% a
 * fill, the real freezes applied per token, split in time):
 *
 * | | Result | train / test | frozen | per $100 of peak capital | peak capital |
 * |---|---|---|---|---|---|
 * | $15, then three $15 rungs at −10/−20/−30 (what ran) | +$373 | 185 / 203 | 8, −$44 | 23.3 | $1,605 |
 * | **A**: $10, then $15/$20/$25/$30/$35 at −10/−15/−20/−25/−30 | **+$520** | 264 / 270 | 6, −$8 | **28.1** | $1,850 |
 *
 * Better in both halves of the split, and better per dollar of capital at its
 * peak, not only in total — so it is not merely more money at risk earning
 * more money.
 *
 * What it costs, stated and accepted knowingly: up to **$135 in one token**,
 * against $60. A token that falls through the last rung and then freezes at
 * −60% loses about **$66**, against about $31 on the ladder it replaces. The
 * freeze exit and the blacklist on freeze are what bound that, and both stay.
 *
 * What came before, kept because each step had a reason:
 *
 * THREE, at −10%, −20% and −30% of the FIRST buy — see `DEFAULT_DCA_DROPS_PCT`.
 * *Podés calibrar según los datos para que las ganancias sean las máximas y las
 * pérdidas las mínimas*, then *apliquemos la configuración completa.* Measured
 * on a replay of all 336 real entries, split in time at 09-25 05:30:
 *
 * | | Result | train / test | frozen losses | worst token | peak deployed |
 * |---|---|---|---|---|---|
 * | one rung at −50% (what ran) | +$71 | 31 / 41 | −$75 | −$20.87 | — |
 * | three rungs, −10/−20/−30 | **+$373** | 185 / 203 | −$44 | −$25.40 | $1,605 |
 *
 * The replay was optimistic by about $35 against the tape (+$71 simulated,
 * +$37 real), so read the gap, not the level. What it costs is stated: the
 * worst single token loses more, because a ladder puts more money into the one
 * that keeps falling — which is why the freeze exit stays, and why a frozen
 * token is now blacklisted rather than bought back.
 *
 * It needs a change in how capital is RESERVED to be the book the replay ran:
 * four entries reserved per token would hold about half as many tokens. See
 * `DEFAULT_RESERVED_ENTRIES`.
 *
 * What came before, kept because each step had a reason:
 *
 * The user's decision, twice, and the second time for a different reason.
 *
 * FIVE came from the ladder's geometry: with `linInc` at 3, DCA-5 already needs
 * a 13% fall and DCA-10 needs 28%, and a token down 28% is rarely an
 * opportunity.
 *
 * TWO came from asking how to avoid large losses. It halves the most one token
 * can ever cost — three rungs at $15 is $45, against $90 — and doubles the
 * book, because the same capital buys twice as many ladders. Measured on
 * $1,500: fourteen positions at $95.09 each becomes TWENTY-NINE at $47.57, and
 * a token that dies costs 3.4% of the book instead of 7%.
 *
 * It has a price, and it is paid in the gates. A two-rung ladder cannot chase
 * a fall the way a ten-rung one could, so the entries have to be better: it is
 * why `maxDailyFallPct` exists at all, and why the turnover gate was added
 * alongside it. Shallower ladder, stricter door.
 *
 * Both are finding 2 of the capital floor arriving by different roads: scale
 * comes from more tokens, not more size per token.
 * Then five became TWO, and two became ZERO — one entry, no ladder at all.
 *
 * The operator's structural change: *pone la profundidad en 0, solo un paso,
 * una sola compra.* Every rebound lock, the separation gap, `confirmBars` and
 * the whole cascade below level 1 are still in the machine and are now never
 * reached, exactly as `maxLevels = 50` sits above `PYRAMIDING = 10` in the
 * reference: the strategy signals, the venue caps.
 *
 * What it costs, stated rather than discovered later. The ladder was the only
 * thing that could improve a position's basis, and it is gone at the same time
 * as the no-loss rule was restored to every exit including the switch. So a
 * position that goes under water has nothing that can rescue it: it cannot
 * average down, the strategy exit wants `avg_cost + 2%`, and the switch now
 * refuses to sell at a loss. Its capital is held until the price comes back
 * over cost or the death watch condemns the token.
 *
 * The operator's argument for accepting that is the doors in front of it, and
 * the arithmetic is on his side: a book of many small single-buy positions
 * where the winners recycle at +2% and the losers wait costs far less per
 * mistake than a deep ladder that keeps buying into one.
 *
 * Then zero became ONE: *armá un solo paso de DCA: si el precio cae al 50% de
 * lo que vale, volver a comprar — sólo esa condición.* The sweep bought it,
 * every thirty seconds, at half the last buy. It is the rule the replay above
 * measured against, and the one three rungs replaced.
 *
 * Then NINETEEN: twenty dip-bounce steps, the first one included, so the venue
 * holds twenty entries. Derived from the steps rather than written twice —
 * `OPERADOR_MAX_STEPS` moves both, and `OPERADOR_MAX_DCA` still overrides.
 */
export const DEFAULT_MAX_DCA_PER_TOKEN = DEFAULT_MAX_STEPS - 1

/**
 * How far under the FIRST buy each rung buys, in percent: DCA-1 at −10%, then
 * every five points down to DCA-5 at −30%. Here because the engine buys on it
 * and the screen draws it.
 *
 * Ladder A keeps the deepest line where it was, −30%, and puts two more rungs
 * between the old three: the same fall is met more often and with more money
 * the deeper it goes. It was [10, 20, 30] with three $15 rungs.
 *
 * It was ONE number, 50, measured from the LAST buy — *si el precio cae al 50%
 * de lo que vale, volver a comprar.* A list measured from the first is what
 * the replay chose, and anchoring to the first is what keeps it bounded: three
 * steps measured from each other would chase a bleed down forever.
 *
 * Every price STOP tested alongside it (30, 50 and 70%) lowered the result, so
 * there is none: a position under the last rung is held, and only the freeze
 * or the death exit may sell it at a loss.
 */
export const DEFAULT_DCA_DROPS_PCT: readonly number[] = [10, 15, 20, 25, 30]

/**
 * What each rung buys, in dollars, DCA-1 first: $15, $20, $25, $30, $35 —
 * paired one to one with `DEFAULT_DCA_DROPS_PCT`. Ladder A.
 *
 * Growing as the price falls, so the deeper a rung, the more of the average it
 * pulls down. Every rung was the same $15 before, and so was the first buy.
 *
 * A LIST, and the same length as the drops, because each size belongs to one
 * line: rung `n` buys `dcaRungsUsd[n-1]` at `dcaDropsPct[n-1]`. A shorter list
 * would leave a rung with a line and no amount; a longer one would size a rung
 * that has no line. Pairing half of each is a ladder nobody chose.
 */
export const DEFAULT_DCA_RUNGS_USD: readonly number[] = [15, 20, 25, 30, 35]

/**
 * Whether the chained drop ladder — `DEFAULT_DCA_DROPS_PCT` at
 * `DEFAULT_DCA_RUNGS_USD`, measured per `DEFAULT_DCA_FROM` — buys at all.
 *
 * OFF: only the deep rung buys after the entry. `OPERADOR_DROP_LADDER=1` brings
 * it back, and with it the spacing and the brake that ride on it; ladder A
 * whole also needs `OPERADOR_MAX_DCA=5` and `OPERADOR_MAX_USD_PER_LEVEL=10`.
 * The lists below are its numbers, dormant and still tested.
 */
export const DEFAULT_DROP_LADDER = false

/**
 * Each drop is measured from the PREVIOUS buy, not the first: *con respecto al
 * anterior — aplicá mi lógica, aunque ganemos menos.* The lines land at −10,
 * −23.5, −38.8, −54 and −68% of the first buy. See `drop-ladder.ts` for what
 * the replay priced it at. `OPERADOR_DCA_FROM=first` puts them back on the
 * first buy.
 */
export const DEFAULT_DCA_FROM = 'previous' as const

/**
 * Each position's drops are multiplied by its own `dcaScale`: the more the
 * token moved in the day before its first buy, the CLOSER its rungs. *Aplicá el
 * de en la línea, la propuesta.* OFF now, with the ladder it spaces — only the
 * deep rung buys after the entry — and `OPERADOR_DCA_ADAPTIVE=1` brings it
 * back. It was ON, and 0 was the way out.
 *
 * The same replay of the 336 real entries, every ladder chained from the
 * previous buy, the exit at +10%:
 *
 * | | Result | train / test | frozen | worst token | peak capital | per $100 |
 * |---|---|---|---|---|---|---|
 * | fixed 10/15/20/25/30 (what ran) | $312 | 110 / 214 | −$37 | −$23 | $1,550 | 20.1 |
 * | **closer rungs the more it moves** | **$394** | 178 / 230 | −$48 | −$30 | $1,405 | **28.0** |
 *
 * What it costs, stated: the frozen tail and the worst token both got a
 * little worse, −$37 to −$48 and −$23 to −$30 — the likely mechanism being a
 * volatile token that keeps falling, which now fills its rungs sooner. The
 * freeze exit and the blacklist on freeze are what bound that,
 * and both stay. See `domain/strategy/dca-scale.ts` for the rule and what was
 * tried and not taken.
 */
export const DEFAULT_DCA_ADAPTIVE = false

/**
 * The NEXT rung is spaced by the token's volatility over the LAST HOUR of
 * closed 5-minute bars, decided at the moment the sweep looks at it — not by
 * the scale measured once, the day before the first buy. *Que el próximo
 * escalón DCA lo calcule por la cantidad de volatilidad que tenga en ese
 * preciso momento la moneda — si es mucha, escalón bien largo; si es poca,
 * escalón corto.* Then *tiempo real.*
 *
 * The same replay of the 336 real entries, rungs of $15 to $35 from the
 * previous buy, the exit at +10%:
 *
 * | Spacing measured | Result | frozen | worst token | peak capital |
 * |---|---|---|---|---|
 * | once, at the buy (what ran) | $263 | −$52 | −$25 | $1,725 |
 * | **in real time, the last hour of 5m bars** | **$324** | **−$30** | **−$17.31** | $2,060 |
 *
 * OFF now, with the ladder it spaces; `OPERADOR_DCA_REALTIME=1` brings it back.
 * A switch INSIDE `DEFAULT_DCA_ADAPTIVE`, never beside it: with the adaptive
 * spacing off nothing is scaled at all, real time included. When
 * the hour cannot be measured the rung falls back to the at-buy scale, then to
 * one. See `realtimeDcaScale` in `domain/strategy/dca-scale.ts` for the whole
 * table and why the shorter window wins.
 */
export const DEFAULT_DCA_REALTIME = false

/**
 * How far, in percent, a pool may drain before the chained ladder brakes — and
 * off whose minimum a 5% bounce BUYS the next rung. See
 * `domain/strategy/liquidity-brake.ts`.
 *
 * ZERO — off — because the bounce is a buy, and only the deep rung may buy
 * after the entry. The operator's five is still the brake's own number
 * (`DEFAULT_LIQUIDITY_BRAKE_PCT`); `OPERADOR_LIQUIDITY_BRAKE_PCT=5` brings it
 * back. It rides on the drop ladder and asks nothing without it.
 */
export const DEFAULT_PRODUCTION_LIQUIDITY_BRAKE_PCT = 0

/**
 * The deep rung's three numbers. *Si el precio cae más de 80% y hay un rebote
 * de 10%, nueva compra DCA de $20.*
 *
 * - `FALL`: the lowest live price since the first buy must be MORE than this
 *   under it — exactly 80% does not arm it.
 * - `REBOUND`: the live price must then be at least this over that low.
 * - `USD`: what the rung buys, asked of the book's free capital when it fires.
 *
 * And the position must still be at a loss when it does. See
 * `domain/strategy/deep-rung.ts`.
 */
export const DEFAULT_DEEP_RUNG_FALL_PCT = DEFAULT_DEEP_RUNG_POLICY.fallPct
export const DEFAULT_DEEP_RUNG_REBOUND_PCT = DEFAULT_DEEP_RUNG_POLICY.reboundPct
export const DEFAULT_DEEP_RUNG_USD = 20

/**
 * How many entries' worth of capital a position is ALLOCATED when it opens.
 * ONE: the first buy. Each rung asks the book's free capital for its own
 * dollars at the moment it fires, and waits a sweep when there is none.
 *
 * Every position used to be allocated its WHOLE ladder up front. Live, with
 * one rung that almost never fired: **$2,887 committed against $1,395
 * deployed** — half the book reserved against rungs that were never bought.
 * With four entries a token the same capital would hold about half as many
 * tokens, and the replay that chose the ladder assumed the book it had: rungs
 * are rare, most positions never buy one, and the capital belongs to the next
 * token rather than to a dip that may never come.
 *
 * Ladder A made the argument stronger: its whole ladder was about $142 with
 * gas and headroom, against about $10.63 for the first buy — reserving it up
 * front would have held one token where thirteen fit. The deep rung almost
 * never fires by design, so it is stronger still: $15.89 reserved, not $37.
 *
 * The cost, stated: a rung can find the book fully deployed and be skipped.
 * That is the cheaper failure — a rung not bought is a basis not improved,
 * while capital parked against every possible rung is a token not bought at
 * all, on every position, every day.
 *
 * Now EVERY step: a slot reserves its whole ladder, exactly steps × step — $20.
 * With $1 steps a slot that reserved one buy would open over a thousand
 * positions, and the per-position candle requests would drown the providers.
 * The capital bounds the book instead: *el tope son 5000 dividido 50, que es lo
 * que tengo* — and at twenty steps, capital / $20. The fees are paid out of
 * the free capital as the fills happen (`fundStepFromFreeCapital`).
 */
export const DEFAULT_RESERVED_ENTRIES = DEFAULT_MAX_STEPS

/**
 * The drop from the 20-bar swing high the classic entry demands, in percent.
 *
 * ZERO in production, and it is the operator's decision taken against my
 * objection. The reference asks for 10%, which is what made the ladder's first
 * rung a good price: without it the entry lands as often near a high as near a
 * low, and the ladder works from a worse basis.
 *
 * What overrode that is a measurement. Twenty-two of forty positions had never
 * bought anything, some after three hours — a slot holding capital and waiting
 * is capital earning nothing, and **an average entry that happens beats a good
 * one that never does.** The exit only wants `avg_cost + 2%`, and the ladder
 * still averages down if the price falls.
 *
 * At zero the condition becomes `close <= swingHigh`, which is not a tautology:
 * it still refuses a bar making a NEW twenty-bar high. So the engine declines
 * to buy a vertical breakout and takes everything else, which is a reasonable
 * reading of "buy it wherever it is".
 *
 * `is_lateral` still gates it. That answers a different question — whether the
 * market is in a regime the ladder handles — and was not what the decision was
 * about.
 */
export const DEFAULT_DROP_INIT_PCT = 0

/**
 * Gains at which the exit stops waiting for the impulse to die.
 *
 * The reference waits `decayBarsRequired` (2) falling VWM bars always. Measured
 * on a live position: `priceless` ran to **+84% in half an hour**, the rule
 * waited its two bars, and it sold at +30%. Two thirds of the gain spent on
 * patience the size of the move did not justify.
 *
 * At 25%, the bar that would have sold it was the one showing **+46%**.
 *
 * TEN and TWENTY-FIVE, and the shape matters more than the numbers: patience
 * falls as the gain rises, because the more there is to lose by waiting, the
 * less waiting is worth. A small winner still gets the full two bars, which is
 * what stops the engine from selling every first red candle.
 */
export const DEFAULT_IMPATIENT_PROFIT_PCT = 10
export const DEFAULT_URGENT_PROFIT_PCT = 25

/**
 * The FIXED take-profit, in percent over the average cost: the stop sweep sells
 * the whole holding on the first live price at or over it, every thirty
 * seconds, with no wait for an impulse or a bar. *Poné un TP fijo al 12.5% del
 * promedio* — the big runs given up, knowingly. See
 * `domain/strategy/fixed-tp.ts`.
 *
 * Zero is a REAL value — the TP off, and the sweep back to what it did before
 * — so it reads through `nonNegative`, never `positive`; nonsense keeps 12.5.
 */
export const DEFAULT_FIXED_TP_PCT = 12.5

/**
 * The least the strategy's own exit may sell for, in percent over the average
 * cost. It is the FLOOR of the derived target — `minProfitPctFor` takes the
 * larger of this and what the pool's round trip demands — so the exit still
 * sells when the impulse dies, only never under it.
 *
 * TWELVE AND A HALF now, the fixed TP's own line and derived from it rather
 * than written twice: the bar-close exit may never sell a holding BELOW the
 * line the sweep sells it at. In practice the sweep, reading the live price
 * every thirty seconds, sells first. `OPERADOR_MIN_PROFIT_PCT` still moves it
 * on its own — `OPERADOR_FIXED_TP_PCT=0` does not.
 *
 * TEN, with the break-even switched off. It was twenty for an hour: *sacá el
 * break-even, pero poné un mínimo de ganancia del 20%* — the break-even armed
 * and sold on the same +7.5% line, and of 49 such sales on the first half day
 * of ladder A, 21 went on to +20%. Then the replay of the 336 real entries
 * under ladder A priced the floor, and the operator took the answer — *bajalas
 * a 10*:
 *
 * | Floor | Result | Halves | Frozen | Peak capital |
 * |---|---|---|---|---|
 * | 7.5% | $520 | 264 / 270 | −$8 | $1,850 |
 * | **10%** | **$538** | **251 / 302** | −$65 | $2,430 |
 * | 15% | $451 | 286 / 193 | −$237 | $2,840 |
 * | 20% | $451 | 362 / 104 | −$243 | $3,305 |
 *
 * Past ten, a position waits longer with up to $135 in it, and the freezes
 * eat what the runners make. The reference's 2 stays in `DEFAULT_PARAMS`,
 * which is evidence.
 */
export const DEFAULT_MIN_PROFIT_PCT = DEFAULT_FIXED_TP_PCT


export interface ProductionLadder {
  readonly maxUsdPerLevel: number
  /** The least the strategy exit sells for, in percent over the average cost. */
  readonly minProfitPct: number
  /** Where the sweep sells the whole holding, in percent over the average cost. Zero: off. */
  readonly fixedTpPct: number
  /** Entries the venue holds open at once: the entry plus its DCA rungs. */
  readonly maxOpenEntries: number
  /** Drop from the swing high the classic entry demands, in percent. */
  readonly dropInitPct: number
  /** Gain above which the exit waits one falling bar instead of the full count. */
  readonly impatientProfitPct: number
  /** Gain above which it waits none at all. */
  readonly urgentProfitPct: number
  /** How far under its anchor each rung buys, in percent, DCA-1 first. */
  readonly dcaDropsPct: readonly number[]
  /** What each rung buys, in dollars, DCA-1 first — one per drop. */
  readonly dcaRungsUsd: readonly number[]
  /** What each drop is measured from: the first buy, or the previous one. */
  readonly dcaFrom: 'first' | 'previous'
  /** Whether the chained drop ladder buys at all. See `DEFAULT_DROP_LADDER`. */
  readonly dropLadder: boolean
  /** Whether each position's drops follow its own volatility (`dcaScale`). */
  readonly dcaAdaptive: boolean
  /** Whether the next rung follows the token's LAST HOUR, inside `dcaAdaptive`. */
  readonly dcaRealtime: boolean
  /**
   * How far, in percent, a pool may have lost liquidity over the last five
   * minutes or the last hour before a rung at its line waits. Zero: off. See
   * `domain/strategy/liquidity-brake.ts`.
   */
  readonly liquidityBrakePct: number
  /**
   * Entries' worth of capital a position is allocated when it opens. Never
   * more than `maxOpenEntries`; the rest is asked of the free capital when a
   * rung fires.
   */
  readonly reservedEntries: number
  /** How far under the first buy, in percent, the low must go — strictly — to arm the deep rung. */
  readonly deepRungFallPct: number
  /** How far over that low, in percent, the live price must come back to buy it. */
  readonly deepRungReboundPct: number
  /** What the deep rung buys, in dollars. */
  readonly deepRungUsd: number
  /** Whether the deep rung buys at all. See `DEFAULT_DEEP_RUNG`. */
  readonly deepRung: boolean
  /** What every dip-bounce buy is, in dollars. */
  readonly stepUsd: number
  /** Buys per holding, the first included. */
  readonly maxSteps: number
  /** The dip, in percent under the reference, that arms the watch — the first buy's and DCA 1's. */
  readonly dipPct: number
  /** The bounce, in percent over the low, that buys — the first buy's and DCA 1's. */
  readonly bouncePct: number
  /** A fall of more than this, in percent under the reference, is a collapse: no step buys. Zero: off. The first buy's and DCA 1's. */
  readonly maxDipPct: number
  /** Points each later DCA adds to the dip and to the collapse ceiling. Zero: flat. */
  readonly dipStepPct: number
  /** Points each later DCA adds to the bounce. Zero: flat. */
  readonly bounceStepPct: number
  /**
   * What a slot is given, exactly: steps × step. No gas, no price headroom and
   * no floor raise it, and no haircut shrinks the count — *el tope son 5000
   * dividido 50*. The allocator hands it out and the trim keeps it.
   */
  readonly slotUsd: number
  /** Whether the cascade's own doors may buy. See `DEFAULT_CASCADE_ENTRIES`. */
  readonly cascadeEntries: boolean
}

/** Reads the overrides, falling back to the decisions above. */
export function productionLadder(env: Readonly<Record<string, string | undefined>>): ProductionLadder {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  /** Rungs: zero allowed, negatives and nonsense fall back. */
  const rungs = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback
  }

  // Zero is a REAL value here, not "unset", so this cannot use `positive`.
  // `maxPositions: 0` meaning one thing in one file and its opposite next door
  // cost this engine every position it could have opened.
  const percent = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isFinite(value) && value >= 0 && value < 100 ? value : fallback
  }

  /**
   * A comma list of drops, each strictly between 0 and 100 and strictly
   * rising. Anything else falls back WHOLE: a ladder is one decision, and
   * keeping the half of a mistyped list that parsed would run a ladder nobody
   * chose while everything kept working.
   */
  const drops = (raw: string | undefined, fallback: readonly number[]): readonly number[] => {
    if (!raw?.trim()) return fallback
    const values = raw.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part.trim())))
    const valid = values.every((value, i) =>
      Number.isFinite(value) && value > 0 && value < 100 && (i === 0 || value > values[i - 1]!))
    return valid ? values : fallback
  }

  /**
   * A comma list of rung sizes in dollars, each positive, and exactly as many
   * as there are drops. Anything else falls back WHOLE, for the drops' reason:
   * a ladder is one decision. The length is checked against the drops that
   * will actually run, because rung `n` buys the `n`-th size at the `n`-th
   * line — a size without a line, or a line without a size, is a rung nobody
   * priced.
   *
   * The fallback is the default list whatever the drops say, so a drop list
   * overridden to another length with no sizes beside it runs a ladder that
   * ends where the SHORTER list ends: the sweep never buys a rung it has no
   * size for.
   */
  const sizes = (raw: string | undefined, fallback: readonly number[], lines: number): readonly number[] => {
    if (!raw?.trim()) return fallback
    const values = raw.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part.trim())))
    const valid = values.length === lines && values.every((value) => Number.isFinite(value) && value > 0)
    return valid ? values : fallback
  }

  /** Zero or more, unbounded: a rebound off a low can be any size. */
  const nonNegative = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback
  }

  /**
   * A switch that is OFF unless 1, true or yes. The operator's decision is
   * off for these, so a typo keeps it off rather than quietly running the one
   * it replaced.
   */
  const onlyIf = (raw: string | undefined) => ['1', 'true', 'yes'].includes(raw?.trim().toLowerCase() ?? '')

  /** A whole number of entries, at least one. */
  const entries = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isInteger(value) && value >= 1 ? value : fallback
  }

  /** A percentage strictly between 0 and 100: a dip of nothing arms on every price. */
  const share = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isFinite(value) && value > 0 && value < 100 ? value : fallback
  }

  const stepUsd = positive(env.OPERADOR_STEP_USD, DEFAULT_STEP_USD)
  const maxSteps = entries(env.OPERADOR_MAX_STEPS, DEFAULT_MAX_STEPS)
  // The venue holds every step unless someone asked for another depth: the
  // steps are what the sweep buys, so they are what the broker must hold.
  const maxOpenEntries = env.OPERADOR_MAX_DCA?.trim() ? rungs(env.OPERADOR_MAX_DCA, maxSteps - 1) + 1 : maxSteps
  const dcaDropsPct = drops(env.OPERADOR_DCA_DROPS_PCT, DEFAULT_DCA_DROPS_PCT)

  return {
    // One step unless someone asks otherwise: the ladder the slot is priced
    // with is the ladder the sweep buys.
    maxUsdPerLevel: positive(env.OPERADOR_MAX_USD_PER_LEVEL, stepUsd),
    // ZERO is a real value: one entry and no ladder at all, which is the
    // operator's structural change. Read through `positive` it would fall back
    // to the default and silently run a five-rung ladder — his decision
    // discarded while everything kept working, which is the failure mode that
    // costs the most. `maxPositions: 0` and `dropInitPct` both taught this.
    maxOpenEntries,
    dropInitPct: percent(env.OPERADOR_DROP_INIT_PCT, DEFAULT_DROP_INIT_PCT),
    minProfitPct: positive(env.OPERADOR_MIN_PROFIT_PCT, DEFAULT_MIN_PROFIT_PCT),
    // *Poné un TP fijo al 12.5% del promedio.* Zero is a REAL value — the TP
    // off — so it reads through `nonNegative`, never `positive`; nonsense and
    // negatives keep the operator's 12.5. No ceiling: +150% is a target, if an
    // odd one.
    fixedTpPct: nonNegative(env.OPERADOR_FIXED_TP_PCT, DEFAULT_FIXED_TP_PCT),
    impatientProfitPct: positive(env.OPERADOR_IMPATIENT_PROFIT_PCT, DEFAULT_IMPATIENT_PROFIT_PCT),
    urgentProfitPct: positive(env.OPERADOR_URGENT_PROFIT_PCT, DEFAULT_URGENT_PROFIT_PCT),
    dcaDropsPct,
    dcaRungsUsd: sizes(env.OPERADOR_DCA_RUNGS_USD, DEFAULT_DCA_RUNGS_USD, dcaDropsPct.length),
    dcaFrom: env.OPERADOR_DCA_FROM?.trim().toLowerCase() === 'first' ? 'first' : DEFAULT_DCA_FROM,
    // OFF: only the deep rung buys after the entry. Only 1, true and yes turn
    // it on.
    dropLadder: onlyIf(env.OPERADOR_DROP_LADDER) || DEFAULT_DROP_LADDER,
    // OFF, the same way: a typo leaves the operator's decision running rather
    // than quietly running the one it replaced.
    dcaAdaptive: onlyIf(env.OPERADOR_DCA_ADAPTIVE) || DEFAULT_DCA_ADAPTIVE,
    // Read on its own, and the same way: the adaptive switch is what gates it,
    // in the sweep and on the screen.
    dcaRealtime: onlyIf(env.OPERADOR_DCA_REALTIME) || DEFAULT_DCA_REALTIME,
    // *Freno en tiempo real por cambio de liquidez inmediata que supere el
    // 5%.* OFF now, because its bounce buys a rung. Zero is a REAL value — the
    // switch off — so it reads through `percent`, never `positive`; anything
    // unreadable keeps it off rather than quietly running a brake that buys.
    liquidityBrakePct: percent(env.OPERADOR_LIQUIDITY_BRAKE_PCT, DEFAULT_PRODUCTION_LIQUIDITY_BRAKE_PCT),
    // The whole ladder, capped by what the venue holds: reserving capital for
    // an entry the broker will refuse is capital held against nothing.
    reservedEntries: Math.min(entries(env.OPERADOR_RESERVED_ENTRIES, maxOpenEntries), maxOpenEntries),
    // *Si el precio cae más de 80% y hay un rebote de 10%, nueva compra DCA de
    // $20.* Zero is a real value for both percentages; the fall stays under a
    // hundred, because no price can fall a hundred percent and still be a price.
    deepRungFallPct: percent(env.OPERADOR_DEEP_RUNG_FALL_PCT, DEFAULT_DEEP_RUNG_FALL_PCT),
    deepRungReboundPct: nonNegative(env.OPERADOR_DEEP_RUNG_REBOUND_PCT, DEFAULT_DEEP_RUNG_REBOUND_PCT),
    deepRungUsd: positive(env.OPERADOR_DEEP_RUNG_USD, DEFAULT_DEEP_RUNG_USD),
    // OFF: every buy is a dip-bounce step. Only 1, true and yes bring it back.
    deepRung: onlyIf(env.OPERADOR_DEEP_RUNG) || DEFAULT_DEEP_RUNG,
    stepUsd,
    maxSteps,
    dipPct: share(env.OPERADOR_DIP_PCT, DEFAULT_DIP_PCT),
    bouncePct: share(env.OPERADOR_BOUNCE_PCT, DEFAULT_BOUNCE_PCT),
    // Zero is a REAL value — the ceiling off — so it reads through `percent`,
    // never `positive`; nonsense keeps the operator's twenty.
    maxDipPct: percent(env.OPERADOR_MAX_DIP_PCT, DEFAULT_MAX_DIP_PCT),
    // *3% suma 2%, el 2% suma 2% por cada DCA* — *el rebote dejalo que aumente
    // de 1%.* Zero is a REAL value — the flat rule — so both read through
    // `percent`, never `positive`; nonsense keeps the operator's steps.
    dipStepPct: percent(env.OPERADOR_DIP_STEP_PCT, DEFAULT_DIP_STEP_PCT),
    bounceStepPct: percent(env.OPERADOR_BOUNCE_STEP_PCT, DEFAULT_BOUNCE_STEP_PCT),
    // Derived from the two variables, never written down on its own: a slot of
    // twenty steps of a dollar is twenty dollars, and nothing is grossed up.
    slotUsd: maxSteps * stepUsd,
    cascadeEntries: onlyIf(env.OPERADOR_CASCADE_ENTRIES) || DEFAULT_CASCADE_ENTRIES,
  }
}
