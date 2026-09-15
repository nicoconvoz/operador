import { type Chain } from '../domain/scanner/snapshot.js'
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
   * Two hours is deliberate. A token you HOLD can rug in ten minutes; a new
   * opportunity missed by an hour is a missed opportunity and nothing worse.
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
  readonly maxSecurityChecks: number
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
   * Hours a reserved slot may sit without a single fill before it goes back to
   * the pool.
   *
   * A slot is handed to a token BEFORE the strategy enters it, so a token whose
   * gates never line up holds capital and a slot against nothing. Three hours
   * is twelve bars at 15m — most of the 20-bar swing-high window the classic
   * entry gate looks back over, so the setup had a fair chance.
   */
  readonly idleSlotHours: number

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
    maxPositions: number(env, 'OPERADOR_MAX_POSITIONS', 5),
    gasUsdPerSwap: number(env, 'OPERADOR_GAS_USD', 0.05),
    cycleIntervalMs: number(env, 'OPERADOR_CYCLE_MS', 5 * 60 * 1000),
    scanIntervalMs: number(env, 'OPERADOR_SCAN_MS', 2 * 60 * 60 * 1000),
    healthIntervalMs: number(env, 'OPERADOR_HEALTH_MS', 10 * 60 * 1000),
    maxCycles: number(env, 'OPERADOR_MAX_CYCLES', 0),
    maxSecurityChecks: number(env, 'OPERADOR_MAX_SECURITY_CHECKS', 20),
    maxUsdPerLevel: number(env, 'OPERADOR_MAX_USD_PER_LEVEL', 15),
    idleSlotHours: number(env, 'OPERADOR_IDLE_HOURS', 3),
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
