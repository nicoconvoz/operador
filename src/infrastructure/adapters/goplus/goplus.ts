import { HttpError, type HttpGet } from '../../http.js'
import { type Chain, type SecurityReport } from '../../../domain/scanner/snapshot.js'

/**
 * GoPlus token security — the safety gates' main source.
 *
 * Public endpoints answered without an access token in Sept 2026 (code 1,
 * "ok") on both chains. Shapes below were confirmed live, and differ from the
 * docs in two ways that matter:
 *  - every `percent` is a FRACTION string: "0.0883" means 8.83%
 *  - the Solana key is `non_transferable`, not `none_transferable`
 *
 * Solana has NO honeypot flag here. The sell test on Solana is a Jupiter
 * quote (see jupiter.ts); this adapter leaves `honeypot` null for Solana and
 * the caller fills it in.
 */

export const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1'
const BSC_CHAIN_ID = '56'

type Flag = '0' | '1' | null | undefined
const flag = (v: Flag): boolean | null => (v === '1' ? true : v === '0' ? false : null)
const fractionPct = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n * 100 : null
}

interface Authority {
  readonly status: Flag
  readonly authority?: readonly { readonly address: string }[]
}

export interface GoPlusSolanaToken {
  readonly mintable?: Authority
  readonly freezable?: Authority
  readonly closable?: Authority
  readonly balance_mutable_authority?: Authority
  readonly transfer_fee?: { readonly current_fee_rate?: { readonly fee_rate?: string } }
  readonly non_transferable?: Flag
  readonly holders?: readonly { readonly account: string; readonly percent: string; readonly is_locked: number; readonly tag?: string }[] | null
  readonly lp_holders?: readonly { readonly token_account?: string; readonly percent: string; readonly is_locked?: number; readonly tag?: string }[] | null
  readonly creators?: readonly { readonly address: string }[] | null
  readonly trusted_token?: number
}

export interface GoPlusEvmToken {
  readonly is_honeypot?: Flag
  readonly is_mintable?: Flag
  readonly is_proxy?: Flag
  readonly is_open_source?: Flag
  readonly buy_tax?: string | null
  readonly sell_tax?: string | null
  readonly is_blacklisted?: Flag
  readonly transfer_pausable?: Flag
  readonly cannot_sell_all?: Flag
  readonly creator_percent?: string | null
  readonly holders?: readonly { readonly address: string; readonly percent: string; readonly is_locked: number; readonly tag?: string }[] | null
  readonly lp_holders?: readonly { readonly address: string; readonly percent: string; readonly is_locked: number; readonly tag?: string }[] | null
}

interface Envelope<T> {
  readonly code: number
  readonly message: string
  readonly result?: Record<string, T>
}

export interface GoPlusOptions {
  /** Minimum spacing between calls. GoPlus returned code 4029 after ~50 back-to-back calls. */
  readonly minIntervalMs?: number
  /** Retries on 4029 / HTTP 429, with doubling backoff starting at `backoffMs`. */
  readonly maxRetries?: number
  readonly backoffMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

const RATE_LIMITED = 4029

export class GoPlus {
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private lastCallAt = -Infinity

  constructor(private readonly http: HttpGet, options: GoPlusOptions = {}) {
    // 1.3s spacing still drew 4029s on a 55-token pass; 2s with a 5s backoff holds.
    this.minIntervalMs = options.minIntervalMs ?? 2_000
    this.maxRetries = options.maxRetries ?? 2
    this.backoffMs = options.backoffMs ?? 5_000
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  /** Security report for one token. Returns null when GoPlus has never seen it. */
  async securityReport(chain: Chain, address: string): Promise<SecurityReport | null> {
    if (chain === 'solana') {
      const token = await this.fetchOne<GoPlusSolanaToken>(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${address}`, address)
      return token ? GoPlus.fromSolana(token) : null
    }
    const token = await this.fetchOne<GoPlusEvmToken>(`${GOPLUS_BASE}/token_security/${BSC_CHAIN_ID}?contract_addresses=${address}`, address)
    return token ? GoPlus.fromEvm(token) : null
  }

  static fromSolana(t: GoPlusSolanaToken): SecurityReport {
    const feeRate = t.transfer_fee?.current_fee_rate?.fee_rate
    // No transfer_fee extension at all means no fee — an empty object is
    // what GoPlus returns for plain SPL tokens.
    const transferTaxPct = t.transfer_fee === undefined ? null : feeRate == null ? 0 : fractionPct(feeRate)

    // Any authority a developer keeps that can interfere with holders' funds
    // counts as a blacklist-class power on Solana.
    const balanceMutable = flag(t.balance_mutable_authority?.status)
    const closable = flag(t.closable?.status)
    const nonTransferable = flag(t.non_transferable)
    const hasBlacklist =
      balanceMutable === null && closable === null && nonTransferable === null
        ? null
        : balanceMutable === true || closable === true || nonTransferable === true

    return {
      honeypot: null, // Solana: decided by a Jupiter sell quote, not GoPlus
      mintAuthorityActive: flag(t.mintable?.status),
      freezeAuthorityActive: flag(t.freezable?.status),
      transferTaxPct,
      hasBlacklist,
      lpLockedPct: GoPlus.lockedShare(t.lp_holders),
      topHoldersPct: GoPlus.topShare(t.holders),
      creatorPct: null, // GoPlus lists creator addresses, not their share
      verifiedSource: null,
      isProxy: null,
    }
  }

  static fromEvm(t: GoPlusEvmToken): SecurityReport {
    const buy = fractionPct(t.buy_tax)
    const sell = fractionPct(t.sell_tax)
    const transferTaxPct = buy === null && sell === null ? null : Math.max(buy ?? 0, sell ?? 0)
    const blacklist = flag(t.is_blacklisted)
    const pausable = flag(t.transfer_pausable)
    const cannotSellAll = flag(t.cannot_sell_all)
    const hasBlacklist =
      blacklist === null && pausable === null && cannotSellAll === null
        ? null
        : blacklist === true || pausable === true || cannotSellAll === true

    return {
      honeypot: flag(t.is_honeypot),
      mintAuthorityActive: flag(t.is_mintable),
      freezeAuthorityActive: false, // no such primitive on EVM; pausable is folded into hasBlacklist
      transferTaxPct,
      hasBlacklist,
      lpLockedPct: GoPlus.lockedShare(t.lp_holders),
      topHoldersPct: GoPlus.topShare(t.holders),
      creatorPct: fractionPct(t.creator_percent),
      verifiedSource: flag(t.is_open_source),
      isProxy: flag(t.is_proxy),
    }
  }

  /** Share of LP held by locked or burned holders, in percent; null when GoPlus has no LP data. */
  private static lockedShare(lp: readonly { readonly percent: string; readonly is_locked?: number; readonly tag?: string; readonly address?: string; readonly token_account?: string }[] | null | undefined): number | null {
    if (!lp || lp.length === 0) return null
    let locked = 0
    for (const holder of lp) {
      const share = fractionPct(holder.percent) ?? 0
      const burned = /burn|dead/i.test(holder.tag ?? '') || /^0x0{36}dead$/i.test(holder.address ?? '') || /^1{20,}$/.test(holder.token_account ?? '')
      if (holder.is_locked === 1 || burned) locked += share
    }
    return locked
  }

  /** Combined share of the top 10 holders, in percent, ignoring burn addresses and locked (vesting) balances. */
  private static topShare(holders: readonly { readonly percent: string; readonly is_locked?: number; readonly tag?: string; readonly address?: string }[] | null | undefined): number | null {
    if (!holders || holders.length === 0) return null
    let total = 0
    for (const holder of holders.slice(0, 10)) {
      const burned = /burn|dead/i.test(holder.tag ?? '') || /^0x0{36}dead$/i.test(holder.address ?? '')
      if (burned) continue
      total += fractionPct(holder.percent) ?? 0
    }
    return total
  }

  private async fetchOne<T>(url: string, address: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle()
      const response = await this.http(url)
      const body = response.status === 200 ? ((await response.json()) as Envelope<T>) : null
      const limited = response.status === 429 || body?.code === RATE_LIMITED

      if (limited && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs * 2 ** attempt)
        continue
      }
      if (response.status !== 200) throw new HttpError(url, response.status)
      if (body!.code !== 1) throw new HttpError(url, response.status, `GoPlus code ${body!.code}: ${body!.message}`)
      const result = body!.result ?? {}
      // EVM results are keyed by lowercase address.
      return result[address] ?? result[address.toLowerCase()] ?? null
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.minIntervalMs - this.now()
    if (wait > 0) await this.sleep(wait)
    this.lastCallAt = this.now()
  }
}
