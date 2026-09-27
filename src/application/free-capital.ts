import { commonFund } from './ledger.js'
import { ladderCapitalUsd } from './paper-run.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { type PersistedFill, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'

/**
 * What the book holds, what it has handed out, and what is left.
 *
 * ONE definition, and it has two callers that must never disagree: the
 * allocator, which opens new positions with what is free, and the sweep, which
 * asks the same pool for a rung's capital the moment the rung fires. Two copies
 * of "how much is free" is how a book spends the same dollar twice — once on a
 * new token and once on a rung — and the one that wins the race is whichever
 * happened to run first.
 *
 * `totalUsd` is the configured capital plus the common fund — what the system
 * has MADE, net of every cost, from every fill ever recorded. `committedUsd` is
 * the capital allocated to the open positions, halted ones included: capital
 * belonging to a position nobody can reconcile is not capital to spend.
 */
export interface BookCapital {
  readonly totalUsd: number
  readonly committedUsd: number
  /** Never negative: an over-committed book has nothing free, not a debt. */
  readonly freeUsd: number
}

export function bookCapital(
  totalCapitalUsd: number,
  allFills: readonly PersistedFill[],
  committed: readonly { readonly capitalUsd: number }[],
): BookCapital {
  const totalUsd = totalCapitalUsd + commonFund(allFills).netUsd
  const committedUsd = committed.reduce((sum, p) => sum + p.capitalUsd, 0)
  return { totalUsd, committedUsd, freeUsd: Math.max(0, totalUsd - committedUsd) }
}

export interface RungFundingDeps {
  readonly store: StatePort
  readonly totalCapitalUsd: number
  /** The production ladder: what a rung costs, and so what one more entry needs. */
  readonly params: CascadeParams
  readonly gasUsdPerSwap: number
}

/**
 * Gives a position the capital of one more entry, out of the book's free
 * capital, at the moment its rung fires.
 *
 * A position is allocated its FIRST buy and nothing more (see
 * `DEFAULT_RESERVED_ENTRIES`). Allocating the whole ladder up front held $2,887
 * against $1,395 deployed — half the book parked against rungs that almost
 * never fired. So a rung pays for itself when it happens: the position is
 * raised to what `entries` entries need — the same `ladderCapitalUsd` the
 * allocator sizes a slot with, gas and price headroom included — and the
 * caller builds its broker from the position this returns, because the broker
 * refuses an entry the position's capital cannot cover.
 *
 * Null when the free capital cannot cover it: the rung waits for the next
 * sweep, and nothing is written.
 *
 * **The capital is read from the STORE, never from the caller's copy.** Every
 * step of a cycle carries a snapshot, and this project has paid more than once
 * for a stale one written back over a fresher row: the trim reverted every
 * ladder to its first rung that way. A sweep holding a copy from before a rung
 * was funded must neither pay for that rung twice nor write the smaller number
 * back over the larger one.
 *
 * Only ever RAISES. A position that can already pay for the rung is returned as
 * the store has it; lowering capital is the cycle's trim, which knows what is
 * deployed.
 */
export function fundRungsFromFreeCapital(
  deps: RungFundingDeps,
): (position: PersistedPosition, entries: number) => Promise<PersistedPosition | null> {
  return async (position, entries) => {
    const book = await deps.store.loadPositions()
    const stored = book.find((p) => p.id === position.id) ?? position
    const needs = ladderCapitalUsd(deps.params, entries, deps.gasUsdPerSwap)
    if (stored.capitalUsd >= needs) return stored

    const extra = needs - stored.capitalUsd
    const free = bookCapital(deps.totalCapitalUsd, await deps.store.allFills(), book).freeUsd
    if (free < extra) return null

    const funded: PersistedPosition = { ...stored, capitalUsd: needs }
    await deps.store.savePosition(funded)
    return funded
  }
}
