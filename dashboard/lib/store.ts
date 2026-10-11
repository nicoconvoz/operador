import { remoteStore } from '../../src/application/state-sync.js'
import type { StatePort } from '../../src/domain/persistence/store.js'
import type { StoreState } from '../../src/infrastructure/persistence/memory-store.js'

/**
 * The state the screen reads: the engine's own file on GitHub.
 *
 * *Hacelo sin Supabase, todo desde GitHub* (2026-10-11). The dashboard alone
 * had spent Supabase's whole monthly egress re-reading the book, the tape and
 * the scan. The engine keeps all of it in memory and writes it every minute to
 * `state.json` on the `state` branch; this reads that file — at most twice a
 * minute per instance, shared by every viewer — and answers every read from it,
 * the phone's alerts included. There is no database here at all.
 *
 * GitHub's raw files are cached up to five minutes on its side; the stamp in
 * the URL asks it not to reuse one. Before the engine has written anything the
 * screen shows an empty book rather than an error.
 *
 * Read-only. The kill switch and the reset are orders the phone writes to a
 * second file (see `api/control`), which the engine applies.
 */
export const STATE_REPO = process.env.OPERADOR_STATE_REPO?.trim() || 'nicoconvoz/operador'
const STATE_URL = process.env.OPERADOR_STATE_URL?.trim() || `https://raw.githubusercontent.com/${STATE_REPO}/state/state.json`
const READ_MS = 30_000

const loadState = async (): Promise<StoreState> => {
  const response = await fetch(`${STATE_URL}?t=${Math.floor(Date.now() / READ_MS)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`state ${response.status}`)
  return (await response.json()) as StoreState
}

let reader: ReturnType<typeof remoteStore> | null = null

/**
 * When the engine wrote what is on the screen, so it can say how old its
 * figures are. Null before anything was read.
 */
export const lastFillsReadAt = (): number | null => reader?.writtenAt() ?? null

/** The engine's state as a store: every read answered from the published file. */
export function openStore(): StatePort {
  reader ??= remoteStore({ load: loadState, everyMs: READ_MS, now: () => Date.now() })
  const current = reader.current
  return new Proxy({} as StatePort, {
    // Not a promise: `then` is absent, so awaiting the store yields the store.
    get: (_, name) => name === 'then' ? undefined : async (...args: unknown[]) => {
      const store = (await current()) as unknown as Record<string | symbol, (...a: unknown[]) => unknown>
      return store[name]!(...args)
    },
  })
}

/**
 * The message, never the stack: a stack from a client carries connection
 * details, and these endpoints are one paste away from public.
 */
export const failed = (error: unknown, status = 500): Response =>
  Response.json({ error: String(error).slice(0, 200) }, { status })
