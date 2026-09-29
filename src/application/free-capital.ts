import { commonFund } from './ledger.js'
import { capitalForFillsUsd, ladderCapitalUsd } from './paper-run.js'
import { type CascadeParams } from '../domain/strategy/params.js'
import { usdForLevel } from '../domain/strategy/ladder.js'
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
  /**
   * What each rung buys, DCA-1 first, when the rungs are not the reference
   * ladder's own levels — ladder A's $15, $20, $25, $30 and $35. The first buy
   * is still `params`' level 0, the one the allocator sizes a slot with.
   * Absent: every entry is priced as the reference ladder prices it, which is
   * the pressure ladder's single size.
   */
  readonly rungsUsd?: readonly number[]
}

/**
 * The capital `entries` entries need: the first buy plus the first
 * `entries − 1` rungs, through the ONE allowance for gas and price headroom
 * (`capitalForFillsUsd`) that sizes a slot too.
 *
 * With `entries` past the end of the list only what the list holds is priced,
 * because the sweep never buys a rung it has no size for.
 */
export function entriesCapitalUsd(
  params: CascadeParams,
  rungsUsd: readonly number[] | undefined,
  entries: number,
  gasUsdPerSwap: number,
): number {
  if (rungsUsd === undefined) return ladderCapitalUsd(params, entries, gasUsdPerSwap)
  if (entries < 1) return 0
  return capitalForFillsUsd([usdForLevel(params, 0), ...rungsUsd.slice(0, entries - 1)], gasUsdPerSwap)
}

/**
 * Gives a position the capital of one more entry, out of the book's free
 * capital, at the moment its rung fires.
 *
 * A position is allocated its FIRST buy and nothing more (see
 * `DEFAULT_RESERVED_ENTRIES`). Allocating the whole ladder up front held $2,887
 * against $1,395 deployed — half the book parked against rungs that almost
 * never fired. So a rung pays for itself when it happens: the position is
 * raised to what `entries` entries need — the first buy and each rung at its
 * own size (`entriesCapitalUsd`), through the same allowance the allocator
 * sizes a slot with, gas and price headroom included — and the caller builds
 * its broker from the position this returns, because the broker refuses an
 * entry the position's capital cannot cover.
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
    const needs = entriesCapitalUsd(deps.params, deps.rungsUsd, entries, deps.gasUsdPerSwap)
    if (stored.capitalUsd >= needs) return stored

    const extra = needs - stored.capitalUsd
    const free = bookCapital(deps.totalCapitalUsd, await deps.store.allFills(), book).freeUsd
    if (free < extra) return null

    const funded: PersistedPosition = { ...stored, capitalUsd: needs }
    await deps.store.savePosition(funded)
    return funded
  }
}

/**
 * How many more tokens the free capital can take: the free capital over the
 * slot, rounded down. *No pongas tope, el tope son 5000 dividido 50, que es lo
 * que tengo* — and at twenty steps of a dollar, capital / $20.
 *
 * ONE definition, read by the scan (how far to look), the ranking (where to cut)
 * and the allocator (how many to open). Nothing is grossed up and no haircut
 * shrinks the count: a slot is exactly steps × step, and the fees are paid out
 * of the free capital as the fills happen (`fundStepFromFreeCapital`). The free
 * capital already carries the common fund, so what the book made widens it and
 * what the chain took narrows it.
 */
export function freeSlots(book: BookCapital, slotUsd: number): number {
  if (!(slotUsd > 0)) return 0
  // A hair of rounding room, so $5,000 over $20 is 250 and not 249.99….
  return Math.max(0, Math.floor(book.freeUsd / slotUsd + 1e-9))
}

export interface StepFundingDeps {
  readonly store: StatePort
  readonly totalCapitalUsd: number
  /**
   * What the position's wallet has left to spend, as the broker that will fill
   * the step counts it — built from the position's capital and its fills. The
   * composition root hands in the broker's own number, so the funder and the
   * broker cannot disagree about whether a step is affordable.
   */
  readonly cashOf: (position: PersistedPosition) => Promise<number>
}

/**
 * Gives a position what its next step costs beyond the cash it has left, out
 * of the book's free capital, at the moment the step fires.
 *
 * A slot reserves exactly steps × step — $20 — and nothing for the spread, the
 * impact and the gas each $1 buy pays. *Las comisiones salen del capital libre
 * y del fondo común a medida que se ejecutan.* So a step whose cash is short
 * asks the free pool for the shortfall — never the whole step again — and the
 * caller builds its broker from the position this returns.
 *
 * Null when the free capital cannot cover it: the step is not bought, it is
 * said unfunded, and nothing is written. The step is never shrunk to fit.
 *
 * Reads the position from the STORE, never the caller's copy: a sweep holding a
 * snapshot from before an earlier step was funded must neither pay twice nor
 * write the smaller number back over the larger.
 */
export function fundStepFromFreeCapital(
  deps: StepFundingDeps,
): (position: PersistedPosition, costUsd: number) => Promise<PersistedPosition | null> {
  return async (position, costUsd) => {
    const book = await deps.store.loadPositions()
    const stored = book.find((p) => p.id === position.id) ?? position
    const cash = await deps.cashOf(stored)
    if (cash >= costUsd) return stored

    // A hair over the shortfall, so the broker's own float arithmetic never
    // finds the step a thousandth of a cent short.
    const extra = costUsd - cash + 1e-9
    const free = bookCapital(deps.totalCapitalUsd, await deps.store.allFills(), book).freeUsd
    if (free < extra) return null

    const funded: PersistedPosition = { ...stored, capitalUsd: stored.capitalUsd + extra }
    await deps.store.savePosition(funded)
    return funded
  }
}
