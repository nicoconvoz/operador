import { describe, it, expect } from 'vitest'
import { incrementalTape, TAPE_OVERLAP_MS } from './incremental-tape.js'
import { type PersistedFill } from '../domain/persistence/store.js'

/**
 * The dashboard re-read the WHOLE fill tape every two minutes, and the tape
 * grows all day — a thousand fills a day is two hundred kilobytes a read, and
 * growing. *Sólo guardemos los datos que nos sirvan, que no pesen nada, para
 * no ocupar ni espacio ni red.* It now asks for the last two hours and a count.
 */
const fill = (key: string, time: number, side: 'buy' | 'sell' = 'buy'): PersistedFill => ({
  positionId: 'p', orderId: 'Step', side, time, price: 1, qty: 1, costUsd: 0.05, comment: 'step', idempotencyKey: key,
})

const database = (initial: readonly PersistedFill[]) => {
  let rows = [...initial]
  const asked = { all: 0, since: [] as number[], count: 0 }
  return {
    asked,
    insert: (f: PersistedFill) => { rows.push(f) },
    truncate: () => { rows = [] },
    source: {
      allFills: async () => { asked.all++; return [...rows] },
      fillsSince: async (time: number) => { asked.since.push(time); return rows.filter((r) => r.time >= time) },
      fillCount: async () => { asked.count++; return rows.length },
    },
  }
}

describe('incrementalTape — the dashboard reads what is new, not the whole tape', () => {
  it('reads the whole tape once, then only the last two hours', async () => {
    const db = database([fill('a', 1_000), fill('b', 10_000_000)])
    const read = incrementalTape(db.source)
    expect((await read()).map((f) => f.idempotencyKey)).toEqual(['a', 'b'])
    db.insert(fill('c', 10_060_000))
    expect((await read()).map((f) => f.idempotencyKey)).toEqual(['a', 'b', 'c'])
    expect(db.asked.all).toBe(1)
    expect(db.asked.since).toEqual([10_000_000 - TAPE_OVERLAP_MS])
  })

  it('files a late stamp where the database would, inside the overlap', async () => {
    const db = database([fill('a', 5_000_000)])
    const read = incrementalTape(db.source)
    await read()
    db.insert(fill('sell', 4_000_000, 'sell'))
    db.insert(fill('buy', 4_000_000))
    expect((await read()).map((f) => f.idempotencyKey)).toEqual(['buy', 'sell', 'a'])
  })

  it('reads everything again when the count says something was missed — a stamp older than the overlap', async () => {
    const db = database([fill('a', 100_000_000)])
    const read = incrementalTape(db.source)
    await read()
    db.insert(fill('ancient', 1))
    expect((await read()).map((f) => f.idempotencyKey)).toEqual(['ancient', 'a'])
    expect(db.asked.all).toBe(2)
  })

  it('reads everything again after a truncate, instead of serving fills that no longer exist', async () => {
    const db = database([fill('a', 1_000), fill('b', 2_000)])
    const read = incrementalTape(db.source)
    await read()
    db.truncate()
    db.insert(fill('new', 3_000))
    expect((await read()).map((f) => f.idempotencyKey)).toEqual(['new'])
  })
})
