import { describe, it, expect } from 'vitest'
import { knownSymbols, matchesToken, normaliseTokenQuery, searchTape, type TapeRow, type TapeSources } from './token-search.js'
import { type PersistedFill } from '../domain/persistence/store.js'

// Base58, 44 characters, and no dictionary word inside: a fixture address that
// happened to end in "bonk" would make a symbol search find it by address.
const MINT = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8MxYzT'
const OTHER_MINT = 'HqT4v7WcRkN2pZs8LmXy3fGjBd6eKaU1oVi9tPrQwEhC'
const USELESS = { symbol: 'USELESS', address: MINT }

describe('normaliseTokenQuery — what the box holds, before anything is compared', () => {
  it('trims the query, because a pasted address arrives with a newline more often than not', () => {
    expect(normaliseTokenQuery(`  ${MINT}\n`)).toBe(MINT)
  })

  it('reads an absent query as empty', () => {
    expect(normaliseTokenQuery(null)).toBe('')
    expect(normaliseTokenQuery(undefined)).toBe('')
  })
})

describe('matchesToken — one definition of "is this the token I am looking for"', () => {
  it('an empty or blank query matches every token, so an idle box hides nothing', () => {
    for (const query of ['', '   ', '\n\t']) expect(matchesToken(query, USELESS)).toBe(true)
    expect(matchesToken('', {})).toBe(true)
  })

  it('matches the symbol as a case-insensitive substring: "use" finds USELESS', () => {
    for (const query of ['use', 'USE', 'eless', 'UsElEsS', '  use  ']) expect(matchesToken(query, USELESS)).toBe(true)
  })

  it('does not match a symbol that does not contain the query', () => {
    expect(matchesToken('bonk', USELESS)).toBe(false)
  })

  it('reads punctuation literally, never as a pattern: "e/acc" finds e/acc', () => {
    const eacc = { symbol: 'e/acc' }
    for (const query of ['e/acc', 'E/ACC', '/acc']) expect(matchesToken(query, eacc)).toBe(true)
    // A regular expression would read "." as any character and find both.
    expect(matchesToken('e.acc', eacc)).toBe(false)
    expect(matchesToken('.', USELESS)).toBe(false)
  })

  it('folds case beyond ASCII, so accented and Cyrillic symbols are found in lowercase', () => {
    expect(matchesToken('ñandú', { symbol: 'ÑANDÚ' })).toBe(true)
    expect(matchesToken('пепе', { symbol: 'ПЕПЕ' })).toBe(true)
  })

  it('finds an emoji symbol by its emoji', () => {
    expect(matchesToken('🐸', { symbol: '🐸FROG' })).toBe(true)
  })

  it('treats a composed and a decomposed accent as the same letter', () => {
    // "É" typed on one keyboard and "E" + combining acute on another are the
    // same letter to anybody reading them.
    expect(matchesToken('é', { symbol: 'CAFÉ' })).toBe(true)
    expect(matchesToken('é', { symbol: 'CAFÉ' })).toBe(true)
  })

  it('finds a token by a pasted full address', () => {
    expect(matchesToken(MINT, USELESS)).toBe(true)
    expect(matchesToken(MINT, { symbol: 'X', address: OTHER_MINT })).toBe(false)
  })

  it('finds a token by part of its address', () => {
    expect(matchesToken('9NzkBc', USELESS)).toBe(true)
  })

  it('matches the address case-SENSITIVELY, because base58 is', () => {
    // Lowercased, this fragment names a different address.
    expect(matchesToken('9nzkbc', USELESS)).toBe(false)
  })

  it('does not match an address on one or two characters, where nearly every address would', () => {
    // A single base58 character appears somewhere in about half of all 44-character
    // addresses; typing the first letter of a symbol must not light up the sky.
    expect(matchesToken('Dz', USELESS)).toBe(false)
    expect(matchesToken('Dz9', USELESS)).toBe(true)
  })

  it('finds a closed position by the address inside its id', () => {
    const closed = { symbol: null, positionId: `solana:${MINT}:1727000000000` }
    expect(matchesToken('9NzkBc', closed)).toBe(true)
    expect(matchesToken(MINT, closed)).toBe(true)
  })

  it('never matches a position id on its chain or its timestamp, which every position shares', () => {
    const closed = { positionId: `solana:${MINT}:1727000000000` }
    expect(matchesToken('solana', closed)).toBe(false)
    expect(matchesToken('1727', closed)).toBe(false)
  })

  it('finds a position by its whole id pasted in, even one that is not shaped chain:address:at', () => {
    expect(matchesToken(`solana:${MINT}:1727000000000`, { positionId: `solana:${MINT}:1727000000000` })).toBe(true)
    expect(matchesToken('pos-DREGG', { positionId: 'pos-DREGG' })).toBe(true)
  })

  it('a token with nothing to match on matches only the empty query', () => {
    expect(matchesToken('x', {})).toBe(false)
    expect(matchesToken('x', { symbol: null, address: null, positionId: null })).toBe(false)
  })
})

describe('knownSymbols — the name a position id is shown and searched under', () => {
  const held = { id: `solana:${MINT}:9`, chain: 'solana', symbol: 'USELESS' }

  it('an open position is named by its own symbol', () => {
    expect(knownSymbols({ positions: [held] })(held.id)).toBe('USELESS')
  })

  it('a closed position is named by an open position on the same token', () => {
    expect(knownSymbols({ positions: [held] })(`solana:${MINT}:3`)).toBe('USELESS')
  })

  it('or by the sky, when nothing is held on it', () => {
    const name = knownSymbols({ positions: [], tokens: [{ chain: 'solana', address: MINT, symbol: 'e/acc' }] })
    expect(name(`solana:${MINT}:3`)).toBe('e/acc')
  })

  it('our own position outranks the sky: it is the name the engine bought under', () => {
    const name = knownSymbols({ positions: [held], tokens: [{ chain: 'solana', address: MINT, symbol: 'RENAMED' }] })
    expect(name(`solana:${MINT}:3`)).toBe('USELESS')
  })

  it('is null when nobody knows the address, or the id carries none', () => {
    const name = knownSymbols({ positions: [held] })
    expect(name(`solana:${OTHER_MINT}:3`)).toBeNull()
    expect(name('pos-DREGG')).toBeNull()
  })

  it('never names an address on one chain after a token on another', () => {
    const name = knownSymbols({ positions: [], tokens: [{ chain: 'bsc', address: MINT, symbol: 'X' }] })
    expect(name(`solana:${MINT}:3`)).toBeNull()
  })
})

describe('searchTape — the Registro rows, filtered BEFORE they are cut', () => {
  const HOUR = 3_600_000
  const T0 = 1_800_000_000_000

  const fill = (over: Partial<PersistedFill> = {}): PersistedFill => ({
    positionId: `solana:${OTHER_MINT}:1`, orderId: 'Entry', side: 'buy', time: T0, price: 1, qty: 1,
    costUsd: 0.01, comment: '🟢 Entry', idempotencyKey: `k${over.time ?? T0}`, ...over,
  })
  const row = (over: Partial<TapeRow> = {}): TapeRow => ({
    ...fill(over), symbol: 'OTHER', realisedUsd: null, ...over,
  })
  const sources = (over: Partial<TapeSources> = {}): TapeSources => ({ recentFills: [], positions: [], ...over })

  it('with no query it is the newest rows, newest first, cut to the limit', () => {
    const tape = Array.from({ length: 40 }, (_, i) => row({ time: T0 - i * HOUR, idempotencyKey: `k${i}` }))
    const rows = searchTape(sources({ recentFills: tape }), '', 30)
    expect(rows).toHaveLength(30)
    expect(rows[0]!.idempotencyKey).toBe('k0')
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.time >= r.time)).toBe(true)
  })

  it('filters before the cut, so a token’s fill behind thirty newer ones is still found', () => {
    const others = Array.from({ length: 60 }, (_, i) => row({ time: T0 - i * HOUR, idempotencyKey: `o${i}` }))
    const old = row({ positionId: `solana:${MINT}:7`, symbol: 'USELESS', time: T0 - 80 * HOUR, idempotencyKey: 'useless' })
    const rows = searchTape(sources({ recentFills: [...others, old] }), 'use', 30)
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['useless'])
  })

  it('cuts to the limit AFTER filtering', () => {
    const tape = Array.from({ length: 40 }, (_, i) =>
      row({ positionId: `solana:${MINT}:7`, symbol: 'USELESS', time: T0 - i * HOUR, idempotencyKey: `u${i}` }),
    )
    expect(searchTape(sources({ recentFills: tape }), 'useless', 30)).toHaveLength(30)
  })

  it('finds an OPEN position’s fills older than the tape, from the position’s own history', () => {
    const id = `solana:${MINT}:7`
    const buy = fill({ positionId: id, side: 'buy', price: 1, qty: 100, time: T0 - 90 * HOUR, idempotencyKey: 'b' })
    const sell = fill({ positionId: id, side: 'sell', orderId: 'Entry', price: 1.5, qty: 40, time: T0 - 89 * HOUR, idempotencyKey: 's', comment: '🏁 Exit' })
    const rows = searchTape(
      sources({
        recentFills: [row({ time: T0, idempotencyKey: 'newer' })],
        positions: [{ id, symbol: 'USELESS', chain: 'solana', fills: [sell, buy] }],
      }),
      'useless',
      30,
    )
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['s', 'b'])
    expect(rows.every((r) => r.symbol === 'USELESS')).toBe(true)
    // What the sale MADE, walked by the ledger exactly as the server walks the
    // tape: 40 sold at 1.5 against an average of 1.
    expect(rows[0]!.realisedUsd).toBeCloseTo(20, 10)
    expect(rows[1]!.realisedUsd).toBeNull()
  })

  it('never lists a fill twice when it is both on the tape and in an open position’s history', () => {
    const id = `solana:${MINT}:7`
    const buy = fill({ positionId: id, time: T0, idempotencyKey: 'b' })
    const rows = searchTape(
      sources({
        recentFills: [{ ...buy, symbol: 'USELESS', realisedUsd: null }],
        positions: [{ id, symbol: 'USELESS', chain: 'solana', fills: [buy] }],
      }),
      'useless',
      30,
    )
    expect(rows).toHaveLength(1)
  })

  it('finds a CLOSED position’s fills by the address in its position id', () => {
    const gone = row({ positionId: `solana:${MINT}:3`, symbol: MINT.slice(0, 6), idempotencyKey: 'gone' })
    expect(searchTape(sources({ recentFills: [gone, row()] }), 'Q9NzkBcCsu', 30).map((r) => r.idempotencyKey)).toEqual(['gone'])
  })

  it('finds a CLOSED position’s fills by the symbol the screen still knows for its address, and names them with it', () => {
    // A position sold at its target leaves the book, and the tape then labels
    // its fills with six characters of address. The universe may still know
    // the token by name — and a search for the name must find its history.
    const gone = row({ positionId: `solana:${MINT}:3`, symbol: MINT.slice(0, 6), idempotencyKey: 'gone' })
    const rows = searchTape(
      sources({ recentFills: [gone, row()], tokens: [{ chain: 'solana', address: MINT, symbol: 'e/acc' }] }),
      'E/ACC',
      30,
    )
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['gone'])
    expect(rows[0]!.symbol).toBe('e/acc')
  })

  it('names a closed position by an OPEN position on the same token when the universe has forgotten it', () => {
    const gone = row({ positionId: `solana:${MINT}:3`, symbol: MINT.slice(0, 6), time: T0 - HOUR, idempotencyKey: 'gone' })
    const rows = searchTape(
      sources({ recentFills: [gone], positions: [{ id: `solana:${MINT}:9`, symbol: 'USELESS', chain: 'solana', fills: [] }] }),
      'useless',
      30,
    )
    expect(rows.map((r) => [r.idempotencyKey, r.symbol])).toEqual([['gone', 'USELESS']])
  })

  it('keeps an open position’s own symbol on its rows', () => {
    const id = `solana:${MINT}:7`
    const rows = searchTape(
      sources({
        recentFills: [row({ positionId: id, symbol: 'USELESS', idempotencyKey: 'mine' })],
        positions: [{ id, symbol: 'USELESS', chain: 'solana', fills: [] }],
        tokens: [{ chain: 'solana', address: MINT, symbol: 'RENAMED' }],
      }),
      '',
      30,
    )
    expect(rows[0]!.symbol).toBe('USELESS')
  })

  it('returns nothing when nothing matches', () => {
    expect(searchTape(sources({ recentFills: [row()] }), 'nothing-like-this', 30)).toEqual([])
  })
})
