import { type Throttle } from './http.js'

/**
 * A pace the PROVIDER sets, instead of a number we guessed.
 *
 * Every throttle in this codebase was a constant somebody chose: GoPlus at
 * 2,000ms, Jupiter at 1,100, GeckoTerminal at 2,500. A constant is a claim
 * about somebody else's quota, and it is wrong in both directions at once —
 * too slow against a provider that never pushes back (GoPlus reported **zero
 * rejections and zero waiting** across a hundred calls in a measured scan), and
 * too fast on the day one does, because a quota shared with every other job on
 * a CI runner's IP is not ours to budget.
 *
 * The operator's rule: *do not put a limit on it. Let the answer take as long
 * as it takes — a little more, a little less — and let that be the time.*
 *
 * So it starts at NO wait and only slows down when told to. A 429 is the
 * provider saying the pace out loud; nothing else is evidence about it.
 *
 * Three properties, and the third is the one that makes it safe to start at
 * zero:
 *
 *  - **It backs off harder the more it is refused.** One step would be another
 *    guess; doubling finds the level without anybody choosing it.
 *  - **It speeds back up when the refusals stop.** Otherwise one bad minute
 *    costs the rest of the hour, which is the failure a fixed interval has
 *    permanently.
 *  - **It has a ceiling.** A provider that refuses everything must not be able
 *    to hang a scan indefinitely — and the caller's own deadline is what
 *    decides to give up, not this.
 */
export interface AdaptiveThrottle extends Throttle {
  /** The provider refused: it is telling us the pace. */
  pushedBack(): void
  /** A clean answer. Enough of them and the pace relaxes again. */
  wentThrough(): void
}

/** Where the first backoff lands. Doubling from here finds the rest. */
const FIRST_BACKOFF_MS = 250
/** Never wait longer than this between calls, whatever the provider says. */
const MAX_INTERVAL_MS = 10_000
/** Clean answers needed before the pace relaxes one step. */
const CLEAN_RUN = 10

export function makeAdaptiveThrottle(options: {
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
} = {}): AdaptiveThrottle {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  let intervalMs = 0
  let clean = 0
  let lastAt = -Infinity

  return {
    async wait() {
      const pause = lastAt + intervalMs - now()
      if (pause > 0) await sleep(pause)
      lastAt = now()
    },
    pushedBack() {
      clean = 0
      intervalMs = Math.min(intervalMs === 0 ? FIRST_BACKOFF_MS : intervalMs * 2, MAX_INTERVAL_MS)
    },
    wentThrough() {
      if (intervalMs === 0) return
      clean += 1
      if (clean < CLEAN_RUN) return
      clean = 0
      // Halve rather than drop to zero: the provider just told us it has a
      // limit, and forgetting that entirely would re-learn it the hard way on
      // the very next burst.
      intervalMs = intervalMs <= FIRST_BACKOFF_MS ? 0 : Math.floor(intervalMs / 2)
    },
  }
}
