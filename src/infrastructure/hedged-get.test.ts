import { describe, it, expect } from 'vitest'
import { makeHedgedGet } from './hedged-get.js'
import { type HttpGet } from './http.js'

/** A clock the test drives, and a request that answers after `ms` of it. */
const rig = (durations: number[]) => {
  let clock = 0
  const attempts: string[] = []
  let i = 0
  const inner: HttpGet = async (url) => {
    attempts.push(url)
    const ms = durations[i++] ?? 0
    clock += ms
    return { status: 200, json: async () => ({ ms }) }
  }
  const get = makeHedgedGet(inner, { now: () => clock, samples: 3 })
  return { get, attempts, clock: () => clock }
}

describe('hedged GET — slower than anything that has worked is not worth waiting for', () => {
  // The operator's rule: if a request takes longer than usual, restart it; if
  // the second one is slow too, move on to the next.
  //
  // "Longer than the AVERAGE" cannot be the line — half of every sample is
  // above its own average by definition, so that would double the load on a
  // provider precisely when it is struggling. The threshold is the SLOWEST
  // answer that recently worked: worse than anything we have seen succeed is an
  // outlier by measurement rather than by a number somebody chose.

  it('does not interfere while answers look normal', async () => {
    const { get, attempts } = rig([100, 110, 90, 105])
    for (let i = 0; i < 4; i++) await get('u')
    expect(attempts).toHaveLength(4)
  })

  it('measures against the SLOWEST that worked, never the average', async () => {
    // The distinction this exists for, and it needs an uneven sample to show:
    // over 100, 100 and 400 the average is 200 and the slowest is 400. A 350ms
    // answer is ordinary for this provider — the average rule would restart it,
    // and with it half of every normal day.
    const { get, attempts } = rig([100, 100, 400, 350])
    for (let i = 0; i < 3; i++) await get('u')
    await get('ordinary')
    expect(attempts.filter((u) => u === 'ordinary')).toHaveLength(1)
  })

  it('learns the shape before it judges anything', async () => {
    // With no history there is nothing to be slower THAN. A first request must
    // never be abandoned for exceeding an average that does not exist yet.
    const { get, attempts } = rig([9_000])
    await get('u')
    expect(attempts).toHaveLength(1)
  })

  it('restarts one that runs past the worst that has worked', async () => {
    const { get, attempts } = rig([100, 100, 100, 5_000, 120])
    for (let i = 0; i < 3; i++) await get('u')
    await get('slow')
    expect(attempts.filter((u) => u === 'slow')).toHaveLength(2)
  })

  it('gives up after the SECOND slow one and hands the caller the failure', async () => {
    const { get } = rig([100, 100, 100, 5_000, 5_000])
    for (let i = 0; i < 3; i++) await get('u')
    await expect(get('slow')).rejects.toThrow()
  })

  it('forgets old samples, so a provider that got faster is not judged on its past', async () => {
    const { get, attempts } = rig([5_000, 5_000, 5_000, 100, 100, 100, 600])
    for (let i = 0; i < 6; i++) await get('u')
    await get('now-slow')
    // 600ms is fine against a history of 5s and an outlier against one of 100ms.
    expect(attempts.filter((u) => u === 'now-slow')).toHaveLength(2)
  })
})
