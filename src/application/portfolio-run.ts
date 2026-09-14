import { planPortfolio, type PortfolioPlan, type PortfolioPolicy, type AllocationCandidate } from '../domain/risk/portfolio.js'
import { type SizingPolicy } from '../domain/economics/sizing.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { paperRun, type PaperRunResult } from './paper-run.js'
import { type Candles } from './replay.js'

/**
 * Paper-trades a whole portfolio: the plan decides who gets capital, then each
 * position runs its own state machine over its own candles.
 *
 * Positions are INDEPENDENT by construction — one token dying cannot touch
 * another's state, cash or ladder. That isolation is not an optimisation; it
 * is the reason a portfolio of small caps is survivable at all.
 */

export interface PortfolioRunConfig {
  readonly params: CascadeParams
  readonly portfolio: PortfolioPolicy
  readonly sizing?: SizingPolicy
  readonly gasUsdPerSwap: number
  readonly maxOpenEntriesPerPosition: number
}

export interface PositionResult extends PaperRunResult {
  readonly capitalUsd: number
  readonly score: number
}

export interface PortfolioSummary {
  readonly positions: number
  readonly capitalUsd: number
  readonly deployedUsd: number
  readonly idleUsd: number
  readonly reserveUsd: number
  readonly grossPnlUsd: number
  readonly costsUsd: number
  readonly netPnlUsd: number
  readonly openPositionUsd: number
  readonly equityUsd: number
  /** Return on the WHOLE wallet, reserve and idle capital included. */
  readonly returnPct: number
  readonly winners: number
  readonly losers: number
  /** Net P&L of the best and worst position — how much breadth actually mattered. */
  readonly bestUsd: number
  readonly worstUsd: number
}

export interface PortfolioRunResult {
  readonly plan: PortfolioPlan
  readonly positions: readonly PositionResult[]
  readonly summary: PortfolioSummary
}

export type CandleLookup = (candidate: AllocationCandidate) => Candles | null

export function portfolioRun(
  candidates: readonly AllocationCandidate[],
  candlesFor: CandleLookup,
  config: PortfolioRunConfig,
): PortfolioRunResult {
  const plan = planPortfolio(candidates, config.params, config.portfolio, config.sizing)

  const positions: PositionResult[] = []
  for (const allocation of plan.allocations) {
    const candles = candlesFor(allocation)
    if (!candles || candles.time.length === 0) continue

    const run = paperRun(allocation.snapshot, allocation.quality, candles, {
      params: config.params,
      ...(config.sizing ? { sizing: config.sizing } : {}),
      gasUsdPerSwap: config.gasUsdPerSwap,
      initialCapital: allocation.capitalUsd,
      maxOpenEntries: config.maxOpenEntriesPerPosition,
    })
    positions.push({ ...run, capitalUsd: allocation.capitalUsd, score: allocation.score })
  }

  const traded = positions.filter((p) => p.summary !== null)
  const sum = (pick: (p: PositionResult) => number) => traded.reduce((total, p) => total + pick(p), 0)

  const nets = traded.map((p) => p.summary!.netPnlUsd)
  const netPnlUsd = sum((p) => p.summary!.netPnlUsd)
  const openPositionUsd = sum((p) => p.summary!.openPositionUsd)
  // Capital allocated to a position that never traded is still the wallet's.
  const untradedCapital = positions.filter((p) => p.summary === null).reduce((t, p) => t + p.capitalUsd, 0)
  const equityUsd = sum((p) => p.summary!.equityUsd) + untradedCapital + plan.idleUsd + plan.reserveUsd

  const summary: PortfolioSummary = {
    positions: traded.length,
    capitalUsd: config.portfolio.totalCapitalUsd,
    deployedUsd: plan.allocatedUsd,
    idleUsd: plan.idleUsd,
    reserveUsd: plan.reserveUsd,
    grossPnlUsd: sum((p) => p.summary!.grossPnlUsd),
    costsUsd: sum((p) => p.summary!.closedCostsUsd),
    netPnlUsd,
    openPositionUsd,
    equityUsd,
    returnPct: ((equityUsd - config.portfolio.totalCapitalUsd) / config.portfolio.totalCapitalUsd) * 100,
    winners: nets.filter((n) => n > 0).length,
    losers: nets.filter((n) => n < 0).length,
    bestUsd: nets.length > 0 ? Math.max(...nets) : 0,
    worstUsd: nets.length > 0 ? Math.min(...nets) : 0,
  }

  return { plan, positions, summary }
}
