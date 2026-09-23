import { describe, it, expect } from 'vitest'
import { withLiveMarket } from './live-market.js'
import { type TokenSnapshot } from './snapshot.js'

const stored = {
  chain: 'solana', address: 'A', symbol: 'A', pairAddress: 'P', observedAt: 1,
  priceUsd: 1, liquidityUsd: 100, fdvUsd: 9, volumeUsd: { h1: 1, h6: 1, h24: 1 },
  priceChangePct: { h1: 1, h6: 1, h24: 1 }, txns: { h1: { buys: 1, sells: 1 }, h24: { buys: 1, sells: 1 } },
  pairCreatedAt: 0,
  security: { honeypot: false } as TokenSnapshot['security'],
  securityChecked: true, historyBars: 1_000, lastTradeAgoHours: 0.2, lastCandlePriceUsd: 1.05,
} as TokenSnapshot

const live = { ...stored, priceUsd: 2, liquidityUsd: 200, observedAt: 99 }

describe('withLiveMarket — refresh what the feed knows, keep what it cannot', () => {
  // Three readers now overlay a live market onto a stored snapshot: the
  // universe view, the recall a watch pass allocates from, and whatever comes
  // next. Two implementations of "which half is refreshable" would eventually
  // disagree about whether a token is safe, which is the failure the read model
  // exists to prevent.

  it('takes the market half', () => {
    const merged = withLiveMarket(stored, { ...live, liquidityChangePct: { h1: 4 } })
    expect(merged.priceUsd).toBe(2)
    // The hour's liquidity change is market data: the candidate door reads it.
    expect(merged.liquidityChangePct).toEqual({ h1: 4 })
    expect(merged.liquidityUsd).toBe(200)
    expect(merged.observedAt).toBe(99)
  })

  it('KEEPS everything the market feed cannot answer', () => {
    // Security, the history count, the bar-freshness measurement and the candle
    // price come from the expensive stage of a scan. Overlaying a market
    // response whole would blank the evidence those gates fire on — and they
    // fail closed, so a position would turn red for the crime of being
    // refreshed.
    const merged = withLiveMarket(stored, { ...live, security: undefined } as never)
    expect(merged.security).toBe(stored.security)
    expect(merged.securityChecked).toBe(true)
    expect(merged.historyBars).toBe(1_000)
    expect(merged.lastTradeAgoHours).toBe(0.2)
    expect(merged.lastCandlePriceUsd).toBe(1.05)
  })

  it('keeps the POOL it was examined on, not whichever the feed named today', () => {
    // The engine trades that pool and its candles come from it. A snapshot
    // whose pair moved mid-life would price one venue and trade another.
    expect(withLiveMarket(stored, { ...live, pairAddress: 'OTHER' }).pairAddress).toBe('P')
  })

  it('returns the stored snapshot untouched when there is nothing live', () => {
    expect(withLiveMarket(stored, undefined)).toBe(stored)
  })
})
