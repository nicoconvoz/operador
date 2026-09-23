import { describe, it, expect } from 'vitest'
import { rotateOnSwitchOff, ROTATION_EXIT_COMMENT, type RotationHolder } from './rotation.js'

const holder = (over: Partial<RotationHolder> = {}): RotationHolder => ({
  unrealisedPct: 2,
  tollPct: 0.9,
  id: 'p1',
  symbol: 'TOK',
  chain: 'solana',
  tokenAddress: 'A',
  openQty: 1_000,
  switchOff: null,
  failed: [],
  ...over,
})

describe('rotation — the switch is off, so the money leaves', () => {
  // The operator's rule, and it is a real departure from the reference: *si el
  // interruptor on/off se desactiva en vivo y en directo, vender todo y
  // redistribuir en un token nuevo, aunque se pierda.*
  //
  // It is NOT a death exit and must never be routed through one.
  // `AssetHealthObservation` is typed so no price-shaped field can exist on
  // it, and that typing is what keeps the death exit from degrading into a
  // stop loss. This decision reads the opportunity floors, one of which
  // (`momentum`) IS price — so it is kept out of that path deliberately, and
  // carries its own comment so the audit trail can never confuse the two.

  it('sells a live position whose switch went off', () => {
    const [decision] = rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'] })])
    expect(decision?.holder.id).toBe('p1')
    expect(decision?.reason).toContain('momentum')
  })

  it('leaves a position whose switch is still on', () => {
    expect(rotateOnSwitchOff([holder({ switchOff: false })])).toEqual([])
  })

  it('does NOTHING when the token was not examined — silence is not evidence', () => {
    // The rule the whole scanner runs on, and here it is load-bearing. A rate
    // limit once turned 26 of 29 live positions red because an unanswered
    // request was read as a verdict. Read that way HERE it would not colour a
    // screen, it would LIQUIDATE the book — every position at once, at market,
    // for a provider having a bad minute.
    expect(rotateOnSwitchOff([holder({ switchOff: null })])).toEqual([])
  })

  it('ignores a slot that holds nothing — that is idle-slots\' job, not this one', () => {
    // A position with no fills is a RESERVATION: handing it on costs nothing
    // and needs no sale. Selling zero tokens would pay gas for a trade that
    // moves nothing, and two functions releasing the same slot is how a book
    // double-counts its own capital.
    expect(rotateOnSwitchOff([holder({ openQty: 0, switchOff: true, failed: ['costEfficiency'] })])).toEqual([])
  })

  it('names every floor that failed, because the evidence travels with the decision', () => {
    const [decision] = rotateOnSwitchOff([holder({ switchOff: true, failed: ['costEfficiency', 'momentum'] })])
    expect(decision?.reason).toContain('costEfficiency')
    expect(decision?.reason).toContain('momentum')
  })

  it('carries a comment of its own, distinct from the two risk exits', () => {
    // The no-loss guard tells the exits apart in the TYPE system. This one must
    // be allowed to sell below average cost — *aunque se pierda* — and must
    // never be mistaken for a death exit, which also blacklists the token. A
    // rotated token is not condemned: it goes back to being an ordinary
    // candidate and may be bought again the day it qualifies.
    expect(ROTATION_EXIT_COMMENT).toBe('🔁 Rotación')
    expect(ROTATION_EXIT_COMMENT).not.toBe('☠️ Death Exit')
  })

  it('decides each position on its own — one token rotating never moves another', () => {
    const decisions = rotateOnSwitchOff([
      holder({ id: 'a', switchOff: true, failed: ['momentum'] }),
      holder({ id: 'b', switchOff: false }),
      holder({ id: 'c', switchOff: null }),
      holder({ id: 'd', switchOff: true, failed: ['costEfficiency'] }),
    ])
    expect(decisions.map((d) => d.holder.id)).toEqual(['a', 'd'])
  })
})

describe('rotateOnSwitchOff — never closes in the red', () => {
  // *Hacé lo mismo en la rotación por filtro.* The operator, right after the
  // swap for a better token got the same floor: out only when the position is
  // up by MORE than its whole round trip costs — fees already paid plus the
  // cost of leaving. Below that, the filter going off is not a reason to lose.
  it('keeps a position that has not yet paid for its own round trip', () => {
    expect(rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], unrealisedPct: 0.5, tollPct: 0.9 })])).toEqual([])
    expect(rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], unrealisedPct: 0.9, tollPct: 0.9 })])).toEqual([])
  })

  it('keeps a position under water, whatever the filter says', () => {
    expect(rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], unrealisedPct: -3, tollPct: 0.9 })])).toEqual([])
  })

  it('keeps a position whose standing or toll nobody could measure', () => {
    expect(rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], unrealisedPct: null })])).toEqual([])
    expect(rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], tollPct: null })])).toEqual([])
  })

  it('says what it made and what the trip cost, because the alert is where it is read', () => {
    const [decision] = rotateOnSwitchOff([holder({ switchOff: true, failed: ['momentum'], unrealisedPct: 2, tollPct: 0.9 })])
    expect(decision?.reason).toContain('+2.00%')
    expect(decision?.reason).toContain('0.90%')
  })
})
