import { describe, it, expect } from 'vitest'
import { cachedTape } from './cached-tape.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { type PersistedFill, type PersistedPosition, type StatePort } from '../domain/persistence/store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'

/**
 * The engine is the only writer of fills, so it can keep the tape in memory.
 *
 * Measured against the book that 5156a9b opens — up to 250 positions buying up
 * to twenty $1 steps — the engine re-read the whole tape about three times a
 * cycle and every held position's fills on every thirty-second sweep. At about
 * two hundred bytes a row that is gigabytes a day against a 5 GB MONTHLY
 * transfer allowance, and this project has already watched its whole stack stop
 * when an allowance ran out.
 */

const fill = (key: string, over: Partial<PersistedFill> = {}): PersistedFill => ({
  positionId: 'a', orderId: 'Step', side: 'buy', time: 1_000, price: 1, qty: 1, costUsd: 0.05, comment: 'step', idempotencyKey: key, ...over,
})

/** A MemoryStore that counts what the cache asks of it — the database, in these tests. */
const counting = (store = new MemoryStore()) => {
  const calls = { allFills: 0, fillsFor: 0, hasFill: 0, recordFill: 0, loadPositions: 0, savePosition: 0, closePosition: 0 }
  let failNextLoad = false
  let loseNextReply = false
  let failNextSave = false
  const tapeMethods: Partial<StatePort> = {
    loadPositions: async () => { calls.loadPositions++; return store.loadPositions() },
    savePosition: async (position: PersistedPosition) => {
      calls.savePosition++
      await store.savePosition(position)
      // The row landed and the reply did not.
      if (failNextSave) {
        failNextSave = false
        throw new Error('connection reset')
      }
    },
    closePosition: async (id: string) => { calls.closePosition++; return store.closePosition(id) },
    allFills: async () => {
      calls.allFills++
      if (failNextLoad) {
        failNextLoad = false
        throw new Error('the database blinked')
      }
      return store.allFills()
    },
    fillsFor: async (id: string) => { calls.fillsFor++; return store.fillsFor(id) },
    hasFill: async (key: string) => { calls.hasFill++; return store.hasFill(key) },
    recordFill: async (f: PersistedFill) => {
      calls.recordFill++
      await store.recordFill(f)
      // The insert landed and the reply did not: the ambiguous failure.
      if (loseNextReply) {
        loseNextReply = false
        throw new Error('connection reset')
      }
    },
  }
  // Everything else is the MemoryStore's own, bound to it, so a write through
  // the cache lands where the test reads it back.
  const wrapped = new Proxy(store, {
    get: (target, name) => {
      const own = tapeMethods[name as keyof StatePort]
      if (own !== undefined) return own
      const value: unknown = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as StatePort
  return {
    store,
    db: wrapped,
    calls,
    failNextLoad: () => { failNextLoad = true },
    loseNextReply: () => { loseNextReply = true },
    failNextSave: () => { failNextSave = true },
    /** Tape reads the database answered: the thing the quota pays for. */
    reads: () => calls.allFills + calls.fillsFor + calls.hasFill,
  }
}

describe('cachedTape — the tape is read once per process, and then from memory', () => {
  it('answers allFills, fillsFor and hasFill from ONE read, however often it is asked', async () => {
    const rig = counting()
    await rig.store.recordFill(fill('k1'))
    await rig.store.recordFill(fill('k2', { positionId: 'b' }))
    const tape = cachedTape(rig.db)

    for (let sweep = 0; sweep < 10; sweep++) {
      expect(await tape.allFills()).toHaveLength(2)
      expect(await tape.fillsFor('a')).toHaveLength(1)
      expect(await tape.hasFill('k2')).toBe(true)
    }
    expect(rig.calls.allFills).toBe(1)
    expect(rig.reads()).toBe(1)
  })

  it('serves what it records without another read — and the write still reaches the database', async () => {
    const rig = counting()
    const tape = cachedTape(rig.db)
    await tape.allFills()

    await tape.recordFill(fill('k1'))

    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(await tape.fillsFor('a')).toEqual([fill('k1')])
    expect(await tape.hasFill('k1')).toBe(true)
    expect(rig.reads()).toBe(1)
    expect(rig.calls.recordFill).toBe(1)
    expect(await rig.store.allFills()).toEqual([fill('k1')])
  })

  it('never appends a duplicate key twice, and keeps the FIRST write exactly as the database does', async () => {
    // `ON CONFLICT DO NOTHING`: a retry of the same intended order collides.
    // A tape that took the retry's price would disagree with the database
    // about what was paid, from the first write on.
    const rig = counting()
    const tape = cachedTape(rig.db)
    await tape.allFills()
    await tape.recordFill(fill('k1', { price: 1 }))
    await tape.recordFill(fill('k1', { price: 999 }))

    expect(await tape.allFills()).toEqual([fill('k1', { price: 1 })])
    expect(await tape.fillsFor('a')).toEqual([fill('k1', { price: 1 })])
    expect(await tape.allFills()).toEqual(await rig.store.allFills())
  })

  it('never appends a key the tape was LOADED with', async () => {
    const rig = counting()
    await rig.store.recordFill(fill('k1', { price: 1 }))
    const tape = cachedTape(rig.db)
    await tape.allFills()
    await tape.recordFill(fill('k1', { price: 999 }))
    expect(await tape.allFills()).toEqual([fill('k1', { price: 1 })])
  })

  it('filters fillsFor by position, in the order the database returns them', async () => {
    const rig = counting()
    const tape = cachedTape(rig.db)
    await tape.allFills()
    await tape.recordFill(fill('a1', { positionId: 'a', time: 1 }))
    await tape.recordFill(fill('b1', { positionId: 'b', time: 2 }))
    await tape.recordFill(fill('a2', { positionId: 'a', side: 'sell', time: 3 }))

    expect((await tape.fillsFor('a')).map((f) => f.idempotencyKey)).toEqual(['a1', 'a2'])
    expect((await tape.fillsFor('b')).map((f) => f.idempotencyKey)).toEqual(['b1'])
    expect(await tape.fillsFor('nobody')).toEqual([])
    expect(rig.calls.fillsFor).toBe(0)
  })

  it('files a late stamp where the database would: by time, a buy before a sell in one instant, then the key', async () => {
    // The tick stamps what it settles with the bar it decided on, up to half an
    // hour behind the clock, while the sweep stamps with the clock — so a fill
    // recorded later is not always a fill that happened later.
    const tape = cachedTape(counting().db)
    await tape.allFills()
    await tape.recordFill(fill('late', { time: 5 }))
    await tape.recordFill(fill('sell', { time: 3, side: 'sell' }))
    await tape.recordFill(fill('buy-b', { time: 3 }))
    await tape.recordFill(fill('buy-a', { time: 3 }))
    await tape.recordFill(fill('early', { time: 1 }))

    const order = ['early', 'buy-a', 'buy-b', 'sell', 'late']
    expect((await tape.allFills()).map((f) => f.idempotencyKey)).toEqual(order)
    expect((await tape.fillsFor('a')).map((f) => f.idempotencyKey)).toEqual(order)
  })

  it('a restart — a new cache — reloads the tape from the database', async () => {
    const rig = counting()
    await cachedTape(rig.db).recordFill(fill('k1'))

    const restarted = cachedTape(rig.db)
    expect(await restarted.fillsFor('a')).toEqual([fill('k1')])
    expect(rig.calls.allFills).toBe(1)
  })

  it('shares one load between the first readers of a pass', async () => {
    const rig = counting()
    await rig.store.recordFill(fill('k1'))
    const tape = cachedTape(rig.db)
    await Promise.all([tape.allFills(), tape.fillsFor('a'), tape.hasFill('k1'), tape.allFills()])
    expect(rig.calls.allFills).toBe(1)
  })

  it('a write that lands while the first load is in flight is on the tape exactly once', async () => {
    // The load read the table BEFORE the insert; the write must still appear.
    const store = new MemoryStore()
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = new Proxy(store, {
      get: (target, name) => name === 'allFills'
        ? async () => { const rows = await target.allFills(); await gate; return rows }
        : (Reflect.get(target, name) as (...args: unknown[]) => unknown).bind(target),
    }) as StatePort
    const tape = cachedTape(slow)

    const reading = tape.allFills()
    const writing = tape.recordFill(fill('k1'))
    release()
    expect(await reading).toEqual([])
    await writing
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(await tape.fillsFor('a')).toEqual([fill('k1')])
  })

  it('a write that FAILS while the first load is in flight throws that load away', async () => {
    // It may have read the table before the lost insert landed.
    const rig = counting()
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let loads = 0
    const slow = new Proxy(rig.db, {
      get: (target, name) => name === 'allFills'
        ? async () => { loads++; const rows = await target.allFills(); if (loads === 1) await gate; return rows }
        : Reflect.get(target, name),
    }) as StatePort
    const tape = cachedTape(slow)
    rig.loseNextReply()

    const reading = tape.allFills()
    await expect(tape.recordFill(fill('k1'))).rejects.toThrow('connection reset')
    release()
    await reading
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(loads).toBe(2)
  })

  it('never remembers a failed load: the next read asks again', async () => {
    // Remembering "the database was down" would serve an empty tape — a book
    // that owns nothing and has made nothing — until the process restarts.
    const rig = counting()
    await rig.store.recordFill(fill('k1'))
    const tape = cachedTape(rig.db)
    rig.failNextLoad()

    await expect(tape.allFills()).rejects.toThrow('the database blinked')
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(rig.calls.allFills).toBe(2)
  })

  it('a write whose reply was lost is re-read from the database, never guessed at', async () => {
    // The insert may have landed or not. The tape does not know, so it forgets
    // what it holds and the next read asks the only party that does.
    const rig = counting()
    const tape = cachedTape(rig.db)
    await tape.allFills()
    rig.loseNextReply()

    await expect(tape.recordFill(fill('k1'))).rejects.toThrow('connection reset')
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(rig.calls.allFills).toBe(2)

    // And the retry of that same order collides instead of being appended.
    await tape.recordFill(fill('k1', { price: 999 }))
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(await tape.allFills()).toEqual(await rig.store.allFills())
  })

  it('a caller cannot change the tape by changing what it was handed, or what it handed in', async () => {
    // One copy of the tape now serves every reader in the process, so a reader
    // that edits its answer would be editing everybody's.
    const tape = cachedTape(counting().db)
    await tape.allFills()
    const written = { ...fill('k1') }
    await tape.recordFill(written)
    ;(written as { price: number }).price = 7
    ;(await tape.allFills() as PersistedFill[]).push(fill('forged'))
    ;(await tape.fillsFor('a') as PersistedFill[]).length = 0
    const [held] = await tape.allFills()
    expect(() => { (held as { price: number }).price = 7 }).toThrow(TypeError)
    expect(await tape.allFills()).toEqual([fill('k1')])
    expect(await tape.fillsFor('a')).toEqual([fill('k1')])
    expect(await tape.hasFill('forged')).toBe(false)
  })

  it('passes everything that is not the tape straight to the store', async () => {
    const rig = counting()
    const tape = cachedTape(rig.db)
    const position = {
      id: 'p', chain: 'solana' as const, tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
      cascade: initialState(), deathWatch: startDeathWatch(1_000, 0),
      quality: { liquidityUsd: 1_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: 0 },
      capitalUsd: 20, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
    }
    await tape.savePosition(position)
    expect((await rig.store.loadPositions()).map((p) => p.id)).toEqual(['p'])
    expect((await tape.loadPositions()).map((p) => p.id)).toEqual(['p'])
    await tape.saveCheckpoint({ savedAt: 1, lastCompletedBar: 2, killSwitchEngaged: true })
    expect(await rig.store.loadCheckpoint()).toEqual({ savedAt: 1, lastCompletedBar: 2, killSwitchEngaged: true })
  })
})

describe('cachedTape — the book is read once per process, and then from memory', () => {
  // *Sólo guardemos los datos que nos sirvan, que no pesen nada, para no ocupar
  // ni espacio ni red.* The operator. The engine re-read the whole book on every
  // thirty-second sweep and six to eight times a pass — about ten thousand full
  // reads a day, measured at 280 MB a day with 30 positions and 2.5 GB with 250,
  // against a book heading for 166. The engine is the only writer of positions,
  // so after one read every change passes through here.
  const position = (id: string, over: Partial<PersistedPosition> = {}): PersistedPosition => ({
    id, chain: 'solana', tokenAddress: id, pairAddress: `pair-${id}`, symbol: id,
    cascade: initialState(), deathWatch: startDeathWatch(1_000, 0),
    quality: { liquidityUsd: 1_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: 0 },
    capitalUsd: 30, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0, ...over,
  })

  it('answers every loadPositions from ONE read, however often it is asked', async () => {
    const rig = counting()
    await rig.store.savePosition(position('a'))
    const book = cachedTape(rig.db)
    for (let i = 0; i < 5; i++) expect((await book.loadPositions()).map((p) => p.id)).toEqual(['a'])
    expect(rig.calls.loadPositions).toBe(1)
  })

  it('serves what it saves without another read — and the write still reaches the database', async () => {
    const rig = counting()
    const book = cachedTape(rig.db)
    await book.loadPositions()
    await book.savePosition(position('a', { lastPriceUsd: 2 }))
    expect((await book.loadPositions()).map((p) => [p.id, p.lastPriceUsd])).toEqual([['a', 2]])
    expect((await rig.store.loadPositions()).map((p) => p.lastPriceUsd)).toEqual([2])
    expect(rig.calls.loadPositions).toBe(1)
  })

  it('keeps what the database keeps: a stale save cannot erase the gain lock, the entry score or the break-even', async () => {
    // The upsert ratchets these in SQL, so memory folds a save by the SAME rules
    // the reference store runs — never the row as it was handed in.
    const rig = counting()
    const book = cachedTape(rig.db)
    await book.savePosition(position('a', { gainLock: { pct: 10, since: 5 }, entryScore: 70, breakEvenArmed: true }))
    await book.loadPositions()
    await book.savePosition(position('a', { gainLock: null, entryScore: 40, breakEvenArmed: false, lastPriceUsd: 3 }))
    const [kept] = await book.loadPositions()
    const [stored] = await rig.store.loadPositions()
    expect(kept).toEqual(stored)
    expect([kept!.gainLock, kept!.entryScore, kept!.breakEvenArmed, kept!.lastPriceUsd]).toEqual([{ pct: 10, since: 5 }, 70, true, 3])
  })

  it('forgets a closed position without another read', async () => {
    const rig = counting()
    await rig.store.savePosition(position('a'))
    await rig.store.savePosition(position('b', { openedAt: 1 }))
    const book = cachedTape(rig.db)
    await book.loadPositions()
    await book.closePosition('a')
    expect((await book.loadPositions()).map((p) => p.id)).toEqual(['b'])
    expect((await rig.store.loadPositions()).map((p) => p.id)).toEqual(['b'])
    expect(rig.calls.loadPositions).toBe(1)
  })

  it('returns the book in the order the database does: by the time it was opened', async () => {
    const rig = counting()
    const book = cachedTape(rig.db)
    await book.loadPositions()
    await book.savePosition(position('late', { openedAt: 9 }))
    await book.savePosition(position('early', { openedAt: 1 }))
    expect((await book.loadPositions()).map((p) => p.id)).toEqual(['early', 'late'])
  })

  it('a save whose reply was lost is re-read from the database, never guessed at', async () => {
    const rig = counting()
    const book = cachedTape(rig.db)
    await book.loadPositions()
    rig.failNextSave()
    await expect(book.savePosition(position('a'))).rejects.toThrow('connection reset')
    expect((await book.loadPositions()).map((p) => p.id)).toEqual(['a'])
    expect(rig.calls.loadPositions).toBe(2)
  })

  it('a caller cannot change the book by changing what it was handed, or what it handed in', async () => {
    const rig = counting()
    const book = cachedTape(rig.db)
    const handed = position('a') as { lastPriceUsd: number | null }
    await book.savePosition(handed as PersistedPosition)
    await book.loadPositions()
    handed.lastPriceUsd = 99
    const [read] = (await book.loadPositions()) as unknown as { lastPriceUsd: number | null }[]
    read!.lastPriceUsd = 77
    expect((await book.loadPositions())[0]!.lastPriceUsd).toBe(1)
  })
})
