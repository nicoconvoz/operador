import { type PersistedFill } from '../domain/persistence/store.js'
import { tapeOrder } from './cached-tape.js'

/**
 * The fill tape for the DASHBOARD, read whole once and then only what is new.
 *
 * *Sólo guardemos los datos que nos sirvan, que no pesen nada, para no ocupar
 * ni espacio ni red.* The operator. The screen re-read the whole tape every two
 * minutes, and the tape grows all day: a thousand fills a day is two hundred
 * kilobytes a read, and growing, on every instance of a poll that never stops.
 *
 * After the first read it asks for the fills stamped in the last two hours and
 * for a COUNT. The overlap exists because a fill is not always recorded in the
 * order it is stamped — the tick stamps with the bar it decided on, up to half
 * an hour behind the clock. The count is what makes that safe rather than
 * probable: if the tape it built does not hold exactly as many fills as the
 * table, something was missed (a stamp older than the overlap) or removed (a
 * truncate), and it reads everything again instead of guessing.
 *
 * The engine never uses this — it keeps its own tape, which it writes.
 */
export const TAPE_OVERLAP_MS = 2 * 3_600_000

export interface TapeSource {
  allFills(): Promise<readonly PersistedFill[]>
  fillsSince(time: number): Promise<readonly PersistedFill[]>
  fillCount(): Promise<number>
}

export function incrementalTape(source: TapeSource): () => Promise<readonly PersistedFill[]> {
  let tape: readonly PersistedFill[] | null = null
  const reload = async () => {
    tape = [...(await source.allFills())].sort(tapeOrder)
    return tape
  }
  return async () => {
    if (tape === null) return reload()
    const latest = tape.reduce((max, f) => Math.max(max, f.time), Number.NEGATIVE_INFINITY)
    const fresh = await source.fillsSince(Number.isFinite(latest) ? latest - TAPE_OVERLAP_MS : 0)
    const count = await source.fillCount()
    const byKey = new Map(tape.map((f) => [f.idempotencyKey, f] as const))
    for (const f of fresh) byKey.set(f.idempotencyKey, f)
    if (byKey.size !== count) return reload()
    tape = [...byKey.values()].sort(tapeOrder)
    return tape
  }
}
