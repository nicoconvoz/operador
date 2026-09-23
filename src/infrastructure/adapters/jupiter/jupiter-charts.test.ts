import { describe, it, expect } from 'vitest'
import { JupiterCharts, JUPITER_CHARTS_BASE } from './jupiter-charts.js'
import { FIFTEEN_MINUTES, ONE_HOUR } from '../geckoterminal/geckoterminal.js'
import { type HttpGet } from '../../http.js'

/**
 * *La operativa también la quiero con Jupiter, todo con Jupiter.*
 *
 * The tick asked GeckoTerminal for a pool's candles, one position at a time,
 * behind a throttle that rate-limits hardest of any provider this engine uses —
 * about 2.5s a position before any refusal. Measured against the book's own
 * size: forty mints from Jupiter's chart endpoint took 10.5s in a row and 2.0s
 * eight at a time, with not one refusal in eighty requests.
 *
 * Shape confirmed live (Sept 2026): GET /v2/charts/<mint>?interval=15_MINUTE
 * &to=<ms>&candles=<n>&type=price → { candles: [{ time (s, the bar's OPEN),
 * open, high, low, close, volume }] }, oldest first, up to a thousand.
 */

const MIN = 60_000
const NOW = 1_790_141_000_000

const answer = (candles: unknown[], status = 200) => {
  const asked: string[] = []
  const http: HttpGet = async (url) => {
    asked.push(url)
    return { status, json: async () => ({ candles }) }
  }
  return { http, asked }
}

const bar = (openMs: number, close: number, volume = 100) => ({
  time: openMs / 1000, open: close, high: close * 1.01, low: close * 0.99, close, volume,
})

describe('JupiterCharts — the same candles the engine always read', () => {
  it('returns them in milliseconds, oldest first, the shape every indicator expects', async () => {
    const a = NOW - 60 * MIN
    const { http } = answer([bar(a, 1), bar(a + 15 * MIN, 2)])
    const candles = await new JupiterCharts(http, { now: () => NOW }).candles('solana', 'Mint', FIFTEEN_MINUTES, 100)
    expect(candles.time).toEqual([a, a + 15 * MIN])
    expect(candles.close).toEqual([1, 2])
    expect(candles.volume).toEqual([100, 100])
  })

  it('drops the bar still being built — the newest one Jupiter returns is', async () => {
    // Measured live: the newest candle had opened 12.7 minutes earlier on a
    // 15-minute bar. Deciding on it is how the engine once bought BinanceTown
    // at a price the bar never closed at — its close is wherever the price
    // happens to be at the instant of the request.
    const forming = NOW - 12 * MIN
    const closed = forming - 15 * MIN
    const { http } = answer([bar(closed, 1), bar(forming, 5)])
    const candles = await new JupiterCharts(http, { now: () => NOW }).candles('solana', 'Mint', FIFTEEN_MINUTES, 100)
    expect(candles.time).toEqual([closed])
  })

  it('keeps a bar that closed exactly now', () => {
    const exactlyClosed = NOW - 15 * MIN
    const { http } = answer([bar(exactlyClosed, 1)])
    return new JupiterCharts(http, { now: () => NOW }).candles('solana', 'Mint', FIFTEEN_MINUTES, 100)
      .then((c) => expect(c.time).toEqual([exactlyClosed]))
  })

  it('skips a row with a non-positive price rather than feeding it to an indicator', async () => {
    const a = NOW - 60 * MIN
    const { http } = answer([bar(a, 1), { ...bar(a + 15 * MIN, 1), low: 0 }])
    const candles = await new JupiterCharts(http, { now: () => NOW }).candles('solana', 'Mint', FIFTEEN_MINUTES, 100)
    expect(candles.time).toEqual([a])
  })

  it('asks for the bar size and count it was given, by MINT', async () => {
    const { http, asked } = answer([])
    const charts = new JupiterCharts(http, { now: () => NOW })
    await charts.candles('solana', 'Mint1', FIFTEEN_MINUTES, 1000)
    await charts.candles('solana', 'Mint2', ONE_HOUR, 60)
    expect(asked[0]).toBe(`${JUPITER_CHARTS_BASE}/v2/charts/Mint1?interval=15_MINUTE&to=${NOW}&candles=1000&type=price`)
    expect(asked[1]).toContain('/v2/charts/Mint2?interval=1_HOUR')
    expect(asked[1]).toContain('candles=60')
  })

  it('THROWS when it could not answer, so the caller can fall back', async () => {
    // An undocumented endpoint — it is what Jupiter's own site uses — and it can
    // change without notice. An empty series would read as "nobody traded",
    // which is a VERDICT the death watch acts on; a refusal is not one.
    const { http } = answer([], 503)
    await expect(new JupiterCharts(http, { now: () => NOW }).candles('solana', 'Mint', FIFTEEN_MINUTES, 100)).rejects.toThrow()
  })

  it('has nothing to say about another chain', async () => {
    const { http, asked } = answer([])
    await expect(new JupiterCharts(http, { now: () => NOW }).candles('bsc', 'Mint', FIFTEEN_MINUTES, 100)).rejects.toThrow()
    expect(asked).toHaveLength(0)
  })
})
