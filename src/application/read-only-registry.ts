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
  let known: { at: number; tokens: readonly RememberedToken[] } | null = null

  return {
    async knownTokens(limit: number) {
      if (known && now() - known.at < options.everyMs) return known.tokens.slice(0, limit)
      const tokens = await store.knownTokens(limit)
      known = { at: now(), tokens }
      return tokens
    },
    // Nothing is stored beyond the candidates and the book.
    async rememberTokens() {},
  }
}
