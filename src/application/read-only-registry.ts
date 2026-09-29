import { type RememberedToken, type StatePort } from '../domain/persistence/store.js'

type Registry = Pick<StatePort, 'rememberTokens' | 'knownTokens'>

/**
 * The permanent registry, READ ONLY, and read at most once per window.
 *
 * The operator's model of a scan, stated when a cold one fell to ten seconds
 * and he asked for one "a cada rato": *revisás todos los tokens pero descartás
 * toda la info y sólo te quedás con las candidatas; no guardás nada más. En el
 * próximo escaneo te quedás con las próximas candidatas y con las que no han
 * salido, y lo demás lo descartás.* Nothing is stored beyond the candidates and
 * the book.
 *
 * The registry wrote every priced token back on every pass, so that write is
 * gone. The registry itself stays — *esto ojo nunca hay que borrarlo* — and is
 * still READ, because the tokens it remembers widen a universe that is this
 * book's binding constraint. It changes over days, so one read per window,
 * kept in memory, serves a scan every minute or two; a failed read is not kept, so
 * the next scan asks again rather than working from nothing.
 *
 * The cost of not writing, stated: the registry stops learning. What it holds
 * today is what it will hold, and the universe grows only from what the
 * providers list on each pass.
 */
export function readOnlyRegistry(store: Registry, options: { readonly everyMs: number; readonly now?: () => number }): Registry {
  const now = options.now ?? Date.now
  /**
   * What has been read inside the window: the busiest rows, a PREFIX of the
   * registry's own order — and whether the registry ran out under it. A scan
   * reads a page at a time and only while its free slots are short, so the
   * prefix grows only as far as some scan needed.
   */
  let known: { at: number; tokens: RememberedToken[]; complete: boolean } | null = null

  return {
    async knownTokens(limit: number, offset = 0) {
      if (!known || now() - known.at >= options.everyMs) known = { at: now(), tokens: [], complete: false }
      const end = offset + limit
      while (!known.complete && known.tokens.length < end) {
        const want = end - known.tokens.length
        // A failed read leaves the prefix as it was, so the next scan asks again
        // rather than working from nothing.
        const page = await store.knownTokens(want, known.tokens.length)
        known.tokens.push(...page)
        if (!Number.isFinite(want) || page.length < want) known.complete = true
      }
      return known.tokens.slice(offset, end)
    },
    // Nothing is stored beyond the candidates and the book.
    async rememberTokens() {},
  }
}
