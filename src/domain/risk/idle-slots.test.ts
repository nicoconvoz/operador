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

describe('releasableSlots — a frozen reservation is waiting for nothing', () => {
  it('hands back a frozen slot that holds nothing, without waiting out the window', () => {
    // The window exists so a slot chosen by this same ranking minutes ago is
    // not judged before its setup had a chance. A FROZEN one had no chance and
    // will get none: freezing blocks entries, so it cannot buy, and it holds
    // nothing to sell. Three hours of waiting buys exactly nothing.
    //
    // Six of them sat like that at once, each holding a slot and the capital
    // for a ladder that could never fire.
    const decisions = releasableSlots(
      [holder({ openQty: 0, hasFills: false, frozen: true, openedAt: NOW - 5 * 60_000, score: 90 })],
      [95],
      NOW,
      policy,
    )
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.reason).toContain('congelada')
  })

  it('still refuses to touch a frozen slot that HOLDS something', () => {
    // Frozen or not, tokens in the slot end the conversation: the slot cannot
    // come back without selling, and selling is the strategy's decision.
    const decisions = releasableSlots(
      [holder({ openQty: 1_000, hasFills: true, frozen: true, openedAt: NOW - 5 * 60_000, score: 10 })],
      [95],
      NOW,
      policy,
    )
    expect(decisions).toEqual([])
  })
})

describe('a slot nobody can ever use again', () => {
  // The operator, reading his own list: *hay una que murió y una congelada, y
  // aunque no tengo dinero en ellas quedaron atrapadas en mi lista sin poderlas
  // sacar y con las notificaciones. Deberían ceder su ranura.*
  //
  // Both were stuck for the same reason, and it is this function's own opening
  // line: `if (waiting.length === 0) return []`. That cap is argued — *freeing a
  // slot into an empty queue is pure loss, since the incumbent might yet
  // enter* — and the argument is simply FALSE for these two.
  //
  // A DEAD position is terminal: the token is blacklisted and can never be
  // opened again, by anyone, ever. A FROZEN one cannot buy either, and this
  // file says so twelve lines further down: *freezing blocks entries, so it
  // cannot buy, and it holds nothing to sell.*
  //
  // So there is no incumbent that might yet enter, and nothing is lost by
  // letting the row go. What was lost by keeping it: a slot, a line on the
  // screen, and a notification about a position that will never do anything.

  it('hands back a DEAD slot even when nothing is waiting', () => {
    const [decision] = releasableSlots([holder({ dead: true, openQty: 0 })], [], NOW)
    expect(decision?.holder.id).toBe('pos-1')
  })

  it('hands back a FROZEN slot even when nothing is waiting', () => {
    const [decision] = releasableSlots([holder({ frozen: true, openQty: 0 })], [], NOW)
    expect(decision?.holder.id).toBe('pos-1')
  })

  it('says WHY, because the alert is the only place the operator reads it', () => {
    const [dead] = releasableSlots([holder({ dead: true, openQty: 0 })], [], NOW)
    expect(dead?.reason).toContain('muerto')
  })

  it('still keeps a dead slot that is HOLDING something', () => {
    // The invariant this file exists to protect, and a death exit does not
    // suspend it: a slot with tokens in it cannot come back without selling,
    // and selling is never the allocator's decision. A death exit that could
    // not complete leaves exactly this state, and the position must stay
    // visible rather than be quietly retired with the money still inside.
    expect(releasableSlots([holder({ dead: true, openQty: 1_000 })], [], NOW)).toEqual([])
  })

  it('leaves an ordinary idle slot alone while nothing is waiting', () => {
    // Unchanged, and the reason still holds: this one CAN still enter, so
    // freeing it into an empty queue really would be pure loss.
    const idle = holder({ openQty: 0, hasFills: false, openedAt: NOW - 9 * 3_600_000 })
    expect(releasableSlots([idle], [], NOW)).toEqual([])
  })
})
