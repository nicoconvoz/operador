import { describe, it, expect } from 'vitest'
import { fillsCsv, fillsInRange } from './fills-csv.js'
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

describe('fillsInRange — a date the operator picked, not a timestamp they guessed', () => {
  const DAY = 86_400_000
  const on = (iso: string) => fill({ time: Date.parse(iso), idempotencyKey: iso })

  it('keeps everything when neither end is given', () => {
    expect(fillsInRange([on('2026-09-01T10:00:00Z'), on('2026-09-10T10:00:00Z')], null, null)).toHaveLength(2)
  })

  it('includes the whole of the LAST day, not just its first instant', () => {
    // A date picker hands over "2026-09-10", which parses to midnight. Read
    // literally, asking for the 1st to the 10th returns nothing from the 10th —
    // and the operator, who asked for a day they can see on screen, gets a file
    // that silently omits it. The most recent day is the one they most wanted.
    const kept = fillsInRange([on('2026-09-10T18:30:00Z')], null, Date.parse('2026-09-10T00:00:00Z'))
    expect(kept).toHaveLength(1)
  })

  it('includes the whole of the first day too', () => {
    expect(fillsInRange([on('2026-09-01T00:00:01Z')], Date.parse('2026-09-01T00:00:00Z'), null)).toHaveLength(1)
  })

  it('drops what falls outside at either end', () => {
    const fills = [on('2026-08-31T23:00:00Z'), on('2026-09-05T12:00:00Z'), on('2026-09-11T01:00:00Z')]
    const kept = fillsInRange(fills, Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-09-10T00:00:00Z'))
    expect(kept.map((f) => f.idempotencyKey)).toEqual(['2026-09-05T12:00:00Z'])
  })

  it('returns nothing rather than everything when the range is backwards', () => {
    // A reversed range is a mistake, and the two ways to be wrong are not
    // equal: an empty file says "check the dates" while a full one says
    // "here is what you asked for" about something nobody asked for.
    const kept = fillsInRange([on('2026-09-05T12:00:00Z')], Date.parse('2026-09-10T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'))
    expect(kept).toHaveLength(0)
  })
})
