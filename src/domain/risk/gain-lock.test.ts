import { describe, it, expect } from 'vitest'
import {
  gainLockFloorPct,
  gainLockStepPct,
  keepGainLock,
  DEFAULT_GAIN_LOCK_POLICY,
  GAIN_LOCK_COMMENT,
} from './gain-lock.js'

/**
 * *Si pasás el 20% de ganancia, break-even en el 10%; con cada aumento de 20%,
 * aumentar el break-even 10% — por si algo es muy volátil y vuela para arriba,
 * lo podemos atrapar si baja a toda velocidad.* The operator.
 */
const POLICY = DEFAULT_GAIN_LOCK_POLICY

describe('gainLockFloorPct — the floor a gain has earned', () => {
  it('is the operator’s numbers: from +20%, a floor of 10, then ten more per twenty', () => {
    expect(POLICY).toEqual({ startPct: 20, stepPct: 20, firstFloorPct: 10, floorStepPct: 10 })
  })

  it('earns nothing under +20%', () => {
    expect(gainLockFloorPct(19.9, POLICY)).toBeNull()
    expect(gainLockFloorPct(0, POLICY)).toBeNull()
    expect(gainLockFloorPct(-35, POLICY)).toBeNull()
  })

  it('earns +10% at +20%, and holds it all the way to just under +40%', () => {
    expect(gainLockFloorPct(20, POLICY)).toBe(10)
    expect(gainLockFloorPct(39.9, POLICY)).toBe(10)
  })

  it('steps ten points for every twenty more', () => {
    expect(gainLockFloorPct(40, POLICY)).toBe(20)
    expect(gainLockFloorPct(60, POLICY)).toBe(30)
    expect(gainLockFloorPct(100, POLICY)).toBe(50)
  })

  it('has no ceiling: a rocket keeps raising its own floor', () => {
    // *Por si algo vuela para arriba.* +500% keeps 250 of it.
    expect(gainLockFloorPct(500, POLICY)).toBe(250)
  })

  it('says nothing about a gain nobody could measure', () => {
    expect(gainLockFloorPct(Number.NaN, POLICY)).toBeNull()
    expect(gainLockFloorPct(Number.POSITIVE_INFINITY, POLICY)).toBeNull()
  })
})

describe('gainLockStepPct — the gain that set a floor, for the alert', () => {
  it('reads the step back out of the floor', () => {
    expect(gainLockStepPct(10, POLICY)).toBe(20)
    expect(gainLockStepPct(20, POLICY)).toBe(40)
    expect(gainLockStepPct(50, POLICY)).toBe(100)
  })
})

describe('keepGainLock — the ratchet both stores run', () => {
  // Every step of the cycle writes the WHOLE row, and this project has paid
  // for a stale snapshot written back over what the sweep had just decided.
  const OLD = 1_000
  const NEW = 2_000

  it('keeps the greater floor of the same holding', () => {
    expect(keepGainLock({ pct: 20, since: OLD }, { pct: 10, since: OLD })).toEqual({ pct: 20, since: OLD })
    expect(keepGainLock({ pct: 10, since: OLD }, { pct: 30, since: OLD })).toEqual({ pct: 30, since: OLD })
  })

  it('takes a NEWER holding’s lock whole, even when its floor is lower', () => {
    expect(keepGainLock({ pct: 40, since: OLD }, { pct: 10, since: NEW })).toEqual({ pct: 10, since: NEW })
  })

  it('never lets an OLDER holding’s lock overwrite a newer one', () => {
    expect(keepGainLock({ pct: 10, since: NEW }, { pct: 40, since: OLD })).toEqual({ pct: 10, since: NEW })
  })

  it('keeps what is stored when the write carries no lock at all', () => {
    expect(keepGainLock({ pct: 20, since: OLD }, undefined)).toEqual({ pct: 20, since: OLD })
    expect(keepGainLock({ pct: 20, since: OLD }, null)).toEqual({ pct: 20, since: OLD })
  })

  it('takes the first lock ever written', () => {
    expect(keepGainLock(undefined, { pct: 10, since: OLD })).toEqual({ pct: 10, since: OLD })
    expect(keepGainLock(null, null)).toBeNull()
  })
})

describe('the lock has a name of its own on the tape', () => {
  it('is not the break-even, and not the strategy’s exit', () => {
    expect(GAIN_LOCK_COMMENT).toBe('🔐 Piso de ganancia')
  })
})
