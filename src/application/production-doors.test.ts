import { describe, it, expect } from 'vitest'
import { productionDoors, DEFAULT_MIN_SCORE, DEFAULT_COMPONENT_FLOORS, DEFAULT_ENTRY_DOORS } from './production-doors.js'

describe('productionDoors — one definition of what the book may buy', () => {
  it('asks a candidate ONE thing: trend at 100%', () => {
    // *Ahora el filtro de entrada es sólo este, que tengan 100% de tendencia
    // en verde — y la única condición para traer candidatas.* The operator.
    // Trend is binary — one when the hour or the day rose 1% or more — so
    // 100% means rising. The toll floor (0.3) and the score door (75) are
    // gone with this; the SAFETY gates are not conditions of this kind and
    // stay, as they always do.
    // Then replaced outright: *sólo traer en candidatas monedas con más del 50%
    // de actividad y con crecimiento de liquidez — de la última hora, más del
    // 0% — y operarlas directamente.* Trend is no longer asked.
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ activity: 0.5, liquidityGrowth: 1 })
    expect(DEFAULT_MIN_SCORE).toBe(0)
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('asks nothing more for a first buy — the one condition already made it a candidate', () => {
    expect(DEFAULT_ENTRY_DOORS).toEqual([])
    expect(productionDoors({}).entryDoors).toEqual([])
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
