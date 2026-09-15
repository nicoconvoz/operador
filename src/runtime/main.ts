import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AlertThrottle } from '../domain/notifications/alerts.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { type Candidate } from '../domain/scanner/ranking.js'

import { scanOnce } from '../application/scan.js'
import { type CycleConfig, type CycleDeps } from '../application/orchestrator.js'

import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { CachedHistory } from '../infrastructure/adapters/geckoterminal/cached-history.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { PancakeSwap, jsonRpcEthCall } from '../infrastructure/adapters/pancakeswap/pancakeswap.js'
import { Erc20Decimals } from '../infrastructure/adapters/pancakeswap/erc20-decimals.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { PostgresStore, type SqlClient } from '../infrastructure/persistence/postgres-store.js'
import { StoredAlertSink } from '../infrastructure/notifications/store-alerts.js'

import { loadConfig, describeConfig, type RuntimeConfig } from './config.js'
import { DEFAULT_SIZING_POLICY } from '../domain/economics/sizing.js'
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
  /** POST returning a parsed body, for JSON-RPC. */
  readonly postJson: (url: string, body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>
}

export function buildRuntime(config: RuntimeConfig, ports: RuntimePorts): Runtime {
  const http = makeHttpGet({ timeoutMs: 20_000 })
  // One throttle per provider, shared by every adapter that talks to it.
  const jupiterThrottle = makeThrottle(1_100)
  const geckoThrottle = makeThrottle(2_500)

  const store = new PostgresStore(ports.sql)
  // Alerts go into the store, not down a wire.
  //
  // Telegram was a pipe: the engine pushed, and whatever was not delivered was
  // gone — a phone that was off missed the death exit entirely, and nothing
  // recorded that it had. The log is read from a cursor by the Android app, so
  // being asleep costs latency rather than the message. It is also the audit
  // trail, which the pipe never was.
  const alerts = new StoredAlertSink(store, (error) => console.error('[alerts]', error))

  const dex = new DexScreener(http)
  const goplus = new GoPlus(http)
  const jupiter = new Jupiter(http, jupiterThrottle)
  const jupiterTokens = new JupiterTokens(http, jupiterThrottle)
  const gecko = new GeckoTerminal(http, geckoThrottle)

  // Counting a pool's bars is the heaviest GeckoTerminal call in a cycle and
  // it was 80% of the wall time in rate-limit backoff — measured, not guessed.
  // A pool cannot lose candles, so the answer is worth keeping.
  const cachedHistory = new CachedHistory(gecko, store, {
    now: () => Date.now(),
    minBars: DEFAULT_GATE_POLICY.minHistoryBars,
  })
  const history = {
    historyBars: (chain: Parameters<typeof gecko.historyBars>[0], pool: string) => cachedHistory.historyBars(chain, pool),
    discoverPools: (chain: Parameters<typeof gecko.discoverPools>[0]) => gecko.discoverPools(chain),
  }

  // One port, the right implementation PER CHAIN. BSC quotes PancakeSwap's
  // router directly; without this its honeypot answer would be a third party's
  // flag rather than a fact.
  //
  // Chosen by the chain in hand rather than by a single configured one: with
  // both chains scanned, a BSC position asked through Jupiter would get a
  // "cannot sell" that means nothing more than "wrong venue" — and the death
  // watch would read it as a rug.
  const bscRpc = jsonRpcEthCall(config.bscRpcUrl, ports.postJson)
  const pancake = new PancakeSwap(bscRpc, makeThrottle(250))
  const sellProbeFor = (chain: string) => (chain === 'bsc' ? pancake : jupiter)

  /**
   * Decimals, from a source that knows the chain.
   *
   * This used to be Jupiter's token list for BOTH chains, and Jupiter is
   * Solana only — so it answered null for every BSC address. Since the
   * decimals lookup stands in FRONT of every sell probe, that one null meant
   * BSC tokens were never honeypot-tested and BSC positions ran with no death
   * watch at all. The PancakeSwap probe was written, wired, and unreachable.
   */
  const erc20 = new Erc20Decimals(bscRpc)
  const decimalsFor = {
    decimals: (chain: Chain, address: string) =>
      chain === 'bsc' ? erc20.decimals(chain, address) : jupiterTokens.decimals(chain, address),
    security: (chain: Chain, address: string) => jupiterTokens.security(chain, address),
  }

  // In paper mode every position keeps its own broker, so one position's cash
  // can never be spent by another — the same isolation the live wallets will
  // need to enforce for real.
  const brokers = new Map<string, PaperBroker>()
  const brokerFor = async (position: PersistedPosition) => {
    let broker = brokers.get(position.id)
    if (!broker) {
      broker = new PaperBroker({
        gasUsdPerSwap: config.gasUsdPerSwap,
        initialCapital: position.capitalUsd,
        // Five DCAs plus the entry. The reference's ten stays in PYRAMIDING,
        // which the parity harness asserts; production composes its own.
        maxOpenEntries: config.maxDcaPerToken + 1,
        quality: () => position.quality,
      })
      // Seeded from the fills, which are the only record that survives a
      // process. Without this every cycle would start flat and the ladder
      // would be rebuilt from level zero, forever.
      broker.seed(await store.fillsFor(position.id))
      brokers.set(position.id, broker)
    }
    return broker
  }

  const deps: CycleDeps = {
    store,
    alerts,
    // Did this pending order actually happen?
    //
    // In PAPER the broker is OURS: deterministic, in-process, and the fills
    // table is the complete record of everything it did. No recorded fill
    // means the order did not happen — a fact about a venue we own, not a
    // guess. Recovery resumes the position and the tick executes the order at
    // the next bar's open, which is where it was always going to happen.
    //
    // This said 'unknown' back when the engine had no execution step at all,
    // and that was honest then. It became a lie the moment orders started
    // filling: every position was halted for an order that was merely still
    // scheduled, and five of them sat frozen with nothing wrong.
    //
    // In LIVE it must go back to 'unknown' until a wallet adapter can ask the
    // chain. An order sent to a real venue genuinely can have landed without
    // us hearing about it, and halting is the only honest answer to that.
    probe: async () => (config.mode === 'paper' ? 'not-filled' : 'unknown'),
    candlesFor: async (position) => {
      try {
        return await gecko.candles(position.chain, position.pairAddress, config.barSize, 1000)
      } catch {
        return null
      }
    },
    healthFor: async (position) => {
      try {
        const decimals = await decimalsFor.decimals(position.chain, position.tokenAddress)
        // Without decimals or a price there is no way to size a meaningful
        // probe, and a probe of the wrong size answers the wrong question.
        // Reporting nothing is honest; reporting an unfounded 'ok' is not.
        if (decimals === null || position.lastPriceUsd === null || position.lastPriceUsd <= 0) return null

        // Probe the FULL position, not a token amount: whether $100 can be
        // sold says nothing about whether the position can leave.
        const referenceUsd = Math.max(position.capitalUsd, 50)
        const amountRaw = BigInt(Math.floor((referenceUsd / position.lastPriceUsd) * 10 ** decimals))
        const assessment = await sellProbeFor(position.chain).assessSell(
          position.tokenAddress,
          amountRaw,
          decimals,
          referenceUsd,
        )
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
    // The scanner's verdict can be hours old by design. The sell path is the
    // one answer that must be current at the moment capital moves, so it is
    // asked again — for the handful about to be opened, which costs seconds.
    confirmSellable: async (snapshot) => {
      try {
        const decimals = await decimalsFor.decimals(snapshot.chain, snapshot.address)
        if (decimals === null || snapshot.priceUsd <= 0) return false
        const amountRaw = BigInt(Math.floor((100 / snapshot.priceUsd) * 10 ** decimals))
        const assessment = await sellProbeFor(snapshot.chain).assessSell(snapshot.address, amountRaw, decimals, 100)
        // 'unknown' is not a yes. An unanswered sell path at the moment of
        // entry is exactly the shape of the thing this prevents.
        return assessment.sellQuote === 'ok'
      } catch {
        return false
      }
    },
    // Every configured chain, each scan stored under its own chain so the
    // universe can show them together. One chain failing must not cost the
    // others their turn: a rate limit on Solana is not a reason to stop
    // looking at BSC.
    scan: async () => {
      const candidates: Candidate[] = []
      for (const chain of config.chains) {
        // The counters live on adapters SHARED by every chain, so they are
        // cumulative. Reporting them raw labelled the second chain with the
        // first one's total — a diagnostic that misleads is worse than none.
        const before = { goplus: { ...goplus.rateLimit }, gecko: { ...gecko.rateLimit } }
        const spentSince = () => {
          const delta = (now: { hits: number; waitedMs: number }, then: { hits: number; waitedMs: number }) =>
            JSON.stringify({ hits: now.hits - then.hits, waitedMs: now.waitedMs - then.waitedMs })
          return `goplus=${delta(goplus.rateLimit, before.goplus)} gecko=${delta(gecko.rateLimit, before.gecko)}`
        }
        try {
          const result = await scanOnce(
            {
              dex,
              goplus,
              sellProbe: sellProbeFor(chain),
              decimals: decimalsFor,
              history,
              // Remembers what has been examined, so the budget reaches the
              // whole list over a few cycles instead of re-checking the same
              // twenty forever.
              securityCache: store,
              // A scan spends minutes inside throttled calls. Saying where it
              // is turns a timeout from a mystery into a measurement.
              onProgress: (p) => console.log(`[scan:${p.stage}]`, JSON.stringify(p)),
            },
            {
              chain,
              ranking: {
                gates: DEFAULT_GATE_POLICY,
                opportunity: DEFAULT_OPPORTUNITY_POLICY,
                watchSlots: config.maxPositions,
                minScore: 0,
              },
              referenceUsd: 100,
              spreadPct: 0.3,
              // The whole visible universe: Jupiter's lists return ~220 unique
              // Solana tokens and GeckoTerminal adds BSC's pools; the free
              // gates cut that to what is worth paying for.
              maxTokens: 300,
              // A bounded budget per chain, because each surviving token costs
              // about nine throttled seconds and a cycle has to finish inside
              // one bar. What it cannot reach is reported as unchecked rather
              // than dropped, and the next cycle is fifteen minutes away.
              maxSecurityChecks: config.maxSecurityChecks,
            },
          )
          await store.saveScan({ scannedAt: result.scannedAt, chain, snapshots: result.snapshots })
          candidates.push(...result.candidates)
          // A scan three times slower in CI than on a laptop is either a rate
          // limit or a mystery. This is how it stops being a mystery.
          console.log(`[scan:limits] ${chain} ${spentSince()}`)
        } catch (error) {
          console.error(`[scan:${chain}]`, error)
        }
      }
      // Ranked across chains: slots are scarce and the best opportunity should
      // win wherever it lives.
      return candidates.sort((a, b) => b.opportunity.score - a.opportunity.score)
    },
    now: () => Date.now(),
  }

  return {
    deps,
    cycleConfig: {
      // The reference params with production's own ladder cap. DEFAULT_PARAMS
      // stays untouched: it is what TradingView ran, and the parity harness
      // asserts it.
      params: { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel },
      // The same numbers the broker charges, so the ladder is sized against
      // the costs it will actually pay rather than against a guess.
      gasUsdPerSwap: config.gasUsdPerSwap,
      maxOpenEntries: config.maxDcaPerToken + 1,
      // The ladder is sized for the rungs that can actually fill. Sizing for
      // ten while the venue holds six would reserve capital for four rungs
      // that are never coming.
      sizing: { ...DEFAULT_SIZING_POLICY, maxOpenEntries: config.maxDcaPerToken + 1 },
      portfolio: { ...DEFAULT_PORTFOLIO_POLICY, totalCapitalUsd: config.totalCapitalUsd, maxPositions: config.maxPositions },
      heartbeatMs: 60 * 60 * 1000,
      // A slot handed to a token that never enters is capital held against
      // nothing. Measured live at five hours and twenty minutes.
      idleSlots: {
        idleAfterMs: config.idleSlotHours * 60 * 60 * 1000,
        minScoreEdge: config.minScoreEdge,
      },
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

  const stopSignal = shutdownSignal()

  const report = await runLoop(deps, cycleConfig, throttle, {
    intervalMs: config.cycleIntervalMs,
    // Watching and hunting are paced separately. Most passes only look after
    // what is already open, which costs a candle request and a sell probe per
    // position instead of a scan.
    scanIntervalMs: config.scanIntervalMs,
    stopSignal,
    // 0 means run forever. A scheduler sets 1 and gets a single cycle.
    ...(config.maxCycles > 0 ? { maxCycles: config.maxCycles } : {}),
  })

  console.log('[exit]', JSON.stringify(report.stoppedBy), report.cycles, 'cycles')
}
