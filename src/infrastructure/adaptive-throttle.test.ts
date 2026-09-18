import { describe, it, expect } from 'vitest'
import { makeAdaptiveThrottle } from './adaptive-throttle.js'

const rig = () => {
  let clock = 0
  const slept: number[] = []
  const throttle = makeAdaptiveThrottle({
    sleep: async (ms) => { slept.push(ms); clock += ms },
    now: () => clock,
  })
  return { throttle, slept, tick: (ms: number) => { clock += ms } }
}

describe('adaptive throttle — the provider sets the pace, not a guess', () => {
  // The operator's rule: do not put a limit on it. Let the answer take as long
  // as it takes — a little more, a little less — and let THAT be the time.
  //
  // A fixed interval is a guess about somebody else's quota, and it is wrong in
  // both directions at once: too slow on a provider that never pushes back
  // (GoPlus reported zero rejections across a hundred calls), too fast on the
  // day one does. The provider already knows the answer and says it with a 429.

  it('does not wait at all until something says to', async () => {
    const { throttle, slept } = rig()
    await throttle.wait()
    await throttle.wait()
    expect(slept).toEqual([])
  })

  it('backs off once the provider pushes back', async () => {
    // The real sequence: a call goes out, it is refused, and the NEXT one waits.
    // An interval is the space between two calls, so there is nothing to space
    // before the first.
    const { throttle, slept } = rig()
    await throttle.wait()
    throttle.pushedBack()
    await throttle.wait()
    expect(slept[0]).toBeGreaterThan(0)
  })

  it('backs off HARDER the more it is refused, because one step is a guess too', async () => {
    const { throttle, slept } = rig()
    await throttle.wait()
    throttle.pushedBack()
    await throttle.wait()
    throttle.pushedBack()
    await throttle.wait()
    expect(slept[1]).toBeGreaterThan(slept[0]!)
  })

  it('speeds back up when the refusals stop, or a bad minute costs the whole hour', async () => {
    const { throttle, slept, tick } = rig()
    await throttle.wait()
    throttle.pushedBack()
    await throttle.wait()
    const punished = slept[0]!
    // A run of clean answers: the pace recovers rather than staying punished.
    for (let i = 0; i < 20; i++) { throttle.wentThrough(); tick(5_000); await throttle.wait() }
    throttle.pushedBack()
    await throttle.wait()
    expect(slept.at(-1)!).toBeLessThanOrEqual(punished)
  })

  it('never waits longer than the ceiling, so one bad provider cannot hang a scan', async () => {
    const { throttle, slept } = rig()
    await throttle.wait()
    for (let i = 0; i < 50; i++) { throttle.pushedBack(); await throttle.wait() }
    expect(Math.max(...slept)).toBeLessThanOrEqual(10_000)
  })
})
