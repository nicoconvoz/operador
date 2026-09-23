import { Console } from '../console.js'
import type { DashboardView } from '../../../src/application/dashboard.js'
import type { UniverseToken, UniverseView, TokenTier } from '../../../src/application/universe-view.js'
import { buildOperations } from '../../../src/application/operations-view.js'
import { MemoryStore } from '../../../src/infrastructure/persistence/memory-store.js'
import { initialState } from '../../../src/domain/strategy/state.js'
import { startDeathWatch } from '../../../src/domain/risk/death-exit.js'
import { DEFAULT_PARAMS } from '../../../src/domain/strategy/params.js'
import { triggerPrice, usdForLevel } from '../../../src/domain/strategy/ladder.js'
import type { PersistedFill, PersistedPosition } from '../../../src/domain/persistence/store.js'

/**
 * A universe with no database behind it, so the view can be seen and judged
 * before the engine has ever run. Synthetic, and labelled as such — a demo
 * that pretends to be live is how people end up trusting a screenshot.
 */
export const dynamic = 'force-static'

const SYMBOLS = ['DREGG', 'TROLL', 'LEAFY', 'SQUIRE', 'EMBER', 'HEV', 'CATE', 'STONK', 'ANTFUN', 'NIGHT', 'PEPE2', 'WAGMI', 'MOONZ', 'BONKR', 'SOLAR', 'VOID', 'GLITCH', 'NOVA', 'RUNE', 'ECHO', 'PIXEL', 'ZEN', 'KARMA', 'FLUX', 'ORBIT', 'QUARK', 'HALO', 'DRIFT', 'CINDER', 'VAPOR']

const make = (i: number): UniverseToken => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  const tier: TokenTier =
    i < 3 ? 'held' : i < 9 ? 'prime' : i < 17 ? 'eligible' : i < 24 ? 'filtered' : i < 60 ? 'pending' : i < 76 ? 'unsafe' : 'dead'
  const chain = r(1) > 0.6 ? 'bsc' : 'solana'
  const liquidityUsd = 20_000 + r(2) ** 3 * 4_000_000
  return {
    id: `${chain}:T${i}`,
    symbol: SYMBOLS[i % SYMBOLS.length]!,
    chain,
    address: `T${i}`,
    pairAddress: `P${i}`,
    tier,
    // One of the three held positions has turned, so the demo shows the alarm
    // rather than only the happy sky. A demo where nothing ever goes wrong
    // teaches the wrong thing about a system whose job is to notice when it
    // does.
    turnedUnsafe: tier === 'held' && i === 1,
    score: tier === 'held' ? 70 + r(3) * 25 : tier === 'prime' ? 48 + r(3) * 40 : tier === 'eligible' ? 20 + r(3) * 25 : r(3) * 30,
    components: {
      volumeExpansion: r(4), buyPressure: r(5), liquidityGrowth: r(6),
      activity: r(7), volatility: r(8), costEfficiency: r(9),
    },
    liquidityUsd,
    volume24hUsd: liquidityUsd * (0.2 + r(10) * 3),
    priceUsd: 0.0001 + r(11) * 0.05,
    change24hPct: (r(12) - 0.4) * 60,
    ageHours: 24 + r(13) * 2000,
    frictionPct: 0.6 + (1 - r(2)) * 6,
    blockers: (tier === 'held' && i === 1) || tier === 'unsafe'
      ? ['mint authority still active']
      : tier === 'filtered'
        ? ['liquidity $12000 < $20000']
        : tier === 'dead'
          ? ['sell quote failed']
          : [],
    // The demo shows WHY a filtered token waits, as the live screen does.
    holdBack: tier === 'filtered' ? [{ kind: 'entry' as const, name: 'volumeExpansion', value: 0.49, floor: 0.5 }] : [],
    position: tier === 'held'
      ? {
          capitalUsd: 200,
          holdsTokens: true,
          filledDcas: Math.floor(r(14) * 5),
          deathStage: i === 2 ? 'frozen' : 'healthy',
          // The demo shows the REASON too, because a snowflake with no reason
          // is the exact state that sent the operator to the database.
          deathSignals: i === 2 ? ['liquidity $41000 = 34.2% of entry'] : [],
        }
      : null,
  }
}

const tokens = Array.from({ length: 80 }, (_, i) => make(i))

const view: UniverseView = {
  generatedAt: Date.now(),
  scannedAt: Date.now() - 4 * 60_000,
  tokens,
  counts: {
    held: tokens.filter((t) => t.tier === 'held').length,
    prime: tokens.filter((t) => t.tier === 'prime').length,
    eligible: tokens.filter((t) => t.tier === 'eligible').length,
    reserve: tokens.filter((t) => t.tier === 'reserve').length,
    pending: tokens.filter((t) => t.tier === 'pending').length,
    filtered: tokens.filter((t) => t.tier === 'filtered').length,
    unsafe: tokens.filter((t) => t.tier === 'unsafe').length,
    dead: tokens.filter((t) => t.tier === 'dead').length,
  },
  chains: ['bsc', 'solana'],
}

/**
 * Synthetic BOOKS, not synthetic numbers.
 *
 * Rather than hand-writing a P&L that looks plausible, this seeds fake fills
 * into a real store and runs the real read model over them. If the maths on
 * this page is wrong, the maths in production is wrong too — which is the only
 * kind of demo worth looking at.
 */
const NOW = Date.now()
const MIN = 60_000

async function demoOperations() {
  const store = new MemoryStore()
  const held = tokens.filter((t) => t.tier === 'held')

  for (const [index, token] of held.entries()) {
    const filled = Math.max(1, token.position!.filledDcas)
    // One winner, one grinder, one underwater — a demo where every position
    // shows the same P&L teaches nothing about reading the screen.
    const entry = token.priceUsd * [0.82, 1.03, 1.19][index % 3]!
    const openedAt = NOW - (90 + index * 40) * MIN

    const position: PersistedPosition = {
      id: `pos-${token.address}`,
      chain: token.chain === 'bsc' ? 'bsc' : 'solana',
      tokenAddress: token.address,
      pairAddress: token.pairAddress,
      symbol: token.symbol,
      cascade: { ...initialState(), level: filled + 1, ep1: entry, wasInTrade: true },
      deathWatch: { ...startDeathWatch(token.liquidityUsd, openedAt), stage: token.position!.deathStage },
      quality: { liquidityUsd: token.liquidityUsd, spreadPct: 0.3, slippagePct: 0.4, referenceUsd: 100, observedAt: NOW },
      capitalUsd: token.position!.capitalUsd,
      lastBarTime: NOW,
      lastPriceUsd: token.priceUsd,
      pendingOrders: index === 0 ? [{ kind: 'entry', id: `DCA-${filled + 1}`, level: filled + 1, usd: 30, qty: 1, comment: 'pending' }] : [],
      openedAt,
      updatedAt: NOW,
    }
    await store.savePosition(position)

    for (let level = 0; level <= filled; level += 1) {
      const price = level === 0 ? entry : triggerPrice(DEFAULT_PARAMS, entry, level)
      const usd = Math.min(usdForLevel(DEFAULT_PARAMS, level), 18)
      const orderId = level === 0 ? 'Entry' : `DCA-${level}`
      const fill: PersistedFill = {
        positionId: position.id,
        orderId,
        side: 'buy',
        time: openedAt + level * 17 * MIN,
        price,
        qty: usd / price,
        costUsd: usd * 0.009 + 0.05, // spread and impact, plus the chain's cut
        comment: orderId,
        idempotencyKey: `${position.id}:${orderId}`,
      }
      await store.recordFill(fill)
    }
  }

  return buildOperations(store, { now: () => NOW, params: DEFAULT_PARAMS })
}

export default async function Demo() {
  const operations = await demoOperations()

  const dashboard: DashboardView = {
    generatedAt: NOW,
    killSwitchEngaged: false,
    lastCompletedBar: NOW,
    positions: [],
    totals: { positions: operations.positions.length, committedUsd: 600, frozen: 1, pending: 1 },
    blacklistedCount: 2,
    lastScan: { at: NOW - 4 * MIN, tokensSeen: tokens.length },
    warnings: [],
  }

  return (
    <>
      <div style={{ color: '#ffb454', fontSize: 12, marginBottom: 8 }}>DEMO — datos sintéticos</div>
      {/* live={false}: there is no database behind this page, so polling it
          would only produce an error banner over data that is fine. */}
      <Console initial={{ dashboard, universe: view, operations }} live={false} />
    </>
  )
}
