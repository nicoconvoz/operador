import { describe, it, expect } from 'vitest'
import { scanOnce } from './scan.js'
import { DexScreener } from '../infrastructure/adapters/dexscreener/dexscreener.js'
import { GoPlus } from '../infrastructure/adapters/goplus/goplus.js'
import { Jupiter } from '../infrastructure/adapters/jupiter/jupiter.js'
import { JupiterTokens } from '../infrastructure/adapters/jupiter/jupiter-tokens.js'
import { makeHttpGet } from '../infrastructure/http.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'

/**
 * SMOKE — hits the real APIs. Skipped unless OPERADOR_SMOKE=1, so the normal
 * suite never touches the network. Run it on purpose:
 *
 *   OPERADOR_SMOKE=1 npx vitest run src/application/scan.smoke.test.ts
 *
 * It prints what a real scan sees today. Not a parity check — a look.
 */
const SMOKE = process.env.OPERADOR_SMOKE === '1'

describe.skipIf(!SMOKE)('scan — live smoke on Solana', () => {
  it('runs one real scan and reports what it found', async () => {
    const http = makeHttpGet({ timeoutMs: 15_000 })
    const out = await scanOnce(
      { dex: new DexScreener(http), goplus: new GoPlus(http), jupiter: new Jupiter(http), decimals: new JupiterTokens(http) },
      {
        chain: 'solana',
        ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 10, minScore: 0 },
        referenceUsd: 100,
        spreadPct: 0.5,
        maxTokens: 60,
      },
    )

    const gateTally: Record<string, number> = {}
    for (const r of out.rejected) for (const f of r.gates.failures) gateTally[`${f.gate}:${f.reason}`] = (gateTally[`${f.gate}:${f.reason}`] ?? 0) + 1

    console.log(JSON.stringify({
      scanned: out.snapshots.length,
      candidates: out.candidates.map((c) => ({
        symbol: c.snapshot.symbol, dex: c.snapshot.dexId, score: +c.opportunity.score.toFixed(1),
        liq: Math.round(c.snapshot.liquidityUsd), slip: +c.marketQuality.slippagePct.toFixed(3),
        honeypot: c.snapshot.security.honeypot, lpLocked: c.snapshot.security.lpLockedPct, top10: c.snapshot.security.topHoldersPct,
      })),
      rejected: out.rejected.length,
      gateTally,
      errors: out.errors,
    }, null, 1))

    expect(out.snapshots.length).toBeGreaterThan(0)
  }, 300_000)
})
