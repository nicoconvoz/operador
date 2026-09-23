import { describe, it, expect } from 'vitest'
import { firstThatAnswers, tokenCandles } from './candle-source.js'
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

describe('tokenCandles — ONE route to the candles of a token, for every reader', () => {
  // The tick moved to Jupiter by mint and the DOOR did not. It went on asking
  // GeckoTerminal by pool — and the pool is now Jupiter's own id, which
  // GeckoTerminal answers with a 404 or with a dead pool's bars. Measured live:
  // 25 of 26 prime tokens refused at the door, "sin velas: HTTP 404" and
  // "última vela hace 12109.5h", while the engine bought nothing.
  const rig = () => {
    const asked: string[] = []
    const candles = tokenCandles({
      byMint: async (chain, mint) => { asked.push(`mint:${chain}:${mint}`); return series(1) },
      byPool: async (chain, pool) => { asked.push(`pool:${chain}:${pool}`); return series(2) },
    })
    return { candles, asked }
  }

  it('asks a Solana token by its MINT, and never touches the pool', async () => {
    const { candles, asked } = rig()
    const result = await candles('solana', 'MINT', 'POOL', '15m', 300)
    expect(result?.close).toEqual([1])
    expect(asked).toEqual(['mint:solana:MINT'])
  })

  it('falls back to the pool when the mint source cannot answer', async () => {
    const asked: string[] = []
    const candles = tokenCandles({
      byMint: async () => { asked.push('mint'); throw new Error('503') },
      byPool: async (_chain, pool) => { asked.push(`pool:${pool}`); return series(2) },
    })
    expect((await candles('solana', 'MINT', 'POOL', '15m', 300))?.close).toEqual([2])
    expect(asked).toEqual(['mint', 'pool:POOL'])
  })

  it('asks BSC by pool only — Jupiter is Solana only', async () => {
    const { candles, asked } = rig()
    await candles('bsc', 'TOKEN', 'POOL', '15m', 300)
    expect(asked).toEqual(['pool:bsc:POOL'])
  })

  it('passes the bar size and the depth through', async () => {
    const seen: unknown[] = []
    const candles = tokenCandles({
      byMint: async (_chain, _mint, size, limit) => { seen.push(size, limit); return series(1) },
      byPool: async () => series(2),
    })
    await candles('solana', 'MINT', 'POOL', '15m', 300)
    expect(seen).toEqual(['15m', 300])
  })
})
