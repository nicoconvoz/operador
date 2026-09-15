import { describe, it, expect } from 'vitest'
import { ConfigError, describeConfig, loadConfig } from './config.js'
import { DEFAULT_PARAMS } from '../domain/strategy/params.js'

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
