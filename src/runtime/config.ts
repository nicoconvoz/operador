import { type Chain } from '../domain/scanner/snapshot.js'
import { productionLadder, DEFAULT_MAX_DCA_PER_TOKEN, DEFAULT_MAX_USD_PER_LEVEL } from '../application/production-ladder.js'
import { FIFTEEN_MINUTES, ONE_HOUR, type BarSize } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'

/**
 * Runtime configuration, read from the environment.
 *
 * Validated eagerly and loudly at boot. A system that holds money must never
 * discover a missing wallet key three hours in, halfway through a ladder —
 * failing to start is a good outcome; starting wrong is not.
 */

export interface RuntimeConfig {
  readonly mode: 'paper' | 'live'
  /**
   * Every chain the scanner covers, in order. A LIST and not one value,
   * because the universe spans chains: running one at a time meant the screen
   * showed whichever scanned last and the other looked like it had stopped
   * existing.
   */
  readonly chains: readonly Chain[]

  readonly databaseUrl: string

  readonly totalCapitalUsd: number
  readonly maxPositions: number
  readonly gasUsdPerSwap: number

  /**
   * How long between PASSES.
   *
   * Most passes are watch passes: recover, advance every open position,
   * checkpoint. On 15-minute bars this is what decides how quickly a closed bar
   * gets acted on — five minutes means a bar is processed within five, instead
   * of waiting out a scan.
   */
  readonly cycleIntervalMs: number
  /**
   * How often a pass ALSO goes looking for new tokens.
   *
   * Separate from the pass interval because the two halves cost wildly
   * different amounts: a scan is hundreds of throttled calls and about half an
   * hour, while advancing five open positions is one candle request and one
   * sell probe each. Sharing a clock meant a held token got attention every
   * ~35 minutes on 15-minute bars.
   *
   * ONE HOUR, the user's decision: scan only when there is no scan from the
   * last hour, and spend the rest of the engine's life on the positions that
   * already have money in them.
   *
   * A token you HOLD can rug in ten minutes; a new opportunity missed by an
   * hour is a missed opportunity and nothing worse.
   */
  readonly scanIntervalMs: number
  /** How often the death watch re-probes the sell path of open positions. */
  readonly healthIntervalMs: number
  /**
   * Stop after this many cycles. 0 means never — the daemon.
   *
   * 1 turns the engine into a ONE-SHOT: do a cycle, write everything down,
   * exit. That is what lets a scheduler run it instead of a server, and it is
   * only honest because every adapter is HTTP polling and every piece of state
   * is in Postgres. Nothing is held in memory between cycles, so there is
   * nothing for a long-lived process to hold.
   */
  readonly maxCycles: number
  /**
   * Tokens per chain given the expensive treatment each cycle.
   *
   * Each one costs about nine throttled seconds on Solana and six on BSC, and
   * a cycle has to finish well inside one 15-minute bar. 20 keeps two chains
   * around five minutes. The rest are reported as unchecked, not dropped.
   */
  readonly maxSecurityChecks: number | null
  /**
   * Sell a position the moment its ladder freezes, instead of holding it.
   *
   * The operator's decision, and it is a real departure from the reference: a
   * freeze fires on ONE reading, so this liquidates where the two-stage design
   * would have paused and asked for confirmation. What it buys is the failure
   * that actually happened — six positions frozen with their capital
   * unreachable, unable to buy because frozen and unable to sell because the
   * strategy's own exit wants a profit it will never reach.
   *
   * The token is NOT blacklisted: only a death verdict does that. It goes back
   * to being merely filtered and may be bought again the day it recovers.
   */
  readonly exitOnFreeze: boolean
  /**
   * USD cap per ladder level, in production.
   *
   * NOT `DEFAULT_PARAMS.maxUsdPerLevel`, which is 5,000 because that is what
   * TradingView ran — the parity harness asserts those params are exactly the
   * backtest's inputs, so they are evidence and must not be edited to express
   * a preference.
   *
   * 15 is the user's decision for 15-minute bars, and it changes the SHAPE of
   * the ladder as well as its size: `min(1000 × (1 + 1.2n), 15)` is $15 at
   * every level, so the ladder is flat rather than growing. Ten fills come to
   * $150, where gas at $0.05 a swap is 0.33% of each — which is what makes a
   * ladder this small viable at all.
   *
   * Raise it as the capital grows. That was always the plan.
   */
  readonly maxUsdPerLevel: number
  /**
   * Drop from the 20-bar swing high the classic entry demands, in percent.
   *
   * ZERO in production, against the reference's 10. See the note in
   * `application/production-ladder.ts`: twenty-two of forty positions had never
   * bought anything, and an average entry that happens beats a good one that
   * never does.
   */
  readonly dropInitPct: number
  /** Gains at which the exit stops waiting for the impulse to die. */
  readonly impatientProfitPct: number
  readonly urgentProfitPct: number
  /**
   * Hours a reserved slot may sit without a single fill before it goes back to
   * the pool.
   *
   * A slot is handed to a token BEFORE the strategy enters it, so a token whose
   * gates never line up holds capital and a slot against nothing. Three hours
   * is twelve bars at 15m — most of the 20-bar swing-high window the classic
   * entry gate looks back over, so the setup had a fair chance.
   */
  readonly idleSlotHours: number
  /**
   * DCA rungs production will actually fill, per token. Entry is not one of
   * them, so 5 means six open entries.
   *
   * NOT `PYRAMIDING`, which is 10 because that is what the `strategy()` header
   * ran and the parity harness asserts it. Evidence, not a preference.
   *
   * The user's reason for 5: with `linInc` at 3, DCA-5 already needs a 13%
   * fall and DCA-10 needs 28%. A token down 28% is rarely an opportunity, and
   * the capital those deep rungs reserve buys more by going to another token.
   */
  readonly maxDcaPerToken: number
  /**
   * How many points better a waiting candidate must score to take a flat
   * position's slot.
   *
   * Not zero on purpose: the opportunity score is a heuristic that moves bar to
   * bar, so swapping on any difference would trade the book against its own
   * noise and pay gas for it.
   */
  readonly minScoreEdge: number

  readonly solanaRpcUrl: string
  readonly bscRpcUrl: string

  /**
   * Bar size the strategy runs on. 15m in production.
   *
   * 1H is what the parity harness proved against TradingView — that test shows
   * the PORT is faithful, and it stays green whatever bar size runs live.
   */
  readonly barSize: BarSize
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type Env = Readonly<Record<string, string | undefined>>

const required = (env: Env, key: string): string => {
  const value = env[key]?.trim()
  if (!value) throw new ConfigError(`${key} is required`)
  return value
}

/** Same as `number`, but zero is a meaningful value rather than an error. */
const numberOrZero = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${key} must be zero or a positive number, got "${raw}"`)
  return value
}

/**
 * A switch that is ON unless it is explicitly turned off.
 *
 * Only '0', 'false' and 'no' turn it off. A typo leaves it ON, which is the
 * safe direction for a switch whose job is to recover capital: the failure it
 * guards against is money stuck in a position nobody can trade.
 */
const onUnless = (env: Env, key: string): boolean => {
  const raw = env[key]?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no')
}

const number = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${key} must be a positive number, got "${raw}"`)
  return value
}

export function loadConfig(env: Env = process.env): RuntimeConfig {
  const mode = env.OPERADOR_MODE?.trim() ?? 'paper'
  if (mode !== 'paper' && mode !== 'live') throw new ConfigError(`OPERADOR_MODE must be "paper" or "live", got "${mode}"`)

  // "solana", "bsc", or "solana,bsc".
  const chains = (env.OPERADOR_CHAIN?.trim() || 'solana')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
  for (const name of chains) {
    if (name !== 'solana' && name !== 'bsc') {
      throw new ConfigError(`OPERADOR_CHAIN accepts "solana", "bsc" or "solana,bsc"; got "${name}"`)
    }
  }
  if (chains.length === 0) throw new ConfigError('OPERADOR_CHAIN must name at least one chain')

  // 15m by default, chosen from live trading rather than from the backtest:
  // on young tokens an hour is long enough for the move to be over before the
  // strategy has an opinion. The 1H parity run remains the proof that the PORT
  // is faithful; the bar size is a separate decision, and this one is the
  // user's, made with money on a real chart.
  const timeframe = env.OPERADOR_TIMEFRAME?.trim() ?? '15m'
  if (timeframe !== '1h' && timeframe !== '15m') throw new ConfigError(`OPERADOR_TIMEFRAME must be "1h" or "15m", got "${timeframe}"`)

  const config: RuntimeConfig = {
    mode,
    chains: chains as readonly Chain[],
    databaseUrl: required(env, 'DATABASE_URL'),
    totalCapitalUsd: number(env, 'OPERADOR_CAPITAL_USD', 1_000),
    // ZERO means no ceiling: the capital decides, at one ladder's worth each.
    // That is the honest default once every slot is the same size — what bounds
    // the damage one token can do is then the SIZE of a slot, not how many
    // there are, and a count cap only leaves capital idle. $1,500 at a $95
    // ladder is about fourteen tokens; five was paired with $200 slots.
    maxPositions: numberOrZero(env, 'OPERADOR_MAX_POSITIONS', 0),
    gasUsdPerSwap: number(env, 'OPERADOR_GAS_USD', 0.05),
    cycleIntervalMs: number(env, 'OPERADOR_CYCLE_MS', 5 * 60 * 1000),
    scanIntervalMs: number(env, 'OPERADOR_SCAN_MS', 60 * 60 * 1000),
    healthIntervalMs: number(env, 'OPERADOR_HEALTH_MS', 10 * 60 * 1000),
    // Zero means "never — the daemon", and `number()` rejects zero. The
    // behaviour therefore existed only while the variable was UNSET: writing
    // its own documented value into it threw at boot. The same sentinel trap
    // as maxPositions, left in the one place it was not fixed.
    maxCycles: numberOrZero(env, 'OPERADOR_MAX_CYCLES', 0),
    // NULL BY DEFAULT — every token that cleared the free gates is examined.
    //
    // The cap of 20 answered a question that has since been re-measured. It was
    // set when a scan cost 384 seconds and each examination was a thousand-row
    // candle download, so a cycle could not finish inside a bar without one. The
    // free gates now reject about ninety percent (57 of 480 on Solana, 41 of 452
    // on BSC, measured), the history count asks for 250 rows instead of 1,000,
    // and a scan runs once an HOUR while watch passes every five minutes look
    // after the money. Ninety-eight examinations at 2.5s is four minutes.
    //
    // A cap is now something you ASK for — on a day the providers are unhappy —
    // rather than something you get. Absent means unbounded; zero is REFUSED
    // rather than read as "no limit", because `maxPositions: 0` meaning "no
    // ceiling" in one file and "zero slots" in the next one cost this engine
    // every position it could have opened. A value that means one thing here and
    // its opposite there is not a sentinel, it is a trap.
    maxSecurityChecks: env.OPERADOR_MAX_SECURITY_CHECKS?.trim() ? number(env, 'OPERADOR_MAX_SECURITY_CHECKS', 0) : null,
    exitOnFreeze: onUnless(env, 'OPERADOR_EXIT_ON_FREEZE'),
    maxUsdPerLevel: number(env, 'OPERADOR_MAX_USD_PER_LEVEL', DEFAULT_MAX_USD_PER_LEVEL),
    dropInitPct: productionLadder(env).dropInitPct,
    impatientProfitPct: productionLadder(env).impatientProfitPct,
    urgentProfitPct: productionLadder(env).urgentProfitPct,
    idleSlotHours: number(env, 'OPERADOR_IDLE_HOURS', 3),
    maxDcaPerToken: number(env, 'OPERADOR_MAX_DCA', DEFAULT_MAX_DCA_PER_TOKEN),
    minScoreEdge: number(env, 'OPERADOR_MIN_SCORE_EDGE', 10),
    solanaRpcUrl: env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
    // Confirmed reachable without a key; Ankr's public endpoint now requires one.
    bscRpcUrl: env.BSC_RPC_URL?.trim() || 'https://bsc-dataseed.binance.org',
    barSize: timeframe === '15m' ? FIFTEEN_MINUTES : ONE_HOUR,
  }

  // Live mode is not a flag you drift into. Nothing in this repo can place a
  // real order yet, so refusing is the only honest answer.
  if (config.mode === 'live') {
    throw new ConfigError(
      'live mode is not available: no wallet adapter has been built or audited. ' +
        'Run OPERADOR_MODE=paper until one exists and has been reviewed.',
    )
  }

  return config
}

/** Redacted for logs. Secrets never reach stdout, not even once at boot. */
export const describeConfig = (config: RuntimeConfig): Record<string, unknown> => ({
  mode: config.mode,
  chains: config.chains.join(','),
  database: config.databaseUrl.replace(/:\/\/[^@]*@/, '://***@'),
  capitalUsd: config.totalCapitalUsd,
  maxPositions: config.maxPositions,
  gasUsdPerSwap: config.gasUsdPerSwap,
  cycleMinutes: config.cycleIntervalMs / 60_000,
})
