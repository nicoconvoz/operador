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
 */
export const DEFAULT_MAX_DCA_PER_TOKEN = 2

export interface ProductionLadder {
  readonly maxUsdPerLevel: number
  /** Entries the venue holds open at once: the entry plus its DCA rungs. */
  readonly maxOpenEntries: number
}

/** Reads the overrides, falling back to the decisions above. */
export function productionLadder(env: Readonly<Record<string, string | undefined>>): ProductionLadder {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw?.trim())
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  return {
    maxUsdPerLevel: positive(env.OPERADOR_MAX_USD_PER_LEVEL, DEFAULT_MAX_USD_PER_LEVEL),
    maxOpenEntries: positive(env.OPERADOR_MAX_DCA, DEFAULT_MAX_DCA_PER_TOKEN) + 1,
  }
}
