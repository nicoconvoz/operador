import { describe, it, expect } from 'vitest'
import { firstThatAnswers } from './candle-source.js'
import { type Candles } from './replay.js'

const series = (close: number): Candles => ({ time: [1], open: [close], high: [close], low: [close], close: [close], volume: [1] })

describe('firstThatAnswers — Jupiter first, GeckoTerminal when it cannot', () => {
  // Jupiter's chart endpoint is undocumented: fast, and able to change without
  // notice. Every position's tick depends on candles, so a Jupiter outage must
  // not become a blind book — and when Jupiter works, the fallback must cost
  // nothing at all.

  it('uses the first source and never asks the second', async () => {
    let asked = 0
    const result = await firstThatAnswers([async () => series(1), async () => { asked++; return series(2) }])
    expect(result?.close).toEqual([1])
    expect(asked).toBe(0)
  })

  it('falls back when the first cannot answer', async () => {
    const result = await firstThatAnswers([async () => { throw new Error('503') }, async () => series(2)])
    expect(result?.close).toEqual([2])
  })

  it('is null when nobody could answer — silence, not "nobody traded"', async () => {
    expect(await firstThatAnswers([async () => { throw new Error('a') }, async () => { throw new Error('b') }])).toBeNull()
  })

  it('does not fall back on an EMPTY answer: an empty series is a real answer', async () => {
    // Jupiter answering "no bars" is a fact about the token. Asking someone
    // else until one says otherwise would be shopping for the answer we want.
    let asked = 0
    const empty: Candles = { time: [], open: [], high: [], low: [], close: [], volume: [] }
    const result = await firstThatAnswers([async () => empty, async () => { asked++; return series(2) }])
    expect(result?.time).toEqual([])
    expect(asked).toBe(0)
  })
})
