import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { scanOnce } from './scan.js'
import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { GeckoTerminal } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'
import { makeHttpGet, makeThrottle } from '../infrastructure/http.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'

/**
 * COLLECTOR — hits every live API once and writes a dataset to disk.
 *
 *   OPERADOR_SMOKE=1 npx vitest run src/application/collect-dataset.smoke.test.ts
 *
 * Separated from the analysis on purpose. Provider throttles make a full pass
 * take minutes, and an experiment you can only run by waiting on rate limits
 * is an experiment you will not re-run. The dataset is a fixture: the capital
 * floor analysis then runs in milliseconds, in the normal suite, over the same
 * recorded market — which also makes its conclusions reproducible.
 */
const SMOKE = process.env.OPERADOR_SMOKE === '1'
const OUT = 'tools/golden/solana-dataset.json'

describe.skipIf(!SMOKE)('collect — live Solana dataset', () => {
  it('scans, fetches candles, and writes the dataset', async () => {
    const http = makeHttpGet({ timeoutMs: 20_000 })
    const jupiterThrottle = makeThrottle(1_100)

    const scan = await scanOnce(
      {
        dex: new DexScreener(http),
        goplus: new GoPlus(http),
        jupiter: new Jupiter(http, jupiterThrottle),
        decimals: new JupiterTokens(http, jupiterThrottle),
      },
      {
        chain: 'solana',
        ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 6, minScore: 0 },
        referenceUsd: 100,
        spreadPct: 0.3,
        maxTokens: 60,
      },
    )
    console.log(`scanned ${scan.snapshots.length}, candidates: ${scan.candidates.map((c) => c.snapshot.symbol).join(', ')}`)

    const gecko = new GeckoTerminal(http, makeThrottle(2_500))
    const tokens = []

    for (const candidate of scan.candidates) {
      try {
        // One page is 1000 bars (~41 days of 1H) — enough, and one request.
        const candles = await gecko.candles('solana', candidate.snapshot.pairAddress, 'hour', 1000)
        console.log(`  ${candidate.snapshot.symbol}: ${candles.time.length} bars`)
        tokens.push({ snapshot: candidate.snapshot, quality: candidate.marketQuality, opportunity: candidate.opportunity, candles })
      } catch (error) {
        console.log(`  ${candidate.snapshot.symbol}: candles unavailable — ${String(error).slice(0, 80)}`)
      }
    }

    mkdirSync('tools/golden', { recursive: true })
    writeFileSync(OUT, JSON.stringify({
      collectedAt: Date.now(),
      chain: 'solana',
      scanned: scan.snapshots.length,
      rejected: scan.rejected.length,
      errors: scan.errors,
      tokens,
    }, null, 1) + '\n')

    console.log(`\nwrote ${OUT}: ${tokens.length} tokens with candles`)
    expect(tokens.length).toBeGreaterThan(0)
  }, 1_500_000)
})
