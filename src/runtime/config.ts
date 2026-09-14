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
  readonly chain: 'solana' | 'bsc'

  readonly databaseUrl: string
  readonly telegramBotToken: string
  readonly telegramChatId: string

  readonly totalCapitalUsd: number
  readonly maxPositions: number
  readonly gasUsdPerSwap: number

  /** How long between cycles. The strategy is 1H, so this is about freshness, not speed. */
  readonly cycleIntervalMs: number
  /** How often the death watch re-probes the sell path of open positions. */
  readonly healthIntervalMs: number

  readonly solanaRpcUrl: string
  readonly bscRpcUrl: string

  /**
   * Bar size the strategy runs on. 1H is the ONLY size validated against the
   * TradingView backtest; anything else is a new configuration whose numbers
   * nobody has checked.
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

  const chain = env.OPERADOR_CHAIN?.trim() ?? 'solana'
  if (chain !== 'solana' && chain !== 'bsc') throw new ConfigError(`OPERADOR_CHAIN must be "solana" or "bsc", got "${chain}"`)

  const timeframe = env.OPERADOR_TIMEFRAME?.trim() ?? '1h'
  if (timeframe !== '1h' && timeframe !== '15m') throw new ConfigError(`OPERADOR_TIMEFRAME must be "1h" or "15m", got "${timeframe}"`)

  const config: RuntimeConfig = {
    mode,
    chain,
    databaseUrl: required(env, 'DATABASE_URL'),
    telegramBotToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: required(env, 'TELEGRAM_CHAT_ID'),
    totalCapitalUsd: number(env, 'OPERADOR_CAPITAL_USD', 1_000),
    maxPositions: number(env, 'OPERADOR_MAX_POSITIONS', 5),
    gasUsdPerSwap: number(env, 'OPERADOR_GAS_USD', 0.05),
    cycleIntervalMs: number(env, 'OPERADOR_CYCLE_MS', 5 * 60 * 1000),
    healthIntervalMs: number(env, 'OPERADOR_HEALTH_MS', 10 * 60 * 1000),
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
  chain: config.chain,
  database: config.databaseUrl.replace(/:\/\/[^@]*@/, '://***@'),
  telegramChat: config.telegramChatId,
  capitalUsd: config.totalCapitalUsd,
  maxPositions: config.maxPositions,
  gasUsdPerSwap: config.gasUsdPerSwap,
  cycleMinutes: config.cycleIntervalMs / 60_000,
})
