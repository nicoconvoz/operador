import { describe, it, expect } from 'vitest'
import { CachedDiscovery } from './cached-discovery.js'
import { MemoryStore } from '../../persistence/memory-store.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const pools = (n: number) => Array.from({ length: n }, (_, i) => ({ tokenAddress: `T${i}`, poolAddress: `P${i}` }))

const rig = (source: () => Promise<{ tokenAddress: string; poolAddress: string }[]>, now = () => NOW) => {
  const store = new MemoryStore()
  let calls = 0
  const discovery = new CachedDiscovery(
    { discoverPools: async () => { calls++; return source() } },
    store,
    { now, staleAfterMs: 6 * HOUR },
  )
  return { store, discovery, calls: () => calls }
}

describe('CachedDiscovery — the universe does not change minute to minute', () => {
  it('asks the provider when it has never looked', async () => {
    const { discovery, calls } = rig(async () => pools(3))
    expect(await discovery.discoverPools('solana')).toHaveLength(3)
    expect(calls()).toBe(1)
  })

  it('answers from the shelf the second time, without a single request', async () => {
    const { discovery, calls } = rig(async () => pools(3))
    await discovery.discoverPools('solana')
    await discovery.discoverPools('solana')

    // Discovery is ten throttled GeckoTerminal calls per chain and most of what
    // is left of a scan. The quota is not ours to budget, so the winning move
    // is to ask less.
    expect(calls()).toBe(1)
  })

  it('asks again once the shelf is past its window', async () => {
    let clock = NOW
    const { discovery, calls } = rig(async () => pools(3), () => clock)
    await discovery.discoverPools('solana')
    clock += 7 * HOUR
    await discovery.discoverPools('solana')
    expect(calls()).toBe(2)
  })

  it('keeps each chain on its own shelf', async () => {
    const { discovery, calls } = rig(async () => pools(2))
    await discovery.discoverPools('solana')
    await discovery.discoverPools('bsc')
    expect(calls()).toBe(2)
  })

  it('never caches a failure — one rate limit must not blind a chain for hours', async () => {
    let fail = true
    const { discovery, calls } = rig(async () => {
      if (fail) throw new Error('429')
      return pools(4)
    })

    await expect(discovery.discoverPools('solana')).rejects.toThrow('429')
    fail = false
    expect(await discovery.discoverPools('solana')).toHaveLength(4)
    expect(calls()).toBe(2)
  })

  it('falls back to a stale shelf when the provider is down', async () => {
    let clock = NOW
    let fail = false
    const { discovery } = rig(async () => {
      if (fail) throw new Error('429')
      return pools(5)
    }, () => clock)

    await discovery.discoverPools('solana')
    clock += 9 * HOUR
    fail = true

    // An old universe beats no universe: the alternative is a scan that sees
    // nothing at all and a book that stops growing for as long as the provider
    // is unhappy.
    expect(await discovery.discoverPools('solana')).toHaveLength(5)
  })

  it('refuses to invent one when there is nothing on the shelf either', async () => {
    const { discovery } = rig(async () => { throw new Error('429') })
    await expect(discovery.discoverPools('solana')).rejects.toThrow('429')
  })
})
