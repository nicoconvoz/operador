import { describe, it, expect } from 'vitest'
import {
  productionLadder,
  DEFAULT_MAX_DCA_PER_TOKEN,
  DEFAULT_MAX_USD_PER_LEVEL,
  DEFAULT_DCA_DROPS_PCT,
  DEFAULT_DCA_RUNGS_USD,
  DEFAULT_DCA_ADAPTIVE,
} from './production-ladder.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'

describe('productionLadder — one place for the two numbers that differ', () => {
  it('defaults to ladder A: a $10 buy, then FIVE rungs of $15..$35 at −10..−30% of it', () => {
    // *Arriesguémonos, activá la A.* The operator, on a replay of all 336 real
    // entries: +$520 against +$373 for three $15 rungs, and in both halves of a
    // split in time. One entry reserved up front; each rung asks the free
    // capital for its own dollars when it fires.
    expect(productionLadder({})).toEqual({
      maxUsdPerLevel: 10, maxOpenEntries: 6, dropInitPct: 0, minProfitPct: 10, impatientProfitPct: 10, urgentProfitPct: 25,
      dcaDropsPct: [10, 15, 20, 25, 30], dcaRungsUsd: [15, 20, 25, 30, 35], dcaFrom: 'previous', dcaAdaptive: true, reservedEntries: 1,
    })
  })

  it('puts at most $135 into one token — the cost the operator accepted', () => {
    const ladder = productionLadder({})
    const total = ladder.maxUsdPerLevel + ladder.dcaRungsUsd.reduce((a, b) => a + b, 0)
    expect(total).toBe(135)
  })

  it('counts the entry on top of the DCA rungs, because the entry is not one', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '9' }).maxOpenEntries).toBe(10)
  })

  it('takes an override for either', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: '50', OPERADOR_MAX_DCA: '2' }))
      .toMatchObject({ maxUsdPerLevel: 50, maxOpenEntries: 3 })
  })

  it('ignores a value that is not a positive number rather than trading on NaN', () => {
    expect(productionLadder({ OPERADOR_MAX_USD_PER_LEVEL: 'lots', OPERADOR_MAX_DCA: '-1' }))
      .toMatchObject({ maxUsdPerLevel: 10, maxOpenEntries: 6 })
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
    // The entry and five rungs.
    expect(productionLadder({}).maxOpenEntries).toBe(6)
  })

  it('still refuses nonsense rather than taking it', () => {
    expect(productionLadder({ OPERADOR_MAX_DCA: '-1' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
    expect(productionLadder({ OPERADOR_MAX_DCA: 'dos' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
    expect(productionLadder({ OPERADOR_MAX_DCA: '   ' }).maxOpenEntries).toBe(DEFAULT_MAX_DCA_PER_TOKEN + 1)
  })
})

describe('production ladder — the rungs are a LIST of drops from the first buy', () => {
  it('takes a comma list, in order: the first number is DCA-1', () => {
    expect(productionLadder({ OPERADOR_DCA_DROPS_PCT: '5,15,25' }).dcaDropsPct).toEqual([5, 15, 25])
    expect(productionLadder({ OPERADOR_DCA_DROPS_PCT: ' 10 , 20 ' }).dcaDropsPct).toEqual([10, 20])
  })

  it('refuses nonsense WHOLE rather than trading on the half it could read', () => {
    // A ladder is one decision. Keeping the readable rungs of a mistyped list
    // would run a ladder nobody chose, and quietly — the failure that costs
    // the most, because everything keeps working.
    const fallback = DEFAULT_DCA_DROPS_PCT
    expect(fallback).toEqual([10, 15, 20, 25, 30])
    for (const raw of ['', '   ', 'diez', '10,,20', '10,veinte', '0,10', '10,100', '-5,10', '30,20', '10,10']) {
      expect(productionLadder({ OPERADOR_DCA_DROPS_PCT: raw }).dcaDropsPct).toEqual(fallback)
    }
  })
})

describe('production ladder — each rung buys its OWN size, paired with its drop', () => {
  // Ladder A: DCA-1 buys $15 at −10%, DCA-5 buys $35 at −30%. The sizes grow as
  // the price falls, so the deepest rungs carry the most weight in the average.
  it('defaults to $15, $20, $25, $30 and $35', () => {
    expect(DEFAULT_DCA_RUNGS_USD).toEqual([15, 20, 25, 30, 35])
    expect(productionLadder({}).dcaRungsUsd).toEqual([15, 20, 25, 30, 35])
  })

  it('takes a comma list, in order: the first number is what DCA-1 buys', () => {
    expect(productionLadder({ OPERADOR_DCA_RUNGS_USD: '12, 12, 20, 20, 40' }).dcaRungsUsd).toEqual([12, 12, 20, 20, 40])
  })

  it('pairs with an overridden drop list of the SAME length', () => {
    expect(productionLadder({ OPERADOR_DCA_DROPS_PCT: '10,20,30', OPERADOR_DCA_RUNGS_USD: '15,15,15' }))
      .toMatchObject({ dcaDropsPct: [10, 20, 30], dcaRungsUsd: [15, 15, 15] })
  })

  it('refuses nonsense WHOLE, as the drops do', () => {
    for (const raw of ['', '   ', 'quince', '15,,20,25,30', '15,20,0,30,35', '15,-20,25,30,35', '15,20,veinte,30,35']) {
      expect(productionLadder({ OPERADOR_DCA_RUNGS_USD: raw }).dcaRungsUsd).toEqual(DEFAULT_DCA_RUNGS_USD)
    }
  })

  it('refuses a list whose length does not match the drops — each size belongs to one line', () => {
    expect(productionLadder({ OPERADOR_DCA_RUNGS_USD: '15,20,25' }).dcaRungsUsd).toEqual(DEFAULT_DCA_RUNGS_USD)
    expect(productionLadder({ OPERADOR_DCA_RUNGS_USD: '15,20,25,30,35,40' }).dcaRungsUsd).toEqual(DEFAULT_DCA_RUNGS_USD)
  })
})

describe('production ladder — a position reserves its FIRST buy, not the whole ladder', () => {
  // Live, before this: $2,887 committed against $1,395 deployed. Reserving
  // four entries a token would hold about half as many tokens as the replay
  // assumed, so each rung takes its capital from the free pool when it fires.
  it('reserves one entry by default', () => {
    expect(productionLadder({}).reservedEntries).toBe(1)
  })

  it('takes an override — the whole ladder is one variable away', () => {
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '4' }).reservedEntries).toBe(4)
  })

  it('never reserves more entries than the venue will hold', () => {
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '9' }).reservedEntries).toBe(6)
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '9', OPERADOR_MAX_DCA: '1' }).reservedEntries).toBe(2)
  })

  it('refuses nonsense: a position always reserves at least its first buy', () => {
    for (const raw of ['0', '-1', 'uno', '1.5']) {
      expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: raw }).reservedEntries).toBe(1)
    }
  })
})

describe('production ladder — the rungs adapt to how much the token moves', () => {
  // *Aplicá el de en la línea, la propuesta.* The more a token moves, the
  // closer its rungs. ON unless switched off, one variable away.
  it('is ON when nothing is set', () => {
    expect(DEFAULT_DCA_ADAPTIVE).toBe(true)
    expect(productionLadder({}).dcaAdaptive).toBe(true)
  })

  it('is OFF with 0, false or no — every position then uses the base drops', () => {
    for (const off of ['0', 'false', 'no', ' NO ']) expect(productionLadder({ OPERADOR_DCA_ADAPTIVE: off }).dcaAdaptive).toBe(false)
  })

  it('stays ON on anything else, a typo included', () => {
    for (const on of ['1', 'true', 'yes', 'si', '']) expect(productionLadder({ OPERADOR_DCA_ADAPTIVE: on }).dcaAdaptive).toBe(true)
  })
})
