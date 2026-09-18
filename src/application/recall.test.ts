import { describe, it, expect } from 'vitest'
import { recallCandidates } from './recall.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { DEFAULT_GATE_POLICY } from '../domain/scanner/gates.js'
import { DEFAULT_OPPORTUNITY_POLICY } from '../domain/scanner/opportunity.js'
import { type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const safe: SecurityReport = {
  honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
  hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
}

const token = (address: string, over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  chain: 'solana', address, symbol: address, pairAddress: `pair-${address}`, observedAt: NOW - HOUR,
  priceUsd: 0.01, liquidityUsd: 250_000, fdvUsd: 5_000_000,
  volumeUsd: { h1: 60_000, h6: 300_000, h24: 875_000 },
  priceChangePct: { h1: 6, h6: -4, h24: 12 },
  txns: { h1: { buys: 70, sells: 25 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 24 * HOUR, historyBars: 1000,
  security: safe, ...over,
})

const options = {
  now: () => NOW,
  ranking: { gates: DEFAULT_GATE_POLICY, opportunity: DEFAULT_OPPORTUNITY_POLICY, watchSlots: 20, minScore: 0 },
  spreadPct: 0.3,
  referenceUsd: 100,
  maxAgeMs: 4 * HOUR,
}

const shelf = async (snapshots: TokenSnapshot[], scannedAt = NOW - HOUR) => {
  const store = new MemoryStore()
  await store.saveScan({ scannedAt, chain: 'solana', snapshots })
  return store
}

describe('recallCandidates — the last scan, re-ranked from the shelf', () => {
  it('reproduces the verdict with no network at all', async () => {
    const store = await shelf([token('a'), token('b')])
    const recalled = await recallCandidates(store, options)
    expect(recalled!.candidates.map((c) => c.snapshot.address).sort()).toEqual(['a', 'b'])
  })

  it('refuses a shelf older than the window rather than serving something stale', async () => {
    // Past the window it is not evidence any more, and opening a position on
    // it would size a ladder against a pool that may not be there.
    const store = await shelf([token('a')], NOW - 9 * HOUR)
    expect(await recallCandidates(store, options)).toBeNull()
  })

  it('has nothing to say before the first scan', async () => {
    expect(await recallCandidates(new MemoryStore(), options)).toBeNull()
  })

  it('still applies every gate — the shelf is snapshots, not a pass list', async () => {
    const store = await shelf([token('good'), token('thin', { liquidityUsd: 900 })])
    const recalled = await recallCandidates(store, options)
    expect(recalled!.candidates.map((c) => c.snapshot.address)).toEqual(['good'])
  })

  it('sizes against the impact that was MEASURED, not against reported liquidity', async () => {
    const store = await shelf([token('hev', { liquidityUsd: 186_000 })])
    // HEV in the first live scan: $186k reported, 5.2% impact on $100 — $3.8k
    // of real depth. Sizing a ladder against the reported number is the one
    // thing the executor refuses to do.
    await store.recordSecurity('solana', 'hev', safe, 5.2, NOW - HOUR)

    const recalled = await recallCandidates(store, options)

    expect(recalled!.candidates[0]!.marketQuality.slippagePct).toBe(5.2)
  })

  it('falls back to the model only for tokens nothing ever quoted', async () => {
    const store = await shelf([token('never')])
    const recalled = await recallCandidates(store, options)
    // 0.08% for $100 against $250k of reported depth — the same fallback the
    // live scan uses when no quote exists.
    expect(recalled!.candidates[0]!.marketQuality.slippagePct).toBeCloseTo(0.08, 4)
  })

  it('reports the OLDEST chain, because a universe is as fresh as its stalest half', async () => {
    const store = await shelf([token('a')], NOW - 2 * HOUR)
    await store.saveScan({ scannedAt: NOW - 5 * 60_000, chain: 'bsc', snapshots: [token('b', { chain: 'bsc' })] })

    expect((await recallCandidates(store, options))!.scannedAt).toBe(NOW - 2 * HOUR)
  })
})

describe('recallCandidates — a shelf priced NOW, for one batched request', () => {
  // The operator's idea, and it turned out to be cheaper than he asked for.
  //
  // A watch pass already re-ranks the stored shelf with no network at all, but
  // it re-ranks the same numbers — so nothing moves until the next full scan an
  // hour later. Since `worthStoring` the shelf is about twenty tokens rather
  // than five hundred, and refreshing its market half is ONE DexScreener call
  // per thirty. Free enough to do every five minutes instead of every thirty.
  //
  // What it buys: a token that fell below what the book will accept is dropped
  // on the next pass rather than on the next scan, and the slot goes to
  // whatever now scores above it. The expensive half — security, history, bar
  // freshness — still stands until a real scan replaces it.

  it('ranks on the refreshed numbers, not the stored ones', async () => {
    const store = await shelf([token('a', { liquidityUsd: 20_000 })])
    const stale = await recallCandidates(store, options)
    const fresh = await recallCandidates(store, {
      ...options,
      liveMarkets: async () => new Map([['solana:a', { ...token('a'), liquidityUsd: 900_000, observedAt: NOW }]]),
    })
    expect(fresh!.candidates[0]!.snapshot.liquidityUsd).toBe(900_000)
    expect(stale!.candidates[0]!.snapshot.liquidityUsd).toBe(20_000)
  })

  it('keeps the shelf exactly as it was when the feed says nothing', async () => {
    const store = await shelf([token('a')])
    const out = await recallCandidates(store, { ...options, liveMarkets: async () => new Map() })
    expect(out!.candidates[0]!.snapshot.liquidityUsd).toBe(token('a').liquidityUsd)
  })

  it('is never fatal — a bad minute serves the stored shelf rather than nothing', async () => {
    const store = await shelf([token('a')])
    const out = await recallCandidates(store, { ...options, liveMarkets: async () => { throw new Error('502') } })
    expect(out!.candidates).toHaveLength(1)
  })

  it('does not move the scan TIME, because the expensive half is still that old', async () => {
    // `maxAgeMs` asks how old the EXAMINATION is. Letting a market refresh reset
    // it would keep a shelf alive forever on security nobody re-checked.
    const store = await shelf([token('a')])
    const out = await recallCandidates(store, {
      ...options,
      liveMarkets: async () => new Map([['solana:a', { ...token('a'), observedAt: NOW }]]),
    })
    expect(out!.scannedAt).toBeLessThan(NOW)
  })
})
