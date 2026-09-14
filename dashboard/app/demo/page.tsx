import { Universe } from '../universe.js'
import type { UniverseToken, UniverseView, TokenTier } from '../../../src/application/universe-view.js'

/**
 * A universe with no database behind it, so the view can be seen and judged
 * before the engine has ever run. Synthetic, and labelled as such — a demo
 * that pretends to be live is how people end up trusting a screenshot.
 */
export const dynamic = 'force-static'

const SYMBOLS = ['DREGG', 'TROLL', 'LEAFY', 'SQUIRE', 'EMBER', 'HEV', 'CATE', 'STONK', 'ANTFUN', 'NIGHT', 'PEPE2', 'WAGMI', 'MOONZ', 'BONKR', 'SOLAR', 'VOID', 'GLITCH', 'NOVA', 'RUNE', 'ECHO', 'PIXEL', 'ZEN', 'KARMA', 'FLUX', 'ORBIT', 'QUARK', 'HALO', 'DRIFT', 'CINDER', 'VAPOR']

const make = (i: number): UniverseToken => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  const tier: TokenTier = i < 3 ? 'held' : i < 9 ? 'prime' : i < 17 ? 'eligible' : i < 24 ? 'filtered' : i < 28 ? 'unsafe' : 'dead'
  const chain = r(1) > 0.6 ? 'bsc' : 'solana'
  const liquidityUsd = 20_000 + r(2) ** 3 * 4_000_000
  return {
    id: `${chain}:T${i}`,
    symbol: SYMBOLS[i % SYMBOLS.length]!,
    chain,
    address: `T${i}`,
    pairAddress: `P${i}`,
    tier,
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
    blockers: tier === 'unsafe'
      ? ['mint authority still active']
      : tier === 'filtered'
        ? ['liquidity $12000 < $20000']
        : tier === 'dead'
          ? ['sell quote failed']
          : [],
    position: tier === 'held'
      ? { capitalUsd: 200, filledDcas: Math.floor(r(14) * 5), deathStage: i === 2 ? 'frozen' : 'healthy' }
      : null,
  }
}

const tokens = Array.from({ length: 30 }, (_, i) => make(i))

const view: UniverseView = {
  generatedAt: Date.now(),
  scannedAt: Date.now() - 4 * 60_000,
  tokens,
  counts: {
    held: tokens.filter((t) => t.tier === 'held').length,
    prime: tokens.filter((t) => t.tier === 'prime').length,
    eligible: tokens.filter((t) => t.tier === 'eligible').length,
    filtered: tokens.filter((t) => t.tier === 'filtered').length,
    unsafe: tokens.filter((t) => t.tier === 'unsafe').length,
    dead: tokens.filter((t) => t.tier === 'dead').length,
  },
  chains: ['bsc', 'solana'],
}

export default function Demo() {
  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontSize: 17, margin: 0 }}>Operador by Open Doors</h1>
        <span style={{ color: '#ffb454' }}>DEMO — synthetic data</span>
      </header>
      <Universe view={view} />
      <footer style={{ marginTop: 18, color: '#8b949e', fontSize: 12 }}>
        size = liquidity · rings = opportunity · glow = in position · ◆ bsc ● solana
      </footer>
    </>
  )
}
