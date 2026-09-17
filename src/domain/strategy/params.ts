/**
 * CASCADE DCA parameters — a one-to-one mirror of the `input.*` block in
 * DCA.pine. Names are the Pine identifiers in camelCase so a diff against the
 * reference stays mechanical. Defaults are the Pine defaults.
 *
 * The user's production configuration IS these defaults — including
 * `maxLevels = 50` alongside `pyramiding = 10` in the `strategy()` header.
 * The two interact: the state machine keeps SIGNALLING DCA levels past the
 * tenth (advancing `level`, resetting the cycle, summing `totalInvested`),
 * while TradingView's broker REJECTS every entry after the tenth open one
 * (Entry + DCA-1..DCA-9). That rejection is an execution constraint, so it
 * lives in the broker simulator and the live risk layer as `PYRAMIDING`,
 * not here. The machine mirrors the script; the broker mirrors the venue.
 */

/** `pyramiding = 10` from the strategy() header — max open entries per position. */
export const PYRAMIDING = 10

export type Progression = 'linear' | 'geometric'

export interface CascadeParams {
  // 💰 DCA Amounts
  readonly baseUsd: number
  readonly amountIncrement: number
  readonly maxUsdPerLevel: number

  // 📉 DCA Drop Progression
  readonly dropInitPct: number
  readonly maxLevels: number
  readonly dcaBasePct: number
  readonly progression: Progression
  readonly linearIncrementPct: number
  readonly geometricMultiplier: number

  // 🎯 Rebound Confirmation
  readonly useRebound: boolean
  readonly reboundPct: number
  readonly requireGreen: boolean
  readonly minGapPct: number
  readonly confirmBars: number

  // ⚖️ Rescue Mode
  readonly rescueLevels: number
  readonly breakevenArmPct: number

  // 🚀 Trend Re-Entry
  readonly useTrendReentry: boolean
  readonly trendAdxMin: number
  readonly trendEmaLength: number
  readonly trendSlopeBars: number

  // 🔲 Lateral Zone
  readonly swingLookback: number
  readonly bbLength: number
  readonly bbStdev: number
  readonly bbwMax: number
  readonly adxLength: number
  readonly adxMax: number
  readonly requireBoth: boolean

  // 🚀 Exit — VWM
  readonly minProfitPct: number
  readonly rocLength: number
  readonly rocSmooth: number
  readonly volumeLength: number
  readonly decayBarsRequired: number
  /**
   * Gain above which the exit waits ONE bar less for the impulse to die, and
   * gain above which it waits none at all. Null on both is the reference.
   *
   * The exit rule is "it stalled at the top, take the money", and stalling is
   * measured as `decayBarsRequired` consecutive falling VWM bars. On an ordinary
   * winner that patience is right: it lets the move finish instead of selling
   * the first red candle.
   *
   * On a violent one it is expensive. Measured on a live position: `priceless`
   * ran to **+84% in half an hour**, the rule waited its two falling bars, and
   * it sold at +30%. Two thirds of the gain spent on patience the size of the
   * move did not justify.
   *
   * So patience falls as the gain rises — the operator's rule, and the right
   * shape: the more there is to lose by waiting, the less it waits. Monotone by
   * construction, so a bigger gain can only ever SHORTEN the wait.
   *
   * Null by default because `DEFAULT_PARAMS` is what TradingView ran and the
   * parity harness asserts it. Impatience is composed in production, like the
   * ladder cap and the entry drop.
   */
  readonly impatientProfitPct: number | null
  readonly urgentProfitPct: number | null
  readonly useSupertrendExit: boolean
  readonly supertrendAtrLength: number
  readonly supertrendFactor: number

  /**
   * The hardcoded `0.3` in `impulse_dead = decay_count >= decay_req and
   * vwm[decay_req] > 0.3`. Not an input in the reference; named here so it is
   * configurable and, above all, visible.
   */
  readonly impulseThreshold: number
}

/** The reference input allows 1..50. */
export const MAX_SUPPORTED_LEVELS = 50

export const DEFAULT_PARAMS: CascadeParams = {
  baseUsd: 1000,
  amountIncrement: 1.2,
  maxUsdPerLevel: 5000,

  dropInitPct: 10,
  maxLevels: MAX_SUPPORTED_LEVELS,
  dcaBasePct: 1.0,
  progression: 'linear',
  linearIncrementPct: 3,
  geometricMultiplier: 10,

  useRebound: true,
  reboundPct: 2.5,
  requireGreen: true,
  minGapPct: 5,
  confirmBars: 20,

  rescueLevels: 10,
  breakevenArmPct: 1,

  useTrendReentry: true,
  trendAdxMin: 30,
  trendEmaLength: 200,
  trendSlopeBars: 1,

  swingLookback: 20,
  bbLength: 50,
  bbStdev: 1.0,
  bbwMax: 14,
  adxLength: 15,
  adxMax: 40,
  requireBoth: false,

  minProfitPct: 2,
  rocLength: 10,
  rocSmooth: 5,
  volumeLength: 10,
  decayBarsRequired: 2,
  impatientProfitPct: null,
  urgentProfitPct: null,
  useSupertrendExit: true,
  supertrendAtrLength: 10,
  supertrendFactor: 3.0,

  impulseThreshold: 0.3,
}

export class ParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParamsError'
  }
}

export function assertParams(params: CascadeParams): void {
  if (!Number.isInteger(params.maxLevels) || params.maxLevels < 1 || params.maxLevels > MAX_SUPPORTED_LEVELS) {
    throw new ParamsError(`maxLevels must be an integer in 1..${MAX_SUPPORTED_LEVELS}, received ${params.maxLevels}`)
  }
  if (params.baseUsd <= 0) throw new ParamsError('baseUsd must be positive')
  if (params.maxUsdPerLevel <= 0) throw new ParamsError('maxUsdPerLevel must be positive')
  if (params.progression === 'geometric' && params.geometricMultiplier <= 1) {
    throw new ParamsError('geometricMultiplier must exceed 1')
  }
}
