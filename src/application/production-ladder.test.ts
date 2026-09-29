import { describe, it, expect } from 'vitest'
import {
  productionLadder,
  DEFAULT_MAX_DCA_PER_TOKEN,
  DEFAULT_MAX_USD_PER_LEVEL,
  DEFAULT_DCA_DROPS_PCT,
  DEFAULT_DCA_RUNGS_USD,
  DEFAULT_DCA_ADAPTIVE,
  DEFAULT_DCA_REALTIME,
  DEFAULT_DROP_LADDER,
  DEFAULT_DEEP_RUNG_FALL_PCT,
  DEFAULT_DEEP_RUNG_REBOUND_PCT,
  DEFAULT_DEEP_RUNG_USD,
  DEFAULT_PRODUCTION_LIQUIDITY_BRAKE_PCT,
  DEFAULT_STEP_USD,
  DEFAULT_MAX_STEPS,
  DEFAULT_DIP_PCT,
  DEFAULT_BOUNCE_PCT,
  DEFAULT_DEEP_RUNG,
  DEFAULT_CASCADE_ENTRIES,
} from './production-ladder.js'
import { DEFAULT_PARAMS, PYRAMIDING } from '../domain/strategy/params.js'

describe('productionLadder — one place for the numbers that differ', () => {
  it('defaults to TWENTY buys of $1, every one on a 3% dip and a 2% bounce', () => {
    // *Ante una caída del 3% del precio y una subida del 2%, comprá 1 USD, y
    // armá escalones de 1 USD con la misma regla* — then *disminuí los
    // escalones a 20.* The slot reserves the whole ladder, exactly steps ×
    // step. Every other path that could buy is OFF, each one a variable away:
    // the deep rung, the chained drop ladder, its volatility spacing, the
    // liquidity brake and the cascade's own doors. The TP stays at 10%.
    expect(productionLadder({})).toEqual({
      maxUsdPerLevel: 1, maxOpenEntries: 20, dropInitPct: 0, minProfitPct: 10, impatientProfitPct: 10, urgentProfitPct: 25,
      dropLadder: false,
      dcaDropsPct: [10, 15, 20, 25, 30], dcaRungsUsd: [15, 20, 25, 30, 35], dcaFrom: 'previous', dcaAdaptive: false, dcaRealtime: false, liquidityBrakePct: 0, reservedEntries: 20,
      deepRung: false, deepRungFallPct: 80, deepRungReboundPct: 10, deepRungUsd: 20,
      stepUsd: 1, maxSteps: 20, dipPct: 3, bouncePct: 2, slotUsd: 20, cascadeEntries: false,
    })
    expect([DEFAULT_STEP_USD, DEFAULT_MAX_STEPS, DEFAULT_DIP_PCT, DEFAULT_BOUNCE_PCT]).toEqual([1, 20, 3, 2])
  })

  it('puts at most $20 into one token — and the slot reserves exactly that, with nothing grossed up', () => {
    const ladder = productionLadder({})
    expect(ladder.maxSteps * ladder.stepUsd).toBe(20)
    expect(ladder.slotUsd).toBe(20)
    expect(ladder.maxOpenEntries).toBe(20)
  })

  it('derives the slot from the two variables, never from a constant', () => {
    expect(productionLadder({ OPERADOR_MAX_STEPS: '50' }).slotUsd).toBe(50)
    expect(productionLadder({ OPERADOR_MAX_STEPS: '50', OPERADOR_STEP_USD: '2' }))
      .toMatchObject({ slotUsd: 100, maxOpenEntries: 50, reservedEntries: 50, maxUsdPerLevel: 2 })
  })

  it('reads the dip, the bounce, the step and the steps from the environment', () => {
    expect(productionLadder({ OPERADOR_DIP_PCT: '5', OPERADOR_BOUNCE_PCT: '1.5', OPERADOR_STEP_USD: '0.5', OPERADOR_MAX_STEPS: '10' }))
      .toMatchObject({ dipPct: 5, bouncePct: 1.5, stepUsd: 0.5, maxSteps: 10, slotUsd: 5 })
  })

  it('keeps the operator’s numbers on nonsense rather than trading on it', () => {
    for (const bad of ['tres', '0', '-3', '100', ' ']) expect(productionLadder({ OPERADOR_DIP_PCT: bad }).dipPct, bad).toBe(3)
    for (const bad of ['dos', '0', '-2', ' ']) expect(productionLadder({ OPERADOR_BOUNCE_PCT: bad }).bouncePct, bad).toBe(2)
    for (const bad of ['uno', '0', '-1', ' ']) expect(productionLadder({ OPERADOR_STEP_USD: bad }).stepUsd, bad).toBe(1)
    for (const bad of ['veinte', '0', '-1', '2.5', ' ']) expect(productionLadder({ OPERADOR_MAX_STEPS: bad }).maxSteps, bad).toBe(20)
  })

  it('keeps the deep rung and the cascade’s own doors OFF — each one a variable away', () => {
    expect(DEFAULT_DEEP_RUNG).toBe(false)
    expect(DEFAULT_CASCADE_ENTRIES).toBe(false)
    expect(productionLadder({ OPERADOR_DEEP_RUNG: '1' }).deepRung).toBe(true)
    expect(productionLadder({ OPERADOR_CASCADE_ENTRIES: 'yes' }).cascadeEntries).toBe(true)
    for (const off of ['0', 'no', 'si', '']) {
      expect(productionLadder({ OPERADOR_DEEP_RUNG: off }).deepRung).toBe(false)
      expect(productionLadder({ OPERADOR_CASCADE_ENTRIES: off }).cascadeEntries).toBe(false)
    }
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
      .toMatchObject({ maxUsdPerLevel: 1, maxOpenEntries: 20 })
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
    // Twenty steps, the first included.
    expect(productionLadder({}).maxOpenEntries).toBe(20)
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

describe('production ladder — a position reserves its WHOLE ladder', () => {
  // With $1 steps a slot reserving one buy would open a thousand positions and
  // drown the providers in candle requests. So a slot reserves every step it
  // can buy, and the capital bounds the book: capital / $20.
  it('reserves every step by default', () => {
    expect(productionLadder({}).reservedEntries).toBe(20)
  })

  it('takes an override', () => {
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '2' }).reservedEntries).toBe(2)
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '4', OPERADOR_MAX_DCA: '5' }).reservedEntries).toBe(4)
  })

  it('never reserves more entries than the venue will hold', () => {
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '90' }).reservedEntries).toBe(20)
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '9', OPERADOR_MAX_DCA: '5' }).reservedEntries).toBe(6)
    expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: '9', OPERADOR_MAX_DCA: '1' }).reservedEntries).toBe(2)
  })

  it('refuses nonsense: the whole ladder, the decision', () => {
    for (const raw of ['0', '-1', 'uno', '1.5']) {
      expect(productionLadder({ OPERADOR_RESERVED_ENTRIES: raw }).reservedEntries).toBe(20)
    }
  })
})

describe('production ladder — the rungs adapt to how much the token moves', () => {
  // *Aplicá el de en la línea, la propuesta.* The more a token moves, the
  // closer its rungs. OFF now — only the deep rung buys after the entry — and
  // one variable away.
  it('is OFF when nothing is set', () => {
    expect(DEFAULT_DCA_ADAPTIVE).toBe(false)
    expect(productionLadder({}).dcaAdaptive).toBe(false)
  })

  it('is ON with 1, true or yes', () => {
    for (const on of ['1', 'true', 'yes', ' YES ']) expect(productionLadder({ OPERADOR_DCA_ADAPTIVE: on }).dcaAdaptive).toBe(true)
  })

  it('stays OFF on anything else, a typo included — the operator’s decision keeps running', () => {
    for (const off of ['0', 'false', 'no', 'si', '']) expect(productionLadder({ OPERADOR_DCA_ADAPTIVE: off }).dcaAdaptive).toBe(false)
  })
})

describe('productionLadder — the NEXT rung spaced by the last hour, in real time', () => {
  // *Que el próximo escalón DCA lo calcule por la cantidad de volatilidad que
  // tenga en ese preciso momento la moneda.* Then *tiempo real.* OFF now, one
  // variable away — and only ever inside the adaptive switch: with that off
  // nothing is scaled at all.
  it('is OFF when nothing is set', () => {
    expect(DEFAULT_DCA_REALTIME).toBe(false)
    expect(productionLadder({}).dcaRealtime).toBe(false)
  })

  it('is ON with 1, true or yes', () => {
    for (const on of ['1', 'true', 'yes', ' YES ']) expect(productionLadder({ OPERADOR_DCA_REALTIME: on }).dcaRealtime).toBe(true)
  })

  it('stays OFF on anything else, a typo included', () => {
    for (const off of ['0', 'false', 'no', 'si', '']) expect(productionLadder({ OPERADOR_DCA_REALTIME: off }).dcaRealtime).toBe(false)
  })

  it('is its own switch: turning it on leaves the adaptive spacing alone', () => {
    const ladder = productionLadder({ OPERADOR_DCA_REALTIME: '1' })
    expect(ladder.dcaAdaptive).toBe(false)
  })
})

describe('productionLadder — the brake on a draining pool', () => {
  // *Freno en tiempo real por cambio de liquidez inmediata que supere el 5%* —
  // *5 minutos o 1 hora.* OFF now, because it also BUYS — a bounce off the
  // pool's minimum bought the next rung — and only the deep rung may buy after
  // the entry. OPERADOR_LIQUIDITY_BRAKE_PCT=5 brings back the operator's five.
  it('is OFF when nothing is set', () => {
    expect(DEFAULT_PRODUCTION_LIQUIDITY_BRAKE_PCT).toBe(0)
    expect(productionLadder({}).liquidityBrakePct).toBe(0)
  })

  it('takes a threshold, and ZERO is a real value rather than falling back', () => {
    // Zero is a real value here, the third time this file has had to say so.
    expect(productionLadder({ OPERADOR_LIQUIDITY_BRAKE_PCT: '5' }).liquidityBrakePct).toBe(5)
    expect(productionLadder({ OPERADOR_LIQUIDITY_BRAKE_PCT: '8' }).liquidityBrakePct).toBe(8)
    expect(productionLadder({ OPERADOR_LIQUIDITY_BRAKE_PCT: '0' }).liquidityBrakePct).toBe(0)
  })

  it('stays off on nonsense — a typo never switches the brake on', () => {
    for (const bad of ['abc', '-5', '100', ' ']) expect(productionLadder({ OPERADOR_LIQUIDITY_BRAKE_PCT: bad }).liquidityBrakePct).toBe(0)
  })
})

describe('productionLadder — the chained drop ladder is OFF', () => {
  // Only the deep rung buys after the entry. Ladder A — five rungs chained
  // from the previous buy — stays built and tested, one variable away.
  it('is OFF when nothing is set', () => {
    expect(DEFAULT_DROP_LADDER).toBe(false)
    expect(productionLadder({}).dropLadder).toBe(false)
  })

  it('is ON with 1, true or yes, and off on anything else', () => {
    for (const on of ['1', 'true', 'yes', ' YES ']) expect(productionLadder({ OPERADOR_DROP_LADDER: on }).dropLadder).toBe(true)
    for (const off of ['0', 'false', 'no', 'si', '']) expect(productionLadder({ OPERADOR_DROP_LADDER: off }).dropLadder).toBe(false)
  })
})

describe('productionLadder — the deep rung', () => {
  // *Si el precio cae más de 80% y hay un rebote de 10%, nueva compra DCA de
  // $20.*
  it('defaults to more than 80% down, a 10% rebound, $20', () => {
    expect([DEFAULT_DEEP_RUNG_FALL_PCT, DEFAULT_DEEP_RUNG_REBOUND_PCT, DEFAULT_DEEP_RUNG_USD]).toEqual([80, 10, 20])
  })

  it('takes each from the environment', () => {
    expect(productionLadder({ OPERADOR_DEEP_RUNG_FALL_PCT: '70', OPERADOR_DEEP_RUNG_REBOUND_PCT: '15', OPERADOR_DEEP_RUNG_USD: '25' }))
      .toMatchObject({ deepRungFallPct: 70, deepRungReboundPct: 15, deepRungUsd: 25 })
  })

  it('reads zero as a real value for the two percentages', () => {
    expect(productionLadder({ OPERADOR_DEEP_RUNG_FALL_PCT: '0', OPERADOR_DEEP_RUNG_REBOUND_PCT: '0' }))
      .toMatchObject({ deepRungFallPct: 0, deepRungReboundPct: 0 })
  })

  it('takes a rebound of 100% or more — off a low at a fifth of the entry, doubling is still a loss', () => {
    expect(productionLadder({ OPERADOR_DEEP_RUNG_REBOUND_PCT: '150' }).deepRungReboundPct).toBe(150)
  })

  it('keeps the operator’s numbers on nonsense rather than trading on it', () => {
    for (const bad of ['ochenta', '-5', '100', '   ']) expect(productionLadder({ OPERADOR_DEEP_RUNG_FALL_PCT: bad }).deepRungFallPct).toBe(80)
    for (const bad of ['diez', '-1', '   ']) expect(productionLadder({ OPERADOR_DEEP_RUNG_REBOUND_PCT: bad }).deepRungReboundPct).toBe(10)
    for (const bad of ['veinte', '0', '-20', '   ']) expect(productionLadder({ OPERADOR_DEEP_RUNG_USD: bad }).deepRungUsd).toBe(20)
  })
})
