import { describe, it, expect } from 'vitest'
import { MemoryStore } from './memory-store.js'
import { alert } from '../../domain/notifications/alerts.js'

/**
 * The alert log is what replaces Telegram.
 *
 * Telegram was a PIPE: the engine pushed, and whatever was not delivered was
 * gone. A phone that was off, out of signal, or simply not installed yet
 * missed the death exit entirely. Storing alerts makes the channel a LOG that
 * a client reads from a cursor, so an app that was asleep for six hours wakes
 * up and catches up instead of finding nothing.
 */

const NOW = 1_800_000_000_000

describe('the alert log', () => {
  it('an empty log has nothing to say', async () => {
    const store = new MemoryStore()
    expect(await store.alertsSince(0)).toEqual([])
  })

  it('stamps each alert with a sequence, starting at one', async () => {
    const store = new MemoryStore()
    const stored = await store.recordAlert(alert('engine-started', 'Up', 'paper mode', NOW))
    expect(stored.seq).toBe(1)
    expect(stored.title).toBe('Up')
    expect(stored.level).toBe('info')
  })

  it('orders by sequence, not by clock — two alerts in the same millisecond must not collide', async () => {
    const store = new MemoryStore()
    await store.recordAlert(alert('dca-filled', 'first', '', NOW))
    await store.recordAlert(alert('dca-filled', 'second', '', NOW))

    const all = await store.alertsSince(0)
    expect(all.map((a) => a.title)).toEqual(['first', 'second'])
    expect(all.map((a) => a.seq)).toEqual([1, 2])
  })

  it('reads oldest first, so a phone that was asleep replays events in the order they happened', async () => {
    const store = new MemoryStore()
    await store.recordAlert(alert('position-opened', 'opened', '', NOW))
    await store.recordAlert(alert('death-exit', 'died', '', NOW + 1))

    expect((await store.alertsSince(0)).map((a) => a.title)).toEqual(['opened', 'died'])
  })

  it('the cursor is exclusive: what you have already seen never arrives twice', async () => {
    const store = new MemoryStore()
    await store.recordAlert(alert('dca-filled', 'one', '', NOW))
    const second = await store.recordAlert(alert('dca-filled', 'two', '', NOW + 1))

    expect(await store.alertsSince(second.seq)).toEqual([])
    expect((await store.alertsSince(1)).map((a) => a.title)).toEqual(['two'])
  })

  it('caps a page, so a long silence cannot flood the phone in one read', async () => {
    const store = new MemoryStore()
    for (let i = 0; i < 40; i += 1) await store.recordAlert(alert('heartbeat', `beat ${i}`, '', NOW + i))

    const page = await store.alertsSince(0, 10)
    expect(page).toHaveLength(10)
    expect(page[0]!.title).toBe('beat 0')
    // The caller pages forward from the last sequence it actually received.
    expect((await store.alertsSince(page[9]!.seq, 10))[0]!.title).toBe('beat 10')
  })

  it('keeps the structured detail, because an alert without its evidence is a rumour', async () => {
    const store = new MemoryStore()
    await store.recordAlert(alert('death-exit', 'DREGG', 'sell path broken', NOW, { positionId: 'pos-1', signal: 'sell-probe' }))

    const [stored] = await store.alertsSince(0)
    expect(stored!.data).toEqual({ positionId: 'pos-1', signal: 'sell-probe' })
  })
})
