import { describe, it, expect } from 'vitest'
import { productionDoors, DEFAULT_MIN_SCORE, DEFAULT_COMPONENT_FLOORS } from './production-doors.js'

describe('productionDoors — one definition of what the book may buy', () => {
  it('is ONE floor now: what the token charges to trade it', () => {
    // `momentum` and `headroom` were removed after the operator relaunched with
    // the momentum rule on and the engine opened THREE positions where the rule
    // had thirty-seven candidates.
    //
    // Both asked the question the rule now asks, and asked it worse. The
    // momentum component is BINARY — one when h24 or h1 cleared 1%, zero
    // otherwise — so a floor of 0.5 meant "the hour must be at least one
    // percent", while the rule requires the hour above ZERO. A token up 0.4% in
    // the hour passed his rule and was killed by a floor set for a different
    // strategy: not a stricter version of his decision, a silent override of it.
    //
    // `headroom` was worse. It is one for anything not falling 3% in the hour,
    // so everything the rule admits passes it and the floor can never cut. A
    // dead knob, and a dead knob is worse than a wrong one, because the next
    // reader tunes it and nothing happens.
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ costEfficiency: 0.3 })
  })

  it('keeps the TOLL, and that is not an oversight', () => {
    // *Sacá todos los filtros* was about what makes a token interesting. This
    // one answers what it CHARGES, which is a different question, and it
    // matters MORE under a strategy whose positions turn over in minutes:
    // every round trip pays it in full. PURR charged 15.55% a round trip and
    // was bought anyway, because an average can always be carried by its other
    // terms and a floor cannot.
    expect(DEFAULT_COMPONENT_FLOORS.costEfficiency).toBe(0.3)
    expect(DEFAULT_COMPONENT_FLOORS.momentum).toBeUndefined()
    expect(DEFAULT_COMPONENT_FLOORS.headroom).toBeUndefined()
  })

  it('opens the score door at 75 — every condition, plus the score', () => {
    // *Hacé que sólo sean candidatas las que ya cumplan todas las condiciones,
    // sumada la condición de puntaje arriba de 75.*
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(DEFAULT_MIN_SCORE).toBe(75)
  })

  it('keeps the reserve OFF — a token that fails any gate is not a candidate', () => {
    expect(productionDoors({}).reserve).toBe(false)
    expect(productionDoors({ OPERADOR_RESERVE: '1' }).reserve).toBe(true)
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
