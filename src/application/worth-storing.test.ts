import { describe, it, expect } from 'vitest'
import { worthStoring } from './worth-storing.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'
import { type Candidate } from '../domain/scanner/ranking.js'

const snap = (address: string): TokenSnapshot => ({ chain: 'solana', address } as TokenSnapshot)
const cand = (address: string): Candidate => ({ snapshot: snap(address) } as Candidate)

describe('worthStoring — the radar carries what we may act on, nothing else', () => {
  // Measured on a live scan: 187 filtered and 108 unsafe cost 227 KB, against
  // ONE kilobyte for everything the engine could actually trade. Ninety-nine
  // percent of what was written, read back every poll and drawn on a phone was
  // tokens nobody will ever touch.
  //
  // The operator's rule: do not even put them on the radar. If one becomes
  // tradeable, the next scan will bring it back — the universe is re-discovered
  // from scratch every time, so nothing is lost by forgetting a rejection.

  it('keeps every candidate, reserve included', () => {
    const kept = worthStoring([snap('a'), snap('b')], [cand('a')], [])
    expect(kept.map((s) => s.address)).toEqual(['a'])
  })

  it('KEEPS a held token even when it passes nothing at all', () => {
    // The trap in this change. A token of ours whose mint authority came back
    // fails every safety gate — and it is the most urgent thing the screen can
    // say. Dropping it because it was rejected would delete the alarm, leaving
    // the dashboard serenely quiet about our money sitting in something that
    // just turned.
    const kept = worthStoring([snap('ours'), snap('junk')], [], ['ours'])
    expect(kept.map((s) => s.address)).toEqual(['ours'])
  })

  it('drops a stranger nobody can trade', () => {
    expect(worthStoring([snap('junk')], [], [])).toEqual([])
  })

  it('never writes the same token twice when it is both held and a candidate', () => {
    const kept = worthStoring([snap('a')], [cand('a')], ['a'])
    expect(kept).toHaveLength(1)
  })
})
