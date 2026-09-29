import { describe, it, expect } from 'vitest'
import {
  productionDoors,
  DEFAULT_MIN_SCORE,
  DEFAULT_COMPONENT_FLOORS,
  DEFAULT_ENTRY_DOORS,
  DEFAULT_CANDIDATE_ORDER,
  DEFAULT_MIN_COST_EDGE_PCT,
  DEFAULT_MIN_VOLATILITY_PCT,
  DEFAULT_ENTRY_RISING,
} from './production-doors.js'
import { meetsMinimums } from '../domain/scanner/opportunity.js'

describe('productionDoors — one definition of what the book may buy', () => {
  it('asks a candidate ONE thing: that it is rising in the last hour', () => {
    // *Hacé que la barrera de entrada sea solamente que los tokens suban, como
    // marca la barra de estudio de los 49 tokens.* The operator. It was no door
    // at all — *todo es bienvenido* — and before that cost efficiency above
    // 60%, buy pressure, liquidity growth, activity, trend. Every component
    // stays, scored and drawn. The SAFETY gates are not conditions of this kind
    // and stay, as they always do.
    expect(DEFAULT_ENTRY_RISING).toBe(true)
    expect(DEFAULT_COMPONENT_FLOORS).toEqual({ risingHour: 1 })
    expect(productionDoors({}).minComponents).toEqual({ risingHour: 1 })
    expect(DEFAULT_MIN_SCORE).toBe(0)
    expect(productionDoors({}).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('lets a RISING token through whatever else it reads — an unmeasured toll, a dead pool, buyers leaving', () => {
    const floors = productionDoors({}).minComponents
    expect(meetsMinimums({ risingHour: 1, costEfficiency: 0 }, floors)).toBe(true)
    expect(meetsMinimums({ risingHour: 1, costEfficiency: 0.1, buyPressure: 0, activity: 0, liquidityGrowth: 0 }, floors)).toBe(true)
    // And nothing that is not rising, however good the rest is.
    expect(meetsMinimums({ risingHour: 0, costEfficiency: 1, buyPressure: 1, activity: 1 }, floors)).toBe(false)
    expect(meetsMinimums({ costEfficiency: 1 }, floors)).toBe(false)
  })

  it('takes the door off with OPERADOR_ENTRY_RISING=0 — and only an explicit off does', () => {
    for (const off of ['0', 'false', 'no', ' 0 ']) expect(productionDoors({ OPERADOR_ENTRY_RISING: off }).minComponents, off).toEqual({})
    for (const on of ['1', 'true', 'sí', 'cero', '']) expect(productionDoors({ OPERADOR_ENTRY_RISING: on }).minComponents, on).toEqual({ risingHour: 1 })
    const open = productionDoors({ OPERADOR_ENTRY_RISING: '0' }).minComponents
    expect(meetsMinimums({ risingHour: 0, costEfficiency: 0 }, open)).toBe(true)
  })

  it('brings a cost-efficiency floor back with OPERADOR_MIN_COST_EFFICIENCY_PCT, read as ABOVE', () => {
    const back = productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '60', OPERADOR_ENTRY_RISING: '0' }).minComponents
    expect(back).toEqual({ costEfficiency: { above: 0.6 } })
    expect(meetsMinimums({ costEfficiency: 0.6 }, back)).toBe(false)
    expect(meetsMinimums({ costEfficiency: 0.61 }, back)).toBe(true)
    const zero = productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '0', OPERADOR_ENTRY_RISING: '0' }).minComponents
    expect(zero).toEqual({ costEfficiency: { above: 0 } })
    expect(meetsMinimums({ costEfficiency: 0 }, zero)).toBe(false)
    // Beside the rising door, never instead of it.
    expect(productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '60' }).minComponents).toEqual({ costEfficiency: { above: 0.6 }, risingHour: 1 })
  })

  it('keeps NO door on nonsense rather than inventing one', () => {
    for (const bad of ['sesenta', '-5', '100', '150', '   ', '']) {
      expect(productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: bad }).minComponents, bad).toEqual(DEFAULT_COMPONENT_FLOORS)
    }
  })

  it('no longer asks buy pressure, even though its old variable is still set somewhere', () => {
    expect(productionDoors({ OPERADOR_MIN_BUY_PRESSURE_PCT: '10' }).minComponents).toEqual(DEFAULT_COMPONENT_FLOORS)
  })

  it('asks nothing more for a first buy', () => {
    expect(DEFAULT_ENTRY_DOORS).toEqual([])
    expect(productionDoors({}).entryDoors).toEqual([])
  })

  it('keeps the reserve OFF — a token that fails any gate is not a candidate', () => {
    expect(productionDoors({}).reserve).toBe(false)
    expect(productionDoors({ OPERADOR_RESERVE: '1' }).reserve).toBe(true)
  })

  it('takes zero as "let everything through", never as unset', () => {
    expect(productionDoors({ OPERADOR_MIN_SCORE: '0' }).minScore).toBe(0)
  })

  it('moves without a deploy, and refuses nonsense rather than silently taking it', () => {
    expect(productionDoors({ OPERADOR_MIN_SCORE: '65' }).minScore).toBe(65)
    expect(productionDoors({ OPERADOR_MIN_SCORE: 'abc' }).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(productionDoors({ OPERADOR_MIN_SCORE: '-5' }).minScore).toBe(DEFAULT_MIN_SCORE)
    expect(productionDoors({ OPERADOR_MIN_SCORE: '  ' }).minScore).toBe(DEFAULT_MIN_SCORE)
  })

  it('hands the engine and the screen the SAME answer from the same environment', () => {
    const env = { OPERADOR_MIN_SCORE: '55', OPERADOR_MIN_COST_EFFICIENCY_PCT: '70', OPERADOR_RANK_BY: 'size' }
    expect(productionDoors(env)).toEqual(productionDoors(env))
    expect(productionDoors(env).minScore).toBe(55)
    expect(productionDoors(env).minComponents).toEqual({ costEfficiency: { above: 0.7 }, risingHour: 1 })
  })
})

describe('productionDoors — who wins when there are more candidates than slots', () => {
  it('orders by cost efficiency, best first: *que elija los que tengan mejor eficiencia de costos*', () => {
    expect(DEFAULT_CANDIDATE_ORDER).toBe('costEfficiency')
    expect(productionDoors({}).order).toBe('costEfficiency')
  })

  it('brings back small caps first, then score, with OPERADOR_RANK_BY=size', () => {
    expect(productionDoors({ OPERADOR_RANK_BY: 'size' }).order).toBe('size')
    expect(productionDoors({ OPERADOR_RANK_BY: ' SIZE ' }).order).toBe('size')
  })

  it('keeps the operator’s order on anything else', () => {
    for (const other of ['score', 'cost', '', '  ', 'sizes']) {
      expect(productionDoors({ OPERADOR_RANK_BY: other }).order, other).toBe('costEfficiency')
    }
  })

  it('hands a reservation to a waiting token 10 points of efficiency better — OPERADOR_MIN_COST_EDGE_PCT', () => {
    expect(DEFAULT_MIN_COST_EDGE_PCT).toBe(10)
    expect(productionDoors({}).minCostEdgePct).toBe(10)
    expect(productionDoors({ OPERADOR_MIN_COST_EDGE_PCT: '5' }).minCostEdgePct).toBe(5)
    expect(productionDoors({ OPERADOR_MIN_COST_EDGE_PCT: '0' }).minCostEdgePct).toBe(0)
    for (const bad of ['diez', '-1', '100', '']) {
      expect(productionDoors({ OPERADOR_MIN_COST_EDGE_PCT: bad }).minCostEdgePct, bad).toBe(10)
    }
  })
})

describe('productionDoors — only tokens that move may enter', () => {
  // *Que la puerta de entrada haga pasar los mejores tokens, los de mayor
  // volatilidad.* The operator. At least 1% every five minutes, over the last
  // six hours: about where the fiftieth most volatile liquid token sat the day
  // it was measured.
  it('asks for 1% by default', () => {
    expect(DEFAULT_MIN_VOLATILITY_PCT).toBe(1)
    expect(productionDoors({}).minVolatilityPct).toBe(1)
  })

  it('moves with OPERADOR_MIN_VOLATILITY_PCT, and zero turns it off', () => {
    expect(productionDoors({ OPERADOR_MIN_VOLATILITY_PCT: '2.5' }).minVolatilityPct).toBe(2.5)
    expect(productionDoors({ OPERADOR_MIN_VOLATILITY_PCT: '0' }).minVolatilityPct).toBe(0)
  })

  it('keeps the default on a value that is not a threshold', () => {
    for (const bad of ['uno', '-1', '', 'Infinity']) {
      expect(productionDoors({ OPERADOR_MIN_VOLATILITY_PCT: bad }).minVolatilityPct, bad).toBe(1)
    }
  })
})
