/**
 * Serve a read from memory while its subject cannot have changed.
 *
 * The dashboard polls every ten seconds because that is how often the PROFIT
 * can move — and the profit moves because of the price feed, not because of the
 * database. Everything it was re-reading from Postgres in between changes far
 * more slowly: a scan lands once an hour, a position changes when the engine
 * ticks.
 *
 * What that cost, measured on the live project: each poll pulled the whole
 * universe back as JSONB, roughly 400 KB, 8,640 times a day — about **3.5 GB
 * daily against a 5 GB MONTHLY transfer allowance**. The free tier was spent in
 * thirty-four hours, and when it went the engine's writes went with it.
 *
 * So the cure is not a slower screen. The screen keeps its ten seconds and its
 * live prices; what stops repeating is the question whose answer is the same.
 *
 * Two properties that matter more than the caching:
 *
 *  - **The in-flight promise is shared**, not just the settled value. Several
 *    viewers, or one page asking twice in a frame, otherwise each pay for the
 *    same read and the saving evaporates exactly under load.
 *  - **A failure is never cached.** Remembering "the database was down" for a
 *    minute turns one bad moment into sixty seconds of a blank screen — the
 *    same rule the discovery and history caches already run on.
 */
export function cacheFor<T>(
  read: () => Promise<T>,
  ttlMs: number,
  now: () => number = () => Date.now(),
): () => Promise<T> {
  let pending: Promise<T> | null = null
  let value: { at: number; result: T } | null = null

  return async () => {
    if (value !== null && now() - value.at <= ttlMs) return value.result
    if (pending !== null) return pending

    pending = read()
      .then((result) => {
        value = { at: now(), result }
        return result
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
