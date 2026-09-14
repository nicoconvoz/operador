import { idempotencyKeyFor, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { type Order } from '../domain/strategy/state.js'

/**
 * Crash recovery — the path that decides whether a restart costs money.
 *
 * An unattended engine WILL go down mid-flight: between deciding to buy and
 * seeing the fill, between the fill and the write, in the middle of a ladder.
 * Coming back is not "load the state and continue"; it is answering one
 * question honestly for every pending order:
 *
 *     did this actually happen?
 *
 * Three answers, three different correct actions. Getting them wrong costs a
 * double buy, a lost position, or a silent divergence between what the engine
 * believes and what the wallet holds — and the third is the worst, because it
 * keeps trading on a lie.
 *
 * This module decides. It does not act: it returns a plan, so the decision is
 * testable without a chain.
 */

export type PendingVerdict = 'filled' | 'not-filled' | 'unknown'

/**
 * Answers whether an intended order reached the chain. In production this
 * queries the venue by the client order id; in tests it is a table.
 */
export type OrderProbe = (position: PersistedPosition, order: Order, key: string) => Promise<PendingVerdict>

export interface PendingResolution {
  readonly positionId: string
  readonly order: Order
  readonly key: string
  readonly verdict: PendingVerdict
  readonly action: 'record-and-continue' | 'resubmit' | 'halt'
}

export interface RecoveredPosition {
  readonly position: PersistedPosition
  readonly resolutions: readonly PendingResolution[]
  /** Safe to resume trading this position on the next closed bar. */
  readonly resumable: boolean
}

export interface RecoveryPlan {
  readonly positions: readonly RecoveredPosition[]
  /** Positions that cannot be resumed without a human. */
  readonly halted: readonly RecoveredPosition[]
  /** Tokens the death exit already condemned; never reopened. */
  readonly blacklisted: ReadonlySet<string>
  readonly resumedFromBar: number | null
  readonly killSwitchEngaged: boolean
}

/**
 * Rebuilds the engine's working set from durable state.
 *
 * The rules, in the order they matter:
 *
 *  1. **A recorded fill is the truth.** If the store already has a fill under
 *     the order's idempotency key, the order happened — whatever the engine
 *     believed when it died.
 *  2. **A confirmed miss may be retried.** The venue says it never saw the
 *     order, so resubmitting is safe.
 *  3. **An unknown HALTS the position.** Not "assume filled", not "assume not"
 *     — both guesses are wrong half the time, and being wrong means either
 *     buying twice or holding a position the engine does not know about. A
 *     halted position keeps its state, stops trading, and asks for a human.
 *     An unattended system is allowed to stop; it is not allowed to guess.
 *  4. **A blacklisted token never resumes**, whatever its state says.
 */
export async function planRecovery(store: StatePort, probe: OrderProbe): Promise<RecoveryPlan> {
  const [stored, blacklisted, checkpoint] = await Promise.all([
    store.loadPositions(),
    store.blacklisted(),
    store.loadCheckpoint(),
  ])

  const positions: RecoveredPosition[] = []
  const halted: RecoveredPosition[] = []

  for (const position of stored) {
    if (blacklisted.has(`${position.chain}:${position.tokenAddress}`)) continue

    const resolutions: PendingResolution[] = []
    for (const order of position.pendingOrders) {
      const key = idempotencyKeyFor(position.id, position.lastBarTime, orderKeyPart(order))

      // Rule 1: a recorded fill settles it without asking anyone.
      if (await store.hasFill(key)) {
        resolutions.push({ positionId: position.id, order, key, verdict: 'filled', action: 'record-and-continue' })
        continue
      }

      const verdict = await probe(position, order, key)
      resolutions.push({
        positionId: position.id,
        order,
        key,
        verdict,
        action: verdict === 'filled' ? 'record-and-continue' : verdict === 'not-filled' ? 'resubmit' : 'halt',
      })
    }

    const recovered: RecoveredPosition = {
      position,
      resolutions,
      resumable: !resolutions.some((r) => r.action === 'halt'),
    }
    if (recovered.resumable) positions.push(recovered)
    else halted.push(recovered)
  }

  return {
    positions,
    halted,
    blacklisted,
    resumedFromBar: checkpoint?.lastCompletedBar ?? null,
    killSwitchEngaged: checkpoint?.killSwitchEngaged ?? false,
  }
}

/** `close_all` has no id of its own; its comment identifies which exit it was. */
export const orderKeyPart = (order: Order): string => (order.kind === 'entry' ? order.id : `closeAll:${order.comment}`)
