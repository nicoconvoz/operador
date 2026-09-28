import { describe, it, expect } from 'vitest'
import { lastHourVolatility } from './recent-volatility.js'
import { type Candles } from './replay.js'
import { type PersistedPosition } from '../domain/persistence/store.js'

/**
 * *Tiempo real.* The sweep looks every thirty seconds and the answer can only
 * change when a new 5-minute bar closes — so the last hour's volatility is
 * asked once per position per bar, never once per sweep.
 */
const BAR = 5 * 60_000
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % BAR)

const position = (id = 'solana:T:1') => ({ id, chain: 'solana', tokenAddress: 'T', pairAddress: 'P' }) as PersistedPosition

/** Sixteen closed 5-minute bars before `at`, swinging ±`swing` every bar. */
const hour = (at: number, swing = 0.1): Candles => {
  const start = Math.floor(at / BAR) * BAR - 16 * BAR
  const time = Array.from({ length: 16 }, (_, i) => start + i * BAR)
  const close = time.map((_, i) => (i % 2 === 0 ? 1 : 1 + swing))
  return { time, open: close, high: close, low: close, close, volume: close.map(() => 100) }
}

const rig = (answer: (at: number) => Candles | null | Error = (at) => hour(at)) => {
  let clock = T0
  let asked = 0
  const measure = lastHourVolatility({
    candles: async () => {
      asked++
      const candles = answer(clock)
      if (candles instanceof Error) throw candles
      return candles
    },
    now: () => clock,
  })
  return { measure, asked: () => asked, at: (ms: number) => { clock = ms } }
}

describe('lastHourVolatility — the last hour of 5-minute bars, once a bar', () => {
  it('measures the last hour of closed 5-minute bars, and says when', async () => {
    const { measure } = rig()
    const measured = await measure(position())
    expect(measured?.volPct).toBeCloseTo(Math.log(1.1) * 100, 9)
    expect(measured?.measuredAt).toBe(T0)
  })

  it('asks once for two sweeps inside the same 5-minute bar', async () => {
    const { measure, asked, at } = rig()
    const first = await measure(position())
    at(T0 + 30_000)
    const second = await measure(position())
    at(T0 + BAR - 1)
    await measure(position())
    expect(asked()).toBe(1)
    // The same reading, with the time it was TAKEN — so the sweep can tell a
    // new reading from one it has already written down.
    expect(second).toEqual(first)
  })

  it('asks again once a new 5-minute bar has closed', async () => {
    const { measure, asked, at } = rig()
    await measure(position())
    at(T0 + BAR)
    const fresh = await measure(position())
    expect(asked()).toBe(2)
    expect(fresh?.measuredAt).toBe(T0 + BAR)
  })

  it('keeps one answer per position', async () => {
    const { measure, asked } = rig()
    await measure(position('solana:A:1'))
    await measure(position('solana:B:1'))
    await measure(position('solana:A:1'))
    expect(asked()).toBe(2)
  })

  it('never remembers a refusal: silence is asked again on the next sweep', async () => {
    let refuse = true
    const { measure, asked } = rig((at) => (refuse ? new Error('HTTP 503') : hour(at)))
    expect(await measure(position())).toBeNull()
    refuse = false
    expect(await measure(position())).not.toBeNull()
    expect(asked()).toBe(2)
  })

  it('never remembers a feed that could not answer at all', async () => {
    let answer: Candles | null = null
    const { measure, asked } = rig(() => answer)
    expect(await measure(position())).toBeNull()
    answer = hour(T0)
    expect(await measure(position())).not.toBeNull()
    expect(asked()).toBe(2)
  })

  it('is null for an hour too thin to measure, and does not ask again until the next bar', async () => {
    // Four bars in the hour is an ANSWER about the token — nobody traded much —
    // and it cannot change before another bar closes.
    const thin = (at: number): Candles => {
      const full = hour(at)
      const keep = (xs: readonly number[]) => xs.slice(-4)
      return { time: keep(full.time), open: keep(full.open), high: keep(full.high), low: keep(full.low), close: keep(full.close), volume: keep(full.volume) }
    }
    const { measure, asked } = rig(thin)
    expect(await measure(position())).toBeNull()
    expect(await measure(position())).toBeNull()
    expect(asked()).toBe(1)
  })
})
