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

/**
 * USD cap per level of the reference ladder — which in production is the FIRST
 * buy alone, because the cascade's own rungs are switched off and the sweep
 * buys each DCA rung at its own size (`DEFAULT_DCA_RUNGS_USD`).
 *
 * TEN, with ladder A: *arriesguémonos, activá la A.* A smaller first buy and
 * bigger rungs under it, so the money goes in where the price is lower. See
 * `DEFAULT_MAX_DCA_PER_TOKEN` for the replay that chose it.
 *
 * It was fifteen, flat: `min(1000 × (1 + 1.2n), 15)` is 15 everywhere, and the
 * rungs bought the same fifteen.
 */
export const DEFAULT_MAX_USD_PER_LEVEL = 10

/**
 * DCA rungs production will fill, per token. The entry is not one of them, so
 * five means six open entries.
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
 */
export const DEFAULT_MAX_DCA_PER_TOKEN = 5

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
 * Each drop is measured from the PREVIOUS buy, not the first: *con respecto al
 * anterior — aplicá mi lógica, aunque ganemos menos.* The lines land at −10,
 * −23.5, −38.8, −54 and −68% of the first buy. See `drop-ladder.ts` for what
 * the replay priced it at. `OPERADOR_DCA_FROM=first` puts them back on the
 * first buy.
 */
export const DEFAULT_DCA_FROM = 'previous' as const

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
 * Ladder A makes the argument stronger: its whole ladder is about $142 with
 * gas and headroom, against about $10.63 for the first buy — reserving it up
 * front would hold one token where thirteen fit.
 *
 * The cost, stated: a rung can find the book fully deployed and be skipped.
 * That is the cheaper failure — a rung not bought is a basis not improved,
 * while capital parked against every possible rung is a token not bought at
 * all, on every position, every day.
 */
export const DEFAULT_RESERVED_ENTRIES = 1

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
 * The least the strategy's own exit may sell for, in percent over the average
 * cost. It is the FLOOR of the derived target — `minProfitPctFor` takes the
 * larger of this and what the pool's round trip demands — so the exit still
 * sells when the impulse dies, only never under it.
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
export const DEFAULT_MIN_PROFIT_PCT = 10


export interface ProductionLadder {
  readonly maxUsdPerLevel: number
  /** The least the strategy exit sells for, in percent over the average cost. */
  readonly minProfitPct: number
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
  /**
   * Entries' worth of capital a position is allocated when it opens. Never
   * more than `maxOpenEntries`; the rest is asked of the free capital when a
   * rung fires.
   */
  readonly reservedEntries: number
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

  /** A whole number of entries, at least one. */
  const entries = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return raw?.trim() && Number.isInteger(value) && value >= 1 ? value : fallback
  }

  const maxOpenEntries = rungs(env.OPERADOR_MAX_DCA, DEFAULT_MAX_DCA_PER_TOKEN) + 1
  const dcaDropsPct = drops(env.OPERADOR_DCA_DROPS_PCT, DEFAULT_DCA_DROPS_PCT)

  return {
    maxUsdPerLevel: positive(env.OPERADOR_MAX_USD_PER_LEVEL, DEFAULT_MAX_USD_PER_LEVEL),
    // ZERO is a real value: one entry and no ladder at all, which is the
    // operator's structural change. Read through `positive` it would fall back
    // to the default and silently run a five-rung ladder — his decision
    // discarded while everything kept working, which is the failure mode that
    // costs the most. `maxPositions: 0` and `dropInitPct` both taught this.
    maxOpenEntries,
    dropInitPct: percent(env.OPERADOR_DROP_INIT_PCT, DEFAULT_DROP_INIT_PCT),
    minProfitPct: positive(env.OPERADOR_MIN_PROFIT_PCT, DEFAULT_MIN_PROFIT_PCT),
    impatientProfitPct: positive(env.OPERADOR_IMPATIENT_PROFIT_PCT, DEFAULT_IMPATIENT_PROFIT_PCT),
    urgentProfitPct: positive(env.OPERADOR_URGENT_PROFIT_PCT, DEFAULT_URGENT_PROFIT_PCT),
    dcaDropsPct,
    dcaRungsUsd: sizes(env.OPERADOR_DCA_RUNGS_USD, DEFAULT_DCA_RUNGS_USD, dcaDropsPct.length),
    dcaFrom: env.OPERADOR_DCA_FROM?.trim().toLowerCase() === 'first' ? 'first' : DEFAULT_DCA_FROM,
    // Capped by what the venue holds: reserving capital for an entry the
    // broker will refuse is capital held against nothing.
    reservedEntries: Math.min(entries(env.OPERADOR_RESERVED_ENTRIES, DEFAULT_RESERVED_ENTRIES), maxOpenEntries),
  }
}
