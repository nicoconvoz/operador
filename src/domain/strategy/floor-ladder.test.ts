import { describe, it, expect } from 'vitest'
import { nextFloorRung, type FloorLadderPolicy } from './floor-ladder.js'

/**
 * *Agregá 5 escalones de DCA, pero pedí un piso lateral de 5 velas de 1
 * minuto antes de volver a comprar la bajada y promediar. Cada escalón de 15
 * dólares.* The operator.
 */

const policy: FloorLadderPolicy = { maxEntries: 6, gapPct: 5, floorBars: 5 }
const MIN = 60_000

/** One-minute lows, oldest first, starting one minute after the last buy. */
const minutes = (lows: readonly number[], from = 0) => ({
  time: lows.map((_, i) => from + (i + 1) * MIN),
  low: lows,
})

const oneBuy = [{ price: 1, time: 0 }]

describe('nextFloorRung — buy the dip only once it has held a floor', () => {
  it('buys the next rung when the price is 5% under the last buy and five minutes held the low', () => {
    // Fell to 0.94, then five one-minute candles that never went under it.
    expect(nextFloorRung({ buys: oneBuy, priceUsd: 0.945, bars: minutes([0.97, 0.94, 0.942, 0.943, 0.944, 0.941, 0.945]) }, policy)).toBe(1)
  })

  it('waits while it is still making new lows — that is a falling knife, not a floor', () => {
    expect(nextFloorRung({ buys: oneBuy, priceUsd: 0.93, bars: minutes([0.97, 0.96, 0.95, 0.94, 0.935, 0.932, 0.93]) }, policy)).toBeNull()
  })

  it('waits when the floor has held for only four minutes', () => {
    expect(nextFloorRung({ buys: oneBuy, priceUsd: 0.945, bars: minutes([0.97, 0.94, 0.942, 0.943, 0.944, 0.945]) }, policy)).toBeNull()
  })

  it('does not buy a dip shallower than the gap, however flat the floor', () => {
    // A 3% dip with a perfect floor is not a rung: averaging down a hair is
    // paying a round trip for nothing.
    expect(nextFloorRung({ buys: oneBuy, priceUsd: 0.97, bars: minutes([0.98, 0.97, 0.971, 0.972, 0.973, 0.972, 0.971]) }, policy)).toBeNull()
  })

  it('measures the gap from the LAST buy, so each rung needs a new dip', () => {
    const two = [{ price: 1, time: 0 }, { price: 0.95, time: 0 }]
    // 0.94 is 6% under the first buy but only 1% under the second.
    expect(nextFloorRung({ buys: two, priceUsd: 0.94, bars: minutes([0.95, 0.93, 0.935, 0.936, 0.937, 0.938, 0.94]) }, policy)).toBeNull()
    expect(nextFloorRung({ buys: two, priceUsd: 0.9, bars: minutes([0.92, 0.89, 0.895, 0.896, 0.897, 0.898, 0.9]) }, policy)).toBe(2)
  })

  it('only reads the bars AFTER the last buy — the floor is of this dip, not the last one', () => {
    // Bars before the buy at t=10min show a low of 0.5; they are not this dip.
    const buys = [{ price: 1, time: 10 * MIN }]
    const bars = {
      time: [...Array.from({ length: 10 }, (_, i) => (i + 1) * MIN), ...Array.from({ length: 6 }, (_, i) => (11 + i) * MIN)],
      low: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.94, 0.93, 0.925, 0.92, 0.915, 0.91],
    }
    // After the buy it has made a new low every minute: no floor.
    expect(nextFloorRung({ buys, priceUsd: 0.91, bars }, policy)).toBeNull()
  })

  it('stops at the last rung — six entries is the whole ladder', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ price: 1 - i * 0.06, time: 0 }))
    expect(nextFloorRung({ buys: six, priceUsd: 0.5, bars: minutes([0.55, 0.5, 0.51, 0.51, 0.51, 0.51, 0.5]) }, policy)).toBeNull()
  })

  it('buys nothing for a position that holds nothing', () => {
    expect(nextFloorRung({ buys: [], priceUsd: 0.5, bars: minutes([0.55, 0.5, 0.51, 0.51, 0.51, 0.51, 0.5]) }, policy)).toBeNull()
  })

  it('buys nothing when it cannot see the minutes — silence is not a floor', () => {
    expect(nextFloorRung({ buys: oneBuy, priceUsd: 0.9, bars: minutes([]) }, policy)).toBeNull()
  })
})
