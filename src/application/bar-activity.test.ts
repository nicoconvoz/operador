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
