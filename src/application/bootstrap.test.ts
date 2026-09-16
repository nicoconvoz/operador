import { describe, it, expect } from 'vitest'
import { securityBudgetFor, type ExaminationCountPort } from './bootstrap.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { type SecurityReport } from '../domain/scanner/snapshot.js'

// All-null: what an unexamined token carries. The content is irrelevant here —
// what matters is that a row EXISTS, because existence is the whole signal.
const anyReport: SecurityReport = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null,
}

const NOW = 1_800_000_000_000

describe('securityBudgetFor — the beginning of everything is not a cycle', () => {
  it('lifts the budget entirely when nothing has ever been examined', async () => {
    // A virgin Neon: no tables, no rows, nothing looked at. The budget of 20
    // exists to keep a RECURRING cycle inside one 15m bar, and on this one pass
    // there is no bar to stay inside — no position is open, no money is at
    // risk, and nothing is waiting on the answer. Spending it here buys the
    // whole universe an examination instead of 2.8% of it.
    const store: ExaminationCountPort = new MemoryStore()
    expect(await securityBudgetFor(store, 'solana', 20)).toBeUndefined()
  })

  it('applies the budget the moment anything has been examined', async () => {
    // Self-terminating by construction: one recorded examination and this is no
    // longer the beginning of anything. It cannot become a permanent unbounded
    // scan through neglect.
    const store = new MemoryStore()
    await store.recordSecurity('solana', 'anything', anyReport, null, NOW)
    expect(await securityBudgetFor(store, 'solana', 20)).toBe(20)
  })

  it('judges each chain on its own history', async () => {
    // Solana having been swept says nothing about BSC. They are discovered,
    // gated and cached separately, so a chain added later gets the same cold
    // sweep the first one got rather than inheriting its neighbour's warmth.
    const store = new MemoryStore()
    await store.recordSecurity('solana', 'anything', anyReport, null, NOW)
    expect(await securityBudgetFor(store, 'bsc', 20)).toBeUndefined()
  })
})
