import { describe, it, expect } from 'vitest'
import { stepCrashStop, type PriceMark } from './crash-stop.js'

// *Si una moneda baja más de 5% del precio en menos de un minuto, SL.*

const MIN = 60_000
const rule = { windowMs: MIN, dropPct: 5 }

const walk = (readings: readonly [number, number][]) => {
  let marks: readonly PriceMark[] = []
  const crashed: boolean[] = []
  for (const [at, price] of readings) {
    const step = stepCrashStop(marks, at, price, rule)
    marks = step.marks
    crashed.push(step.crashed)
  }
  return { marks, crashed }
}

describe('the crash stop: more than 5% down in under a minute', () => {
  it('cuts a fall of more than 5% from the highest price of the last minute', () => {
    expect(walk([[0, 1], [30_000, 1.02], [55_000, 0.968]]).crashed).toEqual([false, false, true])
  })

  it('holds a fall of exactly 5%', () => {
    expect(walk([[0, 1], [30_000, 0.95]]).crashed).toEqual([false, false])
  })

  it('holds the same fall spread over more than a minute', () => {
    // 1.00 at zero is a minute old by the time 0.94 arrives.
    expect(walk([[0, 1], [30_000, 0.97], [60_000, 0.94]]).crashed).toEqual([false, false, false])
  })

  it('never cuts on the first reading — a fall needs a before', () => {
    expect(walk([[0, 0.5]]).crashed).toEqual([false])
  })

  it('forgets readings older than the minute', () => {
    expect(walk([[0, 1], [30_000, 0.99], [70_000, 0.98]]).marks.map((m) => m.at)).toEqual([30_000, 70_000])
  })

  it('is off at zero', () => {
    expect(stepCrashStop([{ at: 0, price: 1 }], 1_000, 0.5, { windowMs: MIN, dropPct: 0 }).crashed).toBe(false)
  })
})
