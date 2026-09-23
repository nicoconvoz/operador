import { describe, it, expect } from 'vitest'
import { productionLadder, DEFAULT_MAX_DCA_PER_TOKEN, DEFAULT_MAX_USD_PER_LEVEL } from './production-ladder.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'

describe('productionLadder — one place for the two numbers that differ', () => {
  it('defaults to a flat $15 ladder of an entry and FIVE DCA rungs', () => {
    // *Agregá 5 escalones de DCA... cada escalón de 15 dólares.* The operator,
    // after the single buy ran out of ways to rescue a position under water.
    expect(productionLadder({})).toEqual({ maxUsdPerLevel: 15, maxOpenEntries: 6, dropInitPct: 0, impatientProfitPct: 10, urgentProfitPct: 25, dcaGapPct: 5, dcaFloorBars: 5 })
  })

  it('holds the floor rule the engine and the screen both read', () => {
    // *Un piso lateral de 5 velas de 1 minuto*, five percent under the last
    // buy. One place, because a screen drawing a different rung from the one
    // the engine buys is the drift this module exists to prevent.
    expect(productionLadder({ OPERADOR_DCA_GAP_PCT: '8', OPERADOR_DCA_FLOOR_BARS: '3' })).toMatchObject({ dcaGapPct: 8, dcaFloorBars: 3 })
    expect(productionLadder({ OPERADOR_DCA_GAP_PCT: 'x', OPERADOR_DCA_FLOOR_BARS: '-2' })).toMatchObject({ dcaGapPct: 5, dcaFloorBars: 5 })
  })

  it('counts the entry on top of the DCA rungs, because the entry is not one', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '9' }).maxOpenEntries).toBe(10)
  })

  it('takes an override for either', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: '50', OPERADOR_MAX_DCA: '2' }))
      .toEqual({ maxUsdPerLevel: 50, maxOpenEntries: 3, dropInitPct: 0, impatientProfitPct: 10, urgentProfitPct: 25, dcaGapPct: 5, dcaFloorBars: 5 })
  })

  it('ignores a value that is not a positive number rather than trading on NaN', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: 'lots', OPERADOR_MAX_DCA: '-1' }))
      .toEqual({ maxUsdPerLevel: 15, maxOpenEntries: 6, dropInitPct: 0, impatientProfitPct: 10, urgentProfitPct: 25, dcaGapPct: 5, dcaFloorBars: 5 })
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

describe('productionLadder — buying where the price IS', () => {
  it('defaults to no required drop, so a reserved slot does not wait for a dip', () => {
    // The operator's decision, taken against my objection and for a better
    // reason than mine. The 10% drop is what made the first rung a good price;
    // without it the ladder enters as often near a high as near a low.
    //
    // But 22 of 40 positions had never bought, some after three hours. A slot
    // holding capital and waiting is capital earning nothing, and an entry that
    // is merely AVERAGE but happens beats a good one that never does — the exit
    // only wants avg_cost + 2%, and the ladder still averages down if it falls.
    expect(productionLadder({}).dropInitPct).toBe(0)
  })

  it('takes an override, so the dip can be asked for again', () => {
    expect(productionLadder({ OPERADOR_DROP_INIT_PCT: '10' }).dropInitPct).toBe(10)
  })

  it('accepts zero as a REAL value, not as "unset"', () => {
    // Zero is the whole point here, so it cannot be a sentinel for absent —
    // `maxPositions: 0` meaning two different things in two files cost this
    // engine every position it could have opened.
    expect(productionLadder({ OPERADOR_DROP_INIT_PCT: '0' }).dropInitPct).toBe(0)
  })

  it('never expresses itself by editing the backtest inputs', () => {
    // DEFAULT_PARAMS is what TradingView ran and the parity harness asserts it.
    expect(DEFAULT_PARAMS.dropInitPct).toBe(10)
  })
})

describe('production ladder — depth ZERO is one buy and nothing after it', () => {
  // The operator's structural change: *pone la profundidad en 0, solo un paso,
  // una sola compra.* The DCA ladder stops existing — one entry per token and
  // the position never averages down.
  //
  // Zero is a REAL value here, and this project has paid for that twice:
  // `maxPositions: 0` meant "no ceiling" in one file and "zero slots" in the
  // one next door, and `dropInitPct` had to learn the same lesson. Read
  // through a `positive` parser, `OPERADOR_MAX_DCA=0` falls back to the
  // default and silently runs a three-rung ladder — the operator's decision
  // quietly discarded, which is the exact failure mode that costs the most
  // because everything keeps working.

  it('reads zero as zero, not as unset', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '0' }).maxOpenEntries).toBe(1)
  })

  it('still defaults to whatever the decision above says', () => {
    expect(productionLadder({}).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
    // *Agregá 5 escalones de DCA.* The entry and five rungs.
    expect(productionLadder({}).maxOpenEntries).toBe(6)
  })

  it('still refuses nonsense rather than taking it', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '-1' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
    expect(productionLadder({ OPERADOR_MAX_DCA: 'dos' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
    expect(productionLadder({ OPERADOR_MAX_DCA: '   ' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
  })
})
