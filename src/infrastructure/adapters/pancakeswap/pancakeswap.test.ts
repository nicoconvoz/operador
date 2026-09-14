import { describe, it, expect } from 'vitest'
import {
  BSC_USDT,
  decodeAmounts,
  encodeGetAmountsOut,
  jsonRpcEthCall,
  PancakeSwap,
  PANCAKE_V2_ROUTER,
  WBNB,
} from './pancakeswap.js'

const CAKE = '0x0e09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
const ONE = 10n ** 18n

/** Builds a `uint256[]` return value the way the router does. */
const amountsResult = (...amounts: bigint[]): string =>
  '0x' +
  ''.padStart(64, '0').slice(0, 62) + '20' + // offset
  amounts.length.toString(16).padStart(64, '0') +
  amounts.map((a) => a.toString(16).padStart(64, '0')).join('')

describe('ABI encoding — written by hand, so it is tested by hand', () => {
  it('encodes the selector, the amount, the offset, the length and the path', () => {
    const data = encodeGetAmountsOut(ONE, [CAKE, BSC_USDT])
    expect(data.startsWith('0xd06ca61f')).toBe(true)
    const body = data.slice(10)
    expect(body.slice(0, 64)).toBe(ONE.toString(16).padStart(64, '0'))
    expect(body.slice(64, 128)).toBe('40'.padStart(64, '0'))
    expect(body.slice(128, 192)).toBe('2'.padStart(64, '0'))
    expect(body.slice(192, 256)).toContain(CAKE.slice(2).toLowerCase())
    expect(body).toHaveLength(64 * 5)
  })

  it('lowercases and left-pads every address to 32 bytes', () => {
    const data = encodeGetAmountsOut(1n, [CAKE.toUpperCase(), WBNB, BSC_USDT])
    expect(data).not.toMatch(/[A-F]/)
    expect(data.slice(10)).toHaveLength(64 * 6)
  })

  it('decodes a uint256 array', () => {
    expect(decodeAmounts(amountsResult(ONE, 3n, 2346514553421625n))).toEqual([ONE, 3n, 2346514553421625n])
  })

  it('refuses anything that is not one, rather than returning nonsense', () => {
    expect(decodeAmounts('0x')).toBeNull()
    expect(decodeAmounts('0x' + '0'.repeat(64))).toBeNull()
    // Claims three entries, carries one.
    expect(decodeAmounts('0x' + '20'.padStart(64, '0') + '3'.padStart(64, '0') + '1'.padStart(64, '0'))).toBeNull()
  })
})

describe('PancakeSwap — quoting a sell', () => {
  it('quotes the direct pair and reports USD out', async () => {
    const calls: { to: string; data: string }[] = []
    const pancake = new PancakeSwap(async (to, data) => {
      calls.push({ to, data })
      return amountsResult(ONE, 2n * ONE)
    })
    const quote = await pancake.quoteSell(CAKE, ONE, 18)
    expect(quote).toEqual({ ok: true, outUsd: 2, hops: 1 })
    expect(calls[0]!.to).toBe(PANCAKE_V2_ROUTER)
  })

  it('falls back to routing through WBNB when the direct pair reverts', async () => {
    let call = 0
    const pancake = new PancakeSwap(async () => {
      call++
      if (call === 1) throw new Error('execution reverted')
      return amountsResult(ONE, ONE / 300n, 2n * ONE)
    })
    const quote = await pancake.quoteSell(CAKE, ONE, 18)
    expect(quote).toMatchObject({ ok: true, hops: 2 })
  })

  it('a revert on every path means no route — which is what a honeypot looks like', async () => {
    const pancake = new PancakeSwap(async () => { throw new Error('execution reverted') })
    expect(await pancake.quoteSell(CAKE, ONE, 18)).toMatchObject({ ok: false, reason: 'no-route' })
  })

  it('an RPC failure is NOT a no-route — it is inconclusive', async () => {
    const pancake = new PancakeSwap(async () => { throw new Error('ETIMEDOUT') })
    expect(await pancake.quoteSell(CAKE, ONE, 18)).toMatchObject({ ok: false, reason: 'rpc' })
  })

  it('a zero quote is a failure, not a price of zero', async () => {
    const pancake = new PancakeSwap(async () => amountsResult(ONE, 0n))
    expect(await pancake.quoteSell(CAKE, ONE, 18)).toMatchObject({ ok: false })
  })

  it('waits on the shared throttle before every call', async () => {
    let waits = 0
    const pancake = new PancakeSwap(async () => amountsResult(ONE, ONE), { wait: async () => { waits++ } })
    await pancake.quoteSell(CAKE, ONE, 18)
    expect(waits).toBe(1)
  })
})

describe('PancakeSwap — assessSell, the same contract as Jupiter', () => {
  /** Constant-product: out = reserveOut × in / (reserveIn + in). */
  const pool = (reserveIn: bigint, reserveOut: bigint) => async (_to: string, data: string) => {
    const amountIn = BigInt('0x' + data.slice(10, 74))
    const out = (reserveOut * amountIn) / (reserveIn + amountIn)
    return amountsResult(amountIn, out)
  }

  it('ok when the route pays roughly what the position is worth', async () => {
    const pancake = new PancakeSwap(pool(1_000_000n * ONE, 1_000_000n * ONE))
    const assessment = await pancake.assessSell(CAKE, ONE, 18, 1)
    expect(assessment.sellQuote).toBe('ok')
  })

  it('implausible when it pays far less than expected — the honeypot signature', async () => {
    const pancake = new PancakeSwap(pool(1_000_000n * ONE, 1_000_000n * ONE))
    const assessment = await pancake.assessSell(CAKE, ONE, 18, 100)
    expect(assessment.sellQuote).toBe('implausible')
  })

  it('failed when nothing routes, unknown when the RPC is down', async () => {
    const dead = new PancakeSwap(async () => { throw new Error('execution reverted') })
    expect((await dead.assessSell(CAKE, ONE, 18, 1)).sellQuote).toBe('failed')
    const down = new PancakeSwap(async () => { throw new Error('ECONNRESET') })
    expect((await down.assessSell(CAKE, ONE, 18, 1)).sellQuote).toBe('unknown')
  })

  it('MEASURES impact against a tiny probe instead of modelling it', async () => {
    // Selling 10% of the reserve moves the price about 9%.
    const pancake = new PancakeSwap(pool(1_000n * ONE, 1_000n * ONE))
    const assessment = await pancake.assessSell(CAKE, 100n * ONE, 18, 90)
    expect(assessment.priceImpactPct).toBeGreaterThan(8)
    expect(assessment.priceImpactPct).toBeLessThan(10)
  })

  it('a deep pool measures near zero impact', async () => {
    const pancake = new PancakeSwap(pool(10_000_000n * ONE, 10_000_000n * ONE))
    const assessment = await pancake.assessSell(CAKE, ONE, 18, 1)
    expect(assessment.priceImpactPct).toBeLessThan(0.01)
  })

  it('never reports negative impact — that would be quote noise, not a gift', async () => {
    let call = 0
    const pancake = new PancakeSwap(async () => {
      call++
      // The probe prices WORSE than the real order: impossible, so clamp.
      return call === 1 ? amountsResult(ONE, 2n * ONE) : amountsResult(ONE / 1000n, ONE / 1000n)
    })
    const assessment = await pancake.assessSell(CAKE, ONE, 18, 2)
    expect(assessment.priceImpactPct).toBe(0)
  })
})

describe('jsonRpcEthCall', () => {
  it('posts eth_call and returns the result', async () => {
    const bodies: unknown[] = []
    const call = jsonRpcEthCall('https://rpc', async (_url, body) => {
      bodies.push(body)
      return { status: 200, json: async () => ({ result: '0xdeadbeef' }) }
    })
    expect(await call('0xrouter', '0xdata')).toBe('0xdeadbeef')
    expect(bodies[0]).toMatchObject({ method: 'eth_call', params: [{ to: '0xrouter', data: '0xdata' }, 'latest'] })
  })

  it('turns an RPC error into a throw, so the caller can tell revert from outage', async () => {
    const call = jsonRpcEthCall('https://rpc', async () => ({ status: 200, json: async () => ({ error: { message: 'execution reverted' } }) }))
    await expect(call('0xr', '0xd')).rejects.toThrow('execution reverted')
  })

  it('throws on a response with no result at all', async () => {
    const call = jsonRpcEthCall('https://rpc', async () => ({ status: 200, json: async () => ({}) }))
    await expect(call('0xr', '0xd')).rejects.toThrow('no result')
  })
})
