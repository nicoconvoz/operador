import { NO_THROTTLE, type HttpGet, type Throttle } from '../../http.js'
import { type SellQuoteResult } from '../../../domain/risk/death-exit.js'

/**
 * Jupiter — Solana's swap aggregator. Used for two things:
 *
 *  1. The SELL PATH PROBE for the death exit: quote a sell of the full
 *     position and see whether a route exists and pays a sane amount.
 *  2. Measuring price impact for a reference size, feeding MarketQuality.
 *
 * Free tier: https://lite-api.jup.ag, no key, fair-use limits. The response
 * shape was confirmed live (Sept 2026).
 */

export const JUPITER_LITE_BASE = 'https://lite-api.jup.ag'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDC_DECIMALS = 6

export interface JupiterQuote {
  readonly inputMint: string
  readonly inAmount: string
  readonly outputMint: string
  readonly outAmount: string
  readonly otherAmountThreshold: string
  readonly swapMode: string
  readonly slippageBps: number
  /** A decimal FRACTION as a string: "0.0123" is 1.23%. */
  readonly priceImpactPct: string
  readonly routePlan: readonly { readonly swapInfo: { readonly label: string }; readonly percent: number }[]
}

export interface QuoteResult {
  readonly ok: true
  readonly quote: JupiterQuote
  /** Output in whole USDC. */
  readonly outUsd: number
  readonly priceImpactPct: number
}

export interface QuoteFailure {
  readonly ok: false
  readonly reason: 'no-route' | 'http' | 'malformed'
  readonly detail: string
}

/** One quote, two answers: the honeypot verdict and the measured impact. */
export interface SellAssessment {
  readonly sellQuote: SellQuoteResult
  readonly priceImpactPct: number | null
}

export class Jupiter {
  constructor(
    private readonly http: HttpGet,
    private readonly throttle: Throttle & { pushedBack?(): void; wentThrough?(): void } = NO_THROTTLE,
    private readonly base: string = JUPITER_LITE_BASE,
  ) {}

  /** Quote selling `amountRaw` base units of `mint` into USDC. */
  async quoteSell(mint: string, amountRaw: bigint, slippageBps = 50): Promise<QuoteResult | QuoteFailure> {
    const url =
      `${this.base}/swap/v1/quote?inputMint=${mint}&outputMint=${USDC_MINT}` +
      `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn`
    // The PROVIDER sets the pace. A 429 is it saying so out loud, and it is the
    // only evidence about its quota that exists — everything else would be a
    // number we chose. So the throttle is told, and the call is retried once at
    // the pace it just asked for rather than being reported as a failure.
    //
    // That last part is what makes this safe to run with no fixed interval: an
    // unanswered sell quote leaves `honeypot` unknown, the gates fail closed,
    // and a perfectly good token is thrown out as unsellable. Speed here was
    // never free — it was paid for in candidates nobody could see being lost.
    let response
    for (let attempt = 0; ; attempt++) {
      try {
        await this.throttle.wait()
        response = await this.http(url)
      } catch (error) {
        return { ok: false, reason: 'http', detail: String(error) }
      }
      if (response.status !== 429) {
        this.throttle.wentThrough?.()
        break
      }
      this.throttle.pushedBack?.()
      if (attempt >= 2) break
    }
    const body = (await response.json()) as Partial<JupiterQuote> & { error?: string }
    if (response.status !== 200) {
      const detail = body.error ?? `HTTP ${response.status}`
      return { ok: false, reason: /route/i.test(detail) ? 'no-route' : 'http', detail }
    }
    if (typeof body.outAmount !== 'string' || typeof body.priceImpactPct !== 'string') {
      return { ok: false, reason: 'malformed', detail: 'missing outAmount or priceImpactPct' }
    }
    const quote = body as JupiterQuote
    return {
      ok: true,
      quote,
      outUsd: Number(quote.outAmount) / 10 ** USDC_DECIMALS,
      priceImpactPct: Number(quote.priceImpactPct) * 100,
    }
  }

  /**
   * The sell probe. `expectedUsd` is what the amount is worth at the last
   * known price; a quote paying far less than that is 'implausible' — the
   * route exists but the market will not honour the price. The same quote
   * yields the measured price impact, so one call answers both questions.
   */
  async assessSell(mint: string, amountRaw: bigint, _decimals: number, expectedUsd: number, maxShortfallPct = 50): Promise<SellAssessment> {
    const result = await this.quoteSell(mint, amountRaw)
    if (!result.ok) return { sellQuote: result.reason === 'no-route' ? 'failed' : 'unknown', priceImpactPct: null }
    if (result.outUsd <= 0) return { sellQuote: 'failed', priceImpactPct: result.priceImpactPct }
    if (expectedUsd > 0 && result.outUsd < expectedUsd * (1 - maxShortfallPct / 100)) {
      return { sellQuote: 'implausible', priceImpactPct: result.priceImpactPct }
    }
    return { sellQuote: 'ok', priceImpactPct: result.priceImpactPct }
  }

  /**
   * The death-exit sell probe for a full position.
   *
   * `decimals` is unused here — Jupiter takes raw amounts — but it is part of
   * the shared SellProbePort because PancakeSwap needs it, and a port shaped
   * around one implementation is not a port.
   */
  async probeSellPath(mint: string, amountRaw: bigint, expectedUsd: number, maxShortfallPct = 50): Promise<SellQuoteResult> {
    return (await this.assessSell(mint, amountRaw, 0, expectedUsd, maxShortfallPct)).sellQuote
  }

  /** Price impact, in percent, of selling `referenceUsd` worth of the token. */
  async measureSlippagePct(mint: string, decimals: number, priceUsd: number, referenceUsd: number): Promise<number | null> {
    if (!(priceUsd > 0)) return null
    const amountRaw = BigInt(Math.floor((referenceUsd / priceUsd) * 10 ** decimals))
    const result = await this.quoteSell(mint, amountRaw)
    return result.ok ? result.priceImpactPct : null
  }
}
