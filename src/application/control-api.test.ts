import { describe, it, expect } from 'vitest'
import { authoriseControl, MIN_TOKEN_LENGTH } from './control-api.js'

const GOOD = 'a'.repeat(MIN_TOKEN_LENGTH)

describe('authoriseControl — the only write path the system has', () => {
  it('refuses when no token is configured, instead of allowing', () => {
    // Fail CLOSED. An unconfigured control surface that defaults to open is
    // how a dashboard URL pasted into a chat becomes a kill switch for
    // whoever reads it.
    expect(authoriseControl(undefined, GOOD)).toEqual({ ok: false, status: 503, reason: 'control token is not configured' })
    expect(authoriseControl('', GOOD)).toMatchObject({ ok: false, status: 503 })
  })

  it('refuses a configured token that is too weak to be worth having', () => {
    expect(authoriseControl('hunter2', 'hunter2')).toMatchObject({ ok: false, status: 503 })
  })

  it('refuses a missing or wrong token', () => {
    expect(authoriseControl(GOOD, null)).toMatchObject({ ok: false, status: 401 })
    expect(authoriseControl(GOOD, 'b'.repeat(MIN_TOKEN_LENGTH))).toMatchObject({ ok: false, status: 401 })
  })

  it('accepts the configured token', () => {
    expect(authoriseControl(GOOD, GOOD)).toEqual({ ok: true })
  })

  it('a wrong token of a different length is still just wrong — length must not leak', () => {
    expect(authoriseControl(GOOD, 'b')).toMatchObject({ ok: false, status: 401 })
    expect(authoriseControl(GOOD, GOOD + 'x')).toMatchObject({ ok: false, status: 401 })
  })

  it('reads a bearer header, and ignores anything that is not one', () => {
    expect(authoriseControl(GOOD, `Bearer ${GOOD}`, { fromHeader: true })).toEqual({ ok: true })
    expect(authoriseControl(GOOD, GOOD, { fromHeader: true })).toMatchObject({ ok: false, status: 401 })
    expect(authoriseControl(GOOD, null, { fromHeader: true })).toMatchObject({ ok: false, status: 401 })
  })
})
