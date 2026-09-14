import { describe, it, expect } from 'vitest'
import { makeThrottle } from './http.js'

describe('makeThrottle — minimum spacing between calls', () => {
  it('lets the first call through and spaces the rest', async () => {
    let t = 0
    const sleeps: number[] = []
    const throttle = makeThrottle(1_000, async (ms) => { sleeps.push(ms); t += ms }, () => t)
    await throttle.wait()
    await throttle.wait()
    t += 400 // some work happened
    await throttle.wait()
    expect(sleeps).toEqual([1_000, 600])
  })

  it('does not sleep when enough time has already passed', async () => {
    let t = 0
    const sleeps: number[] = []
    const throttle = makeThrottle(1_000, async (ms) => { sleeps.push(ms); t += ms }, () => t)
    await throttle.wait()
    t += 5_000
    await throttle.wait()
    expect(sleeps).toEqual([])
  })
})
