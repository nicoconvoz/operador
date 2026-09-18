import { describe, it, expect } from 'vitest'
import { productionDoors, DEFAULT_MIN_SCORE, DEFAULT_COMPONENT_FLOORS } from './production-doors.js'

describe('productionDoors — one definition of what the book may buy', () => {
  it('is a binary key: the floors at thirty percent', () => {
    // The operator's words for it — *o está on o está off*. Below any of the
    // three the coin is out; above all three it passes and the score is
    // computed as it always was, with the check playing no part in it.
    expect(productionDoors({}).minComponents).toEqual({ costEfficiency: 0.3, momentum: 0.3, headroom: 0.3 })
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ costEfficiency: 0.3, momentum: 0.3, headroom: 0.3 })
    // `headroom` came BACK, and what changed is the window it reads rather
    // than the mind of whoever set it. Over a DAY it refused every token up
    // more than ~95%, which is the runner this book exists to catch. Over the
    // HOUR it asks a different question — is this still climbing, and has the
    // climb not already happened — and the 2000%-in-a-day token now passes it
    // whenever its current hour is calm.
    expect(DEFAULT_COMPONENT_FLOORS.headroom).toBe(0.3)
  })

  it('shuts the score door at fifty', () => {
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(DEFAULT_MIN_SCORE).toBe(70)
  })

  it('takes zero as "let everything through", never as unset', () => {
    // `maxPositions: 0` meant "no ceiling" in one file and "zero slots" in the
    // one next door, and the engine opened nothing for weeks. Zero is a real
    // setting here and is read as one.
    expect(productionDoors({ OPERADOR_MIN_SCORE: '0' }).minScore).toBe(0)
  })

  it('moves without a deploy, and refuses nonsense rather than silently taking it', () => {
    expect(productionDoors({ OPERADOR_MIN_SCORE: '65' }).minScore).toBe(65)
    expect(productionDoors({ OPERADOR_MIN_SCORE: 'abc' }).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(productionDoors({ OPERADOR_MIN_SCORE: '-5' }).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(productionDoors({ OPERADOR_MIN_SCORE: '  ' }).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('hands the engine and the screen the SAME answer from the same environment', () => {
    // The whole reason this module exists. The floors were three literal
    // copies in three files — main.ts twice and dashboard/lib/view.ts once —
    // and a screen that draws a token as buyable while the engine refuses it
    // is the drift this project has paid for more than once.
    const env = { OPERADOR_MIN_SCORE: '55' }
    expect(productionDoors(env)).toEqual(productionDoors(env))
    expect(productionDoors(env).minScore).toBe(55)
  })
})
