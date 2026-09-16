import { describe, it, expect } from 'vitest'
import { fillsCsv } from './fills-csv.js'
import { type PersistedFill } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000

const fill = (over: Partial<PersistedFill> = {}): PersistedFill => ({
  positionId: 'p1', orderId: 'Entry', side: 'buy', time: NOW, price: 0.0016426,
  qty: 9130.7, costUsd: 0.05, comment: 'Entry', idempotencyKey: 'k1', ...over,
})

describe('fillsCsv — the tape that does not fit on a phone', () => {
  it('leads with a header, so the file opens as a spreadsheet and not as a puzzle', () => {
    expect(fillsCsv([], () => 'X').split('\n')[0]).toContain('time')
  })

  it('writes newest first, the order the screen shows and the eye expects', () => {
    const csv = fillsCsv([fill({ time: NOW - 1000, orderId: 'old' }), fill({ time: NOW, orderId: 'new' })], () => 'X')
    const [, first] = csv.split('\n')
    expect(first).toContain('new')
  })

  it('carries the symbol, because a position id is not a token to anyone reading this', () => {
    const csv = fillsCsv([fill()], (id) => (id === 'p1' ? 'DREGG' : '?'))
    expect(csv).toContain('DREGG')
  })

  it('writes the price at full precision — a small cap rounds to zero at two decimals', () => {
    // 0.0016426 is a real price from the book. Rendered as "0.00" the file is
    // worse than no file: every row of a micro-cap tape becomes the same number.
    expect(fillsCsv([fill()], () => 'DREGG')).toContain('0.0016426')
  })

  it('quotes a comment that contains a comma instead of inventing a column', () => {
    const csv = fillsCsv([fill({ comment: 'Exit, breakeven' })], () => 'D')
    expect(csv).toContain('"Exit, breakeven"')
  })

  it('names an unknown position rather than writing an empty cell', () => {
    // A closed position leaves the working set and its fills survive it —
    // `fills` deliberately has no foreign key. Those rows are the MAJORITY of
    // the history and must not come out blank.
    expect(fillsCsv([fill({ positionId: 'gone' })], () => null)).toContain('gone')
  })
})
