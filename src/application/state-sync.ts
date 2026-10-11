/**
 * The engine's state, kept in a file on GitHub instead of a database.
 *
 * *Hacelo sin Supabase, todo desde GitHub* (2026-10-11). Supabase's egress was
 * past its 5 GB with a week of the cycle left. The engine already worked from
 * memory — the book and the tape read once per process — so the database was
 * only ever a place to leave the state between runs and a window for the
 * screen. A file does both: the engine reads it at start, writes it every
 * minute and at the end of a run (`periodicPublisher`), the screen reads the
 * same file (`remoteStore`), and the phone's kill switch is a second file the
 * engine applies (`applyControl`).
 *
 * What it costs, stated: a run killed without warning loses at most the last
 * minute of fills — a cancel is a warning, and the run flushes on it — and the
 * repository is public, so the state is too, as the dashboard already was.
 */

import type { StatePort } from '../domain/persistence/store.js'
import { MemoryStore, type StoreState } from '../infrastructure/persistence/memory-store.js'

/**
 * When to publish: on the first pass, then at most once every `everyMs`; only
 * when the content changed; never two at once; never fatal — a failure is
 * retried on the next pass. `flush` publishes now, for the end of a run.
 */
export function periodicPublisher(deps: {
  readonly take: () => Promise<string>
  readonly publish: (content: string) => Promise<void>
  readonly everyMs: number
  readonly now: () => number
  readonly onError: (error: unknown) => void
}): { maybePublish(): Promise<void>; flush(): Promise<void> } {
  let lastAt: number | null = null
  let lastContent: string | null = null
  let busy: Promise<void> | null = null

  const run = async (at: number): Promise<void> => {
    try {
      const content = await deps.take()
      if (content !== lastContent) {
        await deps.publish(content)
        lastContent = content
      }
      lastAt = at
    } catch (error) {
      deps.onError(error)
    }
  }

  return {
    async maybePublish() {
      if (busy) return
      const at = deps.now()
      if (lastAt !== null && at - lastAt < deps.everyMs) return
      busy = run(at).finally(() => {
        busy = null
      })
      await busy
    },
    async flush() {
      if (busy) await busy
      await run(deps.now())
    },
  }
}

/**
 * The published state as a store, for the screen: read at most once per
 * `everyMs`, the last good copy kept when it cannot be read, and an empty book
 * — never an error — before anything was ever published.
 */
export function remoteStore(deps: {
  readonly load: () => Promise<StoreState>
  readonly everyMs: number
  readonly now: () => number
}): { current(): Promise<MemoryStore>; writtenAt(): number | null } {
  let good: { store: MemoryStore; fetchedAt: number; at: number | null } | null = null
  let inFlight: Promise<MemoryStore> | null = null
  return {
    current() {
      if (good && deps.now() - good.fetchedAt < deps.everyMs) return Promise.resolve(good.store)
      inFlight ??= deps
        .load()
        .then((state) => {
          good = { store: MemoryStore.fromState(state), fetchedAt: deps.now(), at: state.at ?? null }
          return good.store
        })
        .catch(() => good?.store ?? new MemoryStore())
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
    /** When the ENGINE wrote what the screen holds; null before anything was read. */
    writtenAt: () => good?.at ?? null,
  }
}

/**
 * An order from the phone, stamped: stop opening positions, start again, or
 * wipe everything and start from zero.
 */
export interface ControlOrder {
  readonly action: 'kill' | 'resume' | 'reset'
  readonly at: number
  readonly detail?: string
}

/**
 * Applies an order this store has not applied yet. The stamp of the last one
 * applied lives IN the store, so a restart reading the same order does
 * nothing — a reset must never wipe the book a second time.
 *
 * The kill switch lives where it always did, on the checkpoint, so everything
 * that reads it is unchanged. An order older than the checkpoint's own last
 * word does not flip it: the engine may have engaged the switch itself since.
 */
export async function applyControl(store: MemoryStore, order: ControlOrder | null): Promise<void> {
  if (order === null || order.at <= store.controlAppliedAt) return
  if (order.action === 'reset') {
    store.reset()
    await store.recordAlert({
      kind: 'kill-switch',
      level: 'critical',
      at: order.at,
      title: '🧹 Borrado: empieza de cero',
      body: 'Se borraron las posiciones, las operaciones y el registro. El motor sigue y arranca de cero.',
    } as Parameters<MemoryStore['recordAlert']>[0])
  } else {
    const engaged = order.action === 'kill'
    const checkpoint = await store.loadCheckpoint()
    const stale = checkpoint !== null && checkpoint.savedAt > order.at
    if (!stale && checkpoint?.killSwitchEngaged !== engaged) {
      await store.saveCheckpoint({ savedAt: order.at, lastCompletedBar: checkpoint?.lastCompletedBar ?? 0, killSwitchEngaged: engaged })
    }
  }
  store.controlAppliedAt = order.at
}

/**
 * The one-time move off the database: everything the engine reads back, and
 * the alert count, so the phone's cursor keeps climbing. The registry, the
 * pool caches and old alerts stay behind — *sólo lo necesario que usamos*. A
 * death verdict's reason is not readable through the port, so a banned token
 * comes across as banned, the reason written as moved.
 */
export async function importState(
  source: Pick<StatePort, 'loadPositions' | 'allFills' | 'latestScansByChain' | 'loadCheckpoint' | 'blacklisted' | 'dailyPnl' | 'latestAlertSeq'>,
): Promise<MemoryStore> {
  const [positions, fills, scans, checkpoint, banned, days, alertSeq] = await Promise.all([
    source.loadPositions(),
    source.allFills(),
    source.latestScansByChain(),
    source.loadCheckpoint(),
    source.blacklisted(),
    source.dailyPnl(366),
    source.latestAlertSeq(),
  ])
  return MemoryStore.fromState({
    version: 1,
    positions,
    fills,
    blacklist: [...banned].map((key) => ({ key, reason: 'trasladado desde la base', at: 0 })),
    alerts: [],
    alertSeq,
    scans,
    checkpoint,
    days,
    discovery: [],
    poolHistory: [],
    quiet: [],
    security: [],
  })
}

/** The word that must be typed to wipe everything. */
export const RESET_WORD = 'BORRAR'

/**
 * What a request from the phone orders, or why it orders nothing. A reset
 * wipes the book for good, so it asks for the word typed out, exactly.
 */
export function controlOrderFrom(
  body: { readonly action?: unknown; readonly detail?: unknown; readonly confirm?: unknown },
  at: number,
): ControlOrder | { readonly error: string } {
  if (body.action === 'reset') {
    return body.confirm === RESET_WORD ? { action: 'reset', at } : { error: `para borrar todo, escribí ${RESET_WORD}` }
  }
  if (body.action === 'kill') return { action: 'kill', at, ...(typeof body.detail === 'string' ? { detail: body.detail.slice(0, 200) } : {}) }
  if (body.action === 'resume') return { action: 'resume', at }
  return { error: "action must be 'kill', 'resume' or 'reset'" }
}
