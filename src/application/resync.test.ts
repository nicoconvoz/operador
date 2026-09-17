import { describe, it, expect } from 'vitest'
import { resyncCascade } from './resync.js'
import { initialState } from '../domain/strategy/state.js'
import { type PersistedFill } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000

const buy = (price: number, at: number, qty = 1_000): PersistedFill => ({
  positionId: 'p', orderId: 'Entry', side: 'buy', time: at, price, qty,
  costUsd: 0.05, comment: 'Entry', idempotencyKey: `p:buy:${at}`,
})

const open = (ep1: number, lastFill: number | null = null) => ({
  ...initialState(), level: 1, ep1, lastFill,
})

describe('resyncCascade — the fills are the facts', () => {
  it('leaves a position alone when the anchor matches what it paid', () => {
    // Pine sets `ep1 := close` on the signal bar and the fill lands at the next
    // bar's OPEN, so the two legitimately differ a little. That is the
    // reference's own behaviour and must not be "repaired".
    expect(resyncCascade(open(0.01), [buy(0.0102, NOW)], 10)).toBeNull()
  })

  it('re-anchors a ladder hung off a price the position never paid', () => {
    // BinanceTown: the entry was sized against 0.0013161 while its bar was
    // mid-pump, and the bar ENDED at 0.00100069. Every rung then hung off a
    // number that was never a close, so the ladder could not average down from
    // anywhere real.
    const fixed = resyncCascade(open(0.0013161), [buy(0.0010038, NOW)], 10)
    expect(fixed?.cascade.ep1).toBeCloseTo(0.0010038, 9)
    expect(fixed?.reasons.join(' ')).toMatch(/ancla/)
  })

  it('anchors on the FIRST buy, never on the average or the latest', () => {
    // `ep1` is the anchor the whole ladder is measured from. Using the average
    // would move it every time a rung fills, and the rungs would chase it.
    const fixed = resyncCascade(open(1), [buy(0.5, NOW - 200), buy(0.25, NOW - 100)], 10)
    expect(fixed?.cascade.ep1).toBeCloseTo(0.5, 9)
  })

  it('brings the separation lock along, because it guards the next rung', () => {
    // `lastFill` is what `minGapPct` measures against. Left on the old scale it
    // demands a fall from a price that never existed.
    const fixed = resyncCascade(open(1, 0.9), [buy(0.5, NOW - 200), buy(0.25, NOW - 100)], 10)
    expect(fixed?.cascade.lastFill).toBeCloseTo(0.25, 9)
  })

  it('says nothing about a position that has never bought anything', () => {
    // A reservation holds no facts to resynchronise against. Its `ep1` is a
    // decision waiting to be executed, not a record of one.
    expect(resyncCascade(open(0.01), [], 10)).toBeNull()
    expect(resyncCascade(initialState(), [buy(1, NOW)], 10)).toBeNull()
  })

  it('never touches anything that could double-count', () => {
    const before = { ...open(1), totalInv: 45, level: 3, decayCount: 2, awaitReentry: true }
    const after = resyncCascade(before, [buy(0.5, NOW)], 10)!.cascade
    expect(after).toMatchObject({ totalInv: 45, level: 3, decayCount: 2, awaitReentry: true })
  })

  it('ignores SELLS, which say where it left and not where it started', () => {
    const sell: PersistedFill = { ...buy(9, NOW - 50), side: 'sell', orderId: 'Exit', idempotencyKey: 'p:sell' }
    const fixed = resyncCascade(open(1), [buy(0.5, NOW - 200), sell], 10)
    expect(fixed?.cascade.ep1).toBeCloseTo(0.5, 9)
  })
})
