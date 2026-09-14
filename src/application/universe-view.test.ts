import { describe, it, expect } from 'vitest'
import { buildUniverse } from './universe-view.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const UNKNOWN: SecurityReport = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null,
}

const safe: SecurityReport = {
  honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
  hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
}

const token = (address: string, over: Partial<TokenSnapshot> = {}, security: Partial<SecurityReport> = {}): TokenSnapshot => ({
  chain: 'solana', address, symbol: address, pairAddress: `pair-${address}`, observedAt: NOW,
  priceUsd: 0.01, liquidityUsd: 250_000, fdvUsd: 5_000_000,
  volumeUsd: { h1: 20_000, h6: 60_000, h24: 150_000 },
  priceChangePct: { h1: 6, h6: -4, h24: 12 },
  txns: { h1: { buys: 70, sells: 25 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 24 * HOUR, historyBars: 1000,
  security: { ...safe, ...security }, ...over,
})

const position = (address: string, over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: `pos-${address}`, chain: 'solana', tokenAddress: address, pairAddress: `pair-${address}`, symbol: address,
  cascade: { ...initialState(), level: 3 }, deathWatch: startDeathWatch(250_000, NOW),
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 200, lastBarTime: NOW, lastPriceUsd: 0.01, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const seed = async (snapshots: TokenSnapshot[]) => {
  const store = new MemoryStore()
  await store.saveScan({ scannedAt: NOW - HOUR, chain: 'solana', snapshots })
  return store
}

const options = { now: () => NOW }

describe('buildUniverse — tiers tell the story', () => {
  it('an empty store yields an empty universe, not a crash', async () => {
    const view = await buildUniverse(new MemoryStore(), options)
    expect(view.tokens).toEqual([])
    expect(view.scannedAt).toBeNull()
  })

  it('a clean, lively token is prime', async () => {
    const store = await seed([token('HOT')])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('prime')
    expect(t!.score).toBeGreaterThan(45)
    expect(t!.blockers).toEqual([])
  })

  it('a clean but quiet token is eligible, not prime', async () => {
    const quiet = token('CALM', {
      volumeUsd: { h1: 1_000, h6: 10_000, h24: 100_000 },
      txns: { h1: { buys: 2, sells: 2 }, h24: { buys: 100, sells: 100 } },
      priceChangePct: { h1: 0, h6: 0, h24: 0 },
    })
    const [t] = (await buildUniverse(await seed([quiet]), options)).tokens
    expect(t!.tier).toBe('eligible')
  })

  it('a safety failure is UNSAFE, not merely filtered — a bullet dodged, not a missed chance', async () => {
    const store = await seed([token('RUG', {}, { honeypot: true })])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('unsafe')
    expect(t!.blockers[0]).toContain('sell simulation')
  })

  it('a market failure is filtered — uninteresting, not dangerous', async () => {
    const store = await seed([token('THIN', { liquidityUsd: 500 })])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('filtered')
    expect(t!.blockers[0]).toContain('liquidity')
  })

  it('a held token is held, whatever its score says', async () => {
    const store = await seed([token('MINE', { volumeUsd: { h1: 0, h6: 0, h24: 0 } })])
    await store.savePosition(position('MINE'))
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('held')
    expect(t!.position).toMatchObject({ capitalUsd: 200, filledDcas: 2, deathStage: 'healthy' })
  })

  it('a blacklisted token is dead, and dead outranks everything', async () => {
    const store = await seed([token('GONE')])
    await store.savePosition(position('GONE'))
    await store.blacklist('solana', 'GONE', 'LP removed', NOW)
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('dead')
  })

  it('carries the death stage so a frozen position can be shown as such', async () => {
    const frozen: DeathWatchState = { ...startDeathWatch(250_000, NOW), stage: 'frozen' }
    const store = await seed([token('ICE')])
    await store.savePosition(position('ICE', { deathWatch: frozen }))
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.position!.deathStage).toBe('frozen')
  })
})

describe('buildUniverse — what a picture needs', () => {
  it('exposes the score components, so the view can show WHY', async () => {
    const [t] = (await buildUniverse(await seed([token('WHY')]), options)).tokens
    expect(Object.keys(t!.components)).toEqual(
      expect.arrayContaining(['volumeExpansion', 'buyPressure', 'liquidityGrowth', 'activity', 'volatility', 'costEfficiency']),
    )
  })

  it('estimates friction so cheap and expensive tokens can look different', async () => {
    const deep = await buildUniverse(await seed([token('DEEP', { liquidityUsd: 5_000_000 })]), options)
    const thin = await buildUniverse(await seed([token('THIN2', { liquidityUsd: 40_000 })]), options)
    expect(thin.tokens[0]!.frictionPct).toBeGreaterThan(deep.tokens[0]!.frictionPct)
  })

  it('counts every tier and lists the chains present', async () => {
    const store = await seed([
      token('A'),
      token('B', { chain: 'bsc', address: 'B' }),
      token('C', { liquidityUsd: 100 }),
      token('D', {}, { honeypot: true }),
    ])
    const view = await buildUniverse(store, options)
    expect(view.counts.filtered).toBe(1)
    expect(view.counts.unsafe).toBe(1)
    expect(view.chains).toEqual(['bsc', 'solana'])
  })

  it('sorts brightest first, so a truncated render keeps what matters', async () => {
    const store = await seed([token('BAD', { liquidityUsd: 1 }), token('GOOD')])
    await store.savePosition(position('MINE'))
    const view = await buildUniverse(await seed([token('BAD', { liquidityUsd: 1 }), token('GOOD')]), options)
    expect(view.tokens[0]!.symbol).toBe('GOOD')
  })
})

describe('buildUniverse — every chain at once', () => {
  const HOUR_MS = 3_600_000

  it('shows Solana AND BSC together, not whichever scanned last', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 2 * HOUR_MS, chain: 'solana', snapshots: [token('SOL1'), token('SOL2')] })
    await store.saveScan({
      scannedAt: NOW - HOUR,
      chain: 'bsc',
      snapshots: [token('BSC1', { chain: 'bsc', address: 'BSC1' })],
    })

    const view = await buildUniverse(store, options)
    // The old read took the newest row and nothing else, so scanning BSC made
    // every Solana token disappear from the screen.
    expect(view.tokens.map((t) => t.symbol).sort()).toEqual(['BSC1', 'SOL1', 'SOL2'])
    expect(view.chains).toEqual(['bsc', 'solana'])
  })

  it('keeps only the LATEST scan of each chain', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 2 * HOUR_MS, chain: 'solana', snapshots: [token('OLD')] })
    await store.saveScan({ scannedAt: NOW - HOUR, chain: 'solana', snapshots: [token('FRESH')] })

    const view = await buildUniverse(store, options)
    expect(view.tokens.map((t) => t.symbol)).toEqual(['FRESH'])
  })

  it('reports the OLDEST chain as the scan time — a universe is only as fresh as its stalest half', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 3 * HOUR_MS, chain: 'solana', snapshots: [token('SOL1')] })
    await store.saveScan({ scannedAt: NOW - HOUR, chain: 'bsc', snapshots: [token('BSC1', { chain: 'bsc', address: 'BSC1' })] })

    expect((await buildUniverse(store, options)).scannedAt).toBe(NOW - 3 * HOUR_MS)
  })
})

describe('buildUniverse — rejected for being thin is not the same as dangerous', () => {
  it('a token rejected on MARKET grounds is filtered, not unsafe', async () => {
    // The scanner never examines these: they fail the free gates first, so
    // their security report is all-null. The gates fail closed, so a naive
    // reading calls them a safety failure — and the screen said "insegura 219,
    // filtrada 6" when almost every one of those was simply too thin.
    const thin = token('THIN', { liquidityUsd: 500 })
    const store = await seed([{ ...thin, security: UNKNOWN, securityChecked: false }])

    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('filtered')
    expect(t!.blockers.some((b) => b.includes('liquidity'))).toBe(true)
  })

  it('a token that passed the market gates but was never examined is pending', async () => {
    const store = await seed([{ ...token('WAIT'), security: UNKNOWN, securityChecked: false }])
    expect((await buildUniverse(store, options)).tokens[0]!.tier).toBe('pending')
  })

  it('a token that WAS examined and failed a safety gate is still unsafe', async () => {
    const store = await seed([token('RUG', {}, { honeypot: true })])
    expect((await buildUniverse(store, options)).tokens[0]!.tier).toBe('unsafe')
  })
})
