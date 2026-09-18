import { describe, it, expect } from 'vitest'
import { CachedBarActivity } from './bar-activity.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'

const NOW = 1_800_000_000_000
const MIN = 60_000

const rig = (answers: (number | null)[], now = () => NOW) => {
  const store = new MemoryStore()
  let calls = 0
  const activity = new CachedBarActivity(
    { barAgeHours: async () => answers[Math.min(calls++, answers.length - 1)] ?? null },
    store,
    { now, staleVerdictMs: 60 * MIN },
  )
  return { activity, calls: () => calls, store }
}

describe('CachedBarActivity — a pool that went quiet is not re-downloaded to learn it again', () => {
  it('measures the first time', async () => {
    const { activity, calls } = rig([5])
    expect(await activity.barAgeHours('solana', 'Pool1')).toBe(5)
    expect(calls()).toBe(1)
  })

  it('remembers a STALE verdict and refuses without asking again', async () => {
    // The whole point. A pool whose newest bar was five hours old ten minutes
    // ago is still five hours old, and the candle download that proves it costs
    // the same 2.5 seconds as a useful one — against the provider that rate
    // limits hardest. Thirty of those a scan is a minute of nothing.
    const { activity, calls } = rig([5])
    await activity.barAgeHours('solana', 'Pool1')
    await activity.barAgeHours('solana', 'Pool1')
    expect(calls()).toBe(1)
  })

  it('does NOT remember a fresh verdict — a live pool can go quiet at any moment', async () => {
    // The asymmetry is the safety. Caching "this pool is alive" is caching the
    // one answer that can turn against us between now and the moment capital
    // moves; caching "it is dead" only risks a missed opportunity.
    const { activity, calls } = rig([0.2, 0.2])
    await activity.barAgeHours('solana', 'Pool1')
    await activity.barAgeHours('solana', 'Pool1')
    expect(calls()).toBe(2)
  })

  it('asks again once the stale verdict is past its window', async () => {
    let clock = NOW
    const { activity, calls } = rig([5, 0.1], () => clock)
    await activity.barAgeHours('solana', 'Pool1')
    clock += 61 * MIN
    expect(await activity.barAgeHours('solana', 'Pool1')).toBe(0.1)
    expect(calls()).toBe(2)
  })

  it('remembers "the feed answered nothing" the same way', async () => {
    // Null is a stale verdict too: no bars at all is the strongest version of
    // "this engine cannot watch it".
    const { activity, calls } = rig([null])
    expect(await activity.barAgeHours('solana', 'Pool1')).toBeNull()
    expect(await activity.barAgeHours('solana', 'Pool1')).toBeNull()
    expect(calls()).toBe(1)
  })

  it('keeps each pool on its own shelf', async () => {
    const { activity, calls } = rig([5, 5])
    await activity.barAgeHours('solana', 'Pool1')
    await activity.barAgeHours('solana', 'Pool2')
    expect(calls()).toBe(2)
  })
})

describe('CachedBarActivity — "could not ask" is not "nobody traded"', () => {
  // The sell probe's rule, which this broke: an RPC failure is never read as
  // "no route". One is inconclusive, the other is a verdict.
  //
  // Measured live after the retry budget was cut from 28s to 6s: **26 of 29
  // positions turned red at once**, every one of them carrying "el proveedor de
  // velas no devolvió ninguna operación". None of those pools had died — Bonk
  // was among them. GeckoTerminal was rate-limiting, the adapter caught the
  // error and returned null, and null is the STRONGEST form of this failure.
  //
  // Worse, the null was then remembered in `pool_quiet` for an hour, so the
  // book stayed red long after the provider recovered.
  const store = () => {
    const quiet = new Map<string, number>()
    return {
      quietPoolSince: async (c: string, p: string) => quiet.get(`${c}:${p}`) ?? null,
      recordQuietPool: async (c: string, p: string, at: number) => { quiet.set(`${c}:${p}`, at) },
      size: () => quiet.size,
    }
  }

  it('lets a failed request THROW instead of answering for the pool', async () => {
    const cache = store()
    const cached = new CachedBarActivity(
      { barAgeHours: async () => { throw new Error('429') } }, cache, { now: () => 1_000 },
    )
    await expect(cached.barAgeHours('solana', 'P')).rejects.toThrow('429')
  })

  it('never remembers it, so one rate limit is not an hour of red', async () => {
    const cache = store()
    const cached = new CachedBarActivity(
      { barAgeHours: async () => { throw new Error('429') } }, cache, { now: () => 1_000 },
    )
    await cached.barAgeHours('solana', 'P').catch(() => undefined)
    expect(cache.size()).toBe(0)
  })

  it('still remembers a MEASURED silence, which is the whole point of the shelf', async () => {
    const cache = store()
    const cached = new CachedBarActivity({ barAgeHours: async () => null }, cache, { now: () => 1_000 })
    expect(await cached.barAgeHours('solana', 'P')).toBeNull()
    expect(cache.size()).toBe(1)
  })
})
