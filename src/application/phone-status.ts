import { type StatePort } from '../domain/persistence/store.js'

/**
 * The smallest useful truth about the system, for a phone to poll.
 *
 * Deliberately CHEAP: positions, the checkpoint, and the newest alert
 * sequence. No fills, no P&L, no scan. This runs every minute, forever, on a
 * free-tier database — and the moment it stops being cheap it stops being
 * something you can leave running.
 *
 * P&L is not here on purpose. It is a number you go and LOOK at; the phone
 * poll answers a different question: is the engine alive, is it stopped, and
 * has anything happened that I have not seen.
 */

/**
 * How long a silent engine stays "probably fine".
 *
 * Three missed 15-minute cycles. Long enough that a slow scan or a restart
 * does not cry wolf, short enough that a dead engine is noticed within the
 * hour — and a silently dead engine is the failure that looks exactly like
 * nothing happening.
 */
export const STALE_AFTER_MS = 45 * 60 * 1000

export interface PhoneStatus {
  readonly generatedAt: number
  readonly killSwitchEngaged: boolean
  /** null when the engine has never written a checkpoint. */
  readonly lastEngineUpdate: number | null
  readonly engineStale: boolean
  readonly positions: number
  readonly frozen: number
  /** Newest alert sequence. The app compares it with its own cursor. */
  readonly cursor: number
}

export interface PhoneStatusOptions {
  readonly now: () => number
  readonly staleAfterMs?: number
}

export async function buildPhoneStatus(store: StatePort, options: PhoneStatusOptions): Promise<PhoneStatus> {
  const now = options.now()
  const staleAfter = options.staleAfterMs ?? STALE_AFTER_MS

  const [positions, checkpoint, cursor] = await Promise.all([
    store.loadPositions(),
    store.loadCheckpoint(),
    // One row, from the END of the log. Reading the first page to find the
    // last sequence stalls at the page size and the app silently stops
    // noticing new alerts.
    store.latestAlertSeq(),
  ])

  const lastEngineUpdate = checkpoint?.savedAt ?? null

  return {
    generatedAt: now,
    killSwitchEngaged: checkpoint?.killSwitchEngaged ?? false,
    lastEngineUpdate,
    // An engine that has NEVER checkpointed is stale, not healthy: never
    // having run and running fine are not the same state, and defaulting the
    // unknown one to green is how a dead engine goes unnoticed.
    engineStale: lastEngineUpdate === null || now - lastEngineUpdate > staleAfter,
    positions: positions.length,
    frozen: positions.filter((p) => p.deathWatch.stage === 'frozen').length,
    cursor,
  }
}
