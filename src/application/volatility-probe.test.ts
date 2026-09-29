import { describe, it, expect } from 'vitest'
import { volatilityProbe, VOLATILITY_CANDLES } from './volatility-probe.js'
import { type Candles } from './replay.js'

const series = (closes: readonly number[]): Candles => ({
  time: closes.map((_, i) => i * 300_000),
  open: [...closes],
  high: [...closes],
  low: [...closes],
  close: [...closes],
  volume: closes.map(() => 1),
})
/** A token that alternates up and down by `stepPct` every bar. */
const zigzag = (n: number, stepPct: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 1 + stepPct / 100))
const token = { chain: 'solana' as const, address: 'mint', pairAddress: 'pool' }

describe('volatilityProbe — how much a token moves every five minutes', () => {
  it('reads the last six hours of five-minute closes, and nothing older', async () => {
    let asked = 0
    const probe = volatilityProbe({
      // A calm past, a wild present: only the last 72 bars may count.
      candles: async () => { asked++; return series([...zigzag(200, 0), ...zigzag(VOLATILITY_CANDLES, 2)]) },
      now: () => 0,
    })
    const vol = await probe(token)
    expect(vol).toBeCloseTo(100 * Math.log(1.02), 6)
    expect(asked).toBe(1)
  })

  it('is null with fewer than 24 candles: too little to call it a measurement', async () => {
    const probe = volatilityProbe({ candles: async () => series(zigzag(23, 5)), now: () => 0 })
    expect(await probe(token)).toBeNull()
    const enough = volatilityProbe({ candles: async () => series(zigzag(24, 5)), now: () => 0 })
    expect(await enough(token)).not.toBeNull()
  })

  it('remembers an answer for ten minutes, so a scan every pass does not ask again', async () => {
    let clock = 0
    let asked = 0
    const probe = volatilityProbe({ candles: async () => { asked++; return series(zigzag(72, 1)) }, now: () => clock })
    await probe(token)
    clock = 9 * 60_000
    await probe(token)
    expect(asked).toBe(1)
    clock = 10 * 60_000 + 1
    await probe(token)
    expect(asked).toBe(2)
  })

  it('never remembers a failure: a provider that could not answer has not measured anything', async () => {
    let asked = 0
    const probe = volatilityProbe({
      candles: async () => { asked++; if (asked === 1) throw new Error('429'); return series(zigzag(72, 1)) },
      now: () => 0,
    })
    await expect(probe(token)).rejects.toThrow('429')
    expect(await probe(token)).not.toBeNull()
    expect(asked).toBe(2)
  })
})
