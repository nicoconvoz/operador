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

export function fillsCsv(
  fills: readonly PersistedFill[],
  symbolFor: (positionId: string) => string | null,
): string {
  const cell = (value: string | number): string => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

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
        cell(fill.positionId),
      ].join(','),
    )

  return ['time,symbol,side,order,price,qty,usd,cost_usd,comment,position_id', ...rows].join('\n')
}
