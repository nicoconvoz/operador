import { type SellQuoteResult } from '../../../domain/risk/death-exit.js'
import { NO_THROTTLE, type Throttle } from '../../http.js'
import { type SellAssessment } from '../jupiter/jupiter.js'

/**
 * PancakeSwap V2 — sell quotes on BSC, by calling the router directly.
 *
 * This is the missing half of BSC support. Without it, "can this position be
 * sold?" was answered by GoPlus's `is_honeypot` flag — a third party's OPINION
 * — while on Solana the same question is answered by quoting a real sell. The
 * whole death exit rests on that difference, so BSC deserved the real test.
 *
 * No SDK and no API key: a quote is one `eth_call` to `getAmountsOut`, and the
 * ABI encoding for that one function is short enough to write by hand. Adding
 * ethers to encode a single call would be a dependency, a bundle and a supply
 * chain, for forty lines of hex.
 *
 * Confirmed live (Sept 2026) against https://bsc-dataseed.binance.org.
 */

export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955'
export const USDT_DECIMALS = 18

/** `getAmountsOut(uint256 amountIn, address[] path)`. */
const GET_AMOUNTS_OUT = '0xd06ca61f'

export type EthCall = (to: string, data: string) => Promise<string>

export interface PancakeQuote {
  readonly ok: true
  /** Output in whole USDT — BSC's USDT has 18 decimals, not 6. */
  readonly outUsd: number
  readonly hops: number
}

export interface PancakeFailure {
  readonly ok: false
  readonly reason: 'no-route' | 'rpc' | 'malformed'
  readonly detail: string
}

const pad = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/**
 * Encodes `getAmountsOut`. The layout, for anyone auditing it:
 *   selector | amountIn | offset to array (0x40) | array length | addresses…
 */
export function encodeGetAmountsOut(amountIn: bigint, path: readonly string[]): string {
  return (
    GET_AMOUNTS_OUT +
    pad(amountIn.toString(16)) +
    pad('40') +
    pad(path.length.toString(16)) +
    path.map((address) => pad(address)).join('')
  )
}

/** Decodes `uint256[]`. Returns null on anything that is not one. */
export function decodeAmounts(result: string): bigint[] | null {
  const hex = result.replace(/^0x/, '')
  if (hex.length < 128) return null
  const length = Number.parseInt(hex.slice(64, 128), 16)
  if (!Number.isFinite(length) || length === 0 || hex.length < 128 + length * 64) return null
  const amounts: bigint[] = []
  for (let i = 0; i < length; i++) amounts.push(BigInt(`0x${hex.slice(128 + i * 64, 192 + i * 64)}`))
  return amounts
}

export class PancakeSwap {
  constructor(
    private readonly ethCall: EthCall,
    private readonly throttle: Throttle = NO_THROTTLE,
    private readonly router: string = PANCAKE_V2_ROUTER,
  ) {}

  /**
   * Quotes selling `amountRaw` of `token` into USDT.
   *
   * Tries the direct pair first, then routes through WBNB. A token with no
   * path to USDT either way cannot be sold for dollars — which is precisely
   * what the death exit needs to know.
   */
  async quoteSell(token: string, amountRaw: bigint, decimals: number): Promise<PancakeQuote | PancakeFailure> {
    const paths = [
      [token, BSC_USDT],
      [token, WBNB, BSC_USDT],
    ]

    let lastDetail = 'no path returned an amount'
    for (const path of paths) {
      await this.throttle.wait()
      let result: string
      try {
        result = await this.ethCall(this.router, encodeGetAmountsOut(amountRaw, path))
      } catch (error) {
        // A reverting call is how the router says "no liquidity on this path".
        // An RPC that is down says the same thing at this level, so only give
        // up on the whole quote once every path has been tried.
        lastDetail = String(error).slice(0, 120)
        continue
      }

      const amounts = decodeAmounts(result)
      if (!amounts || amounts.length !== path.length) {
        lastDetail = 'router returned an unexpected shape'
        continue
      }

      const out = amounts[amounts.length - 1]!
      if (out > 0n) {
        return { ok: true, outUsd: Number(out) / 10 ** USDT_DECIMALS, hops: path.length - 1 }
      }
      lastDetail = 'router quoted zero out'
    }

    return { ok: false, reason: /revert|execution/i.test(lastDetail) ? 'no-route' : 'rpc', detail: lastDetail }
  }

  /**
   * The same contract as Jupiter's `assessSell`, so the scanner and the death
   * watch do not care which chain they are on.
   *
   * Price impact is measured the honest way: quote a tiny amount to learn the
   * undisturbed price, quote the real amount, and take the difference. That is
   * what impact IS — what your own order costs you — and it needs no model.
   */
  async assessSell(token: string, amountRaw: bigint, decimals: number, expectedUsd: number, maxShortfallPct = 50): Promise<SellAssessment> {
    const full = await this.quoteSell(token, amountRaw, decimals)
    if (!full.ok) {
      return { sellQuote: full.reason === 'no-route' ? 'failed' : 'unknown', priceImpactPct: null }
    }
    if (full.outUsd <= 0) return { sellQuote: 'failed', priceImpactPct: null }

    const priceImpactPct = await this.measureImpact(token, amountRaw, decimals, full.outUsd)

    const verdict: SellQuoteResult =
      expectedUsd > 0 && full.outUsd < expectedUsd * (1 - maxShortfallPct / 100) ? 'implausible' : 'ok'
    return { sellQuote: verdict, priceImpactPct }
  }

  /** Impact = how much worse the real order prices than a negligible one. */
  private async measureImpact(token: string, amountRaw: bigint, decimals: number, outUsd: number): Promise<number | null> {
    // A thousandth of the order, floored at one base unit.
    const probeRaw = amountRaw / 1000n > 0n ? amountRaw / 1000n : 1n
    const probe = await this.quoteSell(token, probeRaw, decimals)
    if (!probe.ok || probe.outUsd <= 0) return null

    const undisturbedPrice = probe.outUsd / Number(probeRaw)
    const realisedPrice = outUsd / Number(amountRaw)
    if (!(undisturbedPrice > 0)) return null

    const impact = (1 - realisedPrice / undisturbedPrice) * 100
    // A negative reading is noise between two quotes, not a gift.
    return Math.max(0, impact)
  }
}

/** JSON-RPC `eth_call` over any transport. Split out so the adapter is testable. */
export function jsonRpcEthCall(
  rpcUrl: string,
  post: (url: string, body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>,
): EthCall {
  return async (to, data) => {
    const response = await post(rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    const body = (await response.json()) as { result?: string; error?: { message?: string } }
    if (body.error) throw new Error(body.error.message ?? 'eth_call failed')
    if (typeof body.result !== 'string') throw new Error('eth_call returned no result')
    return body.result
  }
}
