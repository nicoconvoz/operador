import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AlertThrottle } from '../domain/notifications/alerts.js'
import { DEFAULT_GATE_POLICY, minAgeForHistory, type GatePolicy } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { DEFAULT_DEATH_EXIT_POLICY } from '../domain/risk/death-exit.js'
import { admittedUsd } from '../domain/risk/token-tier.js'
import { type SwitchedOff, type Rejected } from '../domain/scanner/ranking.js'
import { fundRungsFromFreeCapital, fundStepFromFreeCapital } from '../application/free-capital.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type Chain, type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candidate } from '../domain/scanner/ranking.js'

import { scanOnce, examineToken, type ScanError } from '../application/scan.js'
import { type CycleConfig, type CycleDeps } from '../application/orchestrator.js'

import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal, barMinutes, FIVE_MINUTES, ONE_HOUR, type BarSize } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { PancakeSwap, jsonRpcEthCall } from '../infrastructure/adapters/pancakeswap/pancakeswap.js'
import { Erc20Decimals } from '../infrastructure/adapters/pancakeswap/erc20-decimals.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { SolanaMints } from '../infrastructure/adapters/solana/mint-facts.js'
import { JupiterCharts } from '../infrastructure/adapters/jupiter/jupiter-charts.js'
import { tokenCandles } from '../application/candle-source.js'
import { lastHourVolatility } from '../application/recent-volatility.js'
import { recentLiquidityChange } from '../application/liquidity-change.js'
import { type LiquidityReading } from '../domain/strategy/liquidity-brake.js'
import { patientSellProbe } from '../application/patient-sell-probe.js'
import { PRESSURE_THRESHOLD } from '../domain/strategy/pressure-ladder.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { makeAdaptiveThrottle } from '../infrastructure/adaptive-throttle.js'
import { makeHedgedGet } from '../infrastructure/hedged-get.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { PostgresStore, type SqlClient } from '../infrastructure/persistence/postgres-store.js'
import { StoredAlertSink } from '../infrastructure/notifications/store-alerts.js'

import { loadConfig, describeConfig, type RuntimeConfig } from './config.js'
import { DEFAULT_SIZING_POLICY } from '../domain/economics/sizing.js'
import { recallCandidates } from '../application/recall.js'
import { healthForCycle, UNMEASURED } from '../application/health-from-scan.js'
import { hoursSinceLastTrade } from '../application/idle-hours.js'
import { confirmEntry } from '../application/confirm-entry.js'
import { CachedDiscovery } from '../infrastructure/adapters/geckoterminal/cached-discovery.js'
import { readOnlyRegistry } from '../application/read-only-registry.js'
import { cachedTape } from '../application/cached-tape.js'
import { worthStoring } from '../application/worth-storing.js'
import { type LiveMarket } from '../domain/scanner/live-market.js'
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
  // The hard timeout stays as the last line of defence, and the HEDGE decides
  // long before it: a request slower than this provider's own recent answers is
  // restarted once, and a second slow one moves on to the next token.
  //
  // Wrapped PER PROVIDER, because a shared baseline would be the average of
  // different things — GoPlus answers in about half a second, Jupiter in one,
  // GeckoTerminal in one and a half — and an outlier is only an outlier against
  // its own kind.
  const http = makeHttpGet({ timeoutMs: 20_000 })
  const hedged = () => makeHedgedGet(http)
  // One throttle per provider, shared by every adapter that talks to it.
  // No fixed interval: the provider sets the pace. 1,100ms was a number nobody
  // measured, and it made the sell quote the slowest thing in a scan — two
  // calls a token, 2.2s each, against a security stage of a hundred tokens.
  // It starts at zero and slows only when Jupiter says to.
  const jupiterThrottle = makeAdaptiveThrottle()
  // Adaptive here too, and the argument is different from Jupiter's. 2,500ms
  // was not a guess — it matches GeckoTerminal's documented ~30/min and was
  // earned by measuring 45 rejections. What it cannot know is that the quota is
  // SHARED: a CI runner's IP carries thousands of unrelated jobs, so the room
  // we have swings by the minute. A constant is the average of a number that
  // never sits still — too slow on a quiet minute, too fast on a busy one.
  const geckoThrottle = makeAdaptiveThrottle()

  // The fill tape is read ONCE per process and then answered from memory,
  // appended by every fill this engine records — it is the only writer. Every
  // reader below goes through it: the cycle, both sweeps, the funders, the
  // brokers, the day log and the common fund. At 250 positions of twenty $1
  // steps they re-read the whole tape about three times a pass and each held
  // position's fills every thirty seconds: gigabytes a day against a 5 GB
  // monthly allowance. The dashboard is read-only and keeps its own cache.
  const store = cachedTape(new PostgresStore(ports.sql))
  // Alerts go into the store, not down a wire.
  //
  // Telegram was a pipe: the engine pushed, and whatever was not delivered was
  // gone — a phone that was off missed the death exit entirely, and nothing
  // recorded that it had. The log is read from a cursor by the Android app, so
  // being asleep costs latency rather than the message. It is also the audit
  // trail, which the pipe never was.
  const alerts = new StoredAlertSink(store, (error) => console.error('[alerts]', error))

  const dex = new DexScreener(hedged())
  const goplus = new GoPlus(hedged())
  const jupiter = new Jupiter(hedged(), jupiterThrottle)
  const jupiterTokens = new JupiterTokens(http, jupiterThrottle)
  // ONE client, one rule: wait until it answers, give up after sixty seconds.
  //
  // This replaced a pair of clients with different retry COUNTS — patient for
  // the book, impatient for the scan. The operator's rule made the split
  // unnecessary: a request that answers in three seconds costs three seconds
  // whoever asked, so the book gets its patience without the scan paying a
  // fixed toll for it. The ceiling is the same for everyone because the quota
  // is the same quota.
  const gecko = new GeckoTerminal(hedged(), geckoThrottle)
  /**
   * Where a token's security and market come from, per chain — ONE answer shared by the
   * scan and the door, so the two cannot disagree about what makes a token safe.
   *
   * Solana: Jupiter and the chain. *Hagamos todo con Jupiter.* GoPlus answered
   * one address per call on a fixed two-second interval and would not batch,
   * and a cold scan spent 3.5 seconds a token on it — 137 tokens, eight
   * minutes. Jupiter's token API answers a hundred mints in half a second with
   * the authorities and holder concentration; `getMultipleAccounts` answers a
   * hundred with every Token-2022 extension, which Jupiter does not carry and
   * which is where the tokens with a transfer fee, a permanent delegate or a
   * pause switch hide — 46 of Jupiter's own hundred trending tokens were
   * Token-2022.
   *
   * BSC: GoPlus, unchanged. Nothing else there reads a contract's security.
   */
  const solanaMints = new SolanaMints(config.solanaRpcUrl, ports.postJson)
  const jupiterCharts = new JupiterCharts(hedged())
  // ONE route to a token's candles — Jupiter by mint, GeckoTerminal by pool
  // behind it — for the tick AND the door. The door kept its own route to
  // GeckoTerminal after the tick moved, and refused 25 of 26 prime tokens on
  // pools GeckoTerminal does not know.
  const candlesOf = tokenCandles({
    byMint: (chain, mint, size: BarSize, limit) => jupiterCharts.candles(chain, mint, size, limit),
    byPool: (chain, pool, size: BarSize, limit) => gecko.candles(chain, pool, size, limit),
  })
  /**
   * The last hour of CLOSED 5-minute bars, for the real-time DCA spacing —
   * through the same route as the tick's candles, Jupiter by mint first and
   * GeckoTerminal behind it, so the rung and the strategy read one feed.
   *
   * Sixteen bars: the twelve of the hour, the forming one the adapters drop,
   * and room for a provider a bar behind. ONE instance, shared by the cycle's
   * sweeps and the loop's, so its per-bar memory is one memory: the 30-second
   * sweep asks each token once per 5-minute bar, never once per pass.
   */
  const recentVolatility = lastHourVolatility({
    candles: (position) => candlesOf(position.chain, position.tokenAddress, position.pairAddress, FIVE_MINUTES, 16),
    now: () => Date.now(),
  })
  /**
   * The book's pools for the liquidity watch — the change over the last five
   * minutes and the last hour, and the depth in dollars — from Jupiter's own
   * windows, the whole book in one request, each answer held a minute. ONE
   * instance, shared by the cycle's sweeps and the loop's, so watching every
   * held position every thirty seconds costs one request a minute. Solana
   * only: nothing else here reports it, and a token nobody answered about
   * changes nothing.
   */
  const liquidityChange = recentLiquidityChange({
    changes: async (positions) => {
      const out = new Map<string, LiquidityReading>()
      const mints = positions.filter((p) => p.chain === 'solana').map((p) => p.tokenAddress)
      if (mints.length === 0) return out
      for (const [mint, reading] of await jupiterTokens.liquidityChanges(mints)) out.set(`solana:${mint}`, reading)
      return out
    },
    now: () => Date.now(),
  })
  const sourcesFor = (chain: Chain) =>
    chain === 'solana'
      ? {
          onChain: solanaMints,
          prefetch: async (_chain: Chain, addresses: readonly string[]) => {
            await Promise.all([jupiterTokens.prefetch(addresses), solanaMints.prefetch(addresses)])
          },
          // The MARKET half too, per mint, from the source the candles and the
          // live prices come from — so the liquidity a position is opened
          // against and the liquidity its death watch reads are comparable.
          markets: (c: Chain, addresses: readonly string[]) => jupiterTokens.markets(c, addresses),
        }
      : { goplus }

  // And the cheapest rejection of all: one that needs no request. A pool younger
  // than `minHistoryBars` bars CANNOT hold them, so it is refused by
  // subtraction instead of by a candle download it was always going to fail.
  // Never lowers the standing 24h floor — that answers a different question.
  const gates: GatePolicy = {
    ...DEFAULT_GATE_POLICY,
    // The operator's volatility door: only tokens that MOVE may enter.
    minVolatility5mPct: config.minVolatilityPct,
    minAgeHours: Math.max(
      DEFAULT_GATE_POLICY.minAgeHours,
      minAgeForHistory(DEFAULT_GATE_POLICY.minHistoryBars, barMinutes(config.barSize)),
    ),
  }
  // And once the candle downloads were cached, DISCOVERY became most of what a
  // scan costs: ten throttled calls per chain, about half an hour, during which
  // the engine is not watching the positions that already hold money. It
  // expires because new pools appear — but a pool younger than the window
  // cannot clear the history gate anyway, which wants 250 bars: 2.6 days at 15m.
  const cachedDiscovery = new CachedDiscovery(gecko, store, { now: () => Date.now() })
  // The permanent registry, read at most every fifteen minutes and never
  // written. A scan keeps the candidates and the book and nothing else.
  const registry = readOnlyRegistry(store, { everyMs: 15 * 60_000 })
  /**
   * The pool provider, whole.
   *
   * Discovery goes through the cache — a list stands six hours and the sweep
   * is thirty throttled calls — while the market fallback does NOT, because a
   * price from six hours ago is not a price. They are different questions
   * about the same pools and they get different freshness, deliberately.
   */
  const history = {
    discoverPools: (chain: Parameters<typeof gecko.discoverPools>[0]) => cachedDiscovery.discoverPools(chain),
    poolMarkets: (chain: Parameters<typeof gecko.poolMarkets>[0], pools: readonly string[]) =>
      gecko.poolMarkets(chain, pools),
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
    /**
     * Jupiter's three lists, and they were MISSING here for the life of this
     * composition.
     *
     * `JupiterTokens.discover()` exists, is tested, and is documented as a
     * universe source — and this hand-built object forwarded two methods and
     * forgot the third, so `if (deps.decimals.discover)` in the scan was
     * always false and the largest single source never ran.
     *
     * Measured the night it was found: locally the three sources give Jupiter
     * 198, GeckoTerminal 285 and DexScreener 47 for 453 unique. The live run
     * reported 323, and the 130 missing were exactly these.
     *
     * TypeScript could not catch it and that is the lesson, not the oversight:
     * `discover` is OPTIONAL on the port, because not every chain has a token
     * list, so an object without it is a perfectly valid one. The same shape
     * as every other gap in this project — written, tested, documented, and
     * reached by nobody.
     */
    discover: () => jupiterTokens.discover(),
  }

  // In paper mode every position keeps its own broker, so one position's cash
  // can never be spent by another — the same isolation the live wallets will
  // need to enforce for real.
  //
  // Kept with the CAPITAL it was built for. A rung now raises a position's
  // capital out of the free pool at the moment it fires, and a broker cached
  // from before that would refuse the very rung it was funded for — the first
  // buy already spent what a one-entry slot was given. A capital that moved
  // rebuilds the broker from the fills, which are the facts either way.
  const brokers = new Map<string, { readonly capitalUsd: number; readonly broker: PaperBroker }>()
  /**
   * The scan a health pass reads, memoised for a minute.
   *
   * `healthFor` runs once per position, and eighteen positions asking the
   * database for the same hourly scan is eighteen queries for one answer.
   */
  let scanMemo: { at: number; scans: Awaited<ReturnType<typeof store.latestScansByChain>> } | null = null
  const scansForHealth = async () => {
    const now = Date.now()
    if (scanMemo && now - scanMemo.at < 60_000) return scanMemo.scans
    scanMemo = { at: now, scans: await store.latestScansByChain() }
    return scanMemo.scans
  }

  /** Which scan each position has already had folded into its evidence. */
  const foldedScanAt = new Map<string, number>()

  /**
   * The market half of every held token, as of THIS cycle.
   *
   * One fetch, two readers — the rule this project wrote down for the dashboard
   * and never applied to the engine. `marketPrices` asks DexScreener for every
   * position once a cycle and the response carries price, LIQUIDITY, volume and
   * the counts; it kept the price and dropped the rest on the floor, while the
   * death watch read liquidity out of a scan up to twenty minutes old.
   *
   * A pool empties faster than that, and `exitOnFreeze` sells into whatever is
   * left — exempt from the no-loss guard, because a death exit has to be able
   * to leave at any price. So the lateness was never a lag on a diagnostic; it
   * was the difference between selling into a pool and selling into its remains.
   *
   * Filled before the ticks run — the orchestrator fetches prices first — and
   * read by `healthFor`. Absent means no feed answered, which is silence and
   * not a collapse.
   */
  const liveMarkets = new Map<string, LiveMarket>()

  let lastSwitchedOff: SwitchedOff[] = []
  // What the last scan rejected, scored anyway, for the score stop on tokens
  // we hold. Reset per scan, like the switch.
  let lastRejected: Rejected[] = []

  const brokerFor = async (position: PersistedPosition) => {
    const cached = brokers.get(position.id)
    if (cached && cached.capitalUsd === position.capitalUsd) return cached.broker
    const broker = new PaperBroker({
      gasUsdPerSwap: config.gasUsdPerSwap,
      initialCapital: position.capitalUsd,
      // Every dip-bounce step: twenty, the first buy included. The reference's
      // ten stays in PYRAMIDING, which the parity harness asserts; production
      // composes its own.
      maxOpenEntries: config.maxDcaPerToken + 1,
      quality: () => position.quality,
    })
    // Seeded from the fills, which are the only record that survives a
    // process. Without this every cycle would start flat and the ladder
    // would be rebuilt from level zero, forever.
    broker.seed(await store.fillsFor(position.id))
    brokers.set(position.id, { capitalUsd: position.capitalUsd, broker })
    return broker
  }

  /**
   * The ladder production runs, composed ONCE: the cycle sizes slots with it
   * and the sweep prices a rung's capital with it. Two copies would disagree
   * about what one more entry costs.
   */
  const params: CycleConfig['params'] = {
    ...DEFAULT_PARAMS,
    // Door 3, composed HERE beside the ladder cap and the entry drop, never
    // in DEFAULT_PARAMS — the parity harness asserts those are the backtest
    // own inputs.
    //
    // It is what the scanner change requires rather than an extra: the
    // shortlist is now chosen for RISING, and door 1 refuses a bar making a
    // new twenty-bar high. Sixteen candidates produced five positions.
    //
    // SHUT now, and `OPERADOR_BUY_ON_SELECTION` no longer opens it: the first
    // buy on selection is a dip-bounce STEP (`dipBounce.onSelection`), bought
    // by the cycle in the pass that opened the slot. This door would size the
    // entry off the slot's deployable capital — $4.70 of a $100 slot, not the
    // $5 step — and, flat after every sale, it would buy the token straight
    // back on the next bar without asking the entry door again.
    useMomentumEntry: false,
    // The cascade's OWN doors, switched off: *nada se compra cuando una moneda
    // pasa a candidata.* Every buy, the first one included, is a dip-bounce
    // step bought by the sweep; the machine is left to sell at the take-profit
    // off the broker's average cost. OPERADOR_CASCADE_ENTRIES=1 reopens both.
    useClassicEntry: config.cascadeEntries,
    useTrendReentry: config.cascadeEntries,
    // The cascade's OWN rungs, switched off: a gap no price can clear. It
    // confirms a bottom on twenty strategy bars — five hours at 15m — while
    // the price ladder buys from the stop's sweep. Two paths buying rungs
    // would buy the same dip twice.
    minGapPct: 100,
    // The floor of the exit's derived target: never sell under +10%.
    minProfitPct: config.minProfitPct,
    maxUsdPerLevel: config.maxUsdPerLevel,
    dropInitPct: config.dropInitPct,
    impatientProfitPct: config.impatientProfitPct,
    urgentProfitPct: config.urgentProfitPct,
  }

  /**
   * A rung's capital, taken from the book's FREE capital when the rung fires —
   * the same definition of free the allocator opens positions with. Ladder A
   * reserved its first buy only (`OPERADOR_RESERVED_ENTRIES=1` with it), so
   * every rung, on either ladder, pays for itself here or waits.
   *
   * Priced at the rungs' OWN sizes — ladder A's $15 to $35 — on top of the
   * first buy `params` sizes. Priced as a flat ladder instead, DCA-5 would be
   * funded for ten dollars and the broker would refuse its thirty-five.
   */
  const fundRung = fundRungsFromFreeCapital({
    store,
    totalCapitalUsd: config.totalCapitalUsd,
    params,
    gasUsdPerSwap: config.gasUsdPerSwap,
    rungsUsd: config.dcaRungsUsd,
  })
  // The pressure ladder buys ONE size, `maxUsdPerLevel`, so it is priced flat:
  // the same funding, without ladder A's list.
  const fundPressureRung = fundRungsFromFreeCapital({
    store,
    totalCapitalUsd: config.totalCapitalUsd,
    params,
    gasUsdPerSwap: config.gasUsdPerSwap,
  })
  // The deep rung buys its OWN size, $20, on top of the $15 first buy — priced
  // at that, or the broker would refuse a rung funded for fifteen.
  const fundDeepRung = fundRungsFromFreeCapital({
    store,
    totalCapitalUsd: config.totalCapitalUsd,
    params,
    gasUsdPerSwap: config.gasUsdPerSwap,
    rungsUsd: [config.deepRungUsd],
  })
  // A dip-bounce step's FEES, out of the free capital when the slot's exact $20
  // runs short — asked of the very broker that will fill the step, so the two
  // cannot disagree about whether it is affordable.
  const fundStep = fundStepFromFreeCapital({
    store,
    totalCapitalUsd: config.totalCapitalUsd,
    cashOf: async (position) => (await brokerFor(position)).equityCash,
  })
  /**
   * The death watch's policy, ONE object: the tick assesses every position
   * with it, and the dip-bounce sweep refuses a step on its freeze line — so
   * the sweep refuses exactly the pool the next tick would freeze, and a
   * change to either is a change to both.
   */
  const deathPolicy = { ...DEFAULT_DEATH_EXIT_POLICY, abandonmentFreezeHours: config.abandonFreezeHours }

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
    // Jupiter first, by MINT; GeckoTerminal by pool only when Jupiter cannot
    // answer. *La operativa también con Jupiter.* GeckoTerminal was about 2.5s
    // a position behind the hardest rate limit this engine meets; forty mints
    // from Jupiter took 2.0s eight at a time with no refusal in eighty. The
    // fallback exists because Jupiter's chart endpoint is undocumented, and a
    // book whose every tick depends on it must not go blind when it moves.
    candlesFor: (position) =>
      candlesOf(position.chain, position.tokenAddress, position.pairAddress, config.barSize, 1000),
    // *Quiero el precio directamente, que vaya con el precio en vivo.* The tick
    // runs on one bar made of the price the cycle already fetched; only a
    // position that has not bought in `staleCheckHours` asks a short read of
    // hourly candles — sixteen closed hours — so the death watch still sees a
    // pool that stopped trading. OPERADOR_LIVE_PRICE=0 brings the downloads back.
    ...(config.livePrice
      ? {
          liveBars: {
            staleAfterMs: config.staleCheckHours * 3_600_000,
            recentCandles: (position: PersistedPosition) =>
              candlesOf(position.chain, position.tokenAddress, position.pairAddress, ONE_HOUR, 17),
          },
        }
      : {}),
    // *Aplicalo para el DCA también — nada de escalones, esa regla.* A $15
    // rung each time buy pressure crosses 1% upward. The hour's counts come
    // from Jupiter, per mint, out of the response the book's live prices just
    // refreshed — so a sweep costs a cache read, not a request.
    // Off by default, one variable away: OPERADOR_PRESSURE=1.
    ...(config.pressure ? { pressureLadder: {
        policy: { maxEntries: config.maxDcaPerToken + 1, threshold: PRESSURE_THRESHOLD },
        rungUsd: config.maxUsdPerLevel,
        hourCounts: async (position: PersistedPosition) => {
          if (position.chain !== 'solana') return null
          const [market] = await jupiterTokens.markets('solana', [position.tokenAddress])
          return market ? { buys: market.txns.h1.buys, sells: market.txns.h1.sells } : null
        },
        previous: new Map<string, number>(),
        gone: new Set<string>(),
        gasUsdPerSwap: config.gasUsdPerSwap,
        // Same funding as the price ladder — a slot holds its first buy only —
        // priced at this ladder's one size.
        fund: fundPressureRung,
      } } : {}),
    // *Sin TP fijo; sólo cuando haya más ganancia que 12% empieza a correr el
    // TP de la presión compradora.* The hour's counts per mint, out of the same
    // cached Jupiter response the pressure ladder reads.
    // *Si una moneda baja más de 5% del precio en menos de un minuto, SL.*
    // Read on the sweep's own live prices, every thirty seconds.
    ...(config.crashStop.dropPct > 0 ? { crashStop: {
        dropPct: config.crashStop.dropPct,
        windowMs: config.crashStop.windowMs,
        marks: new Map(),
      } } : {}),
    ...(config.pressureTp.dropPct > 0 ? { pressureTp: {
        armPct: config.pressureTp.armPct,
        dropPct: config.pressureTp.dropPct,
        hourCounts: async (position: PersistedPosition) => {
          if (position.chain !== 'solana') return null
          const [market] = await jupiterTokens.markets('solana', [position.tokenAddress])
          return market ? { buys: market.txns.h1.buys, sells: market.txns.h1.sells } : null
        },
        peaks: new Map<string, number>(),
        armed: new Set<string>(),
        gasUsdPerSwap: config.gasUsdPerSwap,
      } } : {}),
    // *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay
    // un rebote de 10%, nueva compra DCA de $20.* The ONE rung after the entry,
    // bought by the sweep every thirty seconds at the live price, off the low
    // it follows and writes down. It pays for itself out of the book's FREE
    // capital — a slot holds its first buy only — and waits a sweep when there
    // is none. One `fund` for the cycle's sweeps and the loop's, since both
    // read these deps.
    //
    // OFF now: every buy is a dip-bounce step. OPERADOR_DEEP_RUNG=1 brings it
    // back, and absent, nothing it carries runs — no low followed, no write.
    ...(config.deepRung ? { deepRung: {
      policy: { fallPct: config.deepRungFallPct, reboundPct: config.deepRungReboundPct, maxEntries: config.maxDcaPerToken + 1 },
      usd: config.deepRungUsd,
      fund: fundDeepRung,
    } } : {}),
    // *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y
    // armá escalones de 1 USD con la misma regla* — twenty of them. EVERY buy,
    // the first one included, bought by the sweep every thirty seconds at the
    // live price. A new position is a reservation this watches until its first
    // dip and bounce. The fees the slot's exact $20 does not hold are asked of
    // the free capital as each step fills. One set of deps for the cycle's
    // sweeps and the loop's.
    //
    // "If it fell more than 20% it is a collapse, not a dip: don't buy there.
    // Wait until it is back within 20%." `maxDipPct`; OPERADOR_MAX_DIP_PCT=0
    // turns it off. *3% suma 2%, el 2% suma 2% por cada DCA* — *el rebote
    // dejalo que aumente de 1%*: each DCA asks 2 more points of dip and of
    // ceiling and 1 more of bounce, from the number of buys the holding has;
    // OPERADOR_DIP_STEP_PCT=0 and OPERADOR_BOUNCE_STEP_PCT=0 are the flat rule.
    // And the pool is read LIVE before every step, against the
    // death watch's own freeze line: YAP's froze at 26.6% of entry after four
    // more steps went into it between two ticks. The reader is the liquidity
    // watch's, one request a minute for the whole book, asked only when a step
    // fires.
    dipBounce: {
      policy: {
        dipPct: config.dipPct,
        bouncePct: config.bouncePct,
        maxSteps: config.maxSteps,
        maxDipPct: config.maxDipPct,
        dipStepPct: config.dipStepPct,
        bounceStepPct: config.bounceStepPct,
      },
      stepUsd: config.stepUsd,
      // *1, 2, 4, 8, 16, 32* — each step doubles the one before.
      stepGrowth: config.stepGrowth,
      gasUsdPerSwap: config.gasUsdPerSwap,
      fund: fundStep,
      pool: { liquidity: liquidityChange, deathPolicy, refusing: new Set<string>() },
      // *Y además que la primera compra entre automáticamente.* The FIRST step
      // is bought in the pass that opens the slot, at the live price; every
      // later one waits for its dip and bounce. OPERADOR_BUY_ON_SELECTION=0.
      onSelection: config.buyOnSelection,
      // The first and only buy is what the slot was given — its class.
      ...(config.tiers ? { firstStepFromCapital: true } : {}),
    },
    // *Arriesguémonos, activá la A.* Five rungs of $15, $20, $25, $30 and $35
    // at −10, −15, −20, −25 and −30% of a $10 FIRST buy, bought by the sweep
    // every thirty seconds. It was three $15 rungs at −10, −20 and −30%.
    //
    // OFF now — only the deep rung buys after the entry — and absent, so
    // nothing it carries runs either: no spacing asked, no pool watched, no
    // bounce bought. OPERADOR_DROP_LADDER=1 brings it back.
    //
    // Each pays for itself: a slot is allocated its first buy only, so a rung
    // asks the book's FREE capital for one more entry — the same definition
    // of free the allocator opens positions with — and waits a sweep when
    // there is none. One `fund` for the cycle's sweeps and the loop's, since
    // both read these deps.
    ...(config.dropLadder ? { dropLadder: {
      policy: { maxEntries: config.maxDcaPerToken + 1, dropsPct: config.dcaDropsPct, from: config.dcaFrom },
      rungsUsd: config.dcaRungsUsd,
      fund: fundRung,
      // *Aplicá el de en la línea, la propuesta.* Each position's drops times
      // its own `dcaScale`, measured by the tick from the day before its first
      // buy: the more the token moves, the closer its rungs. Here, once, so
      // the cycle's sweeps and the loop's cannot disagree about the line.
      adaptive: config.dcaAdaptive,
      // *Tiempo real.* The NEXT rung spaced by the token's last hour, decided
      // when the sweep looks at it; the at-buy scale is the fallback when the
      // hour cannot be read. Only inside `adaptive` — the sweep never asks
      // with that off. Absent with OPERADOR_DCA_REALTIME=0.
      ...(config.dcaRealtime ? { recentVolatility } : {}),
      // *Freno en tiempo real por cambio de liquidez inmediata que supere el
      // 5% — 5 minutos o 1 hora.* The ladder brakes while a pool drains —
      // PAID froze at 41% of its entry liquidity after the ladder had bought
      // two rungs into it — and a 5% bounce off the minimum lifts it, buying
      // the next rung if the position is still at a loss.
      // OPERADOR_LIQUIDITY_BRAKE_PCT=0: the whole watch off, nothing asked.
      liquidityChange,
      liquidityBrakePct: config.liquidityBrakePct,
    } } : {}),
    // The SECOND opinion on what a held token is worth, so the engine can tell
    // a token that collapsed from one whose price it cannot read. DexScreener,
    // never GeckoTerminal: asking the candle feed to check the candle feed
    // would agree with itself about a number that does not exist, which is
    // exactly how ZCAT and USDF happened.
    //
    // One call per thirty addresses per chain, so the whole book costs a couple
    // of requests a cycle against a limit of three hundred a minute. A chain
    // that fails costs the others nothing, and a total failure returns an empty
    // map — which the engine reads as silence, not as a mismatch.
    //
    // Solana is JUPITER now, per mint, and asked fresh every time — never from
    // the scan's minute-long cache, because the stop re-prices the book every
    // thirty seconds and a cached price would cut a position on where it WAS.
    // One source for the price, the live liquidity and the candles, so the
    // death watch's live liquidity and the liquidity it recorded at entry are
    // one provider's numbers. The price-agreement guard still compares this
    // against the last closed candle, which catches a momentary glitch against
    // a bar that was right fifteen minutes ago.
    marketPrices: async (positions) => {
      const prices = new Map<string, number>()
      const byChain = new Map<Chain, string[]>()
      for (const p of positions) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.tokenAddress])
      for (const [chain, addresses] of byChain) {
        if (chain === 'solana') {
          try {
            for (const m of await jupiterTokens.markets(chain, addresses, { refresh: true })) {
              prices.set(`${chain}:${m.address}`, m.priceUsd)
              liveMarkets.set(`${chain}:${m.address}`, m)
            }
          } catch {
            // Silence, not a verdict.
          }
          continue
        }
        for (let i = 0; i < addresses.length; i += 30) {
          try {
            const pairs = await dex.tokens(chain, addresses.slice(i, i + 30))
            for (const m of dex.toMarketSnapshots(chain, pairs)) {
              if (m.priceUsd > 0) prices.set(`${chain}:${m.address}`, m.priceUsd)
              // The whole market half, not only the price. It costs nothing —
              // the bytes are already here — and it is what lets the death
              // watch see a pool draining this cycle instead of next scan.
              liveMarkets.set(`${chain}:${m.address}`, m)
            }
          } catch {
            // Silence, not a verdict.
          }
        }
      }
      return prices
    },
    healthFor: async (position, candles) => {
      // *Sin congelamiento, sin caída de la muerte.* No observation: the watch
      // stays healthy, and no sell probe is asked.
      if (!config.deathWatch) return null
      try {
        // ── The scanner's verdict, folded in ONCE ──────────────────────────
        //
        // Seven of the eight invalidation signals used to be hardcoded null
        // here, so a token whose mint authority came back, whose LP was
        // unlocked, or whose pool drained could not be SEEN. The scan measures
        // all of it and was never asked.
        //
        // Once, and that is the load-bearing word. The death exit requires
        // `exitConfirmations` CONSECUTIVE observations carrying stage-2
        // evidence, precisely so one bad reading cannot liquidate a healthy
        // position. Feeding the same hour-old scan every five minutes would
        // turn one reading into twelve confirmations — the exact false
        // positive the rule exists to prevent, wearing the rule's own clothes.
        const scans = await scansForHealth()
        const snapshot =
          scans
            .find((scan) => scan.chain === position.chain)
            ?.snapshots.find((s) => s.address === position.tokenAddress) ?? null
        const scannedAt = scans.find((scan) => scan.chain === position.chain)?.scannedAt ?? 0
        const fresh = scannedAt > (foldedScanAt.get(position.id) ?? 0)
        if (fresh) foldedScanAt.set(position.id, scannedAt)
        // TWO halves on two clocks, and keeping them apart IS the safety.
        //
        // The SCAN folds ONCE, unchanged. Its security verdict is what
        // `exitConfirmations` counts, and replaying one reading every five
        // minutes would turn a single answer into twelve confirmations — the
        // exact false positive that rule exists to prevent, wearing its clothes.
        //
        // The LIVE liquidity is a NEW measurement every cycle, so handing it
        // over every cycle is reporting rather than repeating. Three
        // confirmations then come from three genuine readings fifteen minutes
        // apart, which is what the rule always meant. It is also the only
        // collapse a five-minute feed can carry, and the reason a freeze used
        // to arrive after the pool had already emptied.
        const live = liveMarkets.get(`${position.chain}:${position.tokenAddress}`)
        const scanner = healthForCycle(snapshot, DEFAULT_GATE_POLICY, live, fresh)

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
          source: scanner === UNMEASURED ? 'sell-probe' : 'sell-probe+scan',
          sellQuote: assessment.sellQuote,
          ...scanner,
          // Still unmeasured, and saying so is the point. Mapping holder
          // CONCENTRATION to holder MOVEMENT, or "the contract has a blacklist"
          // to "we are on it", would manufacture evidence out of facts that do
          // not mean what the signal needs them to mean.
          transfersBlocked: null,
          topHolderMovedPct: null,
          // Measured from the candles this tick already fetched: the newest bar
          // with volume is when somebody last traded this pool. The signal it
          // feeds — freeze at three hours, condemn at twelve — had never
          // fired, because this was hardcoded null for the life of the project.
          hoursSinceLastTrade: hoursSinceLastTrade(candles, Date.now()),
        }
      } catch {
        return null
      }
    },
    brokerFor,
    // The scanner's verdict is hours old BY DESIGN — cached security reports so
    // the budget can rotate, and a watch pass allocating from a shelf up to
    // twice the scan interval old. Right for ranking, wrong the moment capital
    // moves: between the scan and the buy a mint authority can come back, an LP
    // can be unlocked and a pool can be drained.
    //
    // So the chosen token is examined again from scratch — through the SAME
    // `examineToken` the scan uses, never a second implementation of what makes
    // a token safe — and the whole gate set runs on what comes back. Only for
    // the handful about to be opened, which costs a few seconds each.
    confirmEntry: (snapshot) =>
      confirmEntry(snapshot.address, async (address) => {
        // Fresh at the door, from the same source the scan priced it with.
        const market =
          snapshot.chain === 'solana'
            ? (await jupiterTokens.markets('solana', [address], { refresh: true }))[0]
            : dex.toMarketSnapshots(snapshot.chain, await dex.tokens(snapshot.chain, [address]))[0]
        if (!market) return null
        const { snapshot: examined } = await examineToken(
          {
            dex,
            // The same source the scan used, asked for ONE token: one request
            // to Jupiter and one to the chain, a second or so, where it was
            // GoPlus on its two-second interval plus a candle download.
            ...sourcesFor(snapshot.chain),
            // PATIENT here, and only here. The scan quoted this token a moment
            // ago; an unanswered re-quote is silence, not a verdict, and
            // refusing on it left prime tokens waiting whole cycles — *estuvieron
            // sin entrar unos minutos.* Sixty seconds at most, the operator's
            // own budget, and it stops the instant Jupiter answers.
            sellProbe: patientSellProbe(sellProbeFor(snapshot.chain), {
              budgetMs: 60_000,
              backoffMs: 1_000,
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            }),
            decimals: decimalsFor,
            ...(snapshot.chain === 'bsc' ? { history } : {}),
            // BSC only: see the scan's own `securityCache` below.
            ...(snapshot.chain === 'bsc' ? { securityCache: store } : {}),
          },
          { chain: snapshot.chain, referenceUsd: 100 },
          market,
          Date.now(),
          // Errors are not swallowed into a pass: `confirmEntry` fails closed on
          // an unreadable provider, and a gate that failed 'unknown' does too.
          (stage: ScanError['stage'], error: unknown) => console.warn('[confirm]', stage, String(error).slice(0, 200)),
        )
        // The candle price beside the market price, so `priceMismatch` decides
        // here too. `examineToken` fetches no candles at all now, so this is the
        // one place the door can ask.
        //
        // BSC only now. On Solana the tick makes the same check before any buy —
        // `pricesDisagree` against the candle close — and a position it refuses
        // to buy holds nothing and is released. Asking twice cost a throttled
        // GeckoTerminal download per candidate at the door.
        let lastCandlePriceUsd: number | null = null
        if (examined.chain === 'bsc') {
          try {
            const candles = await gecko.candles(examined.chain, examined.pairAddress, config.barSize, 2)
            lastCandlePriceUsd = candles.close.at(-1) ?? null
          } catch {
            lastCandlePriceUsd = null
          }
        }
        return { ...examined, lastCandlePriceUsd }
      }, gates, {
        // The same measurement the death watch reads, asked BEFORE the money
        // moves instead of three hours after. `idle-hours.ts` walks back to the
        // newest bar carrying volume; here it answers "can this engine see this
        // pool trade at all", which is a different question from "is this token
        // active" and the only one that decides whether a ladder can ever fill.
        //
        // Through the SAME route as the tick, by mint on Solana. Nobody able to
        // answer is not an answer: it throws, and the door refuses closed.
        barAgeHours: async (fresh) => {
          const candles = await candlesOf(fresh.chain, fresh.address, fresh.pairAddress, config.barSize, 300)
          if (candles === null) throw new Error('ninguna fuente de velas respondió')
          return hoursSinceLastTrade(candles, Date.now())
        },
        // The production gate policy's limit — off since the operator said
        // *sacá la protección de actividad*. A feed with no trades at all
        // still refuses the entry.
        maxBarAgeHours: DEFAULT_GATE_POLICY.maxBarAgeHours,
      }),
    // Every configured chain, each scan stored under its own chain so the
    // universe can show them together. One chain failing must not cost the
    // others their turn: a rate limit on Solana is not a reason to stop
    // looking at BSC.
    // What a WATCH pass allocates from: the last scan off the shelf, re-ranked
    // offline. Same policy, same gates, same measured impact — no network.
    // A free slot no longer waits out half an hour of throttled discovery
    // before anything can go in it.
    recall: async (slots) =>
      recallCandidates(store, {
        now: () => Date.now(),
        ranking: {
          gates,
          opportunity: DEFAULT_OPPORTUNITY_POLICY,
          smallCapFdvUsd: 50_000_000,
          // Never more candidates than the free capital can take — a stale
          // shelf included. *Que no haya más candidatos de los que el capital
          // pueda tomar.* Without a count, no ceiling when the book has none.
          watchSlots: slots ?? (config.maxPositions > 0 ? config.maxPositions : Number.POSITIVE_INFINITY),
          // The operator's order: the cheapest to trade first, before the cut.
          order: config.order,
          // A token we hold is never counted against the free slots.
          held: new Set((await store.loadPositions()).map((p) => `${p.chain}:${p.tokenAddress}`)),
          minScore: config.minScore,
          // *Sólo candidatas las que ya cumplan todas las condiciones.*
          reserve: config.reserve,
          // The SAME floors the live scan applies. A shelf that allocated on
          // looser rules than the scan that filled it would quietly undo them
          // every five minutes.
          minComponents: config.minComponents,
          requireRising: config.requireRising,
        },
        // The shelf, priced NOW, for one batched request per thirty tokens.
        //
        // A watch pass already re-ranked with no network at all — but it
        // re-ranked the SAME numbers, so nothing moved until the next full scan
        // an hour later. Since only what the engine may act on is stored the
        // shelf is about twenty tokens, and this makes every five-minute pass
        // act on current prices: a token that fell below what the book accepts
        // is dropped now, and the slot goes to whatever outscores it.
        //
        // The expensive half stands until a real scan replaces it, which is why
        // a full scan still exists.
        liveMarkets: async (snapshots) => {
          const markets = new Map<string, LiveMarket>()
          const byChain = new Map<Chain, string[]>()
          for (const s of snapshots) byChain.set(s.chain, [...(byChain.get(s.chain) ?? []), s.address])
          for (const [chain, addresses] of byChain) {
            for (let i = 0; i < addresses.length; i += 30) {
              try {
                const pairs = await dex.tokens(chain, addresses.slice(i, i + 30))
                for (const m of dex.toMarketSnapshots(chain, pairs)) {
                  if (m.priceUsd > 0) markets.set(`${chain}:${m.address}`, m)
                }
              } catch {
                // Never fatal: a slightly old universe beats no universe.
              }
            }
          }
          return markets
        },
        referenceUsd: 100,
        spreadPct: 0.3,
        // Twice the scan interval: one missed scan is a delay, two is a shelf
        // nobody should be spending from.
        maxAgeMs: 2 * config.scanIntervalMs,
      }),
    // What the last scan refused on a component floor — the switch, off.
    //
    // A closure rather than a wider `scan` return, and the reason is blast
    // radius: twenty call sites hand back a plain candidate list, and every
    // one of them would have to change to carry a field only the composition
    // root can fill. Not supplying it means no position is ever rotated, so
    // the safe answer is also the default.
    //
    // Reset per scan, never accumulated. A verdict from the pass before last
    // is not a verdict about now, and this one can SELL.
    switchedOff: () => lastSwitchedOff,
    rejected: () => lastRejected,
    scan: async (kind, betweenSteps, slots) => {
      lastSwitchedOff = []
      lastRejected = []
      const candidates: Candidate[] = []
      // What we already hold, per chain. Every universe source is a list of
      // what is POPULAR NOW, so a token bought six hours ago that has stopped
      // trending falls out of all of them — and then out of the maxTokens cut,
      // and then out of a security budget shared on opportunity score.
      // Measured in production: most open positions reporting "el escáner no la
      // encontró en este ciclo", which means nobody had re-checked their
      // honeypot answer since the day they were bought.
      const open = await store.loadPositions()
      // How many more tokens the capital can take — `freeSlots`, counted by the
      // cycle before it scans, the ONE definition the allocator's count comes
      // to. It drives everything below: how far discovery and the registry are
      // read, how many tokens the paid stage examines, how many candles are
      // bought and where the ranking cuts. *No hacemos lectura y búsqueda al
      // pedo.* Without a count, the capital over one slot, as before.
      const fundedSlots = slots ?? Math.max(1, Math.ceil(config.totalCapitalUsd / (config.usdPerToken ?? config.slotUsd)))
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
              // The thread, handed back between units of work. The cycle puts
              // the STOP in here — this is the wire that makes it reach
              // production, and without it the whole thing is an offline
              // rehearsal. Every gap this project has paid for was out here.
              ...(betweenSteps ? { betweenSteps } : {}),
              // Jupiter and the chain on Solana, GoPlus on BSC — the SAME
              // `sourcesFor` the door uses, so the two cannot disagree about
              // what makes a token safe.
              ...sourcesFor(chain),
              sellProbe: sellProbeFor(chain),
              // Held tokens WAIT for their sale quote, sixty seconds at most, the
              // operator's own budget: THREE was painted unsafe, and never
              // scored, because the runner's quote went unanswered once.
              patience: { budgetMs: 60_000, backoffMs: 1_000, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) },
              decimals: decimalsFor,
              // GeckoTerminal's pool discovery was 142 of the first 184 seconds
              // of a cold scan, measured, for a universe Jupiter's own lists
              // cover in under two. BSC keeps it: it has no other index.
              ...(chain === 'bsc' ? { history } : {}),
              // The permanent registry. It is the memory the discovery
              // providers do not have, and the operator's instruction about it
              // was one line: never delete it. Read, never written.
              store: registry,
              // BSC only now. It remembered every token EXAMINED — about 117 a
              // scan, candidates or not — because examining one meant a GoPlus
              // call on a two-second interval and repeating it was the cost.
              // On Solana an examination is a memory read after one batched
              // request, so the cache saves nothing and costs two things: a
              // write per examined token, against the operator's rule that
              // only candidates are stored — *no tenés que guardar todo, sólo
              // las candidatas* — and security answers up to two hours stale.
              ...(chain === 'bsc' ? { securityCache: store } : {}),
              // Can this engine SEE the token trade? Two providers disagreed —
              // GeckoTerminal reporting zero trades an hour where DexScreener
              // reported thirty-five on the same pool — and the engine was
              // buying on one and freezing on the other. The strategy is
              // bar-driven: no bars, no trade, ever.
              //
              // Through the shelf, so a pool already found quiet is refused
              // WITHOUT another download. Only the negative verdict is kept and
              // `confirmEntry` still asks live at the door, so nothing is ever
              // bought on a remembered answer.
              // ONE download, three answers: how many bars this pool has, how
              // long since the newest carried a trade, and what the candle feed
              // says it costs. They were three separate requests — the count
              // per AFFORDABLE token, the age per candidate, the price per
              // candidate again, about 205 a chain against the provider that
              // rate-limits hardest — and most of them for tokens the ranking
              // had already discarded.
              //
              // BSC only now. On Solana the scan asks Jupiter and the chain and
              // NO candles: this stage was one GeckoTerminal download per
              // candidate, up to one per funded slot, against the provider that
              // rate-limits hardest. The unit check it made — `priceMismatch` —
              // is made again by the tick before any buy, against the same
              // candle feed, and the stop has its own second-source guard.
              ...(chain === 'bsc'
                ? {
                    poolCandles: (snapshot: TokenSnapshot) =>
                      // `+ 1` because `candles` discards the bar still being
                      // built; see POOL_CANDLES.
                      gecko.candles(snapshot.chain, snapshot.pairAddress, config.barSize, POOL_CANDLES),
                  }
                : {}),
              // A scan spends minutes inside throttled calls. Saying where it
              // is turns a timeout from a mystery into a measurement.
              onProgress: (p) => console.log(`[scan:${p.stage}]`, JSON.stringify(p)),
            },
            {
              chain,
              // A HELD pass re-examines the book and discovers nothing: the
              // same gates, the same security call, the same sell quote, over
              // thirty tokens instead of five hundred. It is what lets the
              // expensive sweep be rare without leaving our own positions
              // unexamined for hours.
              //
              // And so does a full pass with NO free slot: *no hacemos lectura
              // y búsqueda al pedo.* Nothing is discovered, the registry is not
              // read and no stranger is quoted — only the book's own checks.
              discover: kind === 'full' && fundedSlots > 0,
              ranking: {
                gates,
                opportunity: DEFAULT_OPPORTUNITY_POLICY,
                // Fill with the small ones, complete with the big ones. The
                // gate admits up to $500M now; this is what keeps every small
                // cap ahead of every large one whatever the scores say, so a
                // big name only ever takes a slot nothing smaller wanted.
                smallCapFdvUsd: 50_000_000,
                // Never more candidates than the free capital can take: *que no
                // haya más candidatos de los que el capital pueda tomar; cuando
                // falten, que dependa del rescaneo.* A token we hold is never
                // counted against them — the scan tells the ranking which.
                watchSlots: slots ?? (config.maxPositions > 0 ? config.maxPositions : Number.POSITIVE_INFINITY),
                // *Que elija los que tengan mejor eficiencia de costos.* Before
                // the cut, so the cheapest to trade are never the ones cut.
                order: config.order,
                minScore: config.minScore,
                // *Sólo candidatas las que ya cumplan todas las condiciones.*
                reserve: config.reserve,
                // The operator's floors — today one: buy pressure strictly over
                // 10%. A weighted average can let one ruinous term be carried
                // by the rest — PURR charged 15.55% a round trip and was bought
                // anyway — and a floor is the only thing that says "this alone
                // disqualifies you".
                minComponents: config.minComponents,
                requireRising: config.requireRising,
              },
              // How many candle downloads are worth paying for: the number of
              // positions the capital can actually fund.
              //
              // Not a guess and not a margin — `scanOnce` asks for the
              // SHORTFALL and reaches for the next best score when one fails
              // its candle gates, so the exact figure is the right one. Given
              // to each chain in full rather than divided: the allocator picks
              // the best across both, and halving it would starve one chain on
              // a day the other had nothing.
              candleBudget: fundedSlots,
              // The paid stage — the chain's authorities and the sell quote —
              // stops once this many strangers have passed every gate, spending
              // in order of estimated cost efficiency. *Sólo revisá tokens
              // limitados hasta cubrir los cupos faltantes.*
              ...(slots !== undefined ? { wanted: slots } : {}),
              // As far as the registry may be read — a bound, not a size: it is
              // paged, and read only while the slots are short.
              registryTokens: config.registryTokens,
              // A shortlist the engine can act on. One candle request per
              // CANDIDATE — after the gates cut ninety percent — so about
              // thirty a scan rather than three hundred.
              // Set, so the candles are still downloaded — `priceMismatch` and
              // `history` read them — while the age itself no longer refuses.
              maxBarAgeHours: DEFAULT_GATE_POLICY.maxBarAgeHours,
              // Ours first: into the universe before discovery, past the cap,
              // and ahead of every candidate for the security budget.
              held: open.filter((p) => p.chain === chain).map((p) => p.tokenAddress),
              referenceUsd: 100,
              spreadPct: 0.3,
              // The whole visible universe: Jupiter's lists return ~220 unique
              // Solana tokens and GeckoTerminal adds BSC's pools; the free
              // gates cut that to what is worth paying for.
              // Raised with the cold deep sweep: three GeckoTerminal lists at
              // ten pages is up to six hundred pools per chain, and a cap of
              // three hundred would have thrown half of that away by ARRIVAL
              // ORDER — paying for the sweep and discarding its tail.
              //
              // Affordable because the expensive stage is capped separately.
              // Market data is one DexScreener call per thirty tokens and the
              // free gates cost nothing; security is bounded by
              // `maxSecurityChecks` and rotates through the cache, so a wider
              // universe reaches further over cycles instead of costing more
              // per cycle.
              // The cap must not be what decides the universe. Three lists at
              // GeckoTerminal ten-page ceiling is up to 600 pools per chain,
              // plus Jupiter lists and DexScreener boosts: about 700 unique,
              // which is exactly what 700 was sized for and therefore exactly
              // where it would start cutting.
              //
              // The expensive stage is bounded SEPARATELY and always was:
              // market data is one DexScreener call per thirty tokens, the free
              // gates cost nothing, and roughly one token in ten survives them.
              // A wider universe reaches further per scan rather than costing
              // proportionally more.
              //
              // No cap now: the FREE SLOTS bound the work — the registry is read
              // a page at a time only while they are short, and the paid stage
              // stops once they are covered. A count here would only decide the
              // universe by arrival order.
              maxTokens: Number.POSITIVE_INFINITY,
              // A bounded budget per chain, because each surviving token costs
              // about nine throttled seconds and a cycle has to finish inside
              // one bar. What it cannot reach is reported as unchecked rather
              // than dropped, and the next cycle is fifteen minutes away.
              // Lifted on the ONE pass where nothing has ever been examined.
              // A budget of twenty against a deep sweep of seven hundred would
              // look at under three percent of the universe and then open the
              // first positions out of that sample — and a slot handed out is a
              // commitment. Self-terminating: one examination and it is back.
              // Unbounded unless someone asked for a cap. Every scan is now the
              // full scan the cold start used to be alone in getting.
              ...(config.maxSecurityChecks === null ? {} : { maxSecurityChecks: config.maxSecurityChecks }),
            },
          )
          // Only what the engine may act on. 187 filtered and 108 unsafe cost
          // 227 KB against ONE kilobyte of tradeable tokens, and those bytes
          // are what a phone downloads on every poll.
          const keep = worthStoring(result.snapshots, result.candidates, open.filter((p) => p.chain === chain).map((p) => p.tokenAddress))
          console.log(`[scan:stored] ${chain} ${keep.length} de ${result.snapshots.length}`)
          await store.saveScan({ scannedAt: result.scannedAt, chain, snapshots: keep })
          candidates.push(...result.candidates)
          // Only for tokens we HOLD is this ever acted on, but it is collected
          // whole: the orchestrator does the matching, and a filter here would
          // be a second place that decides what counts as our own position.
          lastSwitchedOff.push(...result.switchedOff)
          lastRejected.push(...result.rejected)
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
      // The two numbers production differs on. Composed above, never by editing
      // DEFAULT_PARAMS — the parity harness asserts those are the backtest's
      // own inputs, and evidence that can be edited to express a preference has
      // stopped being evidence. The SAME object the rung funder prices with.
      params,
      // The same numbers the broker charges, so the ladder is sized against
      // the costs it will actually pay rather than against a guess.
      gasUsdPerSwap: config.gasUsdPerSwap,
      maxOpenEntries: config.maxDcaPerToken + 1,
      // What a slot's capital pays for: every step of its ladder.
      reservedEntries: config.reservedEntries,
      // The ladder is sized for the steps that can actually fill — and a $1
      // step is never refused, shrunk or merged by the fill floor: the floor is
      // the gas floor ($5 at $0.05) or the step, whichever is SMALLER. At a
      // dollar, gas is five percent of each buy; the operator chose the step.
      sizing: {
        ...DEFAULT_SIZING_POLICY,
        maxOpenEntries: config.maxDcaPerToken + 1,
        minFillUsd: Math.min(DEFAULT_SIZING_POLICY.minFillUsd, config.stepUsd),
      },
      portfolio: {
        ...DEFAULT_PORTFOLIO_POLICY,
        totalCapitalUsd: config.totalCapitalUsd,
        maxPositions: config.maxPositions,
        // No haircut on the COUNT: *el tope son 5000 dividido 50, que es lo que
        // tengo.* The fees come out of the free capital as the fills happen.
        reservePct: 0,
        // The cheapest to trade are served first, as the ranking ordered them.
        order: config.order === 'costEfficiency' || config.order === 'volatility' ? config.order : 'score',
      },
      // Exactly steps × step: what the allocator hands out and the trim keeps,
      // and what the free slots are counted in.
      slotUsd: config.slotUsd,
      ...(config.tiers ? { sizeFor: (snapshot: TokenSnapshot) => admittedUsd(snapshot, config.minTier) } : {}),
      heartbeatMs: 60 * 60 * 1000,
      // So a pass can tell whether a position has a new bar to look at before
      // paying a throttled request to find out.
      barMs: config.barSize.timeframe === 'hour' ? 60 * 60 * 1000 : (config.barSize.aggregate ?? 1) * 60_000,
      // Recover the funds instead of holding a position that can neither buy
      // nor sell.
      exitOnFreeze: config.exitOnFreeze,
      // And never buy it back: the token is blacklisted once its slot is
      // released holding nothing — never at the verdict, while a sale may
      // still be waiting to fill.
      blacklistOnFreeze: config.blacklistOnFreeze,
      // Two hours without a trade freezes it, and the freeze sells it. The
      // SAME object the dip-bounce sweep reads its freeze line from.
      deathPolicy,
      // A slot handed to a token that never enters is capital held against
      // nothing. Measured live at five hours and twenty minutes.
      // The stop, composed HERE rather than defaulted in the orchestrator —
      // the same discipline the ladder cap and the entry drop follow. It is the
      // only path in this engine where a PRICE sells, so a caller that says
      // nothing must get the reference behaviour.
      stopLoss: config.stopLoss,
      maxCostSharePct: config.maxCostSharePct,
      rewardRiskRatio: config.rewardRiskRatio,
      breakEven: config.breakEven,
      // *Poné el break-even en 7.5.* Arms at +7.5%, sells an armed position on
      // a fall back to +7.5%. Composed here so the cycle's sweeps and the
      // loop's read the same two lines.
      breakEvenArmPct: config.breakEvenArmPct,
      breakEvenFloorPct: config.breakEvenFloorPct,
      // *Si pasás el 20% de ganancia, break-even en el 10%.* The staircase, or
      // null when switched off — composed here so the cycle's sweeps and the
      // loop's read the same one.
      gainLock: config.gainLock,
      // *Poné un TP fijo al 12.5% del promedio.* Zero is off — composed here
      // so the cycle's sweeps and the loop's read the same line.
      fixedTpPct: config.fixedTpPct,
      maxStopPct: config.maxStopPct,
      usdPerToken: config.usdPerToken,
      // *Para la primera compra: expansión del volumen más del 50% y tendencia
      // más del 50%.* Applied only to what the cycle would open.
      entryDoors: config.entryDoors,
      scoreStopPoints: config.scoreStopPoints,
      // Off by default: *lo demás, sólo salí si el TP se cumple.*
      rotateOnFilter: config.rotateOnFilter,
      idleSlots: {
        // *Si el token ha perdido menos del 1.2% y la moneda está en un puntaje
        // bajo, cambiarla por una mejor y asumir esa pequeña pérdida.*
        //
        // A TOLL, not a trigger: no amount of falling makes it fire, only a
        // better candidate does. Composed here because it is the first thing
        // allowed to sell a position the allocator did not have to sell.
        maxSwapLossPct: config.maxSwapLossPct,
        // Off by default: only a position's own exits close it.
        swapHolders: config.swapHolders,
        idleAfterMs: config.idleSlotHours * 60 * 60 * 1000,
        // "Better" is the operator's order: ten points of cost efficiency for a
        // reservation to change hands — or the score, when the old order is back.
        ...(config.order === 'costEfficiency'
          ? { minScoreEdge: config.minCostEdgePct, measure: 'costEfficiency' as const }
          : { minScoreEdge: config.minScoreEdge }),
      },
    },
    throttle: new AlertThrottle(30 * 60 * 1000),
  }
}

export const schemaSql = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../infrastructure/persistence/schema.sql'), 'utf8')

/** Entry point. Wired only when this file is executed directly. */
/**
 * How many candles the PAID stage downloads per examined pool.
 *
 * A FIXED number, and that is the whole point of it existing. It used to be
 * `minHistoryBars * 3 + 1`, derived from the history gate — and the history
 * gate went to ZERO when door 3 removed the need for indicators, so the
 * request became one candle, the adapter discarded the bar still being built,
 * and every examined pool came back with NONE.
 *
 * No bars is not silence: it is the strongest form of *this engine cannot
 * watch this pool*, so `staleBars` refused the entire universe. One candidate
 * survived a scan that had twenty.
 *
 * The comment on that call already warned about this exact shape — *asking for
 * exactly the threshold once produced 99 against a minimum of 100 and emptied
 * the entire book* — and the lesson generalises past the off-by-one: a
 * DOWNLOAD SIZE must never be derived from a THRESHOLD, because a threshold is
 * allowed to become zero and a download size is not.
 *
 * These candles serve `staleBars` and `priceMismatch`, which need the newest
 * usable bar, and they report the history count for the screen. Sixty is
 * fifteen hours at 15m: enough for the freshness answer to be solid and to
 * saturate a count nobody gates on any more.
 */
const POOL_CANDLES = 60

/** How long an alert is kept: three days, pruned at every engine start. */
export const ALERT_RETENTION_MS = 3 * 86_400_000

export async function main(ports: RuntimePorts): Promise<void> {
  const config = loadConfig()
  console.log('[boot]', JSON.stringify(describeConfig(config)))

  const store = new PostgresStore(ports.sql)
  await store.migrate(schemaSql())
  // *Sólo guardemos los datos que nos sirvan.* Alerts older than three days are
  // let go at every start: the phone reads forward from a cursor and never
  // needs them, and the table only ever grew. Never fatal.
  await store.pruneAlerts(Date.now() - ALERT_RETENTION_MS).catch((error) => console.error('[alerts:prune]', error))

  const { deps, cycleConfig, throttle } = buildRuntime(config, ports)

  const stopSignal = shutdownSignal()

  const report = await runLoop(deps, cycleConfig, throttle, {
    intervalMs: config.cycleIntervalMs,
    // Watching and hunting are paced separately. Most passes only look after
    // what is already open, which costs a candle request and a sell probe per
    // position instead of a scan.
    scanIntervalMs: config.scanIntervalMs,
    heldScanIntervalMs: config.heldScanIntervalMs,
    stopSignal,
    // 0 means run forever. A scheduler sets 1 and gets a single cycle.
    ...(config.maxCycles > 0 ? { maxCycles: config.maxCycles } : {}),
    // Every pass, not just the ones that scan. Without this a watch pass was
    // four minutes of empty log, which reads as a hung process rather than an
    // engine quietly advancing bars.
    onPass: (result, elapsedMs) => {
      const bars = result.ticks.reduce((most, tick) => Math.max(most, tick.barsAdvanced), 0)
      console.log(
        `[${result.kind}]`,
        JSON.stringify({
          positions: result.ticks.length,
          bars,
          opened: result.opened.length,
          released: result.releasedIds.length,
          unreachable: result.unreachableIds.length,
          halted: result.haltedIds.length,
          seconds: Math.round(elapsedMs / 1000),
        }),
      )
    },
  })

  console.log('[exit]', JSON.stringify(report.stoppedBy), report.cycles, 'cycles')
}
