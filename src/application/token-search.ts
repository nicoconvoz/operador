import { realisedBySell } from './ledger.js'
import { type OperationsView, type PositionOperations } from './operations-view.js'
import { type UniverseToken } from './universe-view.js'

/**
 * The one search box, and the one answer to "is this the token I typed".
 *
 * *Un buscador del token que funcione para todos los sectores de la página.*
 * Every tab filters by it, and every tab asks HERE: a Universo that found a
 * token by its address while Operaciones only looked at symbols would show the
 * operator two different answers to one question, which is the drift this read
 * model exists to prevent.
 *
 * Pure and free of the DOM, so the client imports it and the tests pin it —
 * the same arrangement as `resultAt` in the day log.
 */

/**
 * The shortest query that is compared against an ADDRESS.
 *
 * A single base58 character appears somewhere in about half of all
 * 44-character addresses, and any given pair in roughly one in eighty. Typing
 * the first letter of a symbol would otherwise light up the whole sky by
 * accident. At three the chance falls to about one in five thousand per token,
 * and a pasted address — or any fragment worth pasting — is far longer.
 */
export const MIN_ADDRESS_QUERY = 3

/**
 * What a row, a body or a card can be recognised by. Every field is optional
 * because each tab knows a different subset: the sky knows the address, a card
 * knows its position id, and a closed position's fill knows only the id.
 */
export interface TokenIdentity {
  readonly symbol?: string | null
  readonly address?: string | null
  /**
   * `chain:address:openedAt`. A fill whose position has closed carries this
   * and nothing else, so the address inside it is how that history is found.
   */
  readonly positionId?: string | null
}

/** What the box holds, trimmed: a pasted address arrives with a newline more often than not. */
export function normaliseTokenQuery(raw: string | null | undefined): string {
  return (raw ?? '').trim()
}

/**
 * Case folded the way a reader folds it. NFKC first, so an accent typed as one
 * character and the same accent typed as a letter plus a combining mark are the
 * same letter — they are, to anybody reading them.
 */
const fold = (text: string): string => text.normalize('NFKC').toLowerCase()

/** The address inside a position id, or null for an id not shaped `chain:address:…`. */
const addressIn = (positionId: string): string | null => {
  const address = positionId.split(':')[1]
  return address ? address : null
}

/**
 * Whether `token` is what `query` is looking for.
 *
 *  - An empty query matches everything, so an idle box hides nothing.
 *  - The SYMBOL matches as a case-insensitive substring: "use" finds USELESS.
 *    A substring, never a pattern — "e/acc" and "." are read literally.
 *  - The ADDRESS matches as a case-SENSITIVE substring, because base58 is: a
 *    fragment in the wrong case names a different address. Only from
 *    `MIN_ADDRESS_QUERY` characters up.
 *  - A position id is searched for the address inside it, never for its chain
 *    or its timestamp, which every position shares — "solana" would otherwise
 *    match the whole book. The whole id pasted in matches too.
 */
export function matchesToken(query: string, token: TokenIdentity): boolean {
  const q = normaliseTokenQuery(query)
  if (q === '') return true
  if (token.symbol && fold(token.symbol).includes(fold(q))) return true

  const positionId = token.positionId ?? null
  if (q.length >= MIN_ADDRESS_QUERY) {
    const addresses = [token.address ?? null, positionId === null ? null : addressIn(positionId)]
    if (addresses.some((address) => address !== null && address.includes(q))) return true
  }
  return positionId === q
}

/** Where names come from: the open book, and the sky. */
export interface SymbolSources {
  readonly positions: readonly Pick<PositionOperations, 'id' | 'symbol' | 'chain'>[]
  /** The sky: what the screen still knows each address by. */
  readonly tokens?: readonly Pick<UniverseToken, 'chain' | 'address' | 'symbol'>[]
}

/**
 * The name a position id is shown and searched under, or null when nobody
 * knows it.
 *
 * A closed position takes its symbol with it — `fills` has no foreign key to
 * `positions`, on purpose, so its history outlives it — and 76 sales at the
 * target in a day make closed positions most of the tape. Searching them by
 * address alone would miss the name the operator actually types.
 *
 * In order: the open position with that id; an open position on the same
 * token, because that is the name the engine bought under; the sky. Keyed by
 * chain AND address, so a token on one chain never names another.
 */
export function knownSymbols(sources: SymbolSources): (positionId: string) => string | null {
  const byId = new Map(sources.positions.map((position) => [position.id, position.symbol]))
  const byToken = new Map<string, string>()
  for (const token of sources.tokens ?? []) byToken.set(`${token.chain}:${token.address}`, token.symbol)
  for (const position of sources.positions) {
    const address = addressIn(position.id)
    if (address !== null) byToken.set(`${position.chain}:${address}`, position.symbol)
  }
  return (positionId) => {
    const own = byId.get(positionId)
    if (own !== undefined) return own
    const address = addressIn(positionId)
    if (address === null) return null
    return byToken.get(`${positionId.split(':')[0]}:${address}`) ?? null
  }
}

/** One line of the Registro: a fill with the name it is shown under and what it made. */
export type TapeRow = OperationsView['recentFills'][number]

export interface TapeSources extends SymbolSources {
  /** The tape the view ships, newest first, already cut by the server. */
  readonly recentFills: readonly TapeRow[]
  /** The open book. Each position carries its WHOLE history, older than any tape. */
  readonly positions: readonly Pick<PositionOperations, 'id' | 'symbol' | 'chain' | 'fills'>[]
}

/**
 * The Registro's rows for a query: filtered FIRST, cut SECOND.
 *
 * Cutting the tape to thirty and then filtering would find a token only while
 * it was among the last thirty fills of the whole book — a search that forgets
 * anything older than a few hours. So the rows are searched across everything
 * the page already holds and only then cut:
 *
 *  - the tape the view ships, which reaches further back than the thirty drawn;
 *  - with a query, every fill of every MATCHING open position, because each
 *    position already carries its whole history. A position opened three days
 *    ago keeps its entry on the screen at no extra cost to the payload.
 *
 * Without a query nothing is merged: the tape is already the newest fills of
 * the whole book, and splicing older open ones into it would draw a gap no
 * reader could see.
 *
 * A CLOSED position's fills are labelled by the server with six characters of
 * address — its symbol left with it. The name the screen still knows for that
 * address, from an open position on the same token or from the sky, is put
 * back, so a search for the name finds the history and the rows say it. An open
 * position's own rows keep the symbol the engine recorded.
 *
 * What a merged sale made is walked by the ledger over that position's fills —
 * the group the server walks for the tape — so the two cannot disagree.
 */
export function searchTape(sources: TapeSources, query: string, limit: number): readonly TapeRow[] {
  const nameOf = knownSymbols(sources)
  const named = (row: TapeRow): TapeRow => {
    const symbol = nameOf(row.positionId)
    return symbol === null || symbol === row.symbol ? row : { ...row, symbol }
  }

  const rows = new Map<string, TapeRow>()
  for (const row of sources.recentFills) rows.set(row.idempotencyKey, row)
  if (normaliseTokenQuery(query) !== '') {
    for (const position of sources.positions) {
      if (!matchesToken(query, { symbol: position.symbol, positionId: position.id })) continue
      const made = realisedBySell(position.fills)
      for (const fill of position.fills) {
        if (rows.has(fill.idempotencyKey)) continue
        rows.set(fill.idempotencyKey, { ...fill, symbol: position.symbol, realisedUsd: made.get(fill.idempotencyKey) ?? null })
      }
    }
  }

  return [...rows.values()]
    .map(named)
    .filter((row) => matchesToken(query, { symbol: row.symbol, positionId: row.positionId }))
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
}
