import { describe, it, expect } from 'vitest'
import { lpModelOf } from './lp-model.js'

describe('lpModelOf — where an LP lock can even exist', () => {
  it('classic pools carry LP tokens', () => {
    expect(lpModelOf('raydium')).toBe('lp-token')
    expect(lpModelOf('raydium', ['CPMM'])).toBe('lp-token')
    expect(lpModelOf('pumpswap')).toBe('lp-token')
    expect(lpModelOf('pancakeswap')).toBe('lp-token')
    expect(lpModelOf(undefined)).toBe('lp-token')
  })

  it('concentrated venues hold positions as NFTs', () => {
    expect(lpModelOf('orca')).toBe('concentrated')
    expect(lpModelOf('raydium', ['CLMM'])).toBe('concentrated')
    expect(lpModelOf('meteora')).toBe('concentrated')
    expect(lpModelOf('meteora', ['DLMM'])).toBe('concentrated')
  })
})
