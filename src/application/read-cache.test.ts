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

describe('a cached answer says WHEN it was taken', () => {
  // The operator hit this twice and paid for it both times: once reading a
  // cumulative profit as money vanishing, once as two totals that would not
  // agree. Nothing was wrong either time, and finding that out cost an
  // afternoon.
  //
  // The cause is structural and cannot be fixed from inside the process:
  // `cacheFor` is per MODULE and Vercel runs many instances, so a poll every
  // ten seconds lands on different ones holding answers up to the TTL apart.
  // Closing it properly means caching outside the lambda — a bill and a
  // dependency for a screen that disagrees with itself for two minutes an hour.
  //
  // So the figure says how old it is instead. It turns the same flicker from a
  // fact about the MONEY into a fact about the READING, which is the rule this
  // project already applies to the live price: stale and labelled beats absent,
  // and beats stale and silent by more.

  it('knows nothing before the first read', () => {
    const read = cacheFor(async () => 1, 1_000)
    expect(read.readAt()).toBeNull()
  })

  it('reports the instant the value came from the database', async () => {
    let clock = 5_000
    const read = cacheFor(async () => 1, 1_000, () => clock)
    await read()
    expect(read.readAt()).toBe(5_000)
  })

  it('does NOT move while the answer is served from memory', async () => {
    // The distinction that makes it useful: the age is of the VALUE, not of
    // the request. A cached hit is the old number and has to say so.
    let clock = 0
    const read = cacheFor(async () => 1, 10_000, () => clock)
    await read()
    clock = 9_000
    await read()
    expect(read.readAt()).toBe(0)
  })

  it('moves again when the value is actually refetched', async () => {
    let clock = 0
    const read = cacheFor(async () => 1, 10_000, () => clock)
    await read()
    clock = 11_000
    await read()
    expect(read.readAt()).toBe(11_000)
  })
})
