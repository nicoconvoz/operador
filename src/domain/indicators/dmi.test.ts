import { describe, it, expect } from 'vitest'
import { dmi } from './dmi.js'

describe('dmi — Pine Script ta.dmi parity', () => {
  const n = 40
  const high = Array.from({ length: n }, (_, i) => i + 1)
  const low = Array.from({ length: n }, (_, i) => i)
  const close = Array.from({ length: n }, (_, i) => i + 0.5)

  it('on a pure uptrend +DI is positive and -DI is exactly zero', () => {
    const { plus, minus } = dmi(high, low, close, 3, 3)
    const from = plus.findIndex((v) => v !== null)
    expect(from).toBeGreaterThan(0)
    for (let i = from; i < n; i++) {
      expect(plus[i]!).toBeGreaterThan(0)
      expect(minus[i]).toBe(0)
    }
  })

  it('ADX is exactly 100 on a pure trend', () => {
    // With -DI = 0, DX = |+DI - 0| / +DI = 1 on every bar, so the RMA of DX is
    // 1 from its seed onward and ADX is pinned at 100 — it does not "rise".
    const { adx } = dmi(high, low, close, 3, 3)
    const defined = adx.filter((v): v is number => v !== null)
    expect(defined.length).toBeGreaterThan(10)
    for (const value of defined) expect(value).toBeCloseTo(100, 9)
  })

  it('ADX drops when direction alternates', () => {
    // A zig-zag has +DM and -DM trading places, so |+DI - -DI| shrinks.
    const m = 60
    const zh = Array.from({ length: m }, (_, i) => 10 + (i % 2) * 2)
    const zl = Array.from({ length: m }, (_, i) => 8 + (i % 2) * 2)
    const zc = Array.from({ length: m }, (_, i) => 9 + (i % 2) * 2)
    const { adx } = dmi(zh, zl, zc, 3, 3)
    expect(adx.at(-1)!).toBeLessThan(100)
    expect(adx.at(-1)!).toBeGreaterThanOrEqual(0)
  })

  it('returns three series of input length', () => {
    const out = dmi(high, low, close, 3, 3)
    expect(out.plus).toHaveLength(n)
    expect(out.minus).toHaveLength(n)
    expect(out.adx).toHaveLength(n)
  })
})
