import { describe, it, expect } from 'vitest'
import { MemoryStore } from './memory-store.js'
import { type RememberedToken } from '../../domain/persistence/store.js'


describe('the permanent registry — the memory the providers do not have', () => {
  // The operator's idea, and it answers the constraint the whole scanner ran
  // into: the free providers cap discovery at about 570 a sweep and no
  // threshold widens that. Ten pages is GeckoTerminal's ceiling, Jupiter's
  // lists cap at 100 each, DexScreener's boosts are paid promotions.
  //
  // The only lever left is TIME. A registry accumulates what every sweep
  // found, so a week of scans knows far more than any one of them — and his
  // instruction about it was one line: *esto ojo nunca hay que borrarlo.*

  const row = (contract: string, over: Partial<RememberedToken> = {}): RememberedToken => ({
    contract, token: contract.toUpperCase(), pool: `pool-${contract}`,
    price: 0.01, volume24h: 50_000, liquidity: 120_000, marketCap: 900_000,
    txns: 300, lastUpdate: 1_000, ...over,
  })

  it('remembers a token and gives it back', async () => {
    const store = new MemoryStore()
    await store.rememberTokens([row('aaa')])
    expect(await store.knownTokens(10)).toEqual([row('aaa')])
  })

  it('updates what it already knows instead of duplicating it', async () => {
    const store = new MemoryStore()
    await store.rememberTokens([row('aaa', { price: 1, lastUpdate: 1_000 })])
    await store.rememberTokens([row('aaa', { price: 2, lastUpdate: 2_000 })])
    const known = await store.knownTokens(10)
    expect(known).toHaveLength(1)
    expect(known[0]!.price).toBe(2)
    expect(known[0]!.lastUpdate).toBe(2_000)
  })

  it('returns the ones that were MOVING first', async () => {
    // Not arbitrary order and not insertion order: a bounded read costs one
    // DexScreener call per thirty rows, so the first thirty had better be the
    // thirty worth re-pricing.
    const store = new MemoryStore()
    await store.rememberTokens([
      row('quiet', { volume24h: 1_000 }),
      row('busy', { volume24h: 900_000 }),
      row('middling', { volume24h: 40_000 }),
    ])
    expect((await store.knownTokens(10)).map((t) => t.contract)).toEqual(['busy', 'middling', 'quiet'])
  })

  it('honours the limit, because reading it whole is what it exists to avoid', async () => {
    const store = new MemoryStore()
    await store.rememberTokens(Array.from({ length: 50 }, (_, i) => row(`t${i}`, { volume24h: i })))
    expect(await store.knownTokens(5)).toHaveLength(5)
  })

  it('puts a token with no known volume last rather than dropping it', async () => {
    // An unmeasured volume is not a zero one. It goes to the back of the queue
    // and stays in the registry, because the registry's whole job is to
    // remember what the providers have forgotten.
    const store = new MemoryStore()
    await store.rememberTokens([row('unknown', { volume24h: null }), row('known', { volume24h: 5 })])
    expect((await store.knownTokens(10)).map((t) => t.contract)).toEqual(['known', 'unknown'])
  })
})
