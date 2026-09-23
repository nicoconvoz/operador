import { type SecurityReport, type Chain } from '../../../domain/scanner/snapshot.js'

/**
 * What the chain itself says about a mint — read in batches of a hundred.
 *
 * ## Why this exists
 *
 * The operator: *es una consulta de unos segundos y la estamos haciendo
 * demorar más de veinte minutos... hagamos todo con Jupiter.* GoPlus answered
 * one address per call on a fixed two-second interval — it refuses to batch on
 * Solana, verified live — and the scan spent most of its time waiting on it.
 * Jupiter's token API answers a hundred mints in half a second and carries the
 * authorities and holder concentration, but NOT the Token-2022 extensions, and
 * 46 of Jupiter's own hundred trending tokens were Token-2022.
 *
 * Accepting those blind would have bought exactly the dangerous ones. In that
 * same list: nineteen with a permanent delegate, thirteen charging 1-3% on
 * every transfer, twenty with a transfer hook. Rejecting them all would have
 * cut the universe nearly in half, and pump.fun's own Token-2022 mints carry
 * nothing but metadata.
 *
 * The extensions are ON the chain. `getMultipleAccounts` with `jsonParsed`
 * returns a hundred mints per request with every extension decoded — under a
 * second, measured. Primary data rather than a vendor's reading of it.
 *
 * ## What counts as blacklist-class
 *
 * Anything that lets the issuer stop you selling or take the tokens: a
 * permanent delegate, a pause authority, a transfer hook (or the authority to
 * install one), accounts born frozen, a live transfer-fee authority, a
 * non-transferable mint, and the close authority GoPlus already counted. That
 * is wider than GoPlus's own definition, deliberately — the operator's rule for
 * safety failures is *restricción total, porque esas me han hecho perder mucho
 * dinero.*
 */

export const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

interface Extension {
  readonly extension?: string
  readonly state?: Record<string, unknown> | null
}

interface ParsedMint {
  readonly owner?: string
  readonly data?: {
    readonly parsed?: {
      readonly type?: string
      readonly info?: {
        readonly mintAuthority?: string | null
        readonly freezeAuthority?: string | null
        readonly extensions?: readonly Extension[]
      }
    }
  }
}

const set = (value: unknown): boolean => value !== null && value !== undefined && value !== ''

const feeBps = (schedule: unknown): number => {
  const bps = (schedule as { transferFeeBasisPoints?: unknown } | null | undefined)?.transferFeeBasisPoints
  return typeof bps === 'number' && Number.isFinite(bps) ? bps : 0
}

/**
 * The security facts a mint account proves, or null when it is not a mint this
 * understands. Null is silence, never a verdict: the gates fail closed on it.
 */
export function mintFactsFrom(account: unknown): Partial<SecurityReport> | null {
  const a = account as ParsedMint | null
  if (!a || (a.owner !== SPL_TOKEN && a.owner !== TOKEN_2022)) return null
  const parsed = a.data?.parsed
  if (parsed?.type !== 'mint' || !parsed.info) return null
  const info = parsed.info

  let transferTaxPct = 0
  let hasBlacklist = false
  for (const ext of info.extensions ?? []) {
    const s = ext.state ?? {}
    switch (ext.extension) {
      case 'transferFeeConfig':
        // A staged change lives in `newerTransferFee` until its epoch; either
        // may be the one charged next, so the larger is the honest answer.
        transferTaxPct = Math.max(feeBps(s.olderTransferFee), feeBps(s.newerTransferFee)) / 100
        if (set(s.transferFeeConfigAuthority)) hasBlacklist = true
        break
      case 'permanentDelegate':
        if (set(s.delegate)) hasBlacklist = true
        break
      case 'pausableConfig':
        if (set(s.authority) || s.paused === true) hasBlacklist = true
        break
      case 'transferHook':
        if (set(s.programId) || set(s.authority)) hasBlacklist = true
        break
      case 'defaultAccountState':
        if (s.accountState === 'frozen') hasBlacklist = true
        break
      case 'nonTransferable':
        hasBlacklist = true
        break
      case 'mintCloseAuthority':
        if (set(s.closeAuthority)) hasBlacklist = true
        break
    }
  }

  return {
    mintAuthorityActive: set(info.mintAuthority),
    freezeAuthorityActive: set(info.freezeAuthority),
    transferTaxPct,
    hasBlacklist,
  }
}

export type PostJson = (url: string, body: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>

export interface SolanaMintsOptions {
  readonly now?: () => number
  /**
   * How long an answer stands. A minute: long enough that one scan asks once,
   * short enough that the door — which re-asks safety before any money moves —
   * never approves on an answer from the previous pass. A pause switch flips.
   */
  readonly maxAgeMs?: number
}

/** The RPC's own ceiling for `getMultipleAccounts`. */
const BATCH = 100

export class SolanaMints {
  private readonly cache = new Map<string, { facts: Partial<SecurityReport> | null; at: number }>()
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(
    private readonly rpcUrl: string,
    private readonly post: PostJson,
    options: SolanaMintsOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? 60_000
  }

  /** Fetch every address, a hundred per request, and remember the answers. */
  async prefetch(addresses: readonly string[]): Promise<void> {
    const unique = [...new Set(addresses)]
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH)
      const response = await this.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [batch, { encoding: 'jsonParsed' }],
      })
      // A refused request is not a verdict about any token. Nothing is cached,
      // so the next ask tries again and the gates fail closed meanwhile.
      if (response.status !== 200) continue
      const body = (await response.json()) as { result?: { value?: readonly unknown[] } }
      const value = body.result?.value
      if (!Array.isArray(value)) continue
      const at = this.now()
      batch.forEach((address, index) => this.cache.set(address, { facts: mintFactsFrom(value[index]), at }))
    }
  }

  async security(chain: Chain, address: string): Promise<Partial<SecurityReport> | null> {
    if (chain !== 'solana') return null
    const hit = this.cache.get(address)
    if (!hit || this.now() - hit.at > this.maxAgeMs) await this.prefetch([address])
    return this.cache.get(address)?.facts ?? null
  }
}
