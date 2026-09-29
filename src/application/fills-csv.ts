import { realisedBySell } from './ledger.js'
import { matchesToken, normaliseTokenQuery } from './token-search.js'
import { type PersistedFill } from '../domain/persistence/store.js'

/**
 * Every fill ever recorded, as a file.
 *
 * The tape on screen is capped — ten rows, because a phone showing every buy
 * and sell since the engine started is a phone showing none of them. But the
 * history is the audit trail and the only complete record of what the system
 * actually did, so it has to be reachable in full. Capping the screen without
 * offering the rest would be deleting it from the operator's view.
 *
 * CSV rather than JSON: this is a table people open in a spreadsheet and sort.
 *
 * Two details that matter more than they look:
 *
 *  - **Full precision on the price.** These are micro-caps: 0.0016426 rendered
 *    at two decimals is 0.00, and a whole tape of 0.00 is worse than no file.
 *  - **An unknown position is NAMED, not blanked.** `fills` deliberately has no
 *    foreign key to `positions`, because a closed position leaves the working
 *    set and its history must survive it. Those rows are most of the file.
 */

/** A day in milliseconds — what a date picker's value is worth on the clock. */
const DAY_MS = 86_400_000

/**
 * The fills between two dates, both ends INCLUSIVE of their whole day.
 *
 * A date picker hands over `2026-09-10`, which parses to midnight. Read
 * literally, "from the 1st to the 10th" returns nothing at all from the 10th —
 * and the operator, who picked a day they can see on the screen, gets a file
 * that silently omits it. The most recent day is the one they most wanted.
 *
 * A backwards range returns NOTHING rather than everything. The two ways of
 * being wrong are not equal: an empty file says "check the dates", a full one
 * says "here is what you asked for" about something nobody asked for.
 */
export function fillsInRange(
  fills: readonly PersistedFill[],
  from: number | null,
  to: number | null,
): readonly PersistedFill[] {
  const start = from ?? Number.NEGATIVE_INFINITY
  // The END of the chosen day, not its beginning.
  const end = to === null ? Number.POSITIVE_INFINITY : to + DAY_MS - 1
  if (start > end) return []
  return fills.filter((fill) => fill.time >= start && fill.time <= end)
}

/**
 * The fills of the token the search box holds, or all of them when it is empty.
 *
 * The same matcher every tab uses, so the file and the screen cannot disagree
 * about which token was asked for. A position is kept or dropped WHOLE — every
 * fill of one position shares its id — so what each sale made is still walked
 * from its own buys, exactly as in the unfiltered file.
 *
 * `symbolFor` names a position, including one that has closed; the address
 * inside its id finds it either way.
 */
export function fillsForToken(
  fills: readonly PersistedFill[],
  query: string,
  symbolFor: (positionId: string) => string | null,
): readonly PersistedFill[] {
  if (normaliseTokenQuery(query) === '') return fills
  return fills.filter((fill) => matchesToken(query, { symbol: symbolFor(fill.positionId), positionId: fill.positionId }))
}

/** A base58 address, the longest thing worth naming a file after. */
const TAG_MAX = 44

/**
 * The token searched for, fit for a file name: empty when there is none.
 *
 * It goes into `content-disposition`, where a quote or a line break is a
 * broken header rather than a strange name, and onto a disk where a slash is a
 * folder. So anything beyond letters, digits, dot, dash and underscore becomes
 * an underscore, and a query with nothing printable left — an emoji symbol —
 * says "token" rather than nothing.
 */
export function tokenFileTag(query: string): string {
  const q = normaliseTokenQuery(query)
  if (q === '') return ''
  const tag = q.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, TAG_MAX)
  return tag === '' ? 'token' : tag
}

export function fillsCsv(
  fills: readonly PersistedFill[],
  symbolFor: (positionId: string) => string | null,
): string {
  const cell = (value: string | number): string => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  // What each SALE made, walked from the same fills. A tape of trades that
  // hides the result is half a record — and the walk is the ledger's own, so
  // the file cannot disagree with the screen about a number they both show.
  const made = realisedBySell(fills)

  const rows = [...fills]
    .sort((a, b) => b.time - a.time)
    .map((fill) =>
      [
        new Date(fill.time).toISOString(),
        cell(symbolFor(fill.positionId) ?? fill.positionId),
        fill.side,
        cell(fill.orderId),
        fill.price,
        fill.qty,
        (fill.price * fill.qty).toFixed(4),
        fill.costUsd,
        cell(fill.comment ?? ''),
        // BLANK on a buy, never zero: a zero reads as a trade that broke even,
        // and a purchase has made nothing YET. Those are different statements.
        made.has(fill.idempotencyKey) ? made.get(fill.idempotencyKey)!.toFixed(4) : '',
        cell(fill.positionId),
      ].join(','),
    )

  return ['time,symbol,side,order,price,qty,usd,cost_usd,comment,realised_usd,position_id', ...rows].join('\n')
}
