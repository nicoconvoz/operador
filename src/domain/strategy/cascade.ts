import { triggerPrice, usdForLevel } from './ladder.js'
import { type CascadeParams } from './params.js'
import {
  type Bar,
  type BarContext,
  type CascadeState,
  type Order,
  type PositionSnapshot,
  type StepResult,
} from './state.js'

/**
 * One closed bar through the CASCADE DCA state machine.
 *
 * This is a transcription of DCA.pine's per-bar logic, in the SAME ORDER the
 * script evaluates it. In a state machine the order is the semantics: the
 * cycle-low tracking runs before arming, arming before the locks, entries
 * before the post-fill reset, and every entry before the exits. Reordering any
 * of these changes which bar a fill lands on, and parity dies quietly.
 *
 * Pure: returns a new state and the orders to submit. It never reads a series
 * and never touches the broker — `position` is what the broker last reported.
 */
export function stepCascade(
  state: CascadeState,
  params: CascadeParams,
  bar: Bar,
  ctx: BarContext,
  position: PositionSnapshot,
): StepResult {
  const orders: Order[] = []
  const s: { -readonly [K in keyof CascadeState]: CascadeState[K] } = { ...state }
  const inPosition = position.size > 0

  // ── VWM decay counter (computed at the top of DCA.pine, before the machine)
  // Pine: `decay_count := vwm < vwm[1] ? decay_count + 1 : 0`. A comparison
  // against na is false, so any na resets the count.
  const vwmFalling = ctx.vwm !== null && ctx.vwmPrev !== null && ctx.vwm < ctx.vwmPrev
  s.decayCount = vwmFalling ? s.decayCount + 1 : 0
  const impulseDead =
    s.decayCount >= params.decayBarsRequired &&
    ctx.vwmLagged !== null &&
    ctx.vwmLagged > params.impulseThreshold

  // ── Detect a real close and reset the cycle exactly once
  if (inPosition) s.wasInTrade = true
  if (!inPosition && s.wasInTrade) {
    s.wasInTrade = false
    s.level = 0
    s.ep1 = null
    s.totalInvested = 0
    s.cycleLow = null
    s.lastFill = null
    s.dcaArmed = false
    s.breakevenArmed = false
    s.barsSinceLow = 0
    s.awaitReentry = true // just sold: open the trend re-entry door
  }

  // ── Track the bottom of the cycle and how long it has held
  if (inPosition) {
    const madeNewLow = s.cycleLow === null || bar.low < s.cycleLow
    s.cycleLow = s.cycleLow === null ? bar.low : Math.min(s.cycleLow, bar.low)
    s.barsSinceLow = madeNewLow ? 0 : s.barsSinceLow + 1
  }

  // ── Lock 1 (trigger) and lock 2 (min gap) → arm the pending level
  const currentTrigger =
    s.ep1 !== null && s.level >= 1 && s.level <= params.maxLevels
      ? triggerPrice(params, s.ep1, s.level)
      : null
  const triggerOk = s.cycleLow !== null && currentTrigger !== null && s.cycleLow <= currentTrigger
  const gapOk =
    s.lastFill === null ||
    (s.cycleLow !== null && s.cycleLow <= s.lastFill * (1 - params.minGapPct / 100))
  if (inPosition && params.useRebound && !s.dcaArmed && triggerOk && gapOk) s.dcaArmed = true

  // ── Locks 3, 4, 5 → the rebound is confirmed
  const holdOk = s.barsSinceLow >= params.confirmBars
  const reboundOk =
    s.cycleLow !== null && bar.close >= s.cycleLow * (1 + params.reboundPct / 100)
  const greenOk = !params.requireGreen || bar.close > bar.open
  const reboundFire = s.dcaArmed && holdOk && reboundOk && greenOk

  const levelBefore = s.level
  let boughtThisBar = false

  const openPosition = (comment: string): void => {
    const usd = usdForLevel(params, 0)
    orders.push({ kind: 'entry', id: 'Entry', level: 0, usd, qty: usd / bar.close, comment })
    boughtThisBar = true
    s.level = 1
    s.ep1 = bar.close
    s.totalInvested = usd
    s.lastFill = bar.close
    s.cycleLow = null
    s.dcaArmed = false
    s.barsSinceLow = 0
    s.awaitReentry = false
  }

  // ── Door 1: classic entry — drop from swing high inside a lateral zone
  if (
    s.level === 0 &&
    ctx.swingHigh !== null &&
    bar.close <= ctx.swingHigh * (1 - params.dropInitPct / 100) &&
    ctx.isLateral &&
    bar.close > 0 &&
    !boughtThisBar
  ) {
    openPosition('🟢 Entry')
  }

  // ── Door 2: trend re-entry — armed by a sell, fires once
  if (
    params.useTrendReentry &&
    s.level === 0 &&
    s.awaitReentry &&
    ctx.trendBullish &&
    bar.close > 0 &&
    !boughtThisBar
  ) {
    openPosition('🚀 Re-Entry')
  }

  // ── DCA level n = current level. The reference has one block per level
  // guarded by `bought_this_bar`; since each block advances `level`, at most
  // the block matching the incoming level can ever fire. One check suffices.
  const n = s.level
  const trigger = s.ep1 !== null && n >= 1 && n <= params.maxLevels ? triggerPrice(params, s.ep1, n) : null
  if (
    trigger !== null &&
    (params.useRebound ? reboundFire : bar.close <= trigger) &&
    ctx.isLateral &&
    !boughtThisBar
  ) {
    const usd = usdForLevel(params, n)
    orders.push({ kind: 'entry', id: `DCA-${n}`, level: n, usd, qty: usd / bar.close, comment: `DCA-${n}` })
    boughtThisBar = true
    s.level = n + 1
    s.totalInvested += usd
  }

  // ── Post-fill: a DCA landed this bar → a NEW bottom is required to arm again
  if (s.level > levelBefore && levelBefore >= 1) {
    s.lastFill = bar.close
    s.dcaArmed = false
    s.cycleLow = null
    s.barsSinceLow = 0
  }

  // ── Exits read the BROKER's average cost and open P&L, as the reference does
  const avgCost = position.avgPrice
  const inProfit =
    inPosition && avgCost !== null && bar.close > avgCost * (1 + params.minProfitPct / 100)
  const exitSignal = inProfit && (impulseDead || (params.useSupertrendExit && ctx.stBearFlip))

  const filledDcas = s.level > 0 ? s.level - 1 : 0
  const rescueMode = inPosition && filledDcas >= params.rescueLevels
  if (rescueMode && avgCost !== null && bar.close >= avgCost * (1 + params.breakevenArmPct / 100)) {
    s.breakevenArmed = true
  }
  const breakevenExit = inPosition && s.breakevenArmed && position.openProfit <= 0

  if (exitSignal) orders.push({ kind: 'closeAll', comment: '🏁 Exit' })
  else if (breakevenExit) orders.push({ kind: 'closeAll', comment: '⚖️ BE Exit' })

  return { state: s, orders }
}
