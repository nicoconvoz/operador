import { type HttpGet } from './http.js'

/**
 * Restart a request that is running slower than this provider normally answers.
 *
 * The operator's rule, and the house rule applied to latency: *measure what it
 * normally delivers over a number of connections, leave a small space in case
 * it takes a little longer, and if it passes that — start it again; if the
 * second one is slow too, move on to the next.*
 *
 * **Not the average.** Half of any sample is above its own mean by definition,
 * so an average cut-off would restart half of everything — doubling the load on
 * a provider exactly when it is struggling, which is the opposite of the point.
 * The base is the SLOWEST answer that recently worked: the upper edge of normal,
 * measured rather than chosen.
 *
 * The margin on top is the one number here, and it is proportional so it scales
 * with whatever the provider turns out to be: a quarter of the base. On a
 * hundred-millisecond API that is 25ms of grace; on a slow one it is seconds.
 * Nothing about it claims to know the provider.
 *
 * It replaces a fixed 20-second timeout that was invented and never checked.
 * That number is wrong in both directions at once, like every constant this
 * codebase has had to walk back: forever on an API that answers in 80ms, and
 * too soon on one having a bad afternoon.
 *
 * Two properties that keep it from making things worse:
 *
 *  - **It never judges without a history.** Nothing is slower than nothing, and
 *    a first request must not be abandoned for exceeding a shape nobody has
 *    measured yet.
 *  - **It restarts ONCE.** A second slow answer is the provider telling us
 *    about itself rather than one unlucky connection, and retrying into that is
 *    how a scan turns into an afternoon.
 */
const SAMPLES = 20
/** A quarter of the measured base — "a little longer" without pretending to know how much. */
const GRACE = 1.25

export function makeHedgedGet(
  inner: HttpGet,
  options: { readonly now?: () => number; readonly samples?: number } = {},
): HttpGet {
  const now = options.now ?? Date.now
  const keep = options.samples ?? SAMPLES
  const recent: number[] = []

  const record = (ms: number) => {
    recent.push(ms)
    if (recent.length > keep) recent.shift()
  }

  return async (url, init) => {
    // Nothing to be slower THAN until the provider has shown its shape.
    const limit = recent.length < keep ? Number.POSITIVE_INFINITY : Math.max(...recent) * GRACE

    for (let attempt = 0; ; attempt++) {
      const startedAt = now()
      const response = await inner(url, init)
      const took = now() - startedAt
      if (took <= limit) {
        // Only SUCCESSES shape the baseline. A rate-limited refusal comes back
        // fast and would drag the measurement down, making every real answer
        // look like an outlier.
        if (response.status === 200) record(took)
        return response
      }
      if (attempt >= 1) {
        throw new Error(`${url} took ${Math.round(took)}ms twice, past ${Math.round(limit)}ms — moving on`)
      }
    }
  }
}
