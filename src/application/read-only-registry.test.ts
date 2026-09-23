import { describe, it, expect } from 'vitest'
import { readOnlyRegistry } from './read-only-registry.js'
import { type RememberedToken } from '../domain/persistence/store.js'

/**
 * *Revisás todos los tokens pero descartás toda la info y sólo te quedás con
 * las candidatas; no guardás nada más.* The operator's model, when a cold scan
 * fell to ten seconds and he asked for one "a cada rato".
 */

const token = (contract: string): RememberedToken => ({ contract, token: contract } as RememberedToken)

const rig = () => {
  let clock = 0
  let reads = 0
  const writes: number[] = []
  const store = {
    knownTokens: async () => { reads++; return [token('A'), token('B')] },
    rememberTokens: async (tokens: readonly RememberedToken[]) => { writes.push(tokens.length) },
  }
  const registry = readOnlyRegistry(store, { everyMs: 15 * 60_000, now: () => clock })
  return { registry, advance: (ms: number) => { clock += ms }, reads: () => reads, writes }
}

describe('readOnlyRegistry — nothing is stored beyond the candidates and the book', () => {
  it('never writes, however many tokens a scan priced', async () => {
    const { registry, writes } = rig()
    await registry.rememberTokens([token('A'), token('B'), token('C')])
    expect(writes).toEqual([])
  })

  it('reads the registry once per window, however often the scan asks', async () => {
    // Six hundred rows a scan, sixty scans an hour, of a list that changes over
    // days — the kind of traffic that once exhausted this engine's database
    // allowance in thirty-four hours.
    const { registry, advance, reads } = rig()
    await registry.knownTokens(600)
    advance(60_000)
    await registry.knownTokens(600)
    expect(reads()).toBe(1)
    advance(15 * 60_000)
    await registry.knownTokens(600)
    expect(reads()).toBe(2)
  })

  it('a failed read is not remembered, so the next scan asks again', async () => {
    let fail = true
    const registry = readOnlyRegistry({
      knownTokens: async () => { if (fail) throw new Error('db'); return [token('A')] },
      rememberTokens: async () => {},
    }, { everyMs: 15 * 60_000, now: () => 0 })
    await expect(registry.knownTokens(600)).rejects.toThrow()
    fail = false
    expect(await registry.knownTokens(600)).toHaveLength(1)
  })
})
