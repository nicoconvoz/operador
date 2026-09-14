import { describe, it, expect } from 'vitest'
import { Jupiter, JUPITER_LITE_BASE, USDC_MINT } from './jupiter.js'
import { stubHttp } from '../../http.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'

/** Trimmed from a live lite-api quote: 1,000,000 BONK → USDC (Sept 2026). */
const liveQuote = {
  inputMint: BONK,
  inAmount: '1000000000000',
  outputMint: USDC_MINT,
  outAmount: '27222301',
  otherAmountThreshold: '27086190',
  swapMode: 'ExactIn',
  slippageBps: 50,
  platformFee: null,
  priceImpactPct: '0',
  routePlan: [{ swapInfo: { label: 'Scorch' }, percent: 100 }],
}

const quoteUrl = `${JUPITER_LITE_BASE}/swap/v1/quote?inputMint=${BONK}`

describe('Jupiter adapter — quoteSell', () => {
  it('parses a live quote into USD out and percent impact', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { body: liveQuote } }))
    const result = await jup.quoteSell(BONK, 1_000_000_000_000n)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outUsd).toBeCloseTo(27.222301, 9)
    expect(result.priceImpactPct).toBe(0)
  })

  it('converts Jupiter’s fractional priceImpactPct into percent', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { body: { ...liveQuote, priceImpactPct: '0.0123' } } }))
    const result = await jup.quoteSell(BONK, 1n)
    expect(result.ok && result.priceImpactPct).toBeCloseTo(1.23, 9)
  })

  it('reports a missing route as no-route', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { status: 400, body: { error: 'Could not find any route' } } }))
    expect(await jup.quoteSell(BONK, 1n)).toMatchObject({ ok: false, reason: 'no-route' })
  })

  it('reports other failures as http, and a broken body as malformed', async () => {
    const down = new Jupiter(stubHttp({ [quoteUrl]: { status: 503, body: {} } }))
    expect(await down.quoteSell(BONK, 1n)).toMatchObject({ ok: false, reason: 'http' })
    const weird = new Jupiter(stubHttp({ [quoteUrl]: { body: { hello: 'world' } } }))
    expect(await weird.quoteSell(BONK, 1n)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('sends the amount as an integer string in base units', async () => {
    const http = stubHttp({ [quoteUrl]: { body: liveQuote } })
    await new Jupiter(http).quoteSell(BONK, 123456789012345678901234567890n)
    expect(http.calls[0]).toContain('amount=123456789012345678901234567890')
  })
})

describe('Jupiter adapter — the death-exit sell probe', () => {
  it('ok when a route pays roughly what the position is worth', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { body: liveQuote } }))
    expect(await jup.probeSellPath(BONK, 1_000_000_000_000n, 27.5)).toBe('ok')
  })

  it('implausible when the route pays far less than expected — the honeypot signature', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { body: liveQuote } }))
    expect(await jup.probeSellPath(BONK, 1_000_000_000_000n, 100)).toBe('implausible')
  })

  it('failed when there is no route or nothing comes out', async () => {
    const noRoute = new Jupiter(stubHttp({ [quoteUrl]: { status: 400, body: { error: 'Could not find any route' } } }))
    expect(await noRoute.probeSellPath(BONK, 1n, 10)).toBe('failed')
    const zero = new Jupiter(stubHttp({ [quoteUrl]: { body: { ...liveQuote, outAmount: '0' } } }))
    expect(await zero.probeSellPath(BONK, 1n, 10)).toBe('failed')
  })

  it('unknown when the API itself is unreachable — inconclusive, never a death signal', async () => {
    const down = new Jupiter(stubHttp({ [quoteUrl]: { status: 503, body: {} } }))
    expect(await down.probeSellPath(BONK, 1n, 10)).toBe('unknown')
    const throwing = new Jupiter(async () => { throw new Error('ECONNRESET') })
    expect(await throwing.probeSellPath(BONK, 1n, 10)).toBe('unknown')
  })
})

describe('Jupiter adapter — slippage measurement', () => {
  it('sizes the reference order from price and decimals, returns percent impact', async () => {
    const http = stubHttp({ [quoteUrl]: { body: { ...liveQuote, priceImpactPct: '0.004' } } })
    const jup = new Jupiter(http)
    // $100 of a $0.000002723 token with 5 decimals
    const pct = await jup.measureSlippagePct(BONK, 5, 0.000002723, 100)
    expect(pct).toBeCloseTo(0.4, 9)
    const amount = Math.floor((100 / 0.000002723) * 10 ** 5)
    expect(http.calls[0]).toContain(`amount=${amount}`)
  })

  it('returns null when the price is unusable or the quote fails', async () => {
    const jup = new Jupiter(stubHttp({ [quoteUrl]: { status: 400, body: { error: 'Could not find any route' } } }))
    expect(await jup.measureSlippagePct(BONK, 5, 0, 100)).toBeNull()
    expect(await jup.measureSlippagePct(BONK, 5, 1, 100)).toBeNull()
  })
})
