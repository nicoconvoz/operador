import { describe, it, expect } from 'vitest'
import { scanOnce } from './scan.js'
import { paperRun } from './paper-run.js'
import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { GeckoTerminal } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'

/**
 * THE CAPITAL FLOOR EXPERIMENT — the question this project exists to answer.
 *
 * Scans Solana for real candidates, pulls their real 1H candles, and paper
 * trades each one at several starting capitals with spread, impact and gas
 * charged honestly. The output is not a promise of returns; it is the answer
 * to "below what capital does this strategy stop working at all".
 *
 *   OPERADOR_SMOKE=1 npx vitest run src/application/capital-floor.smoke.test.ts
 */
const SMOKE = process.env.OPERADOR_SMOKE === '1'

const CAPITALS = [1, 100, 500, 2_000, 10_000]
const GAS_USD_PER_SWAP = 0.05 // Solana priority fee, conservative

describe.skipIf(!SMOKE)('capital floor — live Solana', () => {
  it('paper trades real candidates at several capitals', async () => {
    const http = makeHttpGet({ timeoutMs: 20_000 })
    const jupiterThrottle = makeThrottle(1_100)
    const geckoThrottle = makeThrottle(3_000)

    const scan = await scanOnce(
      {
        dex: new DexScreener(http),
        goplus: new GoPlus(http),
        jupiter: new Jupiter(http, jupiterThrottle),
        decimals: new JupiterTokens(http, jupiterThrottle),
      },
      {
        chain: 'solana',
        ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 4, minScore: 0 },
        referenceUsd: 100,
        spreadPct: 0.3,
        maxTokens: 60,
      },
    )

    console.log(`\ncandidates: ${scan.candidates.map((c) => c.snapshot.symbol).join(', ') || '(none)'}\n`)

    const gecko = new GeckoTerminal(http, geckoThrottle)
    const rows: Record<string, unknown>[] = []

    for (const candidate of scan.candidates) {
      let candles
      try {
        candles = await gecko.history('solana', candidate.snapshot.pairAddress, 600)
      } catch (error) {
        rows.push({ token: candidate.snapshot.symbol, note: `candles unavailable: ${String(error).slice(0, 60)}` })
        continue
      }
      if (candles.time.length < 250) {
        rows.push({ token: candidate.snapshot.symbol, note: `only ${candles.time.length} bars of history` })
        continue
      }

      for (const initialCapital of CAPITALS) {
        const run = paperRun(candidate.snapshot, candidate.marketQuality, candles, {
          params: DEFAULT_PARAMS,
          gasUsdPerSwap: GAS_USD_PER_SWAP,
          initialCapital,
          maxOpenEntries: 10,
        })
        if (!run.tradeable) {
          rows.push({ token: candidate.snapshot.symbol, capital: initialCapital, verdict: 'REFUSED', why: run.reason })
          continue
        }
        const s = run.summary!
        rows.push({
          token: candidate.snapshot.symbol,
          capital: initialCapital,
          bars: s.bars,
          cycles: s.cycles,
          trades: `${s.wins}/${s.closedTrades}`,
          gross: +s.grossPnlUsd.toFixed(2),
          costs: +s.closedCostsUsd.toFixed(2),
          net: +s.netPnlUsd.toFixed(2),
          equity: +s.equityUsd.toFixed(2),
          'return%': +s.returnPct.toFixed(2),
        })
      }
    }

    console.table(rows)
    expect(scan.snapshots.length).toBeGreaterThan(0)
  }, 600_000)
})
