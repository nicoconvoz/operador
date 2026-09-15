import { sizeLadder, type SizingPolicy, DEFAULT_SIZING_POLICY, type LadderSizing } from '../domain/economics/sizing.js'
import { type MarketQuality } from '../domain/market/market-quality.js'
import { type Candles, replay, type ReplayResult } from './replay.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { usdForLevel } from '../domain/strategy/ladder.js'

/**
 * Paper-trades one token end to end: the executor's strategy over real
 * candles, through the honest broker, with the ladder sized to the pool.
 *
 * This is where the project's open question gets answered. Not "is the
 * strategy good" — parity already settled that it reproduces the backtest —
 * but "does it survive spread, impact and gas at THIS size, on THIS pool".
 */

export interface PaperRunConfig {
  readonly params: CascadeParams
  readonly sizing?: SizingPolicy
  readonly gasUsdPerSwap: number
  readonly initialCapital: number
  readonly maxOpenEntries: number
}

export interface PaperRunResult {
  readonly token: string
  readonly tradeable: boolean
  readonly reason: string | null
  readonly sizing: LadderSizing
  readonly replay: ReplayResult | null
  readonly broker: PaperBroker | null
  readonly summary: PaperSummary | null
}

export interface PaperSummary {
  readonly bars: number
  readonly cycles: number
  readonly closedTrades: number
  readonly wins: number
  readonly grossPnlUsd: number
  /** Spread + impact + gas charged over the whole run, open position included. */
  readonly costsUsd: number
  /** The share of those costs that belongs to CLOSED trades: gross − this = net. */
  readonly closedCostsUsd: number
  readonly netPnlUsd: number
  readonly endingCashUsd: number
  readonly openPositionUsd: number
  readonly equityUsd: number
  readonly returnPct: number
}

/**
 * Price headroom kept back when sizing against capital.
 *
 * The state machine sizes an order at the signal bar's CLOSE, and it fills at
 * the next bar's OPEN plus slippage. Sizing to the last cent therefore makes
 * every order a coin flip on affordability: a gap up of half a percent and the
 * broker rejects it for funds. A position that silently fails to open is the
 * worst failure mode there is — it looks exactly like a strategy with no
 * signals.
 */
const PRICE_HEADROOM_PCT = 5

/**
 * Capital the ladder may actually be sized against: the wallet, minus gas for
 * every swap the full cycle will need, minus headroom for the gap between
 * signal and fill.
 */
export function deployableCapital(config: {
  readonly initialCapital: number
  readonly gasUsdPerSwap: number
  readonly maxOpenEntries: number
  readonly params: { readonly maxLevels: number }
}): number {
  const swaps = Math.min(config.params.maxLevels + 1, config.maxOpenEntries) + 1 // entries + one exit
  const gasReserve = config.gasUsdPerSwap * swaps
  return Math.max(0, (config.initialCapital - gasReserve) * (1 - PRICE_HEADROOM_PCT / 100))
}

/**
 * The wallet a ladder needs — the exact inverse of `deployableCapital`.
 *
 * Allocation was asking the forward question and then handing out whatever the
 * portfolio had spare. Measured live: five positions holding $285 each while a
 * flat $15 ladder of six rungs can only ever deploy about $95. Nine hundred and
 * fifty dollars reserved against rungs that do not exist — capital the engine
 * counted as committed, so it could neither spend it nor open anything with it.
 *
 * Inverse, not an estimate: run `deployableCapital` on the answer and the
 * nominal ladder comes back exactly.
 */
export function ladderCapitalUsd(
  params: CascadeParams,
  maxOpenEntries: number,
  gasUsdPerSwap: number,
): number {
  const rungs = Math.min(params.maxLevels + 1, maxOpenEntries)
  const nominal = Array.from({ length: rungs }, (_, level) => usdForLevel(params, level)).reduce((a, b) => a + b, 0)
  const swaps = rungs + 1 // the entries, and the one sell that closes them all
  return nominal / (1 - PRICE_HEADROOM_PCT / 100) + gasUsdPerSwap * swaps
}

/**
 * Scales the strategy's nominal ladder down to what the pool can take.
 *
 * `usd(n)` is multiplied by the ratio the sizing allows for that level, so the
 * SHAPE of the ladder is preserved — growing size as price falls — while its
 * scale matches the venue. A level the pool cannot fund at all is clamped to
 * the last fundable size rather than dropped, because dropping a level would
 * change the state machine's own transitions and break parity with the
 * validated behaviour.
 */
export function scaledParams(params: CascadeParams, sizing: LadderSizing): CascadeParams {
  const first = sizing.levels[0]
  if (!first || first.nominalUsd <= 0) return params
  const scale = first.sizedUsd / first.nominalUsd
  const cappedNominal = sizing.levels.reduce((max, level) => Math.max(max, level.sizedUsd), 0)
  return {
    ...params,
    baseUsd: params.baseUsd * scale,
    maxUsdPerLevel: Math.min(params.maxUsdPerLevel * scale, Math.max(cappedNominal, usdForLevel(params, 0) * scale)),
  }
}

export function paperRun(
  snapshot: TokenSnapshot,
  quality: MarketQuality,
  candles: Candles,
  config: PaperRunConfig,
): PaperRunResult {
  const sizingPolicy = config.sizing ?? DEFAULT_SIZING_POLICY
  const sizing = sizeLadder(config.params, quality, sizingPolicy, deployableCapital(config))

  if (!sizing.tradeable) {
    return { token: snapshot.symbol, tradeable: false, reason: sizing.reason, sizing, replay: null, broker: null, summary: null }
  }

  const broker = new PaperBroker({
    gasUsdPerSwap: config.gasUsdPerSwap,
    initialCapital: config.initialCapital,
    maxOpenEntries: config.maxOpenEntries,
    quality: () => quality,
  })

  const result = replay(candles, scaledParams(config.params, sizing), broker)

  const closed = broker.closedTrades
  // Mid-to-mid: what the price move was worth before the chain took its cut.
  const grossPnlUsd = broker.realisedGrossUsd
  const costs = broker.totalCosts
  const costsUsd = costs.spreadUsd + costs.impactUsd + costs.gasUsd
  const lastClose = candles.close.at(-1) ?? 0
  const openPositionUsd = broker.openTrades.reduce((sum, t) => sum + t.qty * lastClose, 0)
  const equityUsd = broker.equityCash + openPositionUsd

  // Costs on trades still open are real money already spent, but they have no
  // realised P&L to net against — keeping the two apart is what makes the
  // accounting identity below exact instead of approximately right.
  const closedCostsUsd = closed.reduce((sum, t) => sum + t.entryCommission + t.exitCommission, 0)

  const summary: PaperSummary = {
    bars: candles.time.length,
    cycles: result.orders.filter((os) => os.some((o) => o.kind === 'closeAll')).length,
    closedTrades: closed.length,
    wins: closed.filter((t) => t.profit > 0).length,
    grossPnlUsd,
    costsUsd,
    closedCostsUsd,
    netPnlUsd: closed.reduce((sum, t) => sum + t.profit, 0),
    endingCashUsd: broker.equityCash,
    openPositionUsd,
    equityUsd,
    returnPct: ((equityUsd - config.initialCapital) / config.initialCapital) * 100,
  }

  return { token: snapshot.symbol, tradeable: true, reason: null, sizing, replay: result, broker, summary }
}

/**
 * The least capital a slot can place any order with.
 *
 * NOT the nominal ladder — that is `ladderCapitalUsd`, and demanding it would
 * be far too strict, because `scaledParams` shrinks the ladder to whatever the
 * wallet and the pool allow. A slot with less does not fail; it trades smaller
 * rungs.
 *
 * What it cannot do is trade rungs below the GAS FLOOR, where the chain's fixed
 * cost eats the fill. So the floor is the same ladder priced at that floor:
 * every rung at `minFillUsd`, grossed up for price headroom, plus gas for a
 * full cycle of swaps.
 *
 * It replaces `minPositionUsd: 200`, which was a real measurement — the first
 * capital-floor run placed no orders below it — taken BEFORE sizing began
 * reserving gas and headroom. That change dropped the floor to under $50 and
 * the number never moved, so it kept capping the book at four slots however
 * much capital was free. A floor that is derived cannot go stale that way.
 */
export function slotFloorUsd(
  params: CascadeParams,
  maxOpenEntries: number,
  gasUsdPerSwap: number,
  minFillUsd: number,
): number {
  return ladderCapitalUsd({ ...params, maxUsdPerLevel: minFillUsd, baseUsd: minFillUsd, amountIncrement: 0 }, maxOpenEntries, gasUsdPerSwap)
}
