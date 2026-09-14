import { describe, it, expect } from 'vitest'
import { mergeSecurity } from './security-merge.js'

describe('mergeSecurity — several sources, one report', () => {
  it('fills unknowns from later sources', () => {
    const merged = mergeSecurity(
      { mintAuthorityActive: null, topHoldersPct: null, lpLockedPct: null },
      { mintAuthorityActive: false, topHoldersPct: 30.2 },
      { lpLockedPct: 95 },
    )
    expect(merged.mintAuthorityActive).toBe(false)
    expect(merged.topHoldersPct).toBe(30.2)
    expect(merged.lpLockedPct).toBe(95)
  })

  it('danger wins over safety on every boolean, whatever the order', () => {
    expect(mergeSecurity({ honeypot: false }, { honeypot: true }).honeypot).toBe(true)
    expect(mergeSecurity({ mintAuthorityActive: true }, { mintAuthorityActive: false }).mintAuthorityActive).toBe(true)
    expect(mergeSecurity({ freezeAuthorityActive: null }, { freezeAuthorityActive: true }).freezeAuthorityActive).toBe(true)
    expect(mergeSecurity({ hasBlacklist: false }, { hasBlacklist: true }).hasBlacklist).toBe(true)
    expect(mergeSecurity({ isProxy: false }, { isProxy: true }).isProxy).toBe(true)
  })

  it('numeric facts take the first known value — sources are ordered by trust', () => {
    expect(mergeSecurity({ topHoldersPct: 8.8 }, { topHoldersPct: 30.2 }).topHoldersPct).toBe(8.8)
    expect(mergeSecurity({ topHoldersPct: null }, { topHoldersPct: 30.2 }).topHoldersPct).toBe(30.2)
  })

  it('verified source: an unverified verdict beats a verified one', () => {
    expect(mergeSecurity({ verifiedSource: true }, { verifiedSource: false }).verifiedSource).toBe(false)
  })

  it('everything unknown stays unknown, so the gates still fail closed', () => {
    const merged = mergeSecurity({}, {})
    expect(Object.values(merged).every((v) => v === null)).toBe(true)
  })
})
