import { type Chain } from '../../../domain/scanner/snapshot.js'
import { type EthCall } from './pancakeswap.js'

/**
 * How many decimals an EVM token uses, asked of the token itself.
 *
 * This exists because the decimals lookup in front of every sell probe was
 * Jupiter's token list — for BOTH chains, and Jupiter is Solana only. It
 * returned null for every BSC address, so the probe was never reached: BSC
 * tokens went untested for honeypots, and their open positions ran with no
 * death watch at all. The PancakeSwap probe was written, wired, and never
 * once called.
 *
 * `decimals()` is the whole ABI: selector, no arguments, one uint8 back. No
 * SDK is worth importing for that.
 */

/** `decimals()` — keccak("decimals()")[0..4]. */
export const DECIMALS_SELECTOR = '0x313ce567'

/** Beyond this nothing real exists; ERC-20 allows a uint8 but reality does not. */
const MAX_PLAUSIBLE = 36

export class Erc20Decimals {
  /** A token cannot change its decimals, so one answer lasts the process. */
  private readonly known = new Map<string, number | null>()

  constructor(private readonly ethCall: EthCall) {}

  async decimals(_chain: Chain, address: string): Promise<number | null> {
    const cached = this.known.get(address)
    if (cached !== undefined) return cached

    const answer = await this.read(address)
    // Only a real answer is remembered: caching a failure would make one bad
    // RPC call permanent for the life of the process.
    if (answer !== null) this.known.set(address, answer)
    return answer
  }

  private async read(address: string): Promise<number | null> {
    try {
      const raw = await this.ethCall(address, DECIMALS_SELECTOR)
      const hex = raw.startsWith('0x') ? raw.slice(2) : raw
      // A contract without decimals() returns empty. That is not an ERC-20,
      // and it is certainly not something to guess a default for.
      if (hex.length === 0) return null

      const value = Number(BigInt('0x' + hex))
      // Null rather than a default. Assuming 18 on a 6-decimal token sizes a
      // sell probe a million times wrong, and a probe that large comes back
      // looking exactly like a honeypot on a perfectly healthy pool.
      return Number.isInteger(value) && value >= 0 && value <= MAX_PLAUSIBLE ? value : null
    } catch {
      return null
    }
  }
}
