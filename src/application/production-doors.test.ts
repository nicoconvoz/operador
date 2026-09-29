import { describe, it, expect } from 'vitest'
import { productionDoors, DEFAULT_MIN_SCORE, DEFAULT_COMPONENT_FLOORS, DEFAULT_ENTRY_DOORS } from './production-doors.js'
import { meetsMinimums } from '../domain/scanner/opportunity.js'

describe('productionDoors — one definition of what the book may buy', () => {
  it('asks a candidate ONE thing: cost efficiency above 60%', () => {
    // *Ahora el filtro de entrada es sólo este, que tengan 100% de tendencia
    // en verde — y la única condición para traer candidatas.* The operator.
    // Then replaced outright: *sólo traer en candidatas monedas con más del 50%
    // de actividad y con crecimiento de liquidez.* Then: *como puerta de
    // entrada, todos los tokens que tengan más de 10% de presión compradora.*
    // And now: *la única puerta de entrada para los tokens es que la
    // eficiencia de los costos esté arriba del 60%.* Buy pressure is no longer
    // asked; every component stays, scored and drawn. The SAFETY gates are not
    // conditions of this kind and stay, as they always do.
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ costEfficiency: { above: 0.6 } })
    expect(productionDoors({}).minComponents).toEqual({ costEfficiency: { above: 0.6 } })
    expect(DEFAULT_MIN_SCORE).toBe(0)
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('refuses EXACTLY 60% of cost efficiency — the operator said above', () => {
    const floors = productionDoors({}).minComponents
    expect(meetsMinimums({ costEfficiency: 0.6 }, floors)).toBe(false)
    expect(meetsMinimums({ costEfficiency: 0.45 }, floors)).toBe(false)
    expect(meetsMinimums({ costEfficiency: 0.61 }, floors)).toBe(true)
    // An unmeasured toll is the neutral 0.5, and it stays out.
    expect(meetsMinimums({ costEfficiency: 0.5 }, floors)).toBe(false)
    // Nothing else is asked: buyers leaving and a dead pool clear this door,
    // and the gates judge the rest.
    expect(meetsMinimums({ costEfficiency: 0.9, buyPressure: 0, activity: 0, liquidityGrowth: 0 }, floors)).toBe(true)
  })

  it('moves the door with OPERADOR_MIN_COST_EFFICIENCY_PCT, and reads ZERO as more than zero', () => {
    expect(productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '75' }).minComponents).toEqual({ costEfficiency: { above: 0.75 } })
    const zero = productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '0' }).minComponents
    expect(zero).toEqual({ costEfficiency: { above: 0 } })
    expect(meetsMinimums({ costEfficiency: 0 }, zero)).toBe(false)
    expect(meetsMinimums({ costEfficiency: 0.01 }, zero)).toBe(true)
  })

  it('keeps the operator’s sixty on nonsense rather than trading on it', () => {
    for (const bad of ['sesenta', '-5', '100', '150', '   ', '']) {
      expect(productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: bad }).minComponents, bad).toEqual({ costEfficiency: { above: 0.6 } })
    }
  })

  it('no longer asks buy pressure, even though its old variable is still set somewhere', () => {
    // The door it replaced is gone, not stacked: an environment that still
    // carries OPERADOR_MIN_BUY_PRESSURE_PCT gets the one door the operator
    // asked for, and nothing else.
    expect(productionDoors({ OPERADOR_MIN_BUY_PRESSURE_PCT: '10' }).minComponents).toEqual({ costEfficiency: { above: 0.6 } })
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
    const env = { OPERADOR_MIN_SCORE: '55', OPERADOR_MIN_COST_EFFICIENCY_PCT: '70' }
    expect(productionDoors(env)).toEqual(productionDoors(env))
    expect(productionDoors(env).minScore).toBe(55)
    expect(productionDoors(env).minComponents).toEqual({ costEfficiency: { above: 0.7 } })
  })
})
