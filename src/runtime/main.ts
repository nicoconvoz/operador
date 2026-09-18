import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AlertThrottle } from '../domain/notifications/alerts.js'
import { DEFAULT_GATE_POLICY, minAgeForHistory, type GatePolicy } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { DEFAULT_PORTFOLIO_POLICY } from '../domain/risk/portfolio.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { DEFAULT_COMPONENT_FLOORS } from '../application/production-doors.js'
import { type SwitchedOff } from '../domain/scanner/ranking.js'
import { ladderCapitalUsd } from '../application/paper-run.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { type Candidate } from '../domain/scanner/ranking.js'

import { scanOnce, examineToken, type ScanError } from '../application/scan.js'
import { type CycleConfig, type CycleDeps } from '../application/orchestrator.js'

import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GeckoTerminal, barMinutes } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { PancakeSwap, jsonRpcEthCall } from '../infrastructure/adapters/pancakeswap/pancakeswap.js'
import { Erc20Decimals } from '../infrastructure/adapters/pancakeswap/erc20-decimals.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { makeAdaptiveThrottle } from '../infrastructure/adaptive-throttle.js'
import { makeHedgedGet } from '../infrastructure/hedged-get.js'
import { PaperBroker } from '../infrastructure/brokers/paper-broker.js'
import { PostgresStore, type SqlClient } from '../infrastructure/persistence/postgres-store.js'
import { StoredAlertSink } from '../infrastructure/notifications/store-alerts.js'

import { loadConfig, describeConfig, type RuntimeConfig } from './config.js'
import { DEFAULT_SIZING_POLICY } from '../domain/economics/sizing.js'
import { recallCandidates } from '../application/recall.js'
import { healthFromSnapshot, UNMEASURED } from '../application/health-from-scan.js'
import { hoursSinceLastTrade } from '../application/idle-hours.js'
import { confirmEntry } from '../application/confirm-entry.js'
import { CachedDiscovery } from '../infrastructure/adapters/geckoterminal/cached-discovery.js'
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

  const store = new PostgresStore(ports.sql)
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

  // And the cheapest rejection of all: one that needs no request. A pool younger
  // than `minHistoryBars` bars CANNOT hold them, so it is refused by
  // subtraction instead of by a candle download it was always going to fail.
  // Never lowers the standing 24h floor — that answers a different question.
  const gates: GatePolicy = {
    ...DEFAULT_GATE_POLICY,
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
  const brokers = new Map<string, PaperBroker>()
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

  let lastSwitchedOff: SwitchedOff[] = []

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
    marketPrices: async (positions) => {
      const prices = new Map<string, number>()
      const byChain = new Map<Chain, string[]>()
      for (const p of positions) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.tokenAddress])
      for (const [chain, addresses] of byChain) {
        for (let i = 0; i < addresses.length; i += 30) {
          try {
            const pairs = await dex.tokens(chain, addresses.slice(i, i + 30))
            for (const m of dex.toMarketSnapshots(chain, pairs)) {
              if (m.priceUsd > 0) prices.set(`${chain}:${m.address}`, m.priceUsd)
            }
          } catch {
            // Silence, not a verdict.
          }
        }
      }
      return prices
    },
    healthFor: async (position, candles) => {
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
        const scanner = fresh ? healthFromSnapshot(snapshot, DEFAULT_GATE_POLICY.minLpLockedPct) : UNMEASURED

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
        const pairs = await dex.tokens(snapshot.chain, [address])
        const market = dex.toMarketSnapshots(snapshot.chain, pairs)[0]
        if (!market) return null
        const { snapshot: examined } = await examineToken(
          {
            dex,
            goplus,
            sellProbe: sellProbeFor(snapshot.chain),
            decimals: decimalsFor,
            history,
            // Recorded, so the next scan does not repeat an examination made
            // seconds ago. A fresh look is a fresh look whoever asked for it.
            securityCache: store,
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
        let lastCandlePriceUsd: number | null = null
        try {
          const candles = await gecko.candles(examined.chain, examined.pairAddress, config.barSize, 2)
          lastCandlePriceUsd = candles.close.at(-1) ?? null
        } catch {
          lastCandlePriceUsd = null
        }
        return { ...examined, lastCandlePriceUsd }
      }, gates, {
        // The same measurement the death watch reads, asked BEFORE the money
        // moves instead of three hours after. `idle-hours.ts` walks back to the
        // newest bar carrying volume; here it answers "can this engine see this
        // pool trade at all", which is a different question from "is this token
        // active" and the only one that decides whether a ladder can ever fill.
        barAgeHours: async (fresh) => {
          const candles = await gecko.candles(fresh.chain, fresh.pairAddress, config.barSize, 300)
          return hoursSinceLastTrade(candles, Date.now())
        },
        // One hour: it matches `minHourlyTxns`'s own window, and it leaves the
        // three-hour abandonment freeze clear room. Admitting a token whose
        // newest bar is already two hours old is admitting one that freezes
        // within the hour.
        maxBarAgeHours: 1,
      }),
    // Every configured chain, each scan stored under its own chain so the
    // universe can show them together. One chain failing must not cost the
    // others their turn: a rate limit on Solana is not a reason to stop
    // looking at BSC.
    // What a WATCH pass allocates from: the last scan off the shelf, re-ranked
    // offline. Same policy, same gates, same measured impact — no network.
    // A free slot no longer waits out half an hour of throttled discovery
    // before anything can go in it.
    recall: () =>
      recallCandidates(store, {
        now: () => Date.now(),
        ranking: {
          gates,
          opportunity: DEFAULT_OPPORTUNITY_POLICY,
          smallCapFdvUsd: 50_000_000,
          watchSlots: config.maxPositions > 0 ? config.maxPositions : 50,
          minScore: config.minScore,
          // The SAME floors the live scan applies. A shelf that allocated on
          // looser rules than the scan that filled it would quietly undo them
          // every five minutes.
          minComponents: DEFAULT_COMPONENT_FLOORS,
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
    scan: async (kind) => {
      lastSwitchedOff = []
      const candidates: Candidate[] = []
      // What we already hold, per chain. Every universe source is a list of
      // what is POPULAR NOW, so a token bought six hours ago that has stopped
      // trending falls out of all of them — and then out of the maxTokens cut,
      // and then out of a security budget shared on opportunity score.
      // Measured in production: most open positions reporting "el escáner no la
      // encontró en este ciclo", which means nobody had re-checked their
      // honeypot answer since the day they were bought.
      const open = await store.loadPositions()
      // Priced exactly as the allocator prices it, so the scan buys candles for
      // the number of positions the capital will actually open — not one more.
      const fundedSlots = Math.max(1, Math.ceil(
        config.totalCapitalUsd /
        ladderCapitalUsd(
          { ...DEFAULT_PARAMS, maxUsdPerLevel: config.maxUsdPerLevel, dropInitPct: config.dropInitPct },
          config.maxDcaPerToken + 1,
          config.gasUsdPerSwap,
        ),
      ))
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
              poolCandles: (snapshot) =>
                // `+ 1` because `candles` discards the bar still being built.
                // That compensation used to live inside `historyBars`, beside
                // the discard, precisely so a caller could not get it wrong —
                // and this is a new caller that bypasses it. Asking for exactly
                // the threshold once produced 99 against a minimum of 100 and
                // emptied the entire book.
                gecko.candles(snapshot.chain, snapshot.pairAddress, config.barSize, DEFAULT_GATE_POLICY.minHistoryBars * 3 + 1),
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
              discover: kind === 'full',
              ranking: {
                gates,
                opportunity: DEFAULT_OPPORTUNITY_POLICY,
                // Fill with the small ones, complete with the big ones. The
                // gate admits up to $500M now; this is what keeps every small
                // cap ahead of every large one whatever the scores say, so a
                // big name only ever takes a slot nothing smaller wanted.
                smallCapFdvUsd: 50_000_000,
                watchSlots: config.maxPositions > 0 ? config.maxPositions : 50,
                minScore: config.minScore,
                // The operator's floors: without cost, headroom AND trend all
                // above thirty percent, it is not a coin to trade. A weighted
                // average can let one ruinous term be carried by the rest —
                // PURR charged 15.55% a round trip and was bought anyway — and
                // a floor is the only thing that says "this alone disqualifies
                // you". Measured on a live book of 29: 8 survive.
                minComponents: DEFAULT_COMPONENT_FLOORS,
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
              // A shortlist the engine can act on. One candle request per
              // CANDIDATE — after the gates cut ninety percent — so about
              // thirty a scan rather than three hundred.
              maxBarAgeHours: 1,
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
              maxTokens: 5_000,
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
      // The two numbers production differs on. Composed here, never by editing
      // DEFAULT_PARAMS — the parity harness asserts those are the backtest's
      // own inputs, and evidence that can be edited to express a preference has
      // stopped being evidence.
      params: {
        ...DEFAULT_PARAMS,
        maxUsdPerLevel: config.maxUsdPerLevel,
        dropInitPct: config.dropInitPct,
        impatientProfitPct: config.impatientProfitPct,
        urgentProfitPct: config.urgentProfitPct,
      },
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
      // So a pass can tell whether a position has a new bar to look at before
      // paying a throttled request to find out.
      barMs: config.barSize.timeframe === 'hour' ? 60 * 60 * 1000 : (config.barSize.aggregate ?? 1) * 60_000,
      // Recover the funds instead of holding a position that can neither buy
      // nor sell. The token is not blacklisted: it goes back to the filtered
      // pile and may be bought again the day it recovers.
      exitOnFreeze: config.exitOnFreeze,
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
