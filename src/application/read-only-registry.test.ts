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

describe('readOnlyRegistry — read in pages, and each page once per window', () => {
  // A scan reads the registry only while its free slots are short, a page at a
  // time. The window still holds: a page already read is not read again inside
  // it, and a page never read is asked for exactly once.
  const rows = Array.from({ length: 1_200 }, (_, i) => token(`t${i}`))

  const paged = () => {
    let clock = 0
    const asked: [number, number][] = []
    const store = {
      knownTokens: async (limit: number, offset = 0) => {
        asked.push([limit, offset])
        return rows.slice(offset, offset + limit)
      },
      rememberTokens: async () => {},
    }
    return { registry: readOnlyRegistry(store, { everyMs: 15 * 60_000, now: () => clock }), asked, advance: (ms: number) => { clock += ms } }
  }

  it('asks the store only for what it has not read yet', async () => {
    const { registry, asked } = paged()
    expect((await registry.knownTokens(500, 0)).map((t) => t.contract).slice(0, 2)).toEqual(['t0', 't1'])
    expect((await registry.knownTokens(500, 500))[0]!.contract).toBe('t500')
    expect(await registry.knownTokens(500, 0)).toHaveLength(500)
    expect(asked).toEqual([[500, 0], [500, 500]])
  })

  it('knows when the registry ran out, and stops asking', async () => {
    const { registry, asked } = paged()
    expect(await registry.knownTokens(500, 1_000)).toHaveLength(200)
    expect(await registry.knownTokens(500, 1_500)).toEqual([])
    expect(asked).toEqual([[1_500, 0]])
  })

  it('reads the whole of it when asked for no limit', async () => {
    const { registry } = paged()
    expect(await registry.knownTokens(Number.POSITIVE_INFINITY)).toHaveLength(1_200)
  })

  it('reads it again once the window has passed', async () => {
    const { registry, asked, advance } = paged()
    await registry.knownTokens(500, 0)
    advance(15 * 60_000)
    await registry.knownTokens(500, 0)
    expect(asked).toEqual([[500, 0], [500, 0]])
  })
})
