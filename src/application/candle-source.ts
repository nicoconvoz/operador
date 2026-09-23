import { type Candles } from './replay.js'

/**
 * Ask each source in turn and take the first that ANSWERS.
 *
 * Jupiter's chart endpoint is undocumented — what jup.ag's own site reads —
 * fast, and able to change without notice. Every position's tick depends on
 * candles, so an outage there must not become a blind book; GeckoTerminal
 * stands behind it. When Jupiter answers the fallback is never called, so it
 * costs nothing on a good day.
 *
 * It falls back on a REFUSAL, never on an answer it does not like. An empty
 * series is a fact about the token — nobody traded — and asking another source
 * until one says otherwise would be shopping for a verdict.
 *
 * Null when nobody could answer: silence, which the tick skips, and never an
 * empty series, which the death watch would read as abandonment.
 */
export async function firstThatAnswers(sources: readonly (() => Promise<Candles>)[]): Promise<Candles | null> {
  for (const source of sources) {
    try {
      return await source()
    } catch {
      // Not an answer. The next source is asked.
    }
  }
  return null
}
