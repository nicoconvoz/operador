import { describe, it, expect } from 'vitest'
import { ConfigError, describeConfig, loadConfig } from './config.js'

const valid = {
  DATABASE_URL: 'postgres://user:secret@host:5432/db',
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_CHAT_ID: '42',
}

describe('loadConfig — fails at boot, never mid-ladder', () => {
  it('accepts a minimal valid environment with sane defaults', () => {
    const config = loadConfig(valid)
    expect(config.mode).toBe('paper')
    expect(config.chain).toBe('solana')
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
    expect(() => loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: '   ' })).toThrow(ConfigError)
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

  it('never includes the bot token, not even partially', () => {
    const described = describeConfig(loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: 'supersecrettoken' }))
    expect(JSON.stringify(described)).not.toContain('supersecret')
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
