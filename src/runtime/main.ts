import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AlertThrottle } from '../domain/notifications/alerts.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type PersistedPosition } from '../domain/persistence/store.js'

import { scanOnce } from '../application/scan.js'
import { type CycleConfig, type CycleDeps } from '../application/orchestrator.js'

import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { PostgresStore, type SqlClient } from '../infrastructure/persistence/postgres-store.js'
import { TelegramAlerts } from '../infrastructure/notifications/telegram.js'
import { botApiTransport, pollCommands } from '../infrastructure/notifications/telegram-poller.js'
import { type BotContext } from '../infrastructure/notifications/telegram-bot.js'

import { loadConfig, describeConfig, type RuntimeConfig } from './config.js'
import { runLoop, shutdownSignal } from './loop.js'

/**
 * Composition root — the only place that knows about both halves of the system.
 *
 * Everything above this file takes ports. This is where real adapters get
 * wired to them, which is why it is the one file allowed to touch the
 * environment, the filesystem and the clock.
 */

export interface Runtime {
  readonly deps: CycleDeps
  readonly cycleConfig: CycleConfig
  readonly throttle: AlertThrottle
}

export interface RuntimePorts {
  readonly sql: SqlClient
  /** POST for Telegram. Injected so main() stays testable. */
  readonly post: (url: string, body: unknown) => Promise<{ status: number }>
  /** GET returning JSON, for Telegram long-polling. */
  readonly fetchJson: (url: string) => Promise<unknown>
}

export function buildRuntime(config: RuntimeConfig, ports: RuntimePorts): Runtime {
  const http = makeHttpGet({ timeoutMs: 20_000 })
  // One throttle per provider, shared by every adapter that talks to it.
  const jupiterThrottle = makeThrottle(1_100)
  const geckoThrottle = makeThrottle(2_500)

  const store = new PostgresStore(ports.sql)
  const alerts = new TelegramAlerts(
    { botToken: config.telegramBotToken, chatId: config.telegramChatId },
    ports.post,
    (error) => console.error('[alerts]', error),
  )

  const dex = new DexScreener(http)
  const goplus = new GoPlus(http)
  const jupiter = new Jupiter(http, jupiterThrottle)
  const jupiterTokens = new JupiterTokens(http, jupiterThrottle)
  const gecko = new GeckoTerminal(http, geckoThrottle)

  // In paper mode every position keeps its own broker, so one position's cash
  // can never be spent by another — the same isolation the live wallets will
  // need to enforce for real.
  const brokers = new Map<string, PaperBroker>()
  const brokerFor = (position: PersistedPosition) => {
    let broker = brokers.get(position.id)
    if (!broker) {
      broker = new PaperBroker({
        gasUsdPerSwap: config.gasUsdPerSwap,
        initialCapital: position.capitalUsd,
        maxOpenEntries: 10,
        quality: () => position.quality,
      })
      brokers.set(position.id, broker)
    }
    return broker
  }

  const deps: CycleDeps = {
    store,
    alerts,
    // No live venue yet, so an in-flight order can never be confirmed either
    // way. 'unknown' halts the position, which is the correct answer until a
    // wallet adapter can actually ask the chain.
    probe: async () => 'unknown',
    candlesFor: async (position) => {
      try {
        return await gecko.candles(config.chain, position.pairAddress, 'hour', 1000)
      } catch {
        return null
      }
    },
    healthFor: async (position) => {
      try {
        const decimals = await jupiterTokens.decimals(config.chain, position.tokenAddress)
        // Without decimals or a price there is no way to size a meaningful
        // probe, and a probe of the wrong size answers the wrong question.
        // Reporting nothing is honest; reporting an unfounded 'ok' is not.
        if (decimals === null || position.lastPriceUsd === null || position.lastPriceUsd <= 0) return null

        // Probe the FULL position, not a token amount: whether $100 can be
        // sold says nothing about whether the position can leave.
        const referenceUsd = Math.max(position.capitalUsd, 50)
        const amountRaw = BigInt(Math.floor((referenceUsd / position.lastPriceUsd) * 10 ** decimals))
        const assessment = await jupiter.assessSell(position.tokenAddress, amountRaw, referenceUsd)
        return {
          observedAt: Date.now(),
          source: 'jupiter',
          sellQuote: assessment.sellQuote,
          liquidityUsd: null,
          lpStatus: 'unknown',
          mintAuthorityActive: null,
          freezeAuthorityActive: null,
          transfersBlocked: null,
          topHolderMovedPct: null,
          hoursSinceLastTrade: null,
        }
      } catch {
        return null
      }
    },
    brokerFor,
    scan: async () => {
      const result = await scanOnce(
        { dex, goplus, jupiter, decimals: jupiterTokens, history: gecko },
        {
          chain: config.chain,
          ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: config.maxPositions, minScore: 0 },
          referenceUsd: 100,
          spreadPct: 0.3,
          // The whole visible universe: Jupiter's lists return ~220 unique
          // tokens and the free gates cut that to what is worth paying for.
          maxTokens: 300,
        },
      )
      await store.saveScan({ scannedAt: result.scannedAt, chain: config.chain, snapshots: result.snapshots })
      return result.candidates
    },
    now: () => Date.now(),
  }

  return {
    deps,
    cycleConfig: {
      params: DEFAULT_PARAMS,
      portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: config.totalCapitalUsd, maxPositions: config.maxPositions },
      chain: config.chain,
      heartbeatMs: 60 * 60 * 1000,
    },
    throttle: new AlertThrottle(30 * 60 * 1000),
  }
}

export const schemaSql = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../infrastructure/persistence/schema.sql'), 'utf8')

/** Entry point. Wired only when this file is executed directly. */
export async function main(ports: RuntimePorts): Promise<void> {
  const config = loadConfig()
  console.log('[boot]', JSON.stringify(describeConfig(config)))

  const store = new PostgresStore(ports.sql)
  await store.migrate(schemaSql())

  const { deps, cycleConfig, throttle } = buildRuntime(config, ports)

  // One signal, two consumers: the trading loop and the command poller stop
  // together. A poller that outlived the engine would answer /status about a
  // system that is no longer running.
  const stopSignal = shutdownSignal()

  const botContext: BotContext = {
    store,
    alerts: deps.alerts,
    authorisedChatId: config.telegramChatId,
    now: () => Date.now(),
    equity: async () => {
      // Cash held by each position's broker is not visible from the store, so
      // equity is reported from committed capital until a live wallet can be
      // queried. Stated plainly rather than guessed at.
      const positions = await store.loadPositions()
      return {
        equityUsd: positions.reduce((sum, p) => sum + p.capitalUsd, 0),
        startingCapitalUsd: config.totalCapitalUsd,
      }
    },
  }

  const transport = botApiTransport(config.telegramBotToken, ports.fetchJson, ports.post)

  // Run both; whichever stops first, the other is already stopping.
  const [report] = await Promise.all([
    runLoop(deps, cycleConfig, throttle, { intervalMs: config.cycleIntervalMs, stopSignal }),
    pollCommands(transport, botContext, { stopSignal, onError: (error) => console.error('[telegram]', error) }),
  ])

  console.log('[exit]', JSON.stringify(report.stoppedBy), report.cycles, 'cycles')
}
