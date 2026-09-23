import { describe, it, expect } from 'vitest'
import { deployableCapital } from '../application/paper-run.js'
import { ConfigError, describeConfig, loadConfig } from './config.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'
import { stopLossPctFor } from '../domain/risk/stop-loss.js'

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
  it('caps each level at $15 by default — the size chosen for 15m bars', () => {
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
  it('is OPEN by default — the component floors are the whole rule', () => {
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

  it('gives every token the same fifteen dollars A RUNG, for all six rungs', () => {
    // *Agregá 5 escalones de DCA... cada escalón de 15 dólares.* The slot is
    // what six $15 rungs need once gas and the price headroom are reserved,
    // so the rung the tick derives — deployable over rungs — is exactly 15.
    const config = loadConfig(valid)
    expect(config.maxDcaPerToken).toBe(5)
    const deployable = deployableCapital({
      initialCapital: config.usdPerToken!,
      gasUsdPerSwap: config.gasUsdPerSwap,
      maxOpenEntries: config.maxDcaPerToken + 1,
      params: DEFAULT_PARAMS,
    })
    expect(deployable / 6).toBeCloseTo(15, 9)
    expect(loadConfig({ ...valid, OPERADOR_USD_PER_TOKEN: '30' }).usdPerToken).toBe(30)
  })

  it('sells at a loss only what the token has already paid for', () => {
    // *Si la ganancia es mayor a la pérdida también SL y rotar; si no, no
    // salir en pérdida.*
    expect(loadConfig(valid).stopLoss.onlyWhenHistoryCovers).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_STOP_NEEDS_HISTORY: '0' }).stopLoss.onlyWhenHistoryCovers).toBe(false)
  })

  it('confirms a rung on five one-minute candles, five percent under the last buy', () => {
    const config = loadConfig(valid)
    expect(config.dcaFloorBars).toBe(5)
    expect(config.dcaGapPct).toBe(5)
  })

  it('cuts at one percent, FLAT, whatever the token has already done', () => {
    // The operator: *si alguno llega a bajar 1% SL, revisá tick a tick, no
    // quiero quedarme con ninguna posición que baje eso, y rotás a otra
    // moneda.* Paper mode, so the rule IS the experiment.
    const stop = loadConfig(valid).stopLoss
    expect(stop).toEqual({ shareOfRun: 0, minStopPct: 1, maxStopPct: 1, maxLossUsd: 0.1, onlyWhenHistoryCovers: true })

    // FLAT is the property, not the literal above. `shareOfRun: 0` turns the
    // proportional rule off at its source, so a token up 1000% is cut at the
    // same 1% as a calm one — which is exactly what was asked for and the
    // opposite of what `DEFAULT_STOP_LOSS_POLICY` does.
    expect(stopLossPctFor(1000, stop)).toBe(1)
    expect(stopLossPctFor(0, stop)).toBe(1)
    // And an unmeasured run cannot widen it either.
    expect(stopLossPctFor(null, stop)).toBe(1)
  })

  it('stops at ten cents of loss, in dollars', () => {
    // *Ponele un SL de 0.10 centavos.* Zero turns the dollar stop off and
    // hands the decision back to the percentage.
    expect(loadConfig(valid).stopLoss.maxLossUsd).toBe(0.1)
    expect(loadConfig({ ...valid, OPERADOR_STOP_MAX_LOSS_USD: '0.25' }).stopLoss.maxLossUsd).toBe(0.25)
  })

  it('never lets the derived stop run wider than ten percent', () => {
    // The 1:4 multiplies the toll by about seven and has no ceiling of its own:
    // fomopay was cut with a 24% stop the sweep printed itself. Ten, rounded up
    // from the 8.7-9.5 the operator asked for; zero means no ceiling at all.
    expect(loadConfig(valid).maxStopPct).toBe(10)
    expect(loadConfig({ ...valid, OPERADOR_MAX_STOP_PCT: '15' }).maxStopPct).toBe(15)
  })

  it('keeps a winner from closing at a loss unless told not to', () => {
    // *Un break even.* Four losers had been above their target first — $5.57
    // between them — and a ratchet is what makes that impossible. On by
    // default, because it is the operator's decision; one variable to undo.
    expect(loadConfig(valid).breakEven).toBe(true)
    expect(loadConfig({ ...valid, OPERADOR_BREAK_EVEN: '0' }).breakEven).toBe(false)
  })

  it('still takes a wider stop when one is asked for', () => {
    // The proportional policy is one variable away and stays tested, because
    // the number above is an experiment and experiments get revised.
    const stop = loadConfig({ ...valid, OPERADOR_STOP_SHARE_OF_RUN: '0.05', OPERADOR_STOP_MAX_PCT: '50' }).stopLoss
    expect(stopLossPctFor(1000, stop)).toBe(50)
  })
})
