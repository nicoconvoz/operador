import { describe, it, expect } from 'vitest'
import { fillsCsv, fillsForToken, fillsInRange, tokenFileTag } from './fills-csv.js'
import { type PersistedFill } from '../domain/persistence/store.js'

const NOW = 1_800_000_000_000
const chr10 = () => String.fromCharCode(10)

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

  it('carries what each SALE made, because a tape of trades that hides the result is half a record', () => {
    const csv = fillsCsv(
      [fill({ side: 'buy', price: 0.01, qty: 1_000, time: NOW - 1000, idempotencyKey: 'b' }),
       fill({ side: 'sell', price: 0.012, qty: 1_000, time: NOW, idempotencyKey: 's' })],
      () => 'D',
    )
    expect(csv.split(chr10())[0]).toContain('realised_usd')
    // Bought 1,000 at 0.01 and sold them at 0.012 → +$2.
    expect(csv).toContain('2.0000')
  })

  it('leaves the result blank on a BUY rather than writing a zero', () => {
    // A zero reads as a trade that broke even. A purchase has made nothing yet,
    // which is a different statement and the file has to keep them apart.
    const csv = fillsCsv([fill({ side: 'buy', idempotencyKey: 'b' })], () => 'D')
    const [header, row] = csv.split(chr10())
    const column = header!.split(',').indexOf('realised_usd')
    expect(row!.split(',')[column]).toBe('')
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

describe('fillsForToken — the download follows the search box', () => {
  const MINT = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8MxYzT'
  const OTHER = 'HqT4v7WcRkN2pZs8LmXy3fGjBd6eKaU1oVi9tPrQwEhC'
  const mine = `solana:${MINT}:7`
  const theirs = `solana:${OTHER}:1`
  const symbols = new Map([[mine, 'USELESS'], [theirs, 'BONK']])
  const symbolFor = (id: string) => symbols.get(id) ?? null
  const book = [
    fill({ positionId: mine, side: 'buy', price: 0.01, qty: 1_000, time: NOW - 2000, idempotencyKey: 'b' }),
    fill({ positionId: theirs, side: 'buy', time: NOW - 1500, idempotencyKey: 'x' }),
    fill({ positionId: mine, side: 'sell', price: 0.012, qty: 1_000, time: NOW - 1000, idempotencyKey: 's' }),
  ]

  it('keeps every fill when no token is asked for, blank or absent', () => {
    expect(fillsForToken(book, '', symbolFor)).toHaveLength(3)
    expect(fillsForToken(book, '   ', symbolFor)).toHaveLength(3)
  })

  it('keeps only the fills of the token whose symbol matches, in any case', () => {
    expect(fillsForToken(book, 'use', symbolFor).map((f) => f.idempotencyKey)).toEqual(['b', 's'])
  })

  it('finds a closed position — no symbol left — by the address in its id', () => {
    const kept = fillsForToken(book, 'Q9NzkBcCsu', () => null)
    expect(kept.map((f) => f.idempotencyKey)).toEqual(['b', 's'])
  })

  it('keeps a position whole, so what each sale made is still walked from its own buys', () => {
    // Bought 1,000 at 0.01 and sold them at 0.012 → +$2, as in the unfiltered file.
    expect(fillsCsv(fillsForToken(book, 'useless', symbolFor), symbolFor)).toContain('2.0000')
  })

  it('composes with the date range: both apply, and neither widens the other', () => {
    const DAY = 86_400_000
    const inRange = fillsInRange(book, NOW - 1200, null)
    expect(fillsForToken(inRange, 'use', symbolFor).map((f) => f.idempotencyKey)).toEqual(['s'])
    expect(fillsForToken(fillsInRange(book, NOW + DAY, null), 'use', symbolFor)).toHaveLength(0)
  })

  it('returns nothing, not everything, when no token matches', () => {
    expect(fillsForToken(book, 'nothing-like-this', symbolFor)).toHaveLength(0)
  })
})

describe('tokenFileTag — the file says which token it holds', () => {
  it('is empty when no token is asked for', () => {
    expect(tokenFileTag('')).toBe('')
    expect(tokenFileTag('  ')).toBe('')
  })

  it('keeps a symbol or a whole address as it is', () => {
    expect(tokenFileTag('USELESS')).toBe('USELESS')
    const address = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8MxYzT'
    expect(tokenFileTag(address)).toBe(address)
  })

  it('replaces whatever a header or a file system would choke on', () => {
    // A quote or a line break in content-disposition is a broken header, and
    // a slash is a folder on half the systems the file lands on.
    expect(tokenFileTag('e/acc')).toBe('e_acc')
    expect(tokenFileTag('a"b' + chr10() + 'c')).toBe('a_b_c')
  })

  it('says "token" when nothing printable is left', () => {
    expect(tokenFileTag('🐸')).toBe('token')
  })

  it('is never longer than an address', () => {
    expect(tokenFileTag('A'.repeat(80))).toHaveLength(44)
  })
})
