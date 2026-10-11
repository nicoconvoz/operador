import { describe, expect, it } from 'vitest'
import { MemoryStore, type StoreState } from '../infrastructure/persistence/memory-store.js'
import { applyControl, controlOrderFrom, importState, periodicPublisher, remoteStore } from './state-sync.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch } from '../domain/risk/death-exit.js'

describe('publishing the state — every minute, only when it changed, never two at once, never fatal', () => {
  const rig = () => {
    let clock = 0
    let content = 'a'
    const published: string[] = []
    let fail = false
    let release: (() => void) | null = null
    let hold = false
    const publisher = periodicPublisher({
      take: async () => content,
      publish: async (text) => {
        if (hold) await new Promise<void>((resolve) => { release = resolve })
        if (fail) throw new Error('403')
        published.push(text)
      },
      everyMs: 60_000,
      now: () => clock,
      onError: () => {},
    })
    return {
      publisher, published,
      at: (ms: number) => { clock = ms },
      write: (text: string) => { content = text },
      failing: (on: boolean) => { fail = on },
      holding: (on: boolean) => { hold = on },
      release: () => release?.(),
    }
  }

  it('publishes on the first pass and then at most once a minute', async () => {
    const r = rig()
    await r.publisher.maybePublish()
    r.write('b'); r.at(30_000); await r.publisher.maybePublish()
    r.at(60_000); await r.publisher.maybePublish()
    expect(r.published).toEqual(['a', 'b'])
  })

  it('publishes nothing when nothing changed', async () => {
    const r = rig()
    await r.publisher.maybePublish()
    r.at(120_000); await r.publisher.maybePublish()
    expect(r.published).toEqual(['a'])
  })

  it('publishes at once when asked to flush — the end of a run', async () => {
    const r = rig()
    await r.publisher.maybePublish()
    r.write('last'); r.at(1); await r.publisher.flush()
    expect(r.published).toEqual(['a', 'last'])
  })

  it('never starts a second publish while one is still going', async () => {
    const r = rig()
    r.holding(true)
    const first = r.publisher.maybePublish()
    r.write('b'); r.at(500_000)
    await r.publisher.maybePublish()
    r.release()
    await first
    expect(r.published).toEqual(['a'])
  })

  it('swallows a failure and tries again on the next pass', async () => {
    const r = rig()
    r.failing(true)
    await expect(r.publisher.maybePublish()).resolves.toBeUndefined()
    r.failing(false)
    r.at(1); await r.publisher.maybePublish()
    expect(r.published).toEqual(['a'])
  })
})

describe('the screen reads the published state', () => {
  const stateWith = async (positions: number): Promise<StoreState> => {
    const store = new MemoryStore()
    for (let i = 0; i < positions; i++) await store.saveCheckpoint({ savedAt: i, lastCompletedBar: 0, killSwitchEngaged: false })
    await store.blacklist('solana', `T${positions}`, 'x', 1)
    return JSON.parse(JSON.stringify(store.exportState(positions)))
  }

  it('reads it at most once per window, and keeps the last good copy when it cannot', async () => {
    let fetched = 0
    let clock = 0
    let failing = false
    const states = [await stateWith(1), await stateWith(2)]
    const reader = remoteStore({ load: async () => { fetched += 1; if (failing) throw new Error('404'); return states[fetched - 1] ?? states[1]! }, everyMs: 60_000, now: () => clock })
    expect([...(await (await reader.current()).blacklisted())]).toEqual(['solana:T1'])
    clock = 30_000; await reader.current()
    expect(fetched).toBe(1)
    clock = 61_000; failing = true
    expect([...(await (await reader.current()).blacklisted())]).toEqual(['solana:T1'])
    failing = false
    clock = 62_000
    expect([...(await (await reader.current()).blacklisted())]).toEqual(['solana:T2'])
  })

  it('is an empty book, never an error, before anything was ever published', async () => {
    const reader = remoteStore({ load: async () => { throw new Error('404') }, everyMs: 60_000, now: () => 0 })
    expect(await (await reader.current()).loadPositions()).toEqual([])
  })
})

describe('orders from the phone, through a file the engine reads', () => {
  it('engages and releases the engine\'s own switch, once per new order', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: 1, lastCompletedBar: 7, killSwitchEngaged: false })
    await applyControl(store, { action: 'kill', at: 100 })
    expect(await store.loadCheckpoint()).toMatchObject({ killSwitchEngaged: true, lastCompletedBar: 7 })
    expect(store.controlAppliedAt).toBe(100)
    // The engine engaged it on its own later: the SAME old order must not undo that.
    await store.saveCheckpoint({ savedAt: 200, lastCompletedBar: 8, killSwitchEngaged: false })
    await applyControl(store, { action: 'kill', at: 100 })
    expect((await store.loadCheckpoint())?.killSwitchEngaged).toBe(false)
    await applyControl(store, { action: 'resume', at: 300 })
    expect((await store.loadCheckpoint())?.killSwitchEngaged).toBe(false)
  })

  it('does not let an order older than the engine\'s own last word flip the switch', async () => {
    const store = new MemoryStore()
    await store.saveCheckpoint({ savedAt: 500, lastCompletedBar: 8, killSwitchEngaged: true })
    await applyControl(store, { action: 'resume', at: 400 })
    expect((await store.loadCheckpoint())?.killSwitchEngaged).toBe(true)
  })

  it('wipes everything and starts from zero on a reset — once, and the alert count keeps climbing', async () => {
    // *Quiero un botón que borre y empiece de cero, con confirmación* (2026-10-11).
    const store = new MemoryStore()
    await store.recordFill({ idempotencyKey: 'k1', positionId: 'p', orderId: 'Entry', side: 'buy', time: 10, price: 1, qty: 15, costUsd: 0.1, comment: '🟢 Entry' })
    await store.saveScan({ scannedAt: 20, chain: 'solana', snapshots: [] })
    await store.blacklist('solana', 'DEAD', 'death', 40)
    await store.recordAlert({ kind: 'heartbeat', level: 'info', at: 1, title: 'x', body: '' } as never)
    await applyControl(store, { action: 'reset', at: 1_000 })
    expect(await store.allFills()).toEqual([])
    expect(await store.latestScansByChain()).toEqual([])
    expect([...(await store.blacklisted())]).toEqual([])
    expect(await store.loadPositions()).toEqual([])
    expect((await store.alertsSince(0)).map((a) => a.title)).toEqual(['🧹 Borrado: empieza de cero'])
    // Read again after a restart, the same order wipes nothing new.
    const back = MemoryStore.fromState(JSON.parse(JSON.stringify(store.exportState(2_000))))
    await back.recordFill({ idempotencyKey: 'k2', positionId: 'q', orderId: 'Entry', side: 'buy', time: 1_500, price: 1, qty: 15, costUsd: 0.1, comment: '🟢 Entry' })
    await applyControl(back, { action: 'reset', at: 1_000 })
    expect(await back.allFills()).toHaveLength(1)
  })

  it('does nothing without an order', async () => {
    const store = new MemoryStore()
    await applyControl(store, null)
    expect(await store.loadCheckpoint()).toBeNull()
  })
})

describe('the one-time move off the database', () => {
  it('carries the book, the tape, the scans, the switch, the ban, the day log and the alert count — nothing else', async () => {
    const source = new MemoryStore()
    await source.savePosition({
      id: 'solana:T:1', chain: 'solana', tokenAddress: 'T', pairAddress: 'P', symbol: 'T',
      cascade: initialState(), deathWatch: startDeathWatch(100_000, 0),
      quality: { liquidityUsd: 100_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: 0 },
      capitalUsd: 15, lastBarTime: 0, lastPriceUsd: 1, pendingOrders: [], openedAt: 0, updatedAt: 0,
    })
    await source.recordFill({ idempotencyKey: 'k1', positionId: 'solana:T:1', orderId: 'Entry', side: 'buy', time: 10, price: 1, qty: 15, costUsd: 0.1, comment: '🟢 Entry' })
    await source.saveScan({ scannedAt: 20, chain: 'solana', snapshots: [] })
    await source.saveCheckpoint({ savedAt: 30, lastCompletedBar: 5, killSwitchEngaged: true })
    await source.blacklist('solana', 'DEAD', 'death', 40)
    for (let i = 0; i < 7; i++) await source.recordAlert({ kind: 'heartbeat', level: 'info', at: i, title: 'x', body: '' } as never)
    const moved = await importState(source)
    expect(await moved.loadPositions()).toEqual(await source.loadPositions())
    expect(await moved.allFills()).toEqual(await source.allFills())
    expect(await moved.latestScansByChain()).toEqual(await source.latestScansByChain())
    expect(await moved.loadCheckpoint()).toEqual(await source.loadCheckpoint())
    expect([...(await moved.blacklisted())]).toEqual(['solana:DEAD'])
    // The phone's cursor keeps climbing past what the database handed out.
    expect((await moved.recordAlert({ kind: 'heartbeat', level: 'info', at: 9, title: 'y', body: '' } as never)).seq).toBe(8)
  })
})

describe('what the phone may order, read from its request', () => {
  it('takes a stop, a start and a reset — the reset only with the word typed', () => {
    expect(controlOrderFrom({ action: 'kill', detail: 'x' }, 5)).toEqual({ action: 'kill', at: 5, detail: 'x' })
    expect(controlOrderFrom({ action: 'resume' }, 5)).toEqual({ action: 'resume', at: 5 })
    expect(controlOrderFrom({ action: 'reset', confirm: 'BORRAR' }, 5)).toEqual({ action: 'reset', at: 5 })
    expect(controlOrderFrom({ action: 'reset', confirm: 'borrar' }, 5)).toEqual({ error: "para borrar todo, escribí BORRAR" })
    expect(controlOrderFrom({ action: 'reset' }, 5)).toEqual({ error: "para borrar todo, escribí BORRAR" })
    expect(controlOrderFrom({ action: 'nuke' }, 5)).toEqual({ error: "action must be 'kill', 'resume' or 'reset'" })
  })
})
