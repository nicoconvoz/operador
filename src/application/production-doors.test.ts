import { describe, it, expect } from 'vitest'
import { productionDoors, DEFAULT_MIN_SCORE, DEFAULT_COMPONENT_FLOORS, DEFAULT_ENTRY_DOORS } from './production-doors.js'
import { meetsMinimums } from '../domain/scanner/opportunity.js'

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
    // And replaced again: *como puerta de entrada, todos los tokens que tengan
    // más de 10% de presión compradora.* Activity and liquidity growth are no
    // longer asked; their components stay, scored and drawn.
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ buyPressure: { above: 0.1 } })
    expect(productionDoors({}).minComponents).toEqual({ buyPressure: { above: 0.1 } })
    expect(DEFAULT_MIN_SCORE).toBe(0)
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('refuses EXACTLY 10% of buy pressure — the operator said more than', () => {
    const floors = productionDoors({}).minComponents
    expect(meetsMinimums({ buyPressure: 0.1 }, floors)).toBe(false)
    expect(meetsMinimums({ buyPressure: 0.073 }, floors)).toBe(false)
    expect(meetsMinimums({ buyPressure: 0.11 }, floors)).toBe(true)
    // No other opportunity floor is asked: a dead, shrinking pool with buyers
    // leading clears this door, and the gates judge the rest.
    expect(meetsMinimums({ buyPressure: 0.11, activity: 0, liquidityGrowth: 0 }, floors)).toBe(true)
  })

  it('moves the door with OPERADOR_MIN_BUY_PRESSURE_PCT, and reads ZERO as more than zero', () => {
    expect(productionDoors({ OPERADOR_MIN_BUY_PRESSURE_PCT: '25' }).minComponents).toEqual({ buyPressure: { above: 0.25 } })
    // Zero is a real value, never "unset": the door then asks only that
    // buyers lead at all, and a silent or even hour still stays out.
    const zero = productionDoors({ OPERADOR_MIN_BUY_PRESSURE_PCT: '0' }).minComponents
    expect(zero).toEqual({ buyPressure: { above: 0 } })
    expect(meetsMinimums({ buyPressure: 0 }, zero)).toBe(false)
    expect(meetsMinimums({ buyPressure: 0.01 }, zero)).toBe(true)
  })

  it('keeps the operator’s ten on nonsense rather than trading on it', () => {
    for (const bad of ['diez', '-5', '100', '150', '   ', '']) {
      expect(productionDoors({ OPERADOR_MIN_BUY_PRESSURE_PCT: bad }).minComponents, bad).toEqual({ buyPressure: { above: 0.1 } })
    }
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
    const env = { OPERADOR_MIN_SCORE: '55', OPERADOR_MIN_BUY_PRESSURE_PCT: '15' }
    expect(productionDoors(env)).toEqual(productionDoors(env))
    expect(productionDoors(env).minScore).toBe(55)
    expect(productionDoors(env).minComponents).toEqual({ buyPressure: { above: 0.15 } })
  })
})
