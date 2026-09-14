import { describe, it, expect } from 'vitest'
import { lpLockFromVenue } from './lp-heuristics.js'

describe('lpLockFromVenue — protocol-burned LP', () => {
  it('pump.fun venues burn LP at migration', () => {
    expect(lpLockFromVenue('pumpswap')).toEqual({ lpLockedPct: 100 })
    expect(lpLockFromVenue('PumpFun')).toEqual({ lpLockedPct: 100 })
  })

  it('every other venue stays unknown — and unknown fails closed', () => {
    expect(lpLockFromVenue('raydium')).toEqual({})
    expect(lpLockFromVenue('orca')).toEqual({})
    expect(lpLockFromVenue(undefined)).toEqual({})
  })
})
