import { describe, it, expect } from 'vitest'
import { Erc20Decimals, DECIMALS_SELECTOR } from './erc20-decimals.js'

/**
 * The decimals lookup that stands in FRONT of every sell probe.
 *
 * It used to be Jupiter's token list for BOTH chains — and Jupiter is Solana
 * only. So it returned null for every BSC address, the probe was never
 * reached, and BSC tokens went untested for honeypots while their positions
 * ran with no death watch at all. The PancakeSwap probe existed and nothing
 * ever called it.
 */
describe('Erc20Decimals', () => {
  it('asks the token itself, with the standard selector and no arguments', async () => {
    const seen: { to: string; data: string }[] = []
    const reader = new Erc20Decimals(async (to, data) => {
      seen.push({ to, data })
      return '0x0000000000000000000000000000000000000000000000000000000000000012'
    })

    expect(await reader.decimals('bsc', '0xTOKEN')).toBe(18)
    expect(seen).toEqual([{ to: '0xTOKEN', data: DECIMALS_SELECTOR }])
  })

  it('reads a non-18 token correctly', async () => {
    const reader = new Erc20Decimals(async () => '0x0000000000000000000000000000000000000000000000000000000000000006')
    expect(await reader.decimals('bsc', '0xUSDC')).toBe(6)
  })

  it('returns null rather than guessing when the call fails', async () => {
    const reader = new Erc20Decimals(async () => {
      throw new Error('RPC down')
    })
    // Null is honest. Defaulting to 18 would size a sell probe a million times
    // wrong on a 6-decimal token and call a healthy pool a honeypot.
    expect(await reader.decimals('bsc', '0xTOKEN')).toBeNull()
  })

  it('refuses an implausible answer instead of trusting the wire', async () => {
    const reader = new Erc20Decimals(async () => '0x00000000000000000000000000000000000000000000000000000000000000ff')
    expect(await reader.decimals('bsc', '0xWEIRD')).toBeNull()
  })

  it('returns null for an empty response — a contract with no decimals() is not an ERC-20', async () => {
    const reader = new Erc20Decimals(async () => '0x')
    expect(await reader.decimals('bsc', '0xNOTATOKEN')).toBeNull()
  })

  it('caches: a token cannot change its decimals', async () => {
    let calls = 0
    const reader = new Erc20Decimals(async () => {
      calls += 1
      return '0x0000000000000000000000000000000000000000000000000000000000000012'
    })
    await reader.decimals('bsc', '0xTOKEN')
    await reader.decimals('bsc', '0xTOKEN')
    expect(calls).toBe(1)
  })
})
