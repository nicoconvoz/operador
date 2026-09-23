import { describe, it, expect } from 'vitest'
import { mintFactsFrom, SolanaMints, SPL_TOKEN, TOKEN_2022 } from './mint-facts.js'

/**
 * Every shape here is copied from a live `getMultipleAccounts` response
 * (jsonParsed) over Jupiter's trending list, Sept 2026 — not from the docs.
 * Of those hundred mints, 46 were Token-2022: 19 carried a permanent
 * delegate (tokenised stocks — MU, TSLAx, MSTRx, PAXG), 13 a transfer fee of
 * 1-3% (GROK, DUEL, BEER), 20 a transfer hook. Pump.fun's own Token-2022
 * mints carried only `metadataPointer` and `tokenMetadata`.
 */

const account = (owner: string, info: Record<string, unknown>) => ({
  owner,
  data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true, supply: '1', ...info } } },
})

const clean = { mintAuthority: null, freezeAuthority: null }

describe('mintFactsFrom — what the chain itself says about a mint', () => {
  it('reads a classic SPL mint: tax and blacklist powers are impossible there', () => {
    // The legacy token program has no extensions at all. A transfer fee, a
    // permanent delegate, a pause switch — none can exist on it, so zero and
    // false are FACTS about the program, not optimism about the token.
    expect(mintFactsFrom(account(SPL_TOKEN, clean))).toEqual({
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      transferTaxPct: 0,
      hasBlacklist: false,
    })
  })

  it('sees a live mint or freeze authority', () => {
    const facts = mintFactsFrom(account(SPL_TOKEN, { mintAuthority: 'Dev1', freezeAuthority: 'Dev2' }))
    expect(facts?.mintAuthorityActive).toBe(true)
    expect(facts?.freezeAuthorityActive).toBe(true)
  })

  it('passes pump.fun Token-2022: metadata extensions are not powers over holders', () => {
    const facts = mintFactsFrom(account(TOKEN_2022, {
      ...clean,
      extensions: [
        { extension: 'metadataPointer', state: { authority: null, metadataAddress: 'M' } },
        { extension: 'tokenMetadata', state: { name: 'x', symbol: 'X', updateAuthority: null } },
      ],
    }))
    expect(facts).toEqual({ mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0, hasBlacklist: false })
  })

  it('reads the transfer fee, taking the higher of the two schedules', () => {
    // A fee change is staged as `newerTransferFee` and takes effect at its
    // epoch. Either one may be the one charged on the next transfer, so the
    // larger is the honest answer.
    const facts = mintFactsFrom(account(TOKEN_2022, {
      ...clean,
      extensions: [{
        extension: 'transferFeeConfig',
        state: {
          newerTransferFee: { epoch: 1039, maximumFee: 1e15, transferFeeBasisPoints: 300 },
          olderTransferFee: { epoch: 1039, maximumFee: 1e15, transferFeeBasisPoints: 100 },
          transferFeeConfigAuthority: null,
        },
      }],
    }))
    expect(facts?.transferTaxPct).toBe(3)
  })

  describe('blacklist-class powers: the issuer can stop you selling, or take the tokens', () => {
    const withExt = (extension: string, state: Record<string, unknown>) =>
      mintFactsFrom(account(TOKEN_2022, { ...clean, extensions: [{ extension, state }] }))?.hasBlacklist

    it('a permanent delegate can move or burn tokens out of ANY holder', () => {
      expect(withExt('permanentDelegate', { delegate: 'Issuer' })).toBe(true)
      expect(withExt('permanentDelegate', { delegate: null })).toBe(false)
    })

    it('a pause authority can stop every transfer, sells included', () => {
      expect(withExt('pausableConfig', { authority: 'Issuer', paused: false })).toBe(true)
      expect(withExt('pausableConfig', { authority: null, paused: false })).toBe(false)
    })

    it('a transfer hook runs arbitrary code on every transfer — and an authority can install one later', () => {
      expect(withExt('transferHook', { authority: null, programId: 'Hook' })).toBe(true)
      expect(withExt('transferHook', { authority: 'Issuer', programId: null })).toBe(true)
      expect(withExt('transferHook', { authority: null, programId: null })).toBe(false)
    })

    it('accounts that are born frozen cannot sell until the issuer thaws them', () => {
      expect(withExt('defaultAccountState', { accountState: 'frozen' })).toBe(true)
      expect(withExt('defaultAccountState', { accountState: 'initialized' })).toBe(false)
    })

    it('a live fee authority can raise the toll after you buy', () => {
      expect(withExt('transferFeeConfig', {
        newerTransferFee: { transferFeeBasisPoints: 0 }, olderTransferFee: { transferFeeBasisPoints: 0 },
        transferFeeConfigAuthority: 'Issuer',
      })).toBe(true)
    })

    it('non-transferable tokens cannot be sold at all', () => {
      expect(withExt('nonTransferable', {})).toBe(true)
    })

    it('a close authority matches what GoPlus counted as blacklist-class', () => {
      expect(withExt('mintCloseAuthority', { closeAuthority: 'Issuer' })).toBe(true)
      expect(withExt('mintCloseAuthority', { closeAuthority: null })).toBe(false)
    })
  })

  it('has no opinion on an account that is not a mint it understands', () => {
    // Silence, not a verdict: returning "safe" here would pass a token nobody
    // examined, and returning "unsafe" would condemn one nobody examined.
    expect(mintFactsFrom(null)).toBeNull()
    expect(mintFactsFrom({ owner: '11111111111111111111111111111111', data: {} })).toBeNull()
    // A token ACCOUNT under the same program is not a mint.
    expect(mintFactsFrom({ owner: SPL_TOKEN, data: { parsed: { type: 'account', info: {} } } })).toBeNull()
  })
})

describe('SolanaMints — a hundred mints per request', () => {
  const rig = (reply: (mints: string[]) => unknown[]) => {
    const requests: string[][] = []
    let clock = 0
    const mints = new SolanaMints('https://rpc.test', async (_url, body) => {
      const mintsAsked = (body as { params: [string[]] }).params[0]
      requests.push(mintsAsked)
      return { status: 200, json: async () => ({ result: { value: reply(mintsAsked) } }) }
    }, { now: () => clock, maxAgeMs: 60_000 })
    return { mints, requests, advance: (ms: number) => { clock += ms } }
  }

  it('asks for the whole book in batches of a hundred, not one by one', async () => {
    const { mints, requests } = rig((asked) => asked.map(() => account(SPL_TOKEN, clean)))
    const addresses = Array.from({ length: 250 }, (_, i) => `M${i}`)
    await mints.prefetch(addresses)
    expect(requests.map((r) => r.length)).toEqual([100, 100, 50])
  })

  it('answers from what it already fetched, without another request', async () => {
    const { mints, requests } = rig((asked) => asked.map(() => account(SPL_TOKEN, clean)))
    await mints.prefetch(['A', 'B'])
    expect(await mints.security('solana', 'A')).toMatchObject({ hasBlacklist: false })
    expect(requests).toHaveLength(1)
  })

  it('re-asks once its answer is older than a minute', async () => {
    // Safety facts are re-asked at the door, and a pause switch can flip. A
    // cache that never expires would let the door approve on an old answer.
    const { mints, requests, advance } = rig((asked) => asked.map(() => account(SPL_TOKEN, clean)))
    await mints.prefetch(['A'])
    advance(61_000)
    await mints.security('solana', 'A')
    expect(requests).toHaveLength(2)
  })

  it('has nothing to say about another chain', async () => {
    const { mints, requests } = rig(() => [])
    expect(await mints.security('bsc', 'A')).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('a failed request is not a verdict — nothing is cached, the gates fail closed', async () => {
    // The body of a 502 is an HTML page, not JSON. Parsing it would throw out
    // of the scan; the status is what keeps a bad minute from becoming a crash.
    const mints = new SolanaMints('https://rpc.test', async () => ({
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    }))
    expect(await mints.security('solana', 'A')).toBeNull()
  })
})
