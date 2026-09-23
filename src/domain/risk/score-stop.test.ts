import { describe, it, expect } from 'vitest'
import { scoreFell, SCORE_STOP_COMMENT } from './score-stop.js'

/**
 * *Cuando el puntaje cae 5 puntos, SL.* The operator, after PEPE: bought at a
 * score of 93.2, down to 65.9 ten minutes later, and still held at −11.6% an
 * hour after that.
 */
describe('scoreFell — a stop on the score, measured from the score at entry', () => {
  it('fires when the score is five points or more under the one it was bought at', () => {
    expect(scoreFell({ entryScore: 93.2, score: 65.9 }, 5)).toBe(true)
    expect(scoreFell({ entryScore: 80, score: 75 }, 5)).toBe(true)
  })

  it('holds on a smaller dip', () => {
    expect(scoreFell({ entryScore: 80, score: 75.1 }, 5)).toBe(false)
  })

  it('never fires on a score nobody measured, or without a baseline', () => {
    expect(scoreFell({ entryScore: 93.2, score: null }, 5)).toBe(false)
    expect(scoreFell({ entryScore: null, score: 10 }, 5)).toBe(false)
  })

  it('is off at zero points', () => {
    expect(scoreFell({ entryScore: 93.2, score: 0 }, 0)).toBe(false)
  })

  it('has an exit of its own, so the tape says why a position left at a loss', () => {
    expect(SCORE_STOP_COMMENT).toBe('📉 Cae el puntaje')
  })
})
