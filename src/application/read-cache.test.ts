import { describe, it, expect } from 'vitest'
import { cacheFor } from './read-cache.js'

describe('cacheFor — a read that repeats faster than its subject changes', () => {
  it('asks once and serves the same answer until the window closes', async () => {
    let calls = 0
    let now = 1_000
    const read = cacheFor(async () => ++calls, 5_000, () => now)

    expect(await read()).toBe(1)
    now = 4_000
    expect(await read()).toBe(1)
    expect(calls).toBe(1)
  })

  it('asks again once the answer could have changed', async () => {
    let calls = 0
    let now = 1_000
    const read = cacheFor(async () => ++calls, 5_000, () => now)

    await read()
    now = 6_001
    expect(await read()).toBe(2)
  })

  it('collapses a burst into ONE call, not one per caller', async () => {
    // Several viewers, or one page fetching twice in a frame, must not each
    // pay for the same read. The in-flight promise is what is shared, so the
    // saving survives concurrency rather than only sequential calls.
    let calls = 0
    const read = cacheFor(async () => { calls++; await Promise.resolve(); return calls }, 5_000, () => 1_000)

    const [a, b, c] = await Promise.all([read(), read(), read()])
    expect([a, b, c]).toEqual([1, 1, 1])
    expect(calls).toBe(1)
  })

  it('does not cache a FAILURE, so one bad minute is not remembered as the answer', async () => {
    let attempt = 0
    const read = cacheFor(async () => {
      attempt++
      if (attempt === 1) throw new Error('502')
      return 'ok'
    }, 5_000, () => 1_000)

    await expect(read()).rejects.toThrow('502')
    expect(await read()).toBe('ok')
  })
})
