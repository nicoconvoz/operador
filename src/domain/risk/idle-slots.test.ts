import { describe, it, expect } from 'vitest'
import { releasableSlots, DEFAULT_IDLE_SLOT_POLICY, type SlotHolder } from './idle-slots.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const holder = (over: Partial<SlotHolder> = {}): SlotHolder => ({
  id: 'pos-1', chain: 'solana', tokenAddress: 'Mint1', symbol: 'IDLE',
  openedAt: NOW - 6 * HOUR, hasFills: false, ...over,
})

const policy = { idleAfterMs: 3 * HOUR }

describe('releasableSlots — a reservation nobody used', () => {
  it('releases a slot held for hours by a position that never bought anything', () => {
    const released = releasableSlots([holder()], 1, NOW, policy)
    expect(released.map((h) => h.symbol)).toEqual(['IDLE'])
  })

  it('never releases a position that has traded, however long it has been open', () => {
    // A position with fills is a COMMITMENT: the slot cannot come back without
    // selling, and selling is a decision the strategy makes, never the
    // allocator. Only a slot that was reserved and never used is free.
    const released = releasableSlots([holder({ hasFills: true, openedAt: NOW - 90 * HOUR })], 3, NOW, policy)
    expect(released).toEqual([])
  })

  it('gives a fresh reservation time to set up', () => {
    // The entry gates wait for a drop from the swing high and a lateral zone.
    // Evicting before that can plausibly happen would just churn the book.
    const released = releasableSlots([holder({ openedAt: NOW - 1 * HOUR })], 5, NOW, policy)
    expect(released).toEqual([])
  })

  it('releases nothing when nobody is waiting for the slot', () => {
    // Freeing a slot into an empty queue is pure loss: the incumbent might
    // still enter, and nothing else can use what it gives up.
    expect(releasableSlots([holder()], 0, NOW, policy)).toEqual([])
  })

  it('releases no more slots than there are candidates to fill them', () => {
    const holders = [
      holder({ id: 'a', symbol: 'A', openedAt: NOW - 9 * HOUR }),
      holder({ id: 'b', symbol: 'B', openedAt: NOW - 8 * HOUR }),
      holder({ id: 'c', symbol: 'C', openedAt: NOW - 7 * HOUR }),
    ]
    expect(releasableSlots(holders, 2, NOW, policy).map((h) => h.symbol)).toEqual(['A', 'B'])
  })

  it('lets go of the one that has been waiting longest', () => {
    const holders = [
      holder({ id: 'young', symbol: 'YOUNG', openedAt: NOW - 4 * HOUR }),
      holder({ id: 'old', symbol: 'OLD', openedAt: NOW - 20 * HOUR }),
    ]
    expect(releasableSlots(holders, 1, NOW, policy).map((h) => h.symbol)).toEqual(['OLD'])
  })

  it('defaults to three hours — twelve bars at 15m', () => {
    expect(DEFAULT_IDLE_SLOT_POLICY.idleAfterMs).toBe(3 * HOUR)
  })
})
