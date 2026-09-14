import { describe, it, expect } from 'vitest'
import { StoredAlertSink } from './store-alerts.js'
import { MemoryStore } from '../persistence/memory-store.js'
import { alert, type Alert } from '../../domain/notifications/alerts.js'
import { type StoredAlert } from '../../domain/persistence/store.js'

const NOW = 1_800_000_000_000

/** A store whose writes fail until told otherwise. */
class FlakyStore {
  failing = true
  readonly written: Alert[] = []
  async recordAlert(a: Alert): Promise<StoredAlert> {
    if (this.failing) throw new Error('connection terminated unexpectedly')
    this.written.push(a)
    return { ...a, seq: this.written.length }
  }
}

describe('StoredAlertSink — the engine writes its alerts down', () => {
  it('records what it is given', async () => {
    const store = new MemoryStore()
    await new StoredAlertSink(store).send(alert('death-exit', 'DREGG', 'sell path broken', NOW))

    const [stored] = await store.alertsSince(0)
    expect(stored).toMatchObject({ kind: 'death-exit', level: 'critical', title: 'DREGG', seq: 1 })
  })

  it('never throws into the engine — a channel that can stop trading is worse than a missed message', async () => {
    const errors: unknown[] = []
    const sink = new StoredAlertSink(new FlakyStore(), (e) => errors.push(e))

    await expect(sink.send(alert('heartbeat', 'alive', '', NOW))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('retries a CRITICAL that failed to land, on the next alert', async () => {
    const store = new FlakyStore()
    const sink = new StoredAlertSink(store, () => {})

    await sink.send(alert('death-exit', 'died while the database was down', '', NOW))
    expect(store.written).toEqual([])

    store.failing = false
    await sink.send(alert('heartbeat', 'alive', '', NOW + 1000))

    // The death exit is the message the whole channel exists for; it goes
    // first, in the order it happened.
    expect(store.written.map((a) => a.kind)).toEqual(['death-exit', 'heartbeat'])
  })

  it('does not retry info or warn — only what is worth waking someone for', async () => {
    const store = new FlakyStore()
    const sink = new StoredAlertSink(store, () => {})

    await sink.send(alert('heartbeat', 'lost', '', NOW))
    await sink.send(alert('scan-empty', 'also lost', '', NOW + 1))
    store.failing = false
    await sink.send(alert('position-opened', 'landed', '', NOW + 2))

    expect(store.written.map((a) => a.title)).toEqual(['landed'])
  })

  it('bounds the spool, so a long outage cannot grow without limit', async () => {
    const store = new FlakyStore()
    const sink = new StoredAlertSink(store, () => {}, 3)

    for (let i = 0; i < 10; i += 1) await sink.send(alert('death-exit', `died ${i}`, '', NOW + i))
    store.failing = false
    await sink.send(alert('heartbeat', 'alive', '', NOW + 100))

    // The OLDEST are dropped: during a rolling collapse the most recent
    // verdicts are the ones that still describe the world.
    expect(store.written.map((a) => a.title)).toEqual(['died 7', 'died 8', 'died 9', 'alive'])
  })
})
