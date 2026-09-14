import { describe, it, expect } from 'vitest'
import { CachedHistory, type HistoryBarsCache } from './cached-history.js'
import { type Chain } from '../../../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

class MemoryCache implements HistoryBarsCache {
  readonly rows = new Map<string, { bars: number; measuredAt: number }>()
  async historyBarsFor(chain: Chain, pool: string) {
    return this.rows.get(`${chain}:${pool}`) ?? null
  }
  async recordHistoryBars(chain: Chain, pool: string, bars: number, measuredAt: number) {
    this.rows.set(`${chain}:${pool}`, { bars, measuredAt })
  }
}

const source = (answer: number | null) => {
  const calls: string[] = []
  return {
    calls,
    port: {
      historyBars: async (_c: Chain, pool: string) => {
        calls.push(pool)
        return answer
      },
    },
  }
}

const options = { now: () => NOW, minBars: 250 }

describe('CachedHistory — a bar count only ever grows', () => {
  it('asks the source the first time, and remembers', async () => {
    const cache = new MemoryCache()
    const { port, calls } = source(900)

    expect(await new CachedHistory(port, cache, options).historyBars('solana', 'pool-1')).toBe(900)
    expect(calls).toEqual(['pool-1'])
    expect(cache.rows.get('solana:pool-1')).toEqual({ bars: 900, measuredAt: NOW })
  })

  it('never asks again once a pool has enough history — a pool cannot lose candles', async () => {
    const cache = new MemoryCache()
    await cache.recordHistoryBars('solana', 'pool-1', 900, NOW - 400 * HOUR)
    const { port, calls } = source(999)

    expect(await new CachedHistory(port, cache, options).historyBars('solana', 'pool-1')).toBe(900)
    expect(calls).toEqual([])
  })

  it('re-asks a pool that was SHORT, because that is the answer that can change', async () => {
    const cache = new MemoryCache()
    await cache.recordHistoryBars('solana', 'young', 40, NOW - 7 * HOUR)
    const { port, calls } = source(300)

    expect(await new CachedHistory(port, cache, options).historyBars('solana', 'young')).toBe(300)
    expect(calls).toEqual(['young'])
  })

  it('does not re-ask a short pool that was measured minutes ago', async () => {
    const cache = new MemoryCache()
    await cache.recordHistoryBars('solana', 'young', 40, NOW - 10 * 60_000)
    const { port, calls } = source(300)

    expect(await new CachedHistory(port, cache, options).historyBars('solana', 'young')).toBe(40)
    expect(calls).toEqual([])
  })

  it('does not cache an unknown answer — a failed call is not a measurement', async () => {
    const cache = new MemoryCache()
    const { port } = source(null)

    expect(await new CachedHistory(port, cache, options).historyBars('solana', 'pool-1')).toBeNull()
    expect(cache.rows.size).toBe(0)
  })

  it('keeps the chains apart: the same pool address on two chains is two pools', async () => {
    const cache = new MemoryCache()
    await cache.recordHistoryBars('solana', 'same', 900, NOW)
    const { port, calls } = source(700)

    expect(await new CachedHistory(port, cache, options).historyBars('bsc', 'same')).toBe(700)
    expect(calls).toEqual(['same'])
  })
})
