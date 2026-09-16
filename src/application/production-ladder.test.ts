import { describe, it, expect } from 'vitest'
import { productionLadder, DEFAULT_MAX_DCA_PER_TOKEN, DEFAULT_MAX_USD_PER_LEVEL } from './production-ladder.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'

describe('productionLadder — one place for the two numbers that differ', () => {
  it('defaults to a flat $15 ladder of two DCA rungs', () => {
    // Two, not five: it halves what one token can ever cost and doubles the
    // book. Measured on $1,500 — fourteen positions at $95.09 becomes
    // twenty-nine at $47.57.
    expect(productionLadder({})).toEqual({ maxUsdPerLevel: 15, maxOpenEntries: 3 })
  })

  it('counts the entry on top of the DCA rungs, because the entry is not one', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '9' }).maxOpenEntries).toBe(10)
  })

  it('takes an override for either', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: '50', OPERADOR_MAX_DCA: '2' }))
      .toEqual({ maxUsdPerLevel: 50, maxOpenEntries: 3 })
  })

  it('ignores a value that is not a positive number rather than trading on NaN', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: 'lots', OPERADOR_MAX_DCA: '-1' }))
      .toEqual({ maxUsdPerLevel: 15, maxOpenEntries: 3 })
  })

  it('never expresses itself by editing the evidence', () => {
    // DEFAULT_PARAMS and PYRAMIDING are what TradingView ran, and the parity
    // harness asserts them. Evidence that can be edited to express a
    // preference has stopped being evidence.
    expect(DEFAULT_PARAMS.maxUsdPerLevel).toBe(5_000)
    expect(PYRAMIDING).toBe(10)
    expect(DEFAULT_MAX_USD_PER_LEVEL).not.toBe(DEFAULT_PARAMS.maxUsdPerLevel)
    expect(DEFAULT_MAX_DCA_PER_TOKEN + 1).not.toBe(PYRAMIDING)
  })
})
