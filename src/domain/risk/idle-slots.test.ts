import { describe, it, expect } from 'vitest'
import { releasableSlots, DEFAULT_IDLE_SLOT_POLICY, type SlotHolder } from './idle-slots.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const holder = (over: Partial<SlotHolder> = {}): SlotHolder => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', symbol: 'IDLE',
  openedAt: NOW - 6 * HOUR, openQty: 0, hasFills: false, score: 50, ...over,
})

const policy = { idleAfterMs: 3 * HOUR, minScoreEdge: 10 }
const symbols = (d: readonly { holder: SlotHolder }[]) => d.map((x) => x.holder.symbol)

describe('releasableSlots — a slot with nothing in it', () => {
  it('hands on a reservation that never bought anything', () => {
    expect(symbols(releasableSlots([holder()], [40], NOW, policy))).toEqual(['IDLE'])
  })

  it('never touches a position that is HOLDING something', () => {
    // With tokens in it the slot cannot come back without selling, and selling
    // is the strategy's decision. However long it has been there, however good
    // the queue looks.
    const held = holder({ openQty: 1_000, hasFills: true, openedAt: NOW - 90 * HOUR, score: 1 })
    expect(releasableSlots([held], [99], NOW, policy)).toEqual([])
  })

  it('gives a fresh reservation time to set up', () => {
    const fresh = holder({ openedAt: NOW - 1 * HOUR })
    expect(releasableSlots([fresh], [55], NOW, policy)).toEqual([])
  })

  it('releases nothing when nobody is waiting for the slot', () => {
    expect(releasableSlots([holder()], [], NOW, policy)).toEqual([])
  })

  it('releases no more slots than there are candidates to fill them', () => {
    const holders = [
      holder({ id: 'a', symbol: 'A', score: 10 }),
      holder({ id: 'b', symbol: 'B', score: 20 }),
      holder({ id: 'c', symbol: 'C', score: 30 }),
    ]
    expect(symbols(releasableSlots(holders, [80, 80], NOW, policy))).toEqual(['A', 'B'])
  })
})

describe('releasableSlots — re-examined the moment it goes flat', () => {
  /** Took its profit and is flat: it traded, and it holds nothing. */
  const cashedOut = (over: Partial<SlotHolder> = {}) =>
    holder({ hasFills: true, openQty: 0, openedAt: NOW - 30 * 60_000, ...over })

  it('hands on a token that no longer clears the gates at all', () => {
    // Absent from the scan is the strongest verdict available: it stopped
    // being something the scanner would choose today.
    const decisions = releasableSlots([cashedOut({ score: null })], [10], NOW, policy)
    expect(symbols(decisions)).toEqual(['IDLE'])
    expect(decisions[0]!.reason).toContain('candidatos')
  })

  it('hands on a token something clearly better is waiting to replace', () => {
    const decisions = releasableSlots([cashedOut({ score: 50 })], [65], NOW, policy)
    expect(decisions[0]!.reason).toContain('15 puntos mejor')
  })

  it('keeps it when the queue is only marginally better — score is a heuristic, not a measurement', () => {
    // Swapping on any difference at all would trade the book against the
    // score's own noise, and pay gas for the privilege.
    expect(releasableSlots([cashedOut({ score: 50 })], [57], NOW, policy)).toEqual([])
  })

  it('keeps a token that just banked a profit and still looks the best thing available', () => {
    expect(releasableSlots([cashedOut({ score: 80 })], [60, 55], NOW, policy)).toEqual([])
  })

  it('re-examines immediately, without waiting out the idle window', () => {
    // It has been open half an hour against a three-hour window. Having traded
    // is what makes it eligible now: the question is no longer "did it ever
    // work" but "is this still the right token".
    const decisions = releasableSlots([cashedOut({ score: 20, openedAt: NOW - 30 * 60_000 })], [90], NOW, policy)
    expect(symbols(decisions)).toEqual(['IDLE'])
  })

  it('lets go of the weakest first when slots are scarce', () => {
    const holders = [
      cashedOut({ id: 'ok', symbol: 'OK', score: 45 }),
      cashedOut({ id: 'worst', symbol: 'WORST', score: 5 }),
    ]
    expect(symbols(releasableSlots(holders, [90], NOW, policy))).toEqual(['WORST'])
  })
})

describe('releasableSlots — the defaults', () => {
  it('waits three hours on a reservation, and wants ten points of edge to swap', () => {
    expect(DEFAULT_IDLE_SLOT_POLICY).toEqual({ idleAfterMs: 3 * HOUR, minScoreEdge: 10 })
  })
})

describe('releasableSlots — a fresh reservation is not judged by the ranking that just chose it', () => {
  it('leaves a position opened minutes ago alone, however the queue looks', () => {
    // It was picked by this same scan minutes ago. The opportunity score moves
    // bar to bar, so acting now would open a position and close it on the next
    // pass — churn wearing the costume of discipline.
    const fresh = holder({ openedAt: NOW - 10 * 60_000, score: 10 })
    expect(releasableSlots([fresh], [99], NOW, policy)).toEqual([])
  })

  it('leaves it alone even when the scanner has dropped it entirely', () => {
    const fresh = holder({ openedAt: NOW - 10 * 60_000, score: null })
    expect(releasableSlots([fresh], [99], NOW, policy)).toEqual([])
  })

  it('but one that has TRADED is judged immediately — it proved what it could do', () => {
    const proven = holder({ openedAt: NOW - 10 * 60_000, hasFills: true, score: 10 })
    expect(symbols(releasableSlots([proven], [99], NOW, policy))).toEqual(['IDLE'])
  })
})
