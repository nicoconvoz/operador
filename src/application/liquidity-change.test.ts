import { describe, it, expect } from 'vitest'
import { recentLiquidityChange } from './liquidity-change.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type LiquidityReading } from '../domain/strategy/liquidity-brake.js'

/**
 * The brake's readings, for the whole book in ONE request, each held a minute.
 *
 * The watch follows every held position on every sweep — the bounce that buys
 * a rung does not wait for the price line — and the sweep looks every thirty
 * seconds, from the cycle and from the loop between cycles. One request a
 * minute for the book is the whole bill.
 */
const at = (id: string, tokenAddress: string, chain: PersistedPosition['chain'] = 'solana') =>
  ({ id, chain, tokenAddress }) as PersistedPosition
const reading = (usd: number, h1 = 0): LiquidityReading => ({ usd, m5: 0, h1 })

const rig = (answer: (tokens: string[]) => Map<string, LiquidityReading> | Error) => {
  let clock = 0
  const asked: string[][] = []
  const read = recentLiquidityChange({
    changes: async (positions) => {
      const tokens = positions.map((p) => p.tokenAddress)
      asked.push(tokens)
      const out = answer(tokens)
      if (out instanceof Error) throw out
      return out
    },
    now: () => clock,
  })
  return { read, asked, advance: (ms: number) => { clock += ms } }
}
/** Answers every token asked, keyed as the sweep looks them up. */
const everyone = (usd: number) => (tokens: string[]) => new Map(tokens.map((t) => [`solana:${t}`, reading(usd)]))

describe('recentLiquidityChange — one request for the book, a minute per token, never a remembered failure', () => {
  it('asks for every token in ONE call, keyed by chain and token', async () => {
    const { read, asked } = rig(everyone(100_000))
    const got = await read([at('p1', 'A'), at('p2', 'B'), at('p3', 'C')])
    expect(asked).toEqual([['A', 'B', 'C']])
    expect(got.get('solana:B')).toEqual(reading(100_000))
  })

  it('answers from memory for sixty seconds, then asks again', async () => {
    let usd = 100_000
    const { read, asked, advance } = rig((tokens) => everyone(usd)(tokens))
    await read([at('p1', 'A')])
    usd = 90_000
    advance(60_000)
    expect((await read([at('p1', 'A')])).get('solana:A')?.usd).toBe(100_000)
    expect(asked).toHaveLength(1)
    advance(1)
    expect((await read([at('p1', 'A')])).get('solana:A')?.usd).toBe(90_000)
    expect(asked).toHaveLength(2)
  })

  it('asks only for the tokens it does not hold fresh', async () => {
    const { read, asked, advance } = rig(everyone(100_000))
    await read([at('p1', 'A')])
    advance(30_000)
    await read([at('p1', 'A'), at('p2', 'B')])
    expect(asked).toEqual([['A'], ['B']])
  })

  it('asks once for two positions in one token', async () => {
    const { read, asked } = rig(everyone(100_000))
    const got = await read([at('p1', 'A'), at('p2', 'A')])
    expect(asked).toEqual([['A']])
    expect(got.get('solana:A')).toEqual(reading(100_000))
  })

  it('asks nothing at all when every token is fresh — or there is no book', async () => {
    const { read, asked } = rig(everyone(100_000))
    await read([at('p1', 'A')])
    await read([at('p1', 'A')])
    await read([])
    expect(asked).toHaveLength(1)
  })

  it('never remembers a failure: a throw serves what is fresh, and asks again next sweep', async () => {
    let fail = false
    const { read, asked, advance } = rig((tokens) => (fail ? new Error('HTTP 503') : everyone(100_000)(tokens)))
    await read([at('p1', 'A')])
    advance(30_000)
    fail = true
    const got = await read([at('p1', 'A'), at('p2', 'B')])
    expect(got.get('solana:A')).toEqual(reading(100_000))
    expect(got.has('solana:B')).toBe(false)
    fail = false
    await read([at('p2', 'B')])
    expect(asked).toEqual([['A'], ['B'], ['B']])
  })

  it('never remembers silence: a token nobody answered about is asked again', async () => {
    const { read, asked } = rig(() => new Map())
    expect((await read([at('p1', 'A')])).has('solana:A')).toBe(false)
    await read([at('p1', 'A')])
    expect(asked).toHaveLength(2)
  })
})
