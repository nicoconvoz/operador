import { describe, it, expect } from 'vitest'
import { marketBreadth } from './market-breadth.js'
import { risingInTheHour } from '../domain/scanner/momentum.js'

describe('marketBreadth — which way the universe went in the last hour', () => {
  it('everything rising puts the marker at the green end', () => {
    const breadth = marketBreadth([1, 4.2, 0.01])
    expect(breadth).toMatchObject({ up: 3, down: 0, flat: 0, unknown: 0, total: 3, upShare: 1, at: 100 })
  })

  it('everything falling puts the marker at the red end', () => {
    const breadth = marketBreadth([-1, -30, -0.2])
    expect(breadth).toMatchObject({ up: 0, down: 3, upShare: 0, at: 0 })
  })

  it('three rising against one falling sits three quarters of the way to green', () => {
    const breadth = marketBreadth([2, 5, 0.5, -3])
    expect(breadth).toMatchObject({ up: 3, down: 1, upShare: 0.75, at: 75 })
  })

  it('an even split sits in the middle', () => {
    expect(marketBreadth([3, -3]).at).toBe(50)
  })

  it('with nothing reported the marker sits in the middle, never NaN, and the silence is counted', () => {
    // Silence is not evidence: an unreported hour is neither a rise nor a fall.
    const breadth = marketBreadth([null, undefined, Number.NaN])
    expect(breadth).toMatchObject({ up: 0, down: 0, flat: 0, unknown: 3, total: 3, upShare: 0.5, at: 50 })
  })

  it('a feed that returns garbage is silence too, not a rise', () => {
    expect(marketBreadth([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toMatchObject({ up: 0, down: 0, unknown: 2, at: 50 })
  })

  it('a token that did not move is counted as flat and does not move the marker', () => {
    const withFlat = marketBreadth([2, -1, 0, 0, 0])
    expect(withFlat).toMatchObject({ flat: 3, total: 5 })
    expect(withFlat.at).toBe(marketBreadth([2, -1]).at)
  })

  it('only flat tokens sit in the middle', () => {
    expect(marketBreadth([0, 0]).at).toBe(50)
  })

  it('counts as rising exactly what the entry door lets in — one definition, never two', () => {
    // *Que la barrera de entrada sea solamente que los tokens suban, como marca
    // la barra de estudio.* The bar and the door read the same predicate.
    const hours = [0.3, 0.0001, 0, -0.1, -5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 40]
    expect(marketBreadth(hours).up).toBe(hours.filter((h) => risingInTheHour(h)).length)
    expect(marketBreadth(hours).up).toBe(3)
  })

  it('an empty universe is the middle, not a crash', () => {
    expect(marketBreadth([])).toMatchObject({ up: 0, down: 0, flat: 0, unknown: 0, total: 0, upShare: 0.5, at: 50 })
  })
})
