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

/** USD cap per rung. Flat at this size: `min(1000 × (1 + 1.2n), 15)` is 15 everywhere. */
export const DEFAULT_MAX_USD_PER_LEVEL = 15

/**
 * DCA rungs production will fill, per token. The entry is not one of them, so
 * two means three open entries.
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
 */
export const DEFAULT_MAX_DCA_PER_TOKEN = 5

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


export interface ProductionLadder {
  readonly maxUsdPerLevel: number
  /** Entries the venue holds open at once: the entry plus its DCA rungs. */
  readonly maxOpenEntries: number
  /** Drop from the swing high the classic entry demands, in percent. */
  readonly dropInitPct: number
  /** Gain above which the exit waits one falling bar instead of the full count. */
  readonly impatientProfitPct: number
  /** Gain above which it waits none at all. */
  readonly urgentProfitPct: number
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

  return {
    maxUsdPerLevel: positive(env.OPERADOR_MAX_USD_PER_LEVEL, DEFAULT_MAX_USD_PER_LEVEL),
    // ZERO is a real value: one entry and no ladder at all, which is the
    // operator's structural change. Read through `positive` it would fall back
    // to the default and silently run a three-rung ladder — his decision
    // discarded while everything kept working, which is the failure mode that
    // costs the most. `maxPositions: 0` and `dropInitPct` both taught this.
    maxOpenEntries: rungs(env.OPERADOR_MAX_DCA, DEFAULT_MAX_DCA_PER_TOKEN) + 1,
    dropInitPct: percent(env.OPERADOR_DROP_INIT_PCT, DEFAULT_DROP_INIT_PCT),
    impatientProfitPct: positive(env.OPERADOR_IMPATIENT_PROFIT_PCT, DEFAULT_IMPATIENT_PROFIT_PCT),
    urgentProfitPct: positive(env.OPERADOR_URGENT_PROFIT_PCT, DEFAULT_URGENT_PROFIT_PCT),
  }
}
