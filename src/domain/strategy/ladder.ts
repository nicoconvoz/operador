import { type CascadeParams } from './params.js'

/**
 * The DCA ladder arithmetic from DCA.pine, kept as pure functions so the
 * state machine reads like the reference and the numbers can be tested in
 * isolation.
 *
 * Level numbering follows Pine: level 0 is the initial ("scouting") entry,
 * levels 1..maxLevels are the DCA buys.
 */

/**
 * Percent drop from `ep1` that arms DCA level `n` (n ≥ 1):
 *
 *   Linear:    drop(n) = dcaBasePct + (n - 1) * linearIncrementPct
 *   Geometric: drop(n) = dcaBasePct * geometricMultiplier ^ (n - 1)
 */
export function dropPct(params: CascadeParams, level: number): number {
  return params.progression === 'linear'
    ? params.dcaBasePct + (level - 1) * params.linearIncrementPct
    : params.dcaBasePct * Math.pow(params.geometricMultiplier, level - 1)
}

/** Price at which DCA level `n` arms: `ep1 * (1 - drop(n) / 100)`. */
export function triggerPrice(params: CascadeParams, ep1: number, level: number): number {
  return ep1 * (1 - dropPct(params, level) / 100)
}

/**
 * USD deployed at level `n` (n ≥ 0), with the safety cap:
 *
 *   usd(n) = min(baseUsd * (1 + amountIncrement * n), maxUsdPerLevel)
 */
export function usdForLevel(params: CascadeParams, level: number): number {
  return Math.min(params.baseUsd * (1 + params.amountIncrement * level), params.maxUsdPerLevel)
}

/** Total USD the full ladder would deploy: levels 0 through maxLevels. */
export function ladderCapital(params: CascadeParams): number {
  let total = 0
  for (let level = 0; level <= params.maxLevels; level++) total += usdForLevel(params, level)
  return total
}
