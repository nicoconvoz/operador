import { describe, it, expect } from 'vitest'
import { exitLevelsFor } from '../application/stop-sweep.js'
import { exitSizingFrom, type CycleConfig } from '../application/orchestrator.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { deployableCapital } from '../application/paper-run.js'
import { ConfigError, describeConfig, loadConfig } from './config.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { stopLossPctFor, shouldStopOut } from '../domain/risk/stop-loss.js'

const valid = {
  DATABASE_URL: 'postgres://user:secret@host:5432/db',
}

describe('loadConfig — fails at boot, never mid-ladder', () => {
  it('accepts a minimal valid environment with sane defaults', () => {
    const config = loadConfig(valid)
    expect(config.mode).toBe('paper')
    expect(config.chains).toEqual(['solana'])
    expect(config.totalCapitalUsd).toBe(1_000)
    expect(config.cycleIntervalMs).toBe(300_000)
  })

  it('refuses to start without a database, a bot token or a chat id', () => {
    for (const key of Object.keys(valid)) {
      const incomplete = { ...valid, [key]: undefined }
      expect(() => loadConfig(incomplete), key).toThrow(ConfigError)
    }
  })

  it('treats blank as missing — an empty secret is not a secret', () => {
    // This test had a name and an empty body for weeks: it asserted the
    // behaviour existed by describing it, which is the one thing a test
    // cannot do. Found by reading the documentation against the source.
    expect(() => loadConfig({ ...valid, DATABASE_URL: '   ' })).toThrow(ConfigError)
    // A blank OPTIONAL var falls back rather than throwing — a CI expression
    // that evaluated to nothing must not be read as a configured value.
    expect(loadConfig({ ...valid, OPERADOR_CAPITAL_USD: '' }).totalCapitalUsd).toBe(1_000)
    expect(loadConfig({ ...valid, OPERADOR_MAX_POSITIONS: '  ' }).maxPositions).toBe(0)
  })

  it('accepts an explicit zero where zero has a meaning', () => {
    // `OPERADOR_MAX_CYCLES` documents zero as "never — the daemon", and the
    // fallback is zero, so the behaviour existed only while the variable was
    // UNSET. Writing the documented value into it threw at boot:
    // "OPERADOR_MAX_CYCLES must be a positive number, got \"0\"". The same
    // sentinel trap as maxPositions, left in the one place it was not fixed.
    expect(loadConfig({ ...valid, OPERADOR_MAX_CYCLES: '0' }).maxCycles).toBe(0)
    expect(loadConfig({ ...valid, OPERADOR_MAX_POSITIONS: '0' }).maxPositions).toBe(0)
  })

  it('still refuses a negative, where no reading of it is meaningful', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_MAX_CYCLES: '-1' })).toThrow(ConfigError)
  })

  it('rejects a number that is not one, rather than silently using a default', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_CAPITAL_USD: 'lots' })).toThrow(/positive number/)
    expect(() => loadConfig({ ...valid, OPERADOR_CAPITAL_USD: '-5' })).toThrow(/positive number/)
    expect(() => loadConfig({ ...valid, OPERADOR_CAPITAL_USD: '0' })).toThrow(/positive number/)
  })

  it('rejects an unknown mode or chain', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_MODE: 'yolo' })).toThrow(/paper/)
    expect(() => loadConfig({ ...valid, OPERADOR_CHAIN: 'ethereum' })).toThrow(/solana/)
  })
})

describe('loadConfig — live mode is not a flag you drift into', () => {
  it('refuses live mode while no wallet adapter exists', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_MODE: 'live' })).toThrow(/no wallet adapter/)
  })

  it('the refusal says what to do instead', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_MODE: 'live' })).toThrow(/OPERADOR_MODE=paper/)
  })
})

describe('describeConfig — safe to log', () => {
  it('redacts the database password', () => {
    const described = describeConfig(loadConfig(valid))
    expect(JSON.stringify(described)).not.toContain('secret')
    expect(described.database).toBe('postgres://***@host:5432/db')
  })

  it('describes only what is safe to print — an allow list, not a deny list', () => {
    // A boot line is copied into issues and pasted into chats. This asserts
    // the SHAPE rather than the absence of one known secret: a field added to
    // the config later cannot leak by being forgotten here, because anything
    // not named is simply never printed.
    const described = describeConfig(loadConfig(valid))
    expect(Object.keys(described).sort()).toEqual(
      ['capitalUsd', 'chains', 'cycleMinutes', 'database', 'gasUsdPerSwap', 'maxPositions', 'mode'],
    )
  })
})

describe('loadConfig — bar size', () => {
  it('defaults to 15m — the user trades these tokens on that bar', () => {
    expect(loadConfig(valid).barSize).toEqual({ timeframe: 'minute', aggregate: 15 })
  })

  it('still accepts 1h, which is what the parity harness proved', () => {
    expect(loadConfig({ ...valid, OPERADOR_TIMEFRAME: '1h' }).barSize).toEqual({ timeframe: 'hour' })
  })

  it('rejects a timeframe nobody has measured', () => {
    expect(() => loadConfig({ ...valid, OPERADOR_TIMEFRAME: '5m' })).toThrow(/1h/)
    expect(() => loadConfig({ ...valid, OPERADOR_TIMEFRAME: '4h' })).toThrow(ConfigError)
  })
})

describe('loadConfig — the production ladder is not the reference ladder', () => {
  it('caps each level at $15 by default — the first buy; the rung carries its own size', () => {
    expect(loadConfig(valid).maxUsdPerLevel).toBe(15)
  })

  it('scales up when the capital does, without touching the reference', () => {
    expect(loadConfig({ ...valid, OPERADOR_MAX_USD_PER_LEVEL: '50' }).maxUsdPerLevel).toBe(50)
    // DEFAULT_PARAMS is what TradingView ran, and the parity harness asserts
    // it. Production making a different choice must never edit the evidence.
    expect(DEFAULT_PARAMS.maxUsdPerLevel).toBe(5_000)
  })
})

describe('loadConfig — the security budget is a cap you ASK for, not one you get', () => {
  it('examines every token that cleared the free gates, by default', () => {
    // The user's decision: run the FULL scanner every hour. The budget of 20
    // was set when a cold scan cost 384 seconds and every examination was a
    // thousand-row download — and both of those are measurements that have
    // since been superseded. 98 tokens clear the free gates across both chains,
    // at 2.5s each: four minutes, once an hour.
    expect(loadConfig(valid).maxSecurityChecks).toBeNull()
  })

  it('still accepts an explicit cap, for a day the providers are unhappy', () => {
    expect(loadConfig({ ...valid, OPERADOR_MAX_SECURITY_CHECKS: '20' }).maxSecurityChecks).toBe(20)
  })

  it('refuses zero rather than reading it as "no limit"', () => {
    // NOT a sentinel. `maxPositions: 0` meant "no ceiling" in one file and
    // "zero slots" in the one next door, and with an empty book the engine
    // opened nothing, ever. A value that means one thing here and its opposite
    // there is not a sentinel, it is a trap. Absent means unbounded; a number
    // means that number.
    expect(() => loadConfig({ ...valid, OPERADOR_MAX_SECURITY_CHECKS: '0' })).toThrow()
  })
})

describe('minScore — a door on the score, not another weight in it', () => {
  it('is OPEN by default — trend at 100% is the one condition', () => {
    // The operator's rule, and the shape of it is the point: *un filtro
    // aparte, que no modifique el puntaje total*. The toll was first expressed
    // as a WEIGHT (0.2 -> 0.9), which worked and cost too much — a weighted
    // average has one denominator, so weight added anywhere is share taken
    // everywhere, and every score in the book fell for a change in our own
    // arithmetic rather than in the market.
    //
    // A door does not have that property. It reads the score after it is
    // computed and answers one question, so the scale it is read against is
    // the same scale yesterday's numbers were.
    expect(loadConfig(valid).minScore).toBe(0)
    expect(loadConfig(valid).reserve).toBe(false)
  })

  it('takes zero as a real value — it is "let everything through", not "unset"', () => {
    // `dropInitPct` learned this the expensive way: zero is a REAL setting
    // here, so parsing it as absent would silently restore a threshold the
    // operator turned off on purpose.
    expect(loadConfig({ ...valid, OPERADOR_MIN_SCORE: '0' }).minScore).toBe(0)
  })

  it('is tunable without a deploy', () => {
    expect(loadConfig({ ...valid, OPERADOR_MIN_SCORE: '65' }).minScore).toBe(65)
  })
})

describe('two rules stand, and the doors they need are separate switches', () => {
  // *Dejá pasar todas las monedas que tengan más de 100k de liquidez y tengan
  // menos del 50% topholders, y comprá solo 15 usd por moneda.*

  it('does NOT require the momentum window any more', () => {
    // Liquidity and concentration are the whole rule now. The window was the
    // previous one and it is off unless asked for by name.
    expect(loadConfig(valid).requireRising).toBe(false)
    expect(loadConfig({ ...valid, OPERADOR_REQUIRE_RISING: '1' }).requireRising).toBe(true)
  })

  it('still BUYS on selection, and that is a separate switch', () => {
    // The two were one, because the momentum rule needed door 3: the scanner
    // selects risers and the classic door refuses a bar making a new high.
    //
    // They answer different questions — this one is HOW the executor enters,
    // the other is WHICH tokens are worth entering. Tied together, turning the
    // selection rule off would also close the only door those tokens can come
    // through, and the engine would choose a wide shortlist and buy none of it.
    expect(loadConfig(valid).buyOnSelection).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_BUY_ON_SELECTION: '0' }).buyOnSelection).toBe(false)
  })

  it('gives every token two buys: a fifteen-dollar first buy, then one $20 rung past −80% on a 10% rebound', () => {
    // *Dos escalones solamente: uno con $15; si el precio cae más de 80% y hay
    // un rebote de 10%, nueva compra DCA de $20.* The slot is what ONE $15 buy
    // needs once gas and the price headroom are reserved, so the first buy is
    // exactly 15; the rung asks the free capital for its own $20 when it fires.
    const config = loadConfig(valid)
    expect(config.maxUsdPerLevel).toBe(15)
    expect(config.maxDcaPerToken).toBe(1)
    expect(config).toMatchObject({ deepRungFallPct: 80, deepRungReboundPct: 10, deepRungUsd: 20 })
    // Nothing else buys a rung: the chained ladder, its spacing and the brake.
    expect(config).toMatchObject({ dropLadder: false, dcaAdaptive: false, dcaRealtime: false, liquidityBrakePct: 0, pressure: false })
    expect(config.reservedEntries).toBe(1)
    const deployable = deployableCapital({
      initialCapital: config.usdPerToken!,
      gasUsdPerSwap: config.gasUsdPerSwap,
      maxOpenEntries: config.reservedEntries,
      params: DEFAULT_PARAMS,
    })
    expect(deployable).toBeCloseTo(15, 9)
    expect(config.usdPerToken).toBeCloseTo(15.89, 2)
    expect(loadConfig({ ...valid, OPERADOR_USD_PER_TOKEN: '30' }).usdPerToken).toBe(30)
  })

  it('reads the rung sizes from the environment, beside the drops', () => {
    const config = loadConfig({ ...valid, OPERADOR_DCA_DROPS_PCT: '10,20,30', OPERADOR_DCA_RUNGS_USD: '15,15,15' })
    expect(config.dcaDropsPct).toEqual([10, 20, 30])
    expect(config.dcaRungsUsd).toEqual([15, 15, 15])
  })

  it('reserves the whole ladder again when asked — one variable away', () => {
    const config = loadConfig({ ...valid, OPERADOR_RESERVED_ENTRIES: '2' })
    expect(config.reservedEntries).toBe(2)
    const deployable = deployableCapital({
      initialCapital: config.usdPerToken!,
      gasUsdPerSwap: config.gasUsdPerSwap,
      maxOpenEntries: config.reservedEntries,
      params: DEFAULT_PARAMS,
    })
    // Two FIRST buys' worth, so the tick's first buy is still fifteen dollars;
    // the rung above it is still priced at its own size when it fires.
    expect(deployable / 2).toBeCloseTo(15, 9)
  })

  it('brings each switched-off rung back from the environment', () => {
    const config = loadConfig({
      ...valid, OPERADOR_DROP_LADDER: '1', OPERADOR_DCA_ADAPTIVE: '1', OPERADOR_DCA_REALTIME: '1', OPERADOR_LIQUIDITY_BRAKE_PCT: '5',
      OPERADOR_DEEP_RUNG_FALL_PCT: '70', OPERADOR_DEEP_RUNG_REBOUND_PCT: '15', OPERADOR_DEEP_RUNG_USD: '25',
    })
    expect(config).toMatchObject({
      dropLadder: true, dcaAdaptive: true, dcaRealtime: true, liquidityBrakePct: 5,
      deepRungFallPct: 70, deepRungReboundPct: 15, deepRungUsd: 25,
    })
  })

  it('blacklists a frozen token when its slot is released, unless told not to', () => {
    // *No me gustó que las congeladas ... no pasen a la lista negra.*
    expect(loadConfig(valid).blacklistOnFreeze).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_BLACKLIST_ON_FREEZE: '0' }).blacklistOnFreeze).toBe(false)
  })

  it('sells at a loss only what the token has already paid for', () => {
    // *Si la ganancia es mayor a la pérdida también SL y rotar; si no, no
    // salir en pérdida.*
    expect(loadConfig(valid).stopLoss.onlyWhenHistoryCovers).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_STOP_NEEDS_HISTORY: '0' }).stopLoss.onlyWhenHistoryCovers).toBe(false)
  })

  it('has NO stop by price — only the death and freeze exits may sell at a loss', () => {
    // *No, el SL no lo quiero; quiero el que habíamos acordado antes, el death
    // o congelamiento.* The operator. A position that falls is held and the
    // ladder averages it down; what may sell at a loss is an asset that
    // stopped being one, never a price.
    const config = loadConfig(valid)
    const fell = { entryPriceUsd: 1, marketPriceUsd: 0.1, openQty: 15, runAtEntryPct: null }
    expect(shouldStopOut(fell, config.stopLoss)).toBe(false)
    expect(config.exitOnFreeze).toBe(true)
    // Still one variable away, and still tested where it lives.
    expect(loadConfig({ ...valid, OPERADOR_STOP_MAX_LOSS_USD: '0.1' }).stopLoss.maxLossUsd).toBe(0.1)
    expect(loadConfig({ ...valid, OPERADOR_STOP_MIN_PCT: '0' }).stopLoss.minStopPct).toBe(0)
  })

  it('cuts NOTHING on a fall through the path the sweep actually runs — the 1:4 included', () => {
    // The test above asked the configured stop and passed while production cut
    // six positions at a loss: the sweep does not read that stop, it reads
    // what `exitLevelsFor` derives from it. So this asks the same question the
    // same way the engine does.
    const config = loadConfig(valid)
    const sizing = exitSizingFrom({
      stopLoss: config.stopLoss,
      rewardRiskRatio: config.rewardRiskRatio,
      maxCostSharePct: config.maxCostSharePct,
      gasUsdPerSwap: config.gasUsdPerSwap,
      breakEven: config.breakEven,
      maxStopPct: config.maxStopPct,
      params: DEFAULT_PARAMS,
    } as unknown as CycleConfig)
    const held = {
      quality: { liquidityUsd: 100_000, spreadPct: 0.25, slippagePct: 0.3, referenceUsd: 100, observedAt: 0 },
      capitalUsd: config.usdPerToken,
    } as unknown as PersistedPosition
    const { stop } = exitLevelsFor(held, sizing)
    const fell = { entryPriceUsd: 1, marketPriceUsd: 0.5, openQty: 90, runAtEntryPct: null }
    expect(shouldStopOut(fell, stop)).toBe(false)
  })

  it('stops a position whose score falls five points from the one it was bought at', () => {
    // *Cuando el puntaje cae 5 puntos, SL.* Zero turns it off.
    // OFF now: *sacá lo de la caída del puntaje.* One variable away.
    expect(loadConfig(valid).scoreStopPoints).toBe(0)
    expect(loadConfig({ ...valid, OPERADOR_SCORE_STOP_POINTS: '5' }).scoreStopPoints).toBe(5)
  })

  it('runs only the TP, the freeze and the death: every other exit is off', () => {
    // *Dejá correr todo con esa única condición y la de congelamiento y la de
    // la muerte; lo demás, sólo salí si el TP se cumple.*
    const config = loadConfig(valid)
    expect(config.rotateOnFilter).toBe(false)
    expect(config.pressure).toBe(false)
    expect(config.exitOnFreeze).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_ROTATE_ON_FILTER: '1', OPERADOR_PRESSURE: '1' })).toMatchObject({ rotateOnFilter: true, pressure: true })
  })

  it('never sells a position for a better token — only its TP closes it', () => {
    // *No me cortes por cambio por una mejor; sólo dejá que el TP cierre.*
    expect(loadConfig(valid).swapHolders).toBe(false)
    expect(loadConfig({ ...valid, OPERADOR_SWAP_HOLDERS: '1' }).swapHolders).toBe(true)
  })

  it('never swaps a position under water for a better one — no close in the red', () => {
    expect(loadConfig(valid).maxSwapLossPct).toBe(0)
    expect(loadConfig({ ...valid, OPERADOR_MAX_SWAP_LOSS_PCT: '1.2' }).maxSwapLossPct).toBe(1.2)
  })

  it('never lets the derived stop run wider than ten percent', () => {
    // The 1:4 multiplies the toll by about seven and has no ceiling of its own:
    // fomopay was cut with a 24% stop the sweep printed itself. Ten, rounded up
    // from the 8.7-9.5 the operator asked for; zero means no ceiling at all.
    expect(loadConfig(valid).maxStopPct).toBe(10)
    expect(loadConfig({ ...valid, OPERADOR_MAX_STOP_PCT: '15' }).maxStopPct).toBe(15)
  })

  it('keeps the break-even OFF by default, and one variable brings it back at 7.5', () => {
    // *Sacá el break-even, pero poné un mínimo de ganancia del 20%.* Measured
    // on the first half day of ladder A: of 49 break-even sales at +7.5%, 21
    // went on to +20% and 12 fell to the first rung.
    expect(loadConfig(valid)).toMatchObject({ breakEven: false, breakEvenArmPct: 7.5, breakEvenFloorPct: 7.5 })
    for (const on of ['1', 'true', 'yes']) {
      expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN: on }).breakEven).toBe(true)
    }
  })

  it('keeps the gain lock ON by default — from +20%, a floor of +10% — and one variable turns it off', () => {
    // *Si pasás el 20% de ganancia, break-even en el 10%; con cada aumento de
    // 20%, aumentar el break-even 10%.*
    expect(loadConfig(valid).gainLock).toEqual({ startPct: 20, stepPct: 20, firstFloorPct: 10, floorStepPct: 10 })
    for (const off of ['0', 'false', 'no']) {
      expect(loadConfig({ ...valid, OPERADOR_GAIN_LOCK: off }).gainLock).toBeNull()
    }
    // A typo leaves it on: the safe direction for a rule that only ever sells a winner.
    expect(loadConfig({ ...valid, OPERADOR_GAIN_LOCK: 'nope' }).gainLock).not.toBeNull()
  })

  it('asks the strategy exit for +10% by default, and reads another floor', () => {
    expect(loadConfig(valid).minProfitPct).toBe(10)
    expect(loadConfig({ ...valid, OPERADOR_MIN_PROFIT_PCT: '20' }).minProfitPct).toBe(20)
    expect(loadConfig({ ...valid, OPERADOR_MIN_PROFIT_PCT: 'diez' }).minProfitPct).toBe(10)
  })

  it('takes both lines from the environment, and never floors above the arm', () => {
    expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN_ARM_PCT: '10', OPERADOR_BREAK_EVEN_FLOOR_PCT: '5' }))
      .toMatchObject({ breakEvenArmPct: 10, breakEvenFloorPct: 5 })
    // A floor above the arm would sell on the sweep that armed it. It falls
    // back to the default, itself capped by the arm.
    expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN_FLOOR_PCT: '9' }).breakEvenFloorPct).toBe(7.5)
    expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN_ARM_PCT: '5' }).breakEvenFloorPct).toBe(5)
  })

  it('falls back to 7.5 on nonsense rather than refusing to boot', () => {
    const config = loadConfig({ ...valid, OPERADOR_BREAK_EVEN_ARM_PCT: 'siete', OPERADOR_BREAK_EVEN_FLOOR_PCT: '-1' })
    expect(config).toMatchObject({ breakEvenArmPct: 7.5, breakEvenFloorPct: 7.5 })
    expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN_ARM_PCT: '0' }).breakEvenArmPct).toBe(7.5)
  })

  it('still takes a wider stop when one is asked for', () => {
    // The proportional policy is one variable away and stays tested, because
    // the number above is an experiment and experiments get revised.
    const stop = loadConfig({ ...valid, OPERADOR_STOP_SHARE_OF_RUN: '0.05', OPERADOR_STOP_MAX_PCT: '50' }).stopLoss
    expect(stopLossPctFor(1000, stop)).toBe(50)
  })
})

describe('loadConfig — the entry door is buy pressure over 10%', () => {
  // *Como puerta de entrada, todos los tokens que tengan más de 10% de presión
  // compradora.* From the module the dashboard reads too, so the canvas and
  // the engine cannot disagree about which tokens the book may buy.
  it('asks buy pressure STRICTLY over 10%, and nothing else of the components', () => {
    expect(loadConfig(valid).minComponents).toEqual({ buyPressure: { above: 0.1 } })
  })

  it('moves with OPERADOR_MIN_BUY_PRESSURE_PCT', () => {
    expect(loadConfig({ ...valid, OPERADOR_MIN_BUY_PRESSURE_PCT: '20' }).minComponents).toEqual({ buyPressure: { above: 0.2 } })
    expect(loadConfig({ ...valid, OPERADOR_MIN_BUY_PRESSURE_PCT: '0' }).minComponents).toEqual({ buyPressure: { above: 0 } })
  })
})
